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
    return { ok: false, notice: "pablo: save_research: a note needs at least one source" };
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
