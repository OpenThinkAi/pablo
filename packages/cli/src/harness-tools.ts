/**
 * The harness's `read` and `search` tools (AGT-1554; `pm project show
 * ai-terminal --doc harness`, "The agent's tools"). The harness has no shell
 * and no general file tool, so these two are how it finds what the work has
 * already established.
 *
 * Pure and SDK-independent: input in, result out, no process globals. The
 * Agent SDK registration (AGT-1552) and `verbs.ts` both wrap them.
 *
 * Both are bounded to the work directory twice over. A path must resolve
 * (symlinks followed) inside the work, and then inside one of the readable
 * areas below, so `pablo.json`, `.pablo/` (receipts, conversations, keys'
 * neighbours) and `notes/` are out of reach even though they sit in the work.
 * `research/` IS readable here: the harness may read it, Gemma never does
 * (that rule is the pack assembler's, not this module's).
 *
 * Chapters come back joined into paragraphs (`joinParagraphs`): on disk they
 * are one sentence per line, and a model reads paragraphs.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { joinParagraphs, splitSentences } from "@openthink/pablo-core";

export type ReadableKind = "bible" | "chapter" | "outline" | "continuity" | "research";

/** Directory name (or file name) at the work root -> what it is. */
const AREAS: Readonly<Record<string, ReadableKind>> = {
  bible: "bible",
  chapters: "chapter",
  outline: "outline",
  research: "research",
  "continuity.md": "continuity",
};

/** Search stops here and says so, so one common word cannot flood the model's context. */
export const SEARCH_LIMIT = 50;

export interface ToolRefusal {
  readonly ok: false;
  readonly code: 2;
  readonly message: string;
}

export type ReadResult =
  | { readonly ok: true; readonly path: string; readonly kind: ReadableKind; readonly frontmatter?: string; readonly text: string }
  | { readonly ok: true; readonly path: string; readonly kind: "directory"; readonly entries: readonly string[] }
  | ToolRefusal;

export interface SearchMatch {
  /** Path relative to the work directory, forward slashes. */
  readonly file: string;
  /** 1-based line in the file as stored where the match starts. */
  readonly line: number;
  /** The sentence containing the match (whole line for non-prose files). */
  readonly sentence: string;
}

export type SearchResult =
  | { readonly ok: true; readonly phrase: string; readonly matches: readonly SearchMatch[]; readonly truncated: boolean }
  | ToolRefusal;

function refuse(message: string): ToolRefusal {
  return { ok: false, code: 2, message };
}

type Resolved = { readonly ok: true; readonly abs: string; readonly rel: string; readonly kind: ReadableKind } | ToolRefusal;

/** Resolves `value` against the work, refusing anything outside it or outside the readable areas. */
function resolveReadable(workDir: string, value: string): Resolved {
  const root = realpathSync(workDir);
  const lexical = resolve(root, value);
  if (lexical !== root && !lexical.startsWith(root + sep)) {
    return refuse(`pablo: "${value}" is outside the work directory`);
  }
  // Follow symlinks too: a link inside the work must not lead out of it.
  let abs = lexical;
  if (existsSync(lexical)) {
    abs = realpathSync(lexical);
    if (abs !== root && !abs.startsWith(root + sep)) {
      return refuse(`pablo: "${value}" is outside the work directory`);
    }
  }
  const rel = relative(root, abs).split(sep).join("/");
  const area = rel.split("/")[0] ?? "";
  const kind = AREAS[area];
  if (rel === "" || kind === undefined) {
    return refuse(
      `pablo: "${value}" is not readable; read bible/, chapters/, outline/, research/ or continuity.md`,
    );
  }
  return { ok: true, abs, rel, kind };
}

function splitFrontmatter(raw: string): { readonly frontmatter?: string; readonly body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { body: raw };
  return { frontmatter: match[1] ?? "", body: raw.slice(match[0].length) };
}

/** `read`: one file of the work (a directory lists its entries). Chapters come back as paragraphs. */
export function readTool(workDir: string, path: string): ReadResult {
  const resolved = resolveReadable(workDir, path);
  if (!resolved.ok) return resolved;
  if (!existsSync(resolved.abs)) return refuse(`pablo: ${resolved.rel} does not exist`);

  if (statSync(resolved.abs).isDirectory()) {
    const entries = readdirSync(resolved.abs).filter((name) => !name.startsWith(".")).sort();
    return { ok: true, path: resolved.rel, kind: "directory", entries };
  }

  const raw = readFileSync(resolved.abs, "utf8");
  if (resolved.kind !== "chapter") return { ok: true, path: resolved.rel, kind: resolved.kind, text: raw };

  const { frontmatter, body } = splitFrontmatter(raw);
  const text = joinParagraphs(body);
  return frontmatter === undefined
    ? { ok: true, path: resolved.rel, kind: resolved.kind, text }
    : { ok: true, path: resolved.rel, kind: resolved.kind, frontmatter, text };
}

function listFiles(abs: string, out: string[]): void {
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const child = join(abs, entry.name);
    if (entry.isDirectory()) listFiles(child, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(child);
  }
}

const norm = (text: string): string => text.replace(/\s+/g, " ").toLowerCase();

/** Case-insensitive, whitespace-insensitive start offsets of `needle` in `hay`. */
function offsets(hay: string, needle: string): number[] {
  const found: number[] = [];
  const h = norm(hay);
  // `norm` can shorten the string, so match on the normalised text and keep
  // sentence lookup on the same normalised coordinates.
  for (let at = h.indexOf(needle); at !== -1; at = h.indexOf(needle, at + 1)) found.push(at);
  return found;
}

/** Matches in one file, each with its line and sentence. Prose (chapters) is searched paragraph-wise so a phrase wrapped across lines still hits. */
function searchFile(abs: string, rel: string, kind: ReadableKind, needle: string): SearchMatch[] {
  const raw = readFileSync(abs, "utf8");
  // Not `splitFrontmatter`: that returns the body without its line count, and
  // a match must report its line in the file as stored.
  const fm = kind === "chapter" ? /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw) : null;
  const skipped = fm ? fm[0].split("\n").length - 1 : 0;
  const lines = raw.split(/\r?\n/);
  const matches: SearchMatch[] = [];

  if (kind !== "chapter") {
    lines.forEach((text, index) => {
      if (offsets(text, needle).length === 0) return;
      const sentence = splitSentences(text).find((s) => offsets(s, needle).length > 0) ?? text.trim();
      matches.push({ file: rel, line: index + 1, sentence: sentence.trim() });
    });
    return matches;
  }

  let i = skipped;
  while (i < lines.length) {
    if ((lines[i] ?? "").trim() === "") {
      i++;
      continue;
    }
    const start = i;
    const parts: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "") parts.push((lines[i++] as string).trim().replace(/\s+/g, " "));
    const paragraph = parts.join(" ");
    const hits = offsets(paragraph, needle);
    if (hits.length === 0) continue;

    // Where each line begins within the joined paragraph, and each sentence.
    const lineStarts: number[] = [];
    let cursor = 0;
    for (const part of parts) {
      lineStarts.push(cursor);
      cursor += part.length + 1;
    }
    const sentences: { text: string; at: number }[] = [];
    cursor = 0;
    for (const sentence of splitSentences(paragraph)) {
      const at = paragraph.indexOf(sentence, cursor);
      if (at === -1) continue;
      sentences.push({ text: sentence, at });
      cursor = at + sentence.length;
    }
    const seen = new Set<string>();
    for (const hit of hits) {
      let offset = 0;
      for (let k = 0; k < lineStarts.length; k++) if ((lineStarts[k] as number) <= hit) offset = k;
      const sentence = [...sentences].reverse().find((s) => s.at <= hit)?.text ?? paragraph;
      const key = `${start + offset}:${sentence}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ file: rel, line: start + offset + 1, sentence });
    }
  }
  return matches;
}

/** `search`: a phrase across the readable areas of the work, with file, line and the matching sentence. */
export function searchTool(workDir: string, phrase: string): SearchResult {
  const needle = norm(phrase).trim();
  if (needle === "") return refuse("pablo: search needs a non-empty phrase");

  const root = realpathSync(workDir);
  const files: string[] = [];
  for (const area of Object.keys(AREAS)) {
    const abs = join(root, area);
    if (!existsSync(abs)) continue;
    // A symlinked area (or one pointing out of the work) is skipped, not followed.
    if (realpathSync(abs) !== abs) continue;
    if (statSync(abs).isDirectory()) listFiles(abs, files);
    else files.push(abs);
  }
  files.sort();

  const matches: SearchMatch[] = [];
  let truncated = false;
  for (const abs of files) {
    const resolved = resolveReadable(root, abs);
    if (!resolved.ok) continue; // a file linked out of the work
    for (const match of searchFile(resolved.abs, resolved.rel, resolved.kind, needle)) {
      if (matches.length >= SEARCH_LIMIT) {
        truncated = true;
        break;
      }
      matches.push(match);
    }
    if (truncated) break;
  }
  return { ok: true, phrase, matches, truncated };
}
