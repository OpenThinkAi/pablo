/**
 * The harness's `save_research(title, note, sources)` tool (AGT-1559): keeps a
 * finding with its sources and retrieval date as `research/<slug>.md` on the
 * session's plan branch. Built around the session's `PlanSession`, so like
 * `ask_author` it is not a `VERBS` entry; it is attached through `planTools`
 * (`plan-tools.ts`) with propose and record_fact. The model never sees a path argument: the note
 * lands under the work's own `research/`. The write is `saveResearch`
 * (`../research.ts`); the web fetching that precedes it is the model's own
 * WebSearch / WebFetch.
 */

import { join, relative } from "node:path";
import { z } from "zod";
import type { PlanSession } from "../plan";
import { saveResearch } from "../research";
import { checkSaveItems, linkItemInProject, linkSavedNote, waiveItemInProject } from "../research-checklist";
import type { McpToolSpec, VerbResult } from "../verbs";

const ARGS = z.object({
  title: z.string().describe("What the note is about, e.g. 'Grape prices, 1919'. Becomes the file name."),
  note: z.string().describe("The finding, in your own words: the checkable facts and what they mean for the story."),
  sources: z
    .array(z.string())
    .describe("Where each fact came from: the URL web_fetch returned (with its retrievedAt date), a DOI or ISBN, or a citation naming the work and its year. At least one; general knowledge or memory is refused."),
  items: z.array(z.number().int().positive()).optional().describe("The research checklist item numbers this note sources (research/checklist.md)."),
});

export const SAVE_RESEARCH_TOOL = "save_research";

/**
 * The work as this session sees it (AGT-2184): the plan worktree's copy once the session has written, else the vault's.
 * The checklist tools read the checklist and the notes from here, so a second waive or save in one session builds on
 * the first instead of starting again from `main` and dropping it.
 */
export function sessionWork(session: PlanSession, workPath: string): string {
  return session.worktree === undefined ? workPath : join(session.worktree, relative(session.repo, workPath));
}

function workDir(session: PlanSession, workPath: string): string {
  return relative(session.repo, workPath).split("\\").join("/");
}

/** `workPath` is the work's directory inside the session's repo; notes land under its `research/`. */
export function saveResearchTool(session: PlanSession, workPath: string): McpToolSpec {
  const dir = workDir(session, workPath);
  return {
    name: SAVE_RESEARCH_TOOL,
    description:
      "Save a research finding with its sources to the work's research/ notes, on this session's plan branch. Records the retrieval date. With items, the note also sources those research checklist items (research/checklist.md) on the same branch. You may read these notes later; the writer model never sees them.",
    args: ARGS,
    async run(raw) {
      const args = ARGS.parse(raw);
      // An unknown item refuses before anything is written (AGT-2184).
      const checked = checkSaveItems(sessionWork(session, workPath), args.items ?? []);
      if (!checked.ok) return checked.result;
      const result = saveResearch(session, { title: args.title, note: args.note, sources: args.sources }, dir ? { dir } : {});
      if (!result.ok) return { body: { ok: false, code: 2, message: result.notice }, exitCode: 2 };
      const base = { ok: true, path: result.path, branch: session.branch };
      if (checked.numbers.length === 0) return { body: base, exitCode: 0 };
      const linked = linkSavedNote(sessionWork(session, workPath), session, dir, result.path, checked.numbers);
      if (!linked.ok) return { body: { ok: false, code: 1, message: linked.notice, path: result.path, branch: session.branch }, exitCode: 1 };
      return { body: { ...base, note: linked.id, items: linked.items, open: linked.open }, exitCode: 0 };
    },
  };
}

// The same shape as the MCP tools (AGT-2186): `items` to close a batch, `item` for one.
const WAIVE_ARGS = z.object({
  items: z.array(z.number().int().positive()).optional().describe("The checklist item numbers to waive."),
  item: z.number().int().positive().optional().describe("One item number (the same as items: [n])."),
  reason: z.string().min(1).describe("Why the items need no research."),
});

const LINK_ARGS = z.object({
  items: z.array(z.number().int().positive()).optional().describe("The checklist item numbers the note sources."),
  item: z.number().int().positive().optional().describe("One item number (the same as items: [n])."),
  note: z.string().min(1).describe("The research note's id: its path under research/ without .md."),
});

const selected = (args: { items?: number[] | undefined; item?: number | undefined }): number[] => [...(args.items ?? []), ...(args.item === undefined ? [] : [args.item])];

/** The session's plan branch, as the checklist writers ask for it. */
function sessionFor(session: PlanSession, workPath: string) {
  return () => ({ ok: true as const, session, dir: workDir(session, workPath) });
}

/**
 * `waive_research_item` on this session's plan branch (AGT-2184): the MCP tool starts a branch per call, so a run
 * that waives several items would leave a branch each, every one rewriting the checklist from `main`.
 */
export function waiveResearchItemTool(session: PlanSession, workPath: string): McpToolSpec {
  return {
    name: "waive_research_item",
    description: "Waive research checklist items (research/checklist.md) with one reason, on this session's plan branch. A waived item no longer holds the research gate shut.",
    args: WAIVE_ARGS,
    async run(raw): Promise<VerbResult> {
      const args = WAIVE_ARGS.parse(raw);
      return waiveItemInProject(sessionWork(session, workPath), selected(args), args.reason, sessionFor(session, workPath));
    },
  };
}

/** `link_research_item` on this session's plan branch (AGT-2184), so a note saved earlier in the session can close an item. */
export function linkResearchItemTool(session: PlanSession, workPath: string): McpToolSpec {
  return {
    name: "link_research_item",
    description:
      "Mark research checklist items sourced by an existing research note that has a ## Sources entry (the note's id joins each item's Sources), on this session's plan branch. To save a new finding for an item, use save_research with items instead.",
    args: LINK_ARGS,
    async run(raw): Promise<VerbResult> {
      const args = LINK_ARGS.parse(raw);
      return linkItemInProject(sessionWork(session, workPath), selected(args), args.note, sessionFor(session, workPath));
    },
  };
}
