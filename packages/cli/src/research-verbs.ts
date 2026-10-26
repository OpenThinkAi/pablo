/**
 * `research save` and `fact record` (AGT-2106, pm project `pablo-platform`, D-9): the harness's `save_research` and
 * `record_fact` tools as CLI verbs and MCP tools, so Claude Code, Codex or pi driving pablo can keep research and
 * facts too. These are the same writers the harness tools call (`saveResearch`, `recordFact`); this module only
 * resolves the work and starts a `plan/` branch for the write, as `promote` does. Every write is staged for the
 * author's review, never applied to main.
 */

import { repoRoot } from "./branch";
import { readMarker } from "./marker";
import { type PlanSession, startPlanSession } from "./plan";
import { type RecordFactArgs, recordFact } from "./record-fact";
import { saveResearch, type SaveResearchInput } from "./research";
import type { VerbResult } from "./verbs";

const REFUSED = 2;

/** The plan session and the work's directory relative to the repo root, or a refusal result. */
function planSessionFor(
  projectPath: string,
  env: NodeJS.ProcessEnv,
): { ok: true; session: PlanSession; dir: string } | { ok: false; result: VerbResult } {
  const refuse = (message: string) => ({ ok: false as const, result: { body: { ok: false, code: REFUSED, message }, exitCode: REFUSED } });
  const repo = repoRoot(projectPath);
  if (repo === undefined) return refuse(`pablo: ${projectPath} is not inside a git repository`);
  const marker = readMarker(projectPath);
  if (!marker.ok) return refuse(marker.message);
  const dir = projectPath.slice(repo.length).replace(/^[\\/]+/, "").split("\\").join("/");
  return { ok: true, session: startPlanSession(repo, marker.marker.slug, { env }), dir };
}

/** `save_research` over a project: `research/<slug>.md` on a new `plan/` branch. */
export function saveResearchInProject(projectPath: string, input: SaveResearchInput, env: NodeJS.ProcessEnv): VerbResult {
  const planned = planSessionFor(projectPath, env);
  if (!planned.ok) return planned.result;
  const result = saveResearch(planned.session, input, planned.dir ? { dir: planned.dir } : {});
  if (!result.ok) return { body: { ok: false, code: REFUSED, message: result.notice }, exitCode: REFUSED };
  return { body: { ok: true, path: result.path, branch: planned.session.branch, ...(result.sha ? { sha: result.sha } : {}) }, exitCode: 0 };
}

/** `record_fact` over a project: one tagged fact on a new `plan/` branch. */
export function recordFactInProject(projectPath: string, args: RecordFactArgs, env: NodeJS.ProcessEnv): VerbResult {
  const planned = planSessionFor(projectPath, env);
  if (!planned.ok) return planned.result;
  const result = recordFact(planned.session, projectPath, args);
  if (!result.ok) return { body: { ok: false, code: REFUSED, message: result.notice }, exitCode: REFUSED };
  return { body: result, exitCode: 0 };
}
