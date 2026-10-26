/**
 * `research save` and `fact record` (AGT-2106, pm project `pablo-platform`, D-9): the harness's `save_research` and
 * `record_fact` tools as CLI verbs and MCP tools, so Claude Code, Codex or pi driving pablo can keep research and
 * facts too. These are the same writers the harness tools call (`saveResearch`, `recordFact`); this module only
 * resolves the work and starts a `plan/` branch for the write, as `promote` does. Every write is staged for the
 * author's review, never applied to main. `research distill` (AGT-2109, `distill_facts`) joins them: research
 * notes become `facts/period.md` (`distill.ts`), on a `plan/` branch the same way.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Adapter,
  createProviders,
  EndpointHung,
  loadConfig,
  ProviderConfigError,
  ProviderResponseError,
} from "@openthink/pablo-core";
import { repoRoot } from "./branch";
import {
  checkFacts,
  completeText,
  distillPrompt,
  NAMES_FILE,
  PERIOD_FACTS_FILE,
  parseDistillAnswer,
  parseNameMap,
  readBibleText,
  readResearchNotes,
  RESEARCH_INTENT,
  renderPeriodFacts,
} from "./distill";
import { readMarker, realNamesOf } from "./marker";
import { type PlanSession, planWrite, startPlanSession } from "./plan";
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

/** What `distillFactsInProject` needs beyond the project: the research agent, injected in tests. */
export interface DistillDeps {
  /** The adapter the `research` intent uses; left `undefined`, the routed provider is built from the config. */
  readonly researcher?: Adapter | undefined;
}

/**
 * `distill_facts` over a project (AGT-2109, D-10): the research agent distils `research/` into short, sourced
 * period facts, pablo checks every row (a note that exists, a short fact, a story date) and, on a
 * `realNames: false` work, swaps research names for their bible counterparts, then writes `facts/period.md` on a
 * new `plan/` branch for the author to review.
 */
export async function distillFactsInProject(projectPath: string, env: NodeJS.ProcessEnv, deps: DistillDeps = {}): Promise<VerbResult> {
  const refuse = (message: string, extra: Record<string, unknown> = {}, code = REFUSED): VerbResult => ({
    body: { ok: false, code, message, ...extra },
    exitCode: code,
  });
  const marker = readMarker(projectPath);
  if (!marker.ok) return refuse(marker.message);
  const realNames = realNamesOf(marker.marker);

  const notes = readResearchNotes(projectPath);
  if (notes.length === 0) return refuse("pablo: research distill: research/ has no notes to distill (keep findings with `pablo research save` first)");
  const nameMap = parseNameMap(readIfPresent(join(projectPath, NAMES_FILE)) ?? "");
  const brief = readIfPresent(join(projectPath, "bible", "period.md"));

  let adapter: Adapter;
  try {
    adapter = deps.researcher ?? createProviders(loadConfig({ env, projectDir: projectPath })).adapterFor(RESEARCH_INTENT);
  } catch (error) {
    if (error instanceof ProviderConfigError) return refuse(error.message);
    throw error;
  }

  let answer: string;
  try {
    answer = await completeText(adapter, distillPrompt(notes, { realNames, ...(brief ? { brief } : {}) }));
  } catch (error) {
    if (error instanceof EndpointHung || error instanceof ProviderResponseError) return refuse(error.message, {}, 1);
    if (error instanceof ProviderConfigError) return refuse(error.message);
    throw error;
  }
  const proposed = parseDistillAnswer(answer);
  if (proposed === undefined) return refuse(`pablo: research distill: the research agent (${adapter.id}) did not answer with the facts JSON asked for`, {}, 1);

  const checked = checkFacts(proposed, {
    noteIds: new Set(notes.map((n) => n.id)),
    realNames,
    nameMap,
    bibleText: readBibleText(projectPath),
  });
  if (!checked.ok) {
    return refuse(
      `pablo: research distill: this work sets realNames: false, and these research names have no bible counterpart: ${checked.names.join(", ")}. ` +
        `Map each to the book's invented name in ${NAMES_FILE} (| Research name | Bible name |; the bible name must appear in bible/), then distill again.`,
      { names: checked.names },
    );
  }
  if (checked.facts.length === 0) {
    return refuse("pablo: research distill: no fact survived the checks; nothing written", { rejected: checked.rejected });
  }

  const planned = planSessionFor(projectPath, env);
  if (!planned.ok) return planned.result;
  const path = `${planned.dir ? `${planned.dir}/` : ""}${PERIOD_FACTS_FILE}`;
  const written = planWrite(planned.session, {
    path,
    content: renderPeriodFacts(checked.facts),
    message: `research: distill ${checked.facts.length} period fact${checked.facts.length === 1 ? "" : "s"}`,
  });
  if (!written.ok) return refuse(written.notice, {}, 1);
  return {
    body: {
      ok: true,
      path,
      branch: planned.session.branch,
      ...(written.sha ? { sha: written.sha } : {}),
      facts: checked.facts.length,
      rejected: checked.rejected,
      ...(realNames ? {} : { swapped: checked.swapped }),
      provider: adapter.id,
      model: adapter.model,
    },
    exitCode: 0,
  };
}

function readIfPresent(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}
