/**
 * The radio output's chain end to end (AGT-1700, pm project `pablo-casting`, C22): an episode's script
 * from the core, then `pablo cast --auto --design` (a voice designed on demand for a role the library has
 * no fit for), `pablo perform --stream` (performed, mixed from the same timeline and published to the
 * listening directory the moment it is mixed) and `pablo publish --output radio --target stream`, with the
 * writing of episode N+1 overlapping the performing of episode N (`progressive.ts`'s two queues).
 *
 * Two callers, one chain:
 *
 *  - `pablo story "<prompt>" --output radio` (`story.ts`), after the core: on demand through
 *    `runRadioChain`, or stage by stage under `--review` through the single steps here;
 *  - `pablo perform --output radio --all` on any work with a radio output (`pablo output add radio` on a
 *    work whose core is at `beats`): every episode not yet written is written and accepted, then
 *    cast, performed and published, the way the Valley's Shadow show is made from the novel's work.
 *
 * Everything reaches the Python side through the casting verbs (`casting-verbs.ts`) over the `CastingDeps`
 * the caller hands in, so nothing here provisions anything until an episode is actually cast, and a run
 * with no radio output never loads this module (both callers import it on first use). Each step is
 * resumable from disk: the stage machine (`outputs/radio/state.ts`) says what an episode still needs.
 */

import { readFileSync } from "node:fs";
import { createProviders, loadConfig } from "@openthink/pablo-core";
import type { Adapter, Intent } from "@openthink/pablo-core";
import type { CastingDeps } from "./radio";
import { castingVerbs } from "./casting-verbs";
import { readCoreState } from "./core/machine";
import { mergeDraft } from "./novel/merge";
import { radioUnitFiles } from "./outputs/radio/plan";
import { scriptRoles } from "./outputs/radio/script";
import { castFile, episodeState } from "./outputs/radio/state";
import { RADIO_ID } from "./outputs/radio/units";
import { outputDefinition } from "./outputs/registry";
import { runProgressive } from "./progressive";
import type { ProgressiveReport, StepOutcome } from "./progressive";
import { publishStream } from "./radio-stream";
import type { PublishedChapter } from "./radio-stream";
import { captureConsoleLog, withWriteLock } from "./verbs";
import type { Verb, VerbContext, VerbResult } from "./verbs";
import { runWrite } from "./write";

/** Where the chain runs: the work, and the machine and context its casting verbs run on. */
export interface RadioChain {
  readonly vault: string;
  readonly work: string;
  /** The work's slug: the casting verbs address it with `project`. */
  readonly slug: string;
  readonly ctx: VerbContext;
  /** The Python side's machine (a fake in tests). */
  readonly casting: CastingDeps;
  /** One progress line (`pablo story: radio: ...`). */
  readonly progress?: (line: string) => void;
  readonly now?: () => Date;
}

/** What drafting a unit needs beyond the chain: the writer and the extractor the merge rituals run (fakes in tests). */
export interface WriteDeps {
  readonly writer?: Adapter | undefined;
  readonly extractor?: Adapter | undefined;
  readonly now?: (() => Date) | undefined;
}

const outcome = (result: VerbResult): StepOutcome => ({ ok: result.exitCode === 0, exitCode: result.exitCode, body: result.body });

/** The intent continuity extraction routes under, as `merge` routes it. */
const CONTINUITY_INTENT: Intent = { name: "continuity", kind: "extraction" };

/** The extractor the merge rituals run: the given one, else the routed extraction provider (undefined when none is configured). */
export function routedExtractor(env: Record<string, string | undefined>, given?: Adapter): Adapter | undefined {
  if (given !== undefined) return given;
  try {
    const providers = createProviders(loadConfig({ env }));
    return providers.adapter(providers.route(CONTINUITY_INTENT));
  } catch {
    return undefined;
  }
}

/**
 * Drafts one unit of `output` through `write` (preconditions, pack, writer, draft branch, receipt naming
 * output and unit) and returns its branch and path, or the refusal `write` gave.
 */
export async function writeUnit(
  vault: string,
  work: string,
  output: string,
  unit: number,
  options: { readonly env: Record<string, string | undefined>; readonly writer?: Adapter | undefined; readonly now?: (() => Date) | undefined; readonly words?: number | undefined },
): Promise<{ ok: true; branch: string; path: string } | { ok: false; result: VerbResult }> {
  const { exitCode, text } = await withWriteLock(() =>
    captureConsoleLog(() =>
      runWrite(
        {
          chapter: undefined,
          output,
          unit: String(unit),
          words: options.words === undefined ? undefined : String(options.words),
          scenes: undefined,
          dryRun: false,
          json: true,
          force: false,
        },
        vault,
        work,
        // The caller's own progress line is the run's progress: `write`'s token-by-token lines would bury it.
        { stderr: { write: () => {} }, env: options.env, ...(options.writer ? { adapter: options.writer } : {}), ...(options.now ? { now: options.now } : {}) },
      ),
    ),
  );
  let body: Record<string, unknown> = { ok: exitCode === 0 };
  try {
    if (text !== "") body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { ok: false, code: 1, message: text };
  }
  if (exitCode !== 0 || body["ok"] !== true) {
    return { ok: false, result: { body: { ...body, output, unit }, exitCode: exitCode === 0 ? 1 : exitCode } };
  }
  return { ok: true, branch: body["branch"] as string, path: body["path"] as string };
}

/** Writes episode `unit`'s script and accepts it (merge with the after-write rituals), as an on-demand run does. */
export async function writeAndAcceptEpisode(chain: RadioChain, unit: number, deps: WriteDeps): Promise<StepOutcome & { readonly branch?: string; readonly path?: string; readonly merged?: string }> {
  const drafted = await writeUnit(chain.vault, chain.work, RADIO_ID, unit, { env: chain.ctx.env, writer: deps.writer, now: deps.now });
  if (!drafted.ok) return outcome(drafted.result);
  const merged = await mergeDraft(chain.work, drafted.branch, {
    slug: chain.slug,
    env: chain.ctx.env,
    extractor: routedExtractor(chain.ctx.env, deps.extractor ?? deps.writer),
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (!merged.ok) return { ok: false, exitCode: 1, body: { ok: false, code: 1, message: merged.notice, output: RADIO_ID, unit, branch: drafted.branch } };
  return { ok: true, exitCode: 0, body: { ok: true, output: RADIO_ID, unit, branch: drafted.branch, path: drafted.path, merged: merged.sha }, branch: drafted.branch, path: drafted.path, merged: merged.sha };
}

function verbNamed(chain: RadioChain, name: string): Verb {
  return castingVerbs(() => chain.casting).find((v) => v.name === name) as Verb;
}

/** Runs one casting verb on the chain's machine, its arguments through the verb's own schema (defaults included). */
async function casting(chain: RadioChain, name: string, args: Record<string, unknown>): Promise<VerbResult> {
  const verb = verbNamed(chain, name);
  const parsed = verb.args.safeParse(args);
  if (!parsed.success) return { body: { ok: false, code: 2, message: `pablo: ${name}: ${parsed.error.message}` }, exitCode: 2 };
  return verb.run(parsed.data as never, { ...chain.ctx, casting: chain.casting });
}

/** Episode `unit`'s bindings as `cast.json` holds them: each role the script names, with its voice, how it was bound and whether it is marked for review. */
export function episodeBindings(work: string, unit: number): { role: string; voice?: string; by?: string; score?: number; review?: boolean }[] {
  let roles: Record<string, Record<string, unknown>> = {};
  try {
    const body = JSON.parse(readFileSync(castFile(work), "utf8")) as { roles?: Record<string, Record<string, unknown>> };
    roles = body.roles ?? {};
  } catch {
    // No cast.json yet: nothing is bound.
  }
  const state = episodeState(work, unit);
  const script = radioUnitFiles(work).get(unit);
  const names = script === undefined ? [] : scriptRoleNames(script);
  return (names.length > 0 ? names : state.unbound).map((role) => {
    const row = roles[role];
    return {
      role,
      ...(typeof row?.["slug"] === "string" ? { voice: row["slug"] } : {}),
      ...(typeof row?.["by"] === "string" ? { by: row["by"] } : {}),
      ...(typeof row?.["score"] === "number" ? { score: row["score"] } : {}),
      ...(row?.["review"] === true ? { review: true } : {}),
    };
  });
}

/** The role names the script carries, read exactly as `script.py` reads them. */
function scriptRoleNames(path: string): string[] {
  try {
    return scriptRoles(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

/**
 * The cast stage for one episode: `cast --auto --design --episode N` binds every unbound role (matched from
 * the library, or a voice designed on demand). A role the Python side cannot cast is its refusal, by name.
 */
export async function castEpisode(chain: RadioChain, unit: number): Promise<VerbResult> {
  const before = episodeState(chain.work, unit);
  if (before.stage !== "cast") return { body: { ok: true, output: RADIO_ID, unit, bound: [], note: "every role is already cast" }, exitCode: 0 };
  chain.progress?.(`radio: casting episode ${unit} (${before.unbound.join(", ")})`);
  const result = await casting(chain, "cast", { project: chain.slug, auto: true, design: true, episode: unit });
  if (result.exitCode !== 0) return result;
  const after = episodeState(chain.work, unit);
  if (after.stage === "cast") {
    return {
      body: {
        ...(result.body as object),
        ok: false,
        code: 2,
        message: `pablo: radio episode ${unit} still has roles with no voice after cast --auto --design (${after.unbound.join(", ")}); nothing was performed`,
        output: RADIO_ID,
        unit,
        stage: "cast",
        missing: after.unbound.map((role) => `role ${role} is not cast`),
      },
      exitCode: 2,
    };
  }
  return result;
}

/**
 * The render stages for one episode. `stream`: `perform --stream` performs, mixes and publishes it to the
 * listening directory as it finishes (on demand). Otherwise `perform` then `mix`, with nothing published
 * (`--review`: the review player gates the publish). A stage already done is skipped.
 */
export async function renderEpisode(chain: RadioChain, unit: number, stream: boolean): Promise<VerbResult> {
  let state = episodeState(chain.work, unit);
  let last: VerbResult = { body: { ok: true, output: RADIO_ID, unit }, exitCode: 0 };
  if (state.stage === "perform") {
    chain.progress?.(`radio: performing episode ${unit}${stream ? " (streaming)" : ""}`);
    last = await casting(chain, "perform", { project: chain.slug, episode: unit, stream });
    if (last.exitCode !== 0) return last;
    state = episodeState(chain.work, unit);
  }
  if (state.stage === "mix") {
    chain.progress?.(`radio: mixing episode ${unit}`);
    last = await casting(chain, "mix", { project: chain.slug, episode: unit });
    if (last.exitCode !== 0) return last;
  }
  return last;
}

/** `publish --output radio --target stream` for one episode: its newest mixed version to the listening directory. */
export function publishEpisode(chain: RadioChain, unit: number): VerbResult {
  const published = publishStream(chain.work, { episode: unit, ...(chain.now ? { now: chain.now } : {}) });
  if (!published.ok) return { body: { ...published, output: RADIO_ID, unit }, exitCode: published.code };
  chain.progress?.(`radio: episode ${unit} published (${published.where})`);
  return { body: { ok: true, output: RADIO_ID, unit, where: published.where, chapter: published.chapters.find((c) => c.episode === unit) }, exitCode: 0 };
}

/** One episode after its script, on demand: cast, perform (streamed, mixed), published. */
export async function makeEpisode(chain: RadioChain, unit: number): Promise<VerbResult> {
  if (episodeState(chain.work, unit).stage === "script") {
    return {
      body: { ok: false, code: 2, message: `pablo: radio episode ${unit} has no script (pablo write --output radio --unit ${unit})`, output: RADIO_ID, unit, stage: "script" },
      exitCode: 2,
    };
  }
  const cast = await castEpisode(chain, unit);
  if (cast.exitCode !== 0) return cast;
  const rendered = await renderEpisode(chain, unit, true);
  if (rendered.exitCode !== 0) return rendered;
  const published = publishEpisode(chain, unit);
  if (published.exitCode !== 0) return published;
  const state = episodeState(chain.work, unit);
  return {
    body: { ok: true, output: RADIO_ID, unit, version: state.version ?? null, audio: state.audio ?? null, openFlags: state.openFlags, published: published.body },
    exitCode: 0,
  };
}

/** The radio output's episodes, ascending: every plan row and every episode file. */
export function radioUnits(work: string): number[] {
  const def = outputDefinition(RADIO_ID);
  if (def === undefined) return [];
  return def.report(work, readCoreState(work)).units.map((u) => u.unit).sort((a, b) => a - b);
}

/** What the on-demand chain did. */
export interface RadioChainReport {
  readonly report: ProgressiveReport;
  /** Every chapter the listening directory holds after the run. */
  readonly published: readonly PublishedChapter[];
  /** The listening directory, when anything is published. */
  readonly where?: string;
}

/**
 * The on-demand chain over `units`: the writer queue writes (and accepts) each episode with no script, the
 * engine queue makes each episode as soon as its script exists, so episode N+1 is written while episode N
 * is cast, performed and published. A step that fails or is refused stops both queues; whatever was
 * already published stays where it is. `onWritten` and `onMade` let the caller record progress.
 */
export async function runRadioChain(
  chain: RadioChain,
  units: readonly number[],
  hooks: {
    readonly write: (unit: number) => Promise<StepOutcome>;
    readonly onMade?: (unit: number, result: VerbResult) => void;
  },
): Promise<RadioChainReport> {
  const report = await runProgressive({
    units,
    write: async (unit) => (radioUnitFiles(chain.work).has(unit) ? { ok: true, exitCode: 0, body: { ok: true, unit, written: "already" } } : hooks.write(unit)),
    perform: async (unit) => {
      const made = await makeEpisode(chain, unit);
      if (made.exitCode === 0) hooks.onMade?.(unit, made);
      return outcome(made);
    },
  });
  return { report, ...publishEpisodeIndex(chain) };
}

/** `publish --output radio --target stream` over every mixed episode: the listening directory's index, or nothing when none is mixed. */
export function publishEpisodeIndex(chain: RadioChain): { readonly published: readonly PublishedChapter[]; readonly where?: string } {
  const index = publishStream(chain.work, chain.now ? { now: chain.now } : {});
  return index.ok ? { published: index.chapters, where: index.where } : { published: [] };
}
