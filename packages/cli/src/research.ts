/**
 * `save_research` (AGT-1559): the harness keeps a research finding with its
 * sources and retrieval date as `research/<slug>.md`, committed to the
 * session's plan branch. Design: the `ai-terminal` pm doc `harness`, tool
 * `research`.
 *
 * Claude may read these notes; Gemma never does. The `research/` prefix is in
 * every work's default `neverSend`, and no pack kind reads from it
 * (`packages/cli/test/research-never-sent.test.ts` asserts both). This module
 * only writes; it makes no web call, so the fetching tool stays separate.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BranchResult } from "./branch";
import { type PlanSession, planWrite } from "./plan";
import { slugify } from "./write";

export interface SaveResearchInput {
  title: string;
  /** The finding, in the harness's words. */
  note: string;
  /** Where it came from: URLs or citations. At least one. */
  sources: readonly string[];
}

export interface SaveResearchOptions {
  /** The project directory relative to the repo root (e.g. `novels/valley`); default is the repo root. */
  dir?: string;
  /** Retrieval date (YYYY-MM-DD); default today. Injectable for tests. */
  retrieved?: string;
}

export type SaveResearchResult =
  | { ok: true; path: string; sha?: string }
  | { ok: false; notice: string };

/**
 * What a `## Sources` entry may be (AGT-2185): an http(s) URL, a DOI or ISBN, or a bibliographic citation that names
 * the work and its year. A story run once saved notes citing "General knowledge of …" with no URL; those are not
 * sources, and the author cannot check them.
 */
export const SOURCE_RULE =
  'a source is an http(s) URL (as web_fetch returned it), a DOI or ISBN, or a bibliographic citation naming the work and its year (e.g. "Hobsbawm, The Age of Empire, 1987"); general knowledge, memory or an unnamed source is not one';

const URL_SOURCE = /\bhttps?:\/\/[^\s/$.?#][^\s]*/i;
const DOI_OR_ISBN = /\b(?:doi:\s*)?10\.\d{4,9}\/\S+|\bISBN(?:-1[03])?[\s:]*[\dX][\dX\s-]{8,}/i;
const YEAR = /(?<![\d-])(?:1\d{3}|20\d{2})(?![\d'’]|s\b)/;
const NOT_A_SOURCE =
  /\b(?:general|common|background|personal|prior|own|my|world|historical) knowledge\b|\bfrom memory\b|\b(?:well|widely|commonly)[- ]known\b|\btraining data\b|\bcommon sense\b|^\s*(?:n\/?a|none|unknown|various|misc(?:ellaneous)?|internet|the internet|web|the web|online|google|wikipedia|research|notes?|sources?|books?)\s*\.?\s*$/i;

/** Whether `entry` is a source a reader can follow: a URL, a DOI/ISBN, or a citation naming a work and its year. */
export function isSource(entry: string): boolean {
  const text = entry.trim();
  if (text === "" || NOT_A_SOURCE.test(text)) return false;
  if (URL_SOURCE.test(text) || DOI_OR_ISBN.test(text)) return true;
  if (!YEAR.test(text)) return false;
  // A year alone is not a citation: it needs words naming the work (and usually its author) too.
  const words = text.replace(YEAR, " ").split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w));
  return words.length >= 1 && text.replace(/[^\p{L}]/gu, "").length >= 4;
}

/** `research/<slug>.md` content: title, retrieval date, the note, then the sources. */
export function renderResearchNote(input: SaveResearchInput, retrieved: string): string {
  const sources = input.sources.map((s) => `- ${s.trim()}`).join("\n");
  return `# ${input.title.trim()}\n\nRetrieved: ${retrieved}\n\n${input.note.trim()}\n\n## Sources\n\n${sources}\n`;
}

export function saveResearch(
  session: PlanSession,
  input: SaveResearchInput,
  opts: SaveResearchOptions = {},
): SaveResearchResult {
  const slug = slugify(input.title);
  if (!slug) return { ok: false, notice: "pablo: save_research: title is empty" };
  if (!input.note.trim()) return { ok: false, notice: "pablo: save_research: note is empty" };
  const sources = input.sources.map((s) => s.trim()).filter(Boolean);
  if (sources.length === 0) {
    return { ok: false, notice: `pablo: save_research: a note needs at least one source; ${SOURCE_RULE}` };
  }
  const bad = sources.filter((s) => !isSource(s));
  if (bad.length > 0) {
    const named = bad.map((s) => `"${s.length > 80 ? `${s.slice(0, 77)}...` : s}"`).join(", ");
    return { ok: false, notice: `pablo: save_research: ${bad.length === 1 ? "this is not a source" : "these are not sources"}: ${named}; ${SOURCE_RULE}. Nothing was saved.` };
  }

  const retrieved = opts.retrieved ?? new Date().toISOString().slice(0, 10);
  const dir = (opts.dir ?? "").replace(/\/+$/, "");
  if (dir && (dir.startsWith("/") || dir.split("/").includes(".."))) {
    return { ok: false, notice: "pablo: save_research: dir must be a clean relative path" };
  }
  const prefix = dir ? `${dir}/` : "";
  const title = input.title.replace(/\s+/g, " ").trim();

  // Never silently replace an earlier note (on main or earlier in this session): suffix the slug.
  const roots = [session.repo, ...(session.worktree ? [session.worktree] : [])];
  let name = slug;
  for (let n = 2; roots.some((r) => existsSync(join(r, `${prefix}research/${name}.md`))); n++) {
    name = `${slug}-${n}`;
  }
  const path = `${prefix}research/${name}.md`;

  const written: BranchResult = planWrite(session, {
    path,
    content: renderResearchNote({ ...input, title, sources }, retrieved),
    message: `research: ${title}`,
  });
  return written.ok ? { ok: true, path, ...(written.sha ? { sha: written.sha } : {}) } : written;
}
