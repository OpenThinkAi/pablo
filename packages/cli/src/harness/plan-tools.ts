/**
 * Harness tools that act on the session's plan branch (AGT-1561): built per
 * session, because the `PlanSession` (the `plan/<date>-<id>` branch and its
 * worktree) is harness state, not a CLI verb's. They are `McpToolSpec`s like
 * every other tool, so the agent loop offers and checks them the same way,
 * but they never enter `VERBS`: `pablo mcp` has no session to write to.
 */

import { z } from "zod";
import type { PlanSession } from "../plan";
import { propose } from "../propose";
import { recordFact } from "../record-fact";
import { linkResearchItemTool, saveResearchTool, waiveResearchItemTool } from "./save-research";
import type { McpToolSpec, VerbResult } from "../verbs";

const REFUSED = 2;

const ProposeArgs = z.object({ stage: z.string(), content: z.string(), name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "name is lowercase-hyphen").optional() });

export function proposeTool(session: PlanSession, workPath: string): McpToolSpec {
  const tool: McpToolSpec<typeof ProposeArgs.shape> = {
    name: "propose",
    description:
      "Propose planning output for the author to accept in review mode: stage is premise, acts, beats, cast, places, timeline (bible/timeline.md whole: | Year | Real events | In the story | rows, which date the beats) or period (bible/period.md whole: a historical work's period brief, which its research checklist is derived from). acts and beats take table rows; cast also takes a name (lowercase-hyphen). Staged on this session's plan branch, not applied: the proposal changes nothing in the book until the author accepts the branch in review mode (the branch is merged then).",
    // stage is a plain string, not an enum, so an unknown stage is refused with pablo's own list of valid stages.
    args: ProposeArgs,
    async run(args): Promise<VerbResult> {
      const result = propose(session, workPath, {
        stage: args.stage,
        content: args.content,
        ...(args.name !== undefined ? { name: args.name } : {}),
      });
      return result.ok
        ? { body: result, exitCode: 0 }
        : { body: { ok: false, code: REFUSED, message: result.notice }, exitCode: REFUSED };
    },
  };
  // McpToolSpec<Shape> is not assignable to the default-shape McpToolSpec (run args are contravariant); zod validates the real shape at call time, so the erasure is safe.
  return tool as unknown as McpToolSpec;
}

const RecordFactArgs = z.object({
  fact: z.string(),
  // Path-shaped but model-controlled: recordFact resolves it to `continuity` or a bible .md file; this keeps traversal out at the schema too.
  where: z.string().regex(/^[a-z0-9][a-z0-9/_.-]*$/i).refine((w) => !w.includes(".."), "where must stay inside the work").optional(),
  kind: z.string(),
  source: z.string().optional(),
  heading: z.string().optional(),
  chapter: z.string().optional(),
  promote: z.boolean().optional(),
  established_by: z.string().regex(/^[a-z][a-z0-9-]*\/[a-z]{2}\d+$/).optional(),
});

export function recordFactTool(session: PlanSession, workPath: string): McpToolSpec {
  const tool: McpToolSpec<typeof RecordFactArgs.shape> = {
    name: "record_fact",
    description:
      "Record a fact on this session's plan branch: where is `continuity` or a bible file (`places`, `bible/places.md`); kind is researched (needs a source citation), invented or author. With promote true the fact goes to facts.md instead (the story core's facts every output honours; where is ignored) and needs established_by, the output and unit that established it (`novel/ch03`, `radio/ep05`). Staged on this session's plan branch, not applied to the book until the author accepts it in review mode.",
    args: RecordFactArgs,
    async run(args): Promise<VerbResult> {
      const result = recordFact(session, workPath, {
        fact: args.fact,
        where: args.where ?? "",
        kind: args.kind,
        ...(args.source !== undefined ? { source: args.source } : {}),
        ...(args.heading !== undefined ? { heading: args.heading } : {}),
        ...(args.chapter !== undefined ? { chapter: args.chapter } : {}),
        ...(args.promote === true ? { promote: true } : {}),
        ...(args.established_by !== undefined ? { establishedBy: args.established_by } : {}),
      });
      return result.ok
        ? { body: result, exitCode: 0 }
        : { body: { ok: false, code: REFUSED, message: result.notice }, exitCode: REFUSED };
    },
  };
  // McpToolSpec<Shape> is not assignable to the default-shape McpToolSpec (run args are contravariant); zod validates the real shape at call time, so the erasure is safe.
  return tool as unknown as McpToolSpec;
}

/** The plan-branch tools for one session: the research checklist's waive and link land on it too (AGT-2184). */
export function planTools(session: PlanSession, workPath: string): readonly McpToolSpec[] {
  return [
    proposeTool(session, workPath),
    recordFactTool(session, workPath),
    saveResearchTool(session, workPath),
    waiveResearchItemTool(session, workPath),
    linkResearchItemTool(session, workPath),
  ];
}
