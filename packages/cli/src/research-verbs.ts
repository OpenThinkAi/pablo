/**
 * `research save` and `fact record` (AGT-2106, pm project `pablo-platform`, D-9): the harness's `save_research` and
 * `record_fact` tools as CLI verbs and MCP tools, so Claude Code, Codex or pi driving pablo can keep research and
 * facts too. These are the same writers the harness tools call (`saveResearch`, `recordFact`); this module only
 * resolves the work and starts a `plan/` branch for the write, as `promote` does. Every write is staged for the
 * author's review, never applied to main. `research distill` (AGT-2109, `distill_facts`) joins them: research
 * notes become `facts/period.md` (`distill.ts`), on a `plan/` branch the same way. `research plan|waive|link`
 * (AGT-2111) keep the research checklist (`research-checklist.ts`), each write on a `plan/` branch too.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Adapter,
  createProviders,
  EndpointHung,
  loadConfig,
  ProviderConfigError,
  PERIOD_FACTS_FILE,
  ProviderResponseError,
} from "@openthink/pablo-core";
import { repoRoot } from "./branch";
import {
  checkFacts,
  completeText,
  distillPrompt,
  NAMES_FILE,
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
import { checkSaveItems, type ItemSelector, linkItemInProject, linkSavedNote, type PlanDeps, planChecklistInProject, waiveItemInProject } from "./research-checklist";
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

/**
 * `save_research` over a project: `research/<slug>.md` on a new `plan/` branch. With `items` (AGT-2111, `--item N`)
 * the note also joins those research checklist items' Sources on the same branch; an unknown item refuses before
 * anything is written.
 */
export function saveResearchInProject(
  projectPath: string,
  input: SaveResearchInput,
  env: NodeJS.ProcessEnv,
  items: readonly (string | number)[] = [],
): VerbResult {
  const checked = checkSaveItems(projectPath, items);
  if (!checked.ok) return checked.result;
  const planned = planSessionFor(projectPath, env);
  if (!planned.ok) return planned.result;
  const result = saveResearch(planned.session, input, planned.dir ? { dir: planned.dir } : {});
  if (!result.ok) return { body: { ok: false, code: REFUSED, message: result.notice }, exitCode: REFUSED };
  const base = { ok: true, path: result.path, branch: planned.session.branch, ...(result.sha ? { sha: result.sha } : {}) };
  if (checked.numbers.length === 0) return { body: base, exitCode: 0 };
  const linked = linkSavedNote(projectPath, planned.session, planned.dir, result.path, checked.numbers);
  if (!linked.ok) {
    const message = `${linked.notice} (the note was kept at ${result.path} on ${planned.session.branch}; once it is merged, close the item with \`pablo research link\`)`;
    return { body: { ok: false, code: 1, message, path: result.path, branch: planned.session.branch }, exitCode: 1 };
  }
  return { body: { ...base, note: linked.id, items: linked.items, open: linked.open }, exitCode: 0 };
}

/** `research plan` (AGT-2111): the research checklist from the period brief or thesis, on a new `plan/` branch. */
export function planChecklist(projectPath: string, env: NodeJS.ProcessEnv, deps: PlanDeps = {}): Promise<VerbResult> {
  return planChecklistInProject(projectPath, env, (p) => planSessionFor(p, env), deps);
}

/** `research waive <#,#,a-b> "<reason>"` (AGT-2111; several items on one branch, AGT-2186). */
export function waiveChecklistItem(projectPath: string, item: ItemSelector, reason: string | undefined, env: NodeJS.ProcessEnv): VerbResult {
  return waiveItemInProject(projectPath, item, reason, (p) => planSessionFor(p, env));
}

/** `research link <#,#,a-b> <note>` (AGT-2111; several items on one branch, AGT-2186). */
export function linkChecklistItem(projectPath: string, item: ItemSelector, note: string | undefined, env: NodeJS.ProcessEnv): VerbResult {
  return linkItemInProject(projectPath, item, note, (p) => planSessionFor(p, env));
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
  /** Where the one "asking ..." line goes while the agent works. */
  readonly stderr?: { write(text: string): unknown } | undefined;
}

/**
 * `distill_facts` over a project (AGT-2109, D-10): the research agent distils `research/` into short, sourced
 * period facts, pablo checks every row (a note that exists, a short fact, a story date) and, on a
 * `realNames: false` work, swaps research names for their bible counterparts, then writes `facts/period.md` on a
 * new `plan/` branch for the author to review.
 */
export async function distillFactsInProject(projectPath: string, env: NodeJS.ProcessEnv, deps: DistillDeps = {}): Promise<VerbResult> {
  const refuse = (message: string, extra: Record<string, unknown> = {}): VerbResult => ({
    body: { ok: false, code: REFUSED, message, ...extra },
    exitCode: REFUSED,
  });
  const fail = (message: string): VerbResult => ({ body: { ok: false, code: 1, message }, exitCode: 1 });
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

  deps.stderr?.write(`pablo: research distill: asking ${adapter.id} (${adapter.model}) about ${notes.length} research note${notes.length === 1 ? "" : "s"}\n`);
  let answer: string;
  try {
    answer = await completeText(adapter, distillPrompt(notes, { realNames, ...(brief ? { brief } : {}) }));
  } catch (error) {
    if (error instanceof EndpointHung || error instanceof ProviderResponseError) return fail(error.message);
    if (error instanceof ProviderConfigError) return refuse(error.message);
    throw error;
  }
  const proposed = parseDistillAnswer(answer);
  if (proposed === undefined) {
    return fail(`pablo: research distill: the research agent (${adapter.id}) did not answer with the facts JSON asked for; run it again, or route the research intent to another provider`);
  }

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
  if (!written.ok) return fail(written.notice);
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
