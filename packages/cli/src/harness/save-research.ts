/**
 * The harness's `save_research(title, note, sources)` tool (AGT-1559): keeps a
 * finding with its sources and retrieval date as `research/<slug>.md` on the
 * session's plan branch. Built around the session's `PlanSession`, so like
 * `ask_author` it is not a `VERBS` entry; a session with no plan session has
 * no `save_research` tool. The model never sees a path argument: the note
 * lands under the work's own `research/`. The write is `saveResearch`
 * (`../research.ts`); the web fetching that precedes it is the model's own
 * WebSearch / WebFetch.
 */

import { z } from "zod";
import type { PlanSession } from "../plan";
import { saveResearch } from "../research";
import type { McpToolSpec } from "../verbs";

const ARGS = z.object({
  title: z.string().describe("What the note is about, e.g. 'Grape prices, 1919'. Becomes the file name."),
  note: z.string().describe("The finding, in your own words: the checkable facts and what they mean for the story."),
  sources: z.array(z.string()).describe("Where each fact came from: URLs or full citations. At least one."),
});

export const SAVE_RESEARCH_TOOL = "save_research";

/** `dir` is the work's directory relative to the repo root ("" when the work is the repo). */
export function saveResearchTool(session: PlanSession, dir = ""): McpToolSpec {
  return {
    name: SAVE_RESEARCH_TOOL,
    description:
      "Save a research finding with its sources to the work's research/ notes, on this session's plan branch. Records the retrieval date. You may read these notes later; the local writer never sees them.",
    args: ARGS,
    async run(raw) {
      const args = ARGS.parse(raw);
      const result = saveResearch(session, args, dir ? { dir } : {});
      if (!result.ok) return { body: { ok: false, code: 2, message: result.notice }, exitCode: 2 };
      return { body: { ok: true, path: result.path, branch: session.branch }, exitCode: 0 };
    },
  };
}
