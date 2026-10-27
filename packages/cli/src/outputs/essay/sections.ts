/**
 * The essay's sections (AGT-2134, pm project `pablo-platform`, D-7): what
 * they are, and how they live in one file.
 *
 * On a nonfiction work the sections are the rows of the core outline
 * (`core/outline.md`, `| # | Section | What it covers |`), and a section's
 * claims are the claims rows its "What it covers" cell names (`#2`, `#3`), or
 * every claim when it names none. On a fiction track the essay is about the
 * story (D-7: it draws on the story core's research and facts): its sections
 * are `outputs/essay/outline.md`'s rows (same table), which `output add essay`
 * scaffolds from the core with the thesis (AGT-2135, `./scaffold.ts`); a work
 * without that file has one section, the whole essay.
 *
 * Every section lives in `outputs/essay/essay.md`, under a `## <section
 * title>` heading, in outline order:
 *
 *     ---
 *     (the provenance of the section written last)
 *     ---
 *
 *     ## The press arrives
 *
 *     One sentence per line [#1].
 *
 *     ## What changed
 *     ...
 *
 * A heading is matched to its section by title (case and spacing ignored).
 * Each section's own receipt is in the receipts log; the file's frontmatter
 * is the last write's, which is what `check` needs for provenance.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EssayClaim, EssaySection } from "@openthink/pablo-core";
import { CLAIMS_FILE, OUTLINE_FILE, parseClaims, parseSections } from "../../core/nonfiction";
import { readMarker, trackOf } from "../../marker";
import type { TrackId } from "../../tracks/registry";
import { ESSAY_DIR, ESSAY_FILE } from "./units";

/** The essay file, work-relative. */
export const ESSAY_PATH = `${ESSAY_DIR}/${ESSAY_FILE}`;

/** A fiction track's essay thesis (AGT-2135), written by `output add essay --thesis`. Work-relative. */
export const ESSAY_THESIS_FILE = `${ESSAY_DIR}/thesis.md`;

/** A fiction track's essay outline (AGT-2135), `| # | Section | What it covers |`, scaffolded from the core. */
export const ESSAY_OUTLINE_FILE = `${ESSAY_DIR}/outline.md`;

/**
 * The one section of an essay on a fiction track that has no `outputs/essay/outline.md` (one added before
 * AGT-2135 gave the fiction essay a thesis and an outline).
 */
export const FICTION_ESSAY_SECTION: EssaySection = { number: 1, title: "The essay", covers: "the story: what it is about, where it comes from and why it is told" };

function read(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** The work's track, from its marker (fiction when it cannot be read). */
export function essayTrack(workDir: string): TrackId {
  const marker = readMarker(workDir);
  return marker.ok ? trackOf(marker.marker) : "fiction";
}

/**
 * The essay's outline: the core outline's sections on nonfiction; on a fiction track the sections of
 * `outputs/essay/outline.md` (AGT-2135), or the one whole-essay section when the work has no such file.
 */
export function essayOutline(workDir: string, track: TrackId = essayTrack(workDir)): { readonly sections: readonly EssaySection[]; readonly source: string } {
  if (track !== "nonfiction") {
    const text = read(join(workDir, ESSAY_OUTLINE_FILE));
    if (text === undefined) return { sections: [FICTION_ESSAY_SECTION], source: ESSAY_PATH };
    return { sections: parseSections(text).map((r) => ({ number: r.number, title: r.section, covers: r.summary })), source: ESSAY_OUTLINE_FILE };
  }
  const rows = parseSections(read(join(workDir, OUTLINE_FILE)) ?? "");
  return { sections: rows.map((r) => ({ number: r.number, title: r.section, covers: r.summary })), source: OUTLINE_FILE };
}

/** The claims rows `covers` names (`#2`, `#3`), in the order named, each once. */
export function claimRefs(covers: string): number[] {
  return [...new Set([...covers.matchAll(/(?<![\w[])#(\d+)\b/g)].map((m) => Number(m[1])))];
}

/** A section's claims: the rows its cell names, else every row; and any it names that the claims table lacks. */
export function sectionClaims(workDir: string, section: EssaySection): { readonly claims: readonly EssayClaim[]; readonly absent: readonly number[] } {
  const rows = parseClaims(read(join(workDir, CLAIMS_FILE)) ?? "");
  const named = claimRefs(section.covers);
  if (named.length === 0) return { claims: rows.map((r) => ({ number: r.number, claim: r.claim, sources: r.sources })), absent: [] };
  const claims: EssayClaim[] = [];
  const absent: number[] = [];
  for (const n of named) {
    const row = rows.find((r) => r.number === n);
    if (row === undefined) absent.push(n);
    else claims.push({ number: row.number, claim: row.claim, sources: row.sources });
  }
  return { claims, absent };
}

/** One `## ` section of the essay file as written. */
interface FileSection {
  readonly title: string;
  readonly body: string;
}

interface EssayFile {
  /** The frontmatter block, `---` lines included, or `""`. */
  readonly front: string;
  /** Text before the first `## ` heading (a `# Title` line, an epigraph), trimmed. */
  readonly preamble: string;
  readonly sections: readonly FileSection[];
}

const FRONT = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Case and spacing folded, so a heading matches its outline row however it was typed. */
function fold(title: string): string {
  return title.replace(/\s+/g, " ").trim().toLowerCase();
}

/** The essay file split into its frontmatter, preamble and `## ` sections. Pure. */
export function parseEssayFile(content: string): EssayFile {
  const front = FRONT.exec(content)?.[0] ?? "";
  const lines = content.slice(front.length).split(/\r?\n/);
  const preamble: string[] = [];
  const sections: { title: string; lines: string[] }[] = [];
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading !== null && !line.startsWith("###")) sections.push({ title: heading[1] as string, lines: [] });
    else if (sections.length === 0) preamble.push(line);
    else (sections.at(-1) as { lines: string[] }).lines.push(line);
  }
  return {
    front: front.trimEnd(),
    preamble: preamble.join("\n").trim(),
    sections: sections.map((s) => ({ title: s.title, body: s.lines.join("\n").trim() })),
  };
}

/** The file text for `file`. Pure. */
function renderEssayFile(file: EssayFile): string {
  const parts = [file.front, file.preamble, ...file.sections.map((s) => (s.body === "" ? `## ${s.title}` : `## ${s.title}\n\n${s.body}`))].filter((p) => p !== "");
  return `${parts.join("\n\n")}\n`;
}

/** The outline section a heading names, or undefined. */
function unitOfHeading(outline: readonly EssaySection[], title: string): number | undefined {
  return outline.find((s) => fold(s.title) === fold(title))?.number;
}

/** Section `unit`'s body in `content` (frontmatter and heading excluded), or undefined when the file has no text for it. Pure over `outline`. */
export function sectionBody(outline: readonly EssaySection[], content: string, unit: number): string | undefined {
  const section = outline.find((s) => s.number === unit);
  if (section === undefined) return undefined;
  const found = parseEssayFile(content).sections.find((s) => fold(s.title) === fold(section.title));
  return found === undefined || found.body === "" ? undefined : found.body;
}

/** A writer's answer as a section body: any leading heading dropped, any other `#`/`##` heading demoted so it cannot open a section. */
export function cleanSectionBody(body: string): string {
  const lines = body.trim().split("\n");
  while (lines.length > 0 && /^#{1,6}\s/.test(lines[0] as string)) {
    lines.shift();
    while (lines.length > 0 && (lines[0] as string).trim() === "") lines.shift();
  }
  return lines.map((line) => line.replace(/^#{1,2}(\s)/, "###$1")).join("\n").trim();
}

/**
 * `content` with section `unit` set to `body`: its text replaced when the file has the section, else the section
 * inserted before the first later outline section (appended when there is none). `frontmatter` replaces the file's.
 * Sections the outline does not name are kept where they are. Pure over `outline`.
 */
export function putSection(outline: readonly EssaySection[], content: string | undefined, unit: number, body: string, frontmatter: string): string {
  const file = parseEssayFile(content ?? "");
  const title = outline.find((s) => s.number === unit)?.title ?? `Section ${unit}`;
  const cleaned = cleanSectionBody(body);
  const sections = [...file.sections];
  const at = sections.findIndex((s) => fold(s.title) === fold(title));
  if (at !== -1) {
    sections[at] = { title: (sections[at] as FileSection).title, body: cleaned };
  } else {
    const later = sections.findIndex((s) => {
      const n = unitOfHeading(outline, s.title);
      return n !== undefined && n > unit;
    });
    const entry = { title, body: cleaned };
    if (later === -1) sections.push(entry);
    else sections.splice(later, 0, entry);
  }
  return renderEssayFile({ front: frontmatter.trim(), preamble: file.preamble, sections });
}

/** The essay file's text, or undefined when it is not written. */
export function readEssayFile(workDir: string): string | undefined {
  return read(join(workDir, ESSAY_PATH));
}

/** Section `unit`'s body as written in the work's essay file, or undefined. */
export function essaySectionText(workDir: string, unit: number): string | undefined {
  const content = readEssayFile(workDir);
  return content === undefined ? undefined : sectionBody(essayOutline(workDir).sections, content, unit);
}

/** A bracket made only of `@id`/`#n` tokens: a citation (the claim-support check's syntax, AGT-2114). */
export const CITATION = /\s*\[((?:\s*(?:@[\w./-]+|#\d+)\s*[;,]?)+)\]/g;

/** `text` with its citations removed, as a listener hears it (the narrated output reads this). */
export function withoutCitations(text: string): string {
  return text.replace(CITATION, "");
}
