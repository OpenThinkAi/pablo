/**
 * `casting-verbs.ts` (AGT-1679, pm project `pablo-casting`) — the voice
 * library's verbs, one `VERBS` entry each, so the CLI, `pablo mcp` and the
 * harness all reach them from the same zod shape and the same `run`:
 *
 * - `audition --role R --describe "..." [--designer qwen3|voxcpm2] [-n 6]`
 *   renders candidates of the shared audition passage into the library's
 *   `voices/<slug>/auditions/` (untracked), scored and with near duplicates
 *   marked. `--dry-run` only checks the casting side (AGT-1678).
 * - `cast --role R --candidate n [--recast]` freezes a candidate into the
 *   voice's card (`card.json`, `reference.flac`/`.txt`, `embedding.ecapa.npy`)
 *   and returns the card hash. There is no `--from-wav`: voices are synthetic
 *   only, and `cli.ts` refuses the flag by name.
 * - `cast --auto --project W [--episode N | --all]` (AGT-1698) auto-casts
 *   the work's described `CAST:` roles from the library (`matching.py`):
 *   `cast.json` gets `by: match`, the score, the runner-up and `review`;
 *   roles with no fit come back as `needsDesign`. With `--design` (AGT-1699,
 *   `design.py`) those roles get a voice designed on demand: auditioned
 *   unattended, screened, trialled through the engine and the gates, admitted
 *   with `admitted.by: auto` and bound `by: design`, or refused (exit 2) by
 *   name after one re-phrased retry. It provisions the `scorers` extra.
 * - `describe_voice --describe "..." [--gender f|m|x]` (AGT-1699) is the
 *   harness's tool for a description the `CAST:` mapper cannot normalise: the
 *   mapper's traits, the phrases left over and the traits vocabulary, so the
 *   harness can hand `cast --auto --design` its own `role-traits`.
 * - `voices list|show|retire` reads the library; `retire` marks a voice
 *   unmatchable without changing its card hash.
 * - `perform --project W --episode N [--engine chatterbox-turbo|dia]
 *   [--json-lines]` (AGT-1683) renders the episode through the decided engine
 *   with the gates, retakes and pace policy into takes and `v1.json`; it
 *   provisions the `scorers` extra, and with `--json-lines` relays each line's
 *   progress event to stdout as it lands (always on stderr). With `--stream`
 *   (AGT-1697) it is the progressive render: segments into the listening
 *   directory as the lines pass, the episode file mixed from the same
 *   timeline, then published there at once (`radio-stream.ts`); `--all`
 *   performs every unrendered episode in order through `progressive.ts`'s
 *   engine queue, each published as it finishes. `--output radio --all` (AGT-1700) is
 *   the radio output's whole chain (`radio-chain.ts`): episodes with no script are
 *   written from the core and accepted, then cast (`--auto --design`), performed
 *   with `--stream` and published, writing overlapping performing.
 * - `mix --project W --episode N [--version k]` (AGT-1684) turns a performed
 *   episode into `renders/epNN/epNN.v<k>.m4a`: the takes paced by the manifest,
 *   the script's cues from the content-addressed cue library, normalised and
 *   encoded, the `epNN.m4a` link moved and each line's start/end written into
 *   the manifest. It provisions the `mix` extra (Stable Audio Open).
 * - `fix --project W --episode N [--json-lines]` (AGT-1685) re-records only the
 *   episode's flagged lines (`flags.json`, with their reasons), writes the next
 *   manifest version through the "only flagged lines change" invariant, remixes
 *   it and moves the flags to `flags-done.json`. No open flags is a refusal. It
 *   provisions both the `scorers` and `mix` extras.
 *
 * `cast --auto`, `perform`, `mix` and `fix` also take `--output narrated --unit N` (AGT-2158, D-7): the narrated
 * output's readings, with their own casting state (`outputs/narrated/casting/`); `outputs/audio.ts` names the
 * output to the Python side through `PABLO_CASTING_OUTPUT`. `--stream` and `--all` stay radio's.
 *
 * Each `run` resolves what it can from `ctx` (the vault, for the library's
 * default `<vault>/casting`; the work, when `project` is given, for receipts)
 * and hands the rest to the Python side through `runCasting`, which
 * provisions it lazily on first use. All the casting logic (cards, hashes,
 * the library layout) lives in `packages/casting`; this file only builds argv.
 *
 * `castingVerbs(deps)` takes the machine as a parameter so `bun test` passes
 * a fake `CastingDeps` and never needs uv, Python or a model.
 */

import { resolve } from "node:path";
import { z } from "zod";
import { ensureProvisioned, MIX_EXTRA, realCastingDeps, runCasting, runPython, runPythonStreaming, SCORERS_EXTRA } from "./casting";
import type { CastingDeps } from "./casting";
import { readMarker } from "./marker";
import { AUDIO_OUTPUTS, audioEnv, isAudioOutput, unitNoun } from "./outputs/audio";
import type { AudioOutput } from "./outputs/audio";
import { episodeState, lastReceipt, radioStageCheck } from "./outputs/radio/state";
import type { RadioVerbStage } from "./outputs/radio/state";
import { RADIO_ID } from "./outputs/radio/units";
import { resolveOutput } from "./outputs/registry";
import { runProgressive } from "./progressive";
import { findVault, resolveProject } from "./project";
import { radioEpisodes } from "./radio";
import { isPerformed, publishStream } from "./radio-stream";
import type { Verb, VerbContext, VerbResult } from "./verbs";

type Env = Record<string, string | undefined>;

const projectField = z
  .string()
  .optional()
  .describe("Optional work slug: receipts for the model calls go under <work>/.pablo/casting/. The voice library is shared across works.");
const libraryField = z
  .string()
  .optional()
  .describe("The voice library root (default: the casting config's `library`, else <vault>/casting). Cards live under <library>/voices/<slug>/.");
const vaultField = z.string().optional().describe("The vault whose <vault>/casting is the library, when it is not the one found from the current directory.");
const roleField = z.string().describe('The role, as the script names it (e.g. "CORA"); its voice slug is the role lowercased.');
const slugField = z.string().optional().describe("The voice's slug in the library, when it should differ from the role's.");
const traitsField = z
  .string()
  .optional()
  .describe(
    'The traits block as JSON: gender (f|m|x, required for a card), age (child|teen|20s|30s|40s|50s|60s|70s), pitch (low|low-medium|medium|medium-high|high), energy (subdued|measured|lively|intense), warmth (warm|cool), register (dry|formal|folksy|theatrical|plain|gruff), era (period|modern), roles (["lead", ...]).',
  );

/** `--output radio --unit N` (AGT-1686): the radio output's addressing, the same as `write`'s; `--episode N` is its short spelling. */
const outputArg = z
  .string()
  .optional()
  .describe(
    'The performed output whose unit this is: "radio" (the default) or "narrated" (a reading of another output\'s prose, AGT-2158: its narrator, and character voices only when the reading gives them lines). With `unit`, the same as `episode`.',
  );
const unitArg = z.number().int().positive().optional().describe("The output's unit number (a radio episode, a narrated reading), with output; the same as `episode`.");

const AUDITION_ARGS = z.object({
  project: projectField,
  library: libraryField,
  vault: vaultField,
  role: roleField.optional(),
  describe: z.string().optional().describe("The voice in words, 15-40 words: gender, age, pitch, pace, manner (the designer's instruct)."),
  designer: z.enum(["qwen3", "voxcpm2"]).optional().describe("Which designer renders the candidates (default qwen3)."),
  language: z.enum(["en", "es"]).optional().describe("The audition passage's language (default en). A voice designed reading Spanish (with a Spanish description) keeps that accent when cloned reading English."),
  n: z.number().int().min(1).max(24).optional().describe("How many candidates (default 6)."),
  seed: z.number().int().nonnegative().optional().describe("The first candidate's seed; candidate k uses seed + k - 1 (default random)."),
  traits: traitsField,
  slug: slugField,
  "dry-run": z.boolean().optional().default(false).describe("Only check that the casting side is provisioned and runnable; no model is loaded."),
});

const CAST_ARGS = z.object({
  project: projectField,
  library: libraryField,
  vault: vaultField,
  role: roleField.optional(),
  candidate: z.number().int().positive().optional().describe("The audition candidate to freeze, as `audition` numbered it (required unless `auto`)."),
  auto: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Auto-cast the work's scripts instead (needs `project`): every unbound described role in `CAST:` is matched to the best distinct, non-retired library voice and pinned with by: match, its score and the runner-up; a middle-band match is marked review; roles with no fit or no distinct candidate come back as needsDesign. With output: narrated (and optionally unit), casts the narrated output's readings instead: the narrator, and any character a reading gives lines.",
    ),
  design: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "auto: design a voice for every role that needs one (6 candidates auditioned unattended, screened for naturalness, pitch and distinctness from the library, a 3-line trial through the engine scored by every gate); the best passing voice is admitted to the library (admitted.by: auto) and bound by: design. One retry with a re-phrased description; a second miss refuses naming the role. Loads models and uses the GPU.",
    ),
  "role-traits": z
    .string()
    .optional()
    .describe(
      'design: traits for roles whose CAST: description the mapper could not normalise (see describe_voice), as JSON mapping role to a traits block, e.g. {"RAMON": {"gender": "m", "age": "70s", "pitch": "high"}}.',
    ),
  episode: z.number().int().positive().optional().describe("auto: only the roles of episode N (default: every episode)."),
  output: outputArg,
  unit: unitArg,
  all: z.boolean().optional().default(false).describe("auto: every episode's roles (the default; not with `episode`)."),
  recast: z.boolean().optional().default(false).describe("Replace an existing card; the old one is archived under recast/<timestamp>/."),
  traits: traitsField,
  notes: z.string().optional().describe('Why this candidate, e.g. "picked over 1 and 5; 2 too young".'),
  by: z.string().optional().describe("Who cast it (default $USER)."),
  slug: slugField,
});

const PERFORM_ARGS = z.object({
  project: z.string().describe("The work whose radio episode (or narrated unit) to perform."),
  episode: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "The episode number (or output: radio with unit): its script is outputs/radio/episodes/NN-*.md, else the novel's chapter file NN-*.md carrying a CAST: line. Required unless `all`.",
    ),
  output: outputArg,
  unit: unitArg,
  all: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Perform every episode that has a script and no render yet, in order, one at a time (not with `episode`). With output: radio, the radio output's whole chain instead: every episode not yet made is written from the story core (and accepted), cast from the library (a voice designed on demand when none fits), performed with stream and published to the listening directory, the next episode written while one performs.",
    ),
  stream: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Progressive render: mix as the lines pass and cut 6-second segments into the listening directory (<work>/.pablo/out/stream/), so the review player can start an episode once its first 30 seconds have passed the gates; then mix the episode file from the same timeline and publish it there the moment it exists. Time to first audio is recorded in the manifest and the receipts.",
    ),
  engine: z
    .enum(["chatterbox-turbo", "dia"])
    .optional()
    .describe("The performance engine: chatterbox-turbo (the decided engine, default) or dia (the radio prototype's, for A/B against old renders only)."),
  "json-lines": z
    .boolean()
    .optional()
    .default(false)
    .describe("Also write each line's progress event (take key, path, status, stretch) to stdout as a JSON line as it lands; they always go to stderr."),
});

const MIX_ARGS = z.object({
  project: z.string().describe("The work whose performed radio episode (or narrated unit) to mix."),
  episode: z.number().int().positive().optional().describe("The episode number (or output: radio with unit); it must have been performed (`pablo perform`)."),
  output: outputArg,
  unit: unitArg,
  version: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The manifest version to mix (default: the newest). An unmixed version is completed in place; a version that already has audio is remixed into a new version (the newest only)."),
  auto: z
    .boolean()
    .optional()
    .describe(
      "Write a fresh automatic mix even when the newest mix document still fits the takes (after the sound library or the mix rules changed): cues are re-resolved, so a cue a CC0 recording now matches comes from that recording.",
    ),
  sounds: z
    .string()
    .optional()
    .describe("The CC0 sound library directory SFX and BED cues are built from (default: the casting config's `sounds`, else ~/.local/share/pablo/sounds)."),
});

const FIX_ARGS = z.object({
  project: z.string().describe("The work whose performed radio episode (or narrated unit) to fix."),
  episode: z.number().int().positive().optional().describe("The episode number (or output: radio with unit); it must have been performed and have open flags (flags.json)."),
  output: outputArg,
  unit: unitArg,
  "json-lines": z
    .boolean()
    .optional()
    .default(false)
    .describe("Also write each re-recorded line's progress event to stdout as a JSON line as it lands; they always go to stderr."),
  line: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Re-record only this line (its open flags); the episode's other flags stay open. The line must have an open flag."),
});

const DESCRIBE_ARGS = z.object({
  describe: z.string().describe("The role's description as the script's CAST: line gives it, e.g. \"seventies, reedy, smells of the sea\"."),
  gender: z.enum(["f", "m", "x"]).optional().describe("The role's gender from its CAST: entry."),
  role: roleField.optional(),
});

const VOICES_ARGS = z.object({
  sub: z.enum(["list", "show", "retire"]).describe("`list` the library, `show` one card, `retire` a voice so it is never matched again."),
  name: z.string().optional().describe("The voice slug, for show and retire."),
  "auto-admitted": z.boolean().optional().default(false).describe("list: only the voices the product admitted on its own."),
  reason: z.string().optional().describe("retire: why, recorded on the card."),
  project: projectField,
  library: libraryField,
  vault: vaultField,
});

/** `<vault>` for the library default, and the work directory when `project` names one. */
function locate(ctx: Pick<VerbContext, "cwd" | "env">, project: string | undefined): { readonly vault?: string; readonly work?: string } | VerbResult {
  const vault = findVault(ctx.cwd, ctx.env);
  if (project === undefined) return vault.ok ? { vault: vault.path } : {};
  if (!vault.ok) return { body: { ok: false, code: vault.code, message: vault.message, tried: vault.tried }, exitCode: vault.code };
  const work = resolveProject(vault.path, project);
  if (!work.ok) return { body: { ok: false, code: work.code, message: work.message, tried: work.tried }, exitCode: work.code };
  const marker = readMarker(work.path);
  if (!marker.ok) return { body: { ok: false, code: marker.code, message: marker.message, tried: marker.tried }, exitCode: marker.code };
  return { vault: vault.path, work: work.path };
}

/** `--name=value`, one argv token, so a value that starts with a dash is never read as a flag. */
function flag(name: string, value: string | number | undefined): string[] {
  return value === undefined ? [] : [`${name}=${String(value)}`];
}

function refuse(message: string): VerbResult {
  return { body: { ok: false, code: 2, message }, exitCode: 2 };
}

/** `cast --auto` binds a work's roles: it needs the work, and none of the hand-casting fields. */
function autoRefusal(args: z.infer<typeof CAST_ARGS>): VerbResult | undefined {
  if (args.project === undefined) return refuse("pablo cast --auto needs --project <slug>: the work whose scripts name the roles");
  const manual: string[] = (["role", "candidate", "traits", "notes", "by", "slug"] as const).filter((key) => args[key] !== undefined);
  if (args.recast) manual.push("recast");
  if (manual.length > 0) return refuse(`pablo cast --auto matches from the library; it takes no ${manual.map((key) => `--${key}`).join(", ")}`);
  if (args.episode !== undefined && args.all) return refuse("pablo cast --auto takes --episode N or --all, not both");
  if (args["role-traits"] !== undefined && !args.design) return refuse("pablo cast --role-traits only applies with --auto --design");
  return undefined;
}

function refuseWith(message: string, missing: readonly string[]): VerbResult {
  return { body: { ok: false, code: 2, message, missing }, exitCode: 2 };
}

interface Addressed {
  readonly episode?: number | undefined;
  readonly output?: string | undefined;
  readonly unit?: number | undefined;
}

/**
 * The performed output a casting verb addresses (AGT-2158): `--output radio|narrated`, which needs the work to
 * have that output, else radio (the default, with or without a radio output: a sandbox drama's scripts are
 * chapters). Anything else is a refusal naming the outputs that are performed.
 */
function addressedOutput(args: Addressed, work: string, verb: string): AudioOutput | VerbResult {
  if (args.output === undefined) return RADIO_ID;
  if (!isAudioOutput(args.output)) {
    return refuseWith(`pablo ${verb}: only the ${AUDIO_OUTPUTS.join(" and ")} outputs are performed; got --output ${args.output}`, AUDIO_OUTPUTS.map((o) => `--output ${o}`));
  }
  const marker = readMarker(work);
  const resolved = resolveOutput(marker.ok ? marker.marker.outputs : {}, args.output, verb);
  if (!resolved.ok) return refuseWith(resolved.message, resolved.missing);
  return args.output;
}

/**
 * The unit a casting verb addresses (AGT-1686, AGT-2158): `--episode N` (radio's), or an output's own spelling
 * `--output radio|narrated --unit N` (which needs the work to have that output). Anything else is a refusal
 * naming the fix.
 */
function addressedEpisode(args: Addressed, work: string, verb: string): { readonly episode: number; readonly output: AudioOutput } | VerbResult {
  if (args.output === undefined && args.unit !== undefined) {
    return refuseWith(`pablo ${verb}: --unit is an output's unit; say --output ${RADIO_ID} --unit ${args.unit}, or --episode ${args.unit}`, [`--output ${RADIO_ID}`]);
  }
  const output = addressedOutput(args, work, verb);
  if (typeof output !== "string") return output;
  if (args.episode !== undefined && args.unit !== undefined && args.episode !== args.unit) {
    return refuse(`pablo ${verb}: --episode ${args.episode} and --unit ${args.unit} name different ${unitNoun(output)}s`);
  }
  const episode = args.episode ?? args.unit;
  if (episode === undefined) {
    return output === RADIO_ID
      ? refuseWith(`pablo ${verb} needs --episode N (or --output ${RADIO_ID} --unit N)`, ["--episode N"])
      : refuseWith(`pablo ${verb} needs --output ${output} --unit N`, ["--unit N"]);
  }
  return { episode, output };
}

/**
 * The radio output's stage machine for a casting verb (AGT-1686,
 * `outputs/radio/state.ts`): a refusal naming exactly what is missing
 * (`role NED is not cast`), returned before anything is provisioned or run.
 */
function stageRefusal(work: string, stage: RadioVerbStage, episode: number, verb: string, output: AudioOutput = RADIO_ID): VerbResult | undefined {
  const check = radioStageCheck(work, stage, episode, output);
  if (check.ready) return undefined;
  const hint = output !== RADIO_ID && check.missing.some((m) => m.startsWith("role ")) ? `; cast it with pablo cast --auto --output ${output} --unit ${episode}` : "";
  return {
    body: {
      ok: false,
      code: 2,
      message: `pablo ${verb}: ${output} ${unitNoun(output)} ${episode} is not ready to ${stage} (${check.missing.join("; ")})${hint}; nothing was run`,
      output,
      unit: episode,
      stage,
      missing: check.missing,
    },
    exitCode: 2,
  };
}

/** The fields of a perform or fix receipt worth reporting back: the summary, not the engine's whole load record. */
const RECEIPT_FIELDS = ["at", "intent", "episode", "engine", "version", "lines", "pass", "best_of_failed", "rtf_total", "rtf_engine", "audio_seconds", "wall"] as const;

/**
 * What a performed episode adds to the body (AGT-1686): its output and unit,
 * the newest mixed audio (null until `pablo mix`, with the command as
 * `next`), and the summary of the receipt the run left. The Python body's own
 * fields (`version`, `manifest`, ...) win over these.
 */
function performedBody(work: string, episode: number, intent: "perform" | "fix", output: AudioOutput = RADIO_ID): Record<string, unknown> {
  const state = episodeState(work, episode, output);
  const receipt = lastReceipt(work, episode, [intent], output);
  const summary = receipt === undefined ? null : Object.fromEntries(RECEIPT_FIELDS.filter((key) => receipt[key] !== undefined).map((key) => [key, receipt[key]]));
  return {
    output,
    unit: episode,
    audio: state.audio ?? null,
    receiptSummary: summary,
    ...(state.audio === undefined ? { next: `pablo mix --output ${output} --unit ${episode}` } : {}),
  };
}

/** The options every casting verb shares: the work (receipts) and where the library is (`--library`, `--vault`). */
interface Where {
  readonly project?: string | undefined;
  readonly library?: string | undefined;
  readonly vault?: string | undefined;
}

/**
 * `extras` are the optional Python extras the command needs: a real `audition`
 * and `cast` render and score audio, so they provision with `scorers` (AGT-1709);
 * `voices`, `cast --auto` and `audition --dry-run` need none.
 */
function run(args: readonly string[], where: Where, ctx: VerbContext, deps: (env: Env) => CastingDeps, extras: readonly string[] = [], output: AudioOutput = RADIO_ID): VerbResult {
  // The library and vault are the author's to aim: a model (or text it read) must not redirect where `cast` writes cards.
  // Only the CLI (caller unset or "cli") may; `pablo mcp` and the harness (harness/agent.ts) both set "mcp".
  if (ctx.caller !== undefined && ctx.caller !== "cli" && (where.library !== undefined || where.vault !== undefined)) {
    return refuse("pablo: --library and --vault are CLI options; through MCP the library is the vault's <vault>/casting or the casting config's `library`");
  }
  const located = locate(ctx, where.project);
  if ("exitCode" in located) return located;
  const vault = where.vault === undefined ? located.vault : resolve(ctx.cwd, where.vault);
  const library = where.library === undefined ? undefined : resolve(ctx.cwd, where.library);
  return runCasting([...args, ...flag("--vault", vault), ...flag("--library", library)], { env: audioEnv(ctx.env, output), stderr: ctx.stderr }, ctx.casting ?? deps(ctx.env), located.work, extras);
}

/** One `fix` run, as `pablo fix` and the mixer's re-take (AGT-2155, `mixer-punch-host.ts`) both make it. */
export interface FixRun {
  readonly work: string;
  readonly episode: number;
  /** The performed output whose unit `episode` is (default radio; narrated, AGT-2158). */
  readonly output?: AudioOutput;
  /** Only this line's open flags (`--line`); the rest stay open. */
  readonly line?: number;
  readonly vault?: string;
  readonly library?: string;
  /** Where each line's progress event is also written as a JSON line (`--json-lines`). */
  readonly relay?: { write(text: string): unknown };
  readonly env: Env;
  readonly stderr: { write(text: string): unknown };
  readonly casting: CastingDeps;
}

/**
 * The body of `pablo fix` after the episode is addressed: the radio stage check, provisioning (the engine, the
 * gates' scorers, the remix's cue generators), then `python -m pablo_casting fix`. Asynchronous throughout, so a
 * window's server keeps answering while the GPU works.
 */
export async function runFix(r: FixRun): Promise<VerbResult> {
  const { work, episode } = r;
  const output = r.output ?? RADIO_ID;
  const notReady = stageRefusal(work, "fix", episode, "fix", output);
  if (notReady !== undefined) return notReady;
  const casting = { env: audioEnv(r.env, output), stderr: r.stderr };
  const ready = ensureProvisioned(casting, r.casting, work, [SCORERS_EXTRA, MIX_EXTRA]);
  if (!ready.ok) return ready.result;
  const relay = r.relay;
  const pythonArgs = [
    "fix",
    ...flag("--episode", episode),
    ...flag("--line", r.line),
    ...(relay !== undefined ? ["--json-lines"] : []),
    ...flag("--vault", r.vault),
    ...flag("--library", r.library),
    "--work",
    work,
  ];
  const result = await runPythonStreaming(ready.layout, r.casting, casting, pythonArgs, (line) => {
    if (relay !== undefined && isProgressEvent(line)) relay.write(`${line}\n`);
  });
  return {
    body: {
      ...(result.exitCode === 0 ? performedBody(work, episode, "fix", output) : {}),
      ...(result.body as object),
      provisioned: ready.outcome.provisioned,
      ...(ready.outcome.receipt ? { receipt: ready.outcome.receipt } : {}),
    },
    exitCode: result.exitCode,
  };
}

/** The audition fields `auditionArgv` reads (`AUDITION_ARGS` without the library's whereabouts). */
export interface AuditionFields {
  readonly role?: string | undefined;
  readonly describe?: string | undefined;
  readonly designer?: "qwen3" | "voxcpm2" | undefined;
  readonly language?: "en" | "es" | undefined;
  readonly n?: number | undefined;
  readonly seed?: number | undefined;
  readonly traits?: string | undefined;
  readonly slug?: string | undefined;
}

/**
 * The Python argv of a real `audition` (no library flags, no `--work`): the `audition` verb's and the mixer's Cast
 * panel's (AGT-2157, `mixer-cast-host.ts`), so the panel designs a voice exactly as `pablo audition` does.
 */
export function auditionArgv(args: AuditionFields): string[] {
  return [
    "audition",
    ...flag("--role", args.role),
    ...flag("--describe", args.describe),
    ...flag("--designer", args.designer),
    ...flag("--language", args.language),
    ...flag("--n", args.n),
    ...flag("--seed", args.seed),
    ...flag("--traits", args.traits),
    ...flag("--slug", args.slug),
  ];
}

/** The fields of a hand cast (`cast --role R --candidate n`) that `castArgv` reads. */
export interface CastFields {
  readonly role: string;
  readonly candidate: number;
  readonly recast?: boolean | undefined;
  readonly traits?: string | undefined;
  readonly notes?: string | undefined;
  readonly by?: string | undefined;
  readonly slug?: string | undefined;
}

/** The Python argv of a hand cast (freeze a candidate into a card): the `cast` verb's and the Cast panel's (AGT-2157). */
export function castArgv(args: CastFields): string[] {
  return [
    "cast",
    ...flag("--role", args.role),
    ...flag("--candidate", args.candidate),
    ...(args.recast === true ? ["--recast"] : []),
    ...flag("--traits", args.traits),
    ...flag("--notes", args.notes),
    ...flag("--by", args.by),
    ...flag("--slug", args.slug),
  ];
}

/** The casting verbs (audition, cast, voices, perform), over `deps` (the real machine by default). */
export function castingVerbs(deps: (env: Env) => CastingDeps = realCastingDeps): readonly Verb[] {
  const audition: Verb<typeof AUDITION_ARGS.shape> = {
    name: "audition",
    description:
      "Audition voices for a role: the designer (Qwen3-TTS VoiceDesign or VoxCPM2) renders n candidates reading the shared audition passage from a description, each scored (naturalness, pitch, words/s, speaker similarity to the others, near duplicates marked) into the voice library's auditions/. Listen, then `cast` one. Loads models; `dry-run` only checks the casting side.",
    args: AUDITION_ARGS,
    run: async (args, ctx) => {
      if (args["dry-run"]) return run(["audition", "--dry-run"], args, ctx, deps);
      return run(auditionArgv(args), args, ctx, deps, [SCORERS_EXTRA]);
    },
  };

  const cast: Verb<typeof CAST_ARGS.shape> = {
    name: "cast",
    description:
      "Freeze an audition candidate as the role's cast card in the shared voice library (24 kHz mono FLAC reference trimmed by the aligner, its transcript, an ECAPA embedding, the traits block and the designer's provenance) and return the card hash a story pins. Refuses to replace an existing card unless `recast`, which archives the old one. Voices are synthetic only: there is no way to cast from a recording. With `auto` (and `project`), cast the work's script roles from the library instead: each unbound role is matched by its CAST: description (gender a hard filter, weighted trait agreement, never a voice that sounds like one already in the story, never a retired voice), bound with its score and runner-up, marked review in the middle band, or returned in needsDesign.",
    args: CAST_ARGS,
    run: async (args, ctx) => {
      if (args.auto) {
        const refusal = autoRefusal(args);
        if (refusal !== undefined) return refusal;
        let episode: number | undefined;
        let output: AudioOutput = RADIO_ID;
        if (args.output !== undefined && args.episode === undefined && args.unit === undefined) {
          // Every unit of the named output (AGT-2158: `--output narrated` casts the narrator, and any character the readings give lines).
          const where = locate(ctx, args.project);
          if ("exitCode" in where) return where;
          const addressed = addressedOutput(args, where.work as string, "cast");
          if (typeof addressed !== "string") return addressed;
          output = addressed;
        } else if (args.episode !== undefined || args.unit !== undefined) {
          // One unit's roles: the output's cast stage needs its script (AGT-1686).
          const where = locate(ctx, args.project);
          if ("exitCode" in where) return where;
          const addressed = addressedEpisode(args, where.work as string, "cast");
          if ("exitCode" in addressed) return addressed;
          if (args.all) return refuse("pablo cast --auto takes --episode N or --all, not both");
          const notReady = stageRefusal(where.work as string, "cast", addressed.episode, "cast", addressed.output);
          if (notReady !== undefined) return notReady;
          episode = addressed.episode;
          output = addressed.output;
        }
        return run(
          [
            "cast",
            "--auto",
            ...flag("--episode", episode),
            ...(args.all ? ["--all"] : []),
            ...(args.design ? ["--design"] : []),
            ...flag("--role-traits", args["role-traits"]),
          ],
          args,
          ctx,
          deps,
          args.design ? [SCORERS_EXTRA] : [],
          output,
        );
      }
      if (args.design || args["role-traits"] !== undefined) {
        return refuse("pablo cast --design designs voices for an auto-cast: pass it with --auto --project <slug>");
      }
      if (args.output !== undefined || args.unit !== undefined) return refuse("pablo cast: --output and --unit address a work's episode; they go with --auto");
      if (args.role === undefined || args.candidate === undefined) {
        return refuse("pablo cast needs --role R and --candidate n (or --auto --project <slug> to match the work's roles from the library)");
      }
      return run(castArgv({ ...args, role: args.role, candidate: args.candidate }), args, ctx, deps, [SCORERS_EXTRA]);
    },
  };

  const voices: Verb<typeof VOICES_ARGS.shape> = {
    name: "voices",
    description:
      "The shared voice library: `list` every voice (card hash, traits, retired, auditions; `auto-admitted` for the ones the product added), `show` one card and whether its reference is intact, `retire` a voice so auto-casting never matches it again (stories that already pin it keep it; its card hash does not change).",
    args: VOICES_ARGS,
    run: async (args, ctx) =>
      run(
        ["voices", args.sub, ...(args.name === undefined ? [] : [args.name]), ...(args["auto-admitted"] ? ["--auto-admitted"] : []), ...flag("--reason", args.reason)],
        args,
        ctx,
        deps,
      ),
    positionalArgs: ["sub", "name"],
  };

  const perform: Verb<typeof PERFORM_ARGS.shape> = {
    name: "perform",
    description:
      "Perform a radio episode: every spoken line is rendered through the decided engine (Chatterbox-Turbo; `dia` for A/B only) in its bound voice, scored by the quality gates, and retaken up to 4 times with derived seeds (first passing take kept, else the best kept and flagged automatically); the pace policy stretches each take to its role's pace (slow/quick directions scale it) within 0.75-1.05, retaking lines that would need more. Writes immutable takes and the episode's v1 manifest (with rtf_total) and a receipt per engine pass; each line's take is reported as it lands. Refuses an unbound role, a changed card pin, or an episode that already has a manifest (use fix). With output: narrated and unit, performs that reading of the narrated output instead (its narrator, and character voices only where the reading gives them lines; cast them first with cast auto and output: narrated). With `stream`, a listener can start the episode in the review player before its last line is performed, and the episode is mixed and published to the listening directory as soon as it finishes; with `all`, every episode not yet performed, in order. Loads models and uses the GPU.",
    args: PERFORM_ARGS,
    run: async (args, ctx) => {
      // `--output radio --all` (AGT-1700) is the radio output's whole chain, not the engine queue alone.
      const outputAll = args.all && args.output !== undefined && args.episode === undefined && args.unit === undefined;
      const addressedAny = args.episode !== undefined || args.unit !== undefined || args.output !== undefined;
      if (args.all && addressedAny && !outputAll) return refuse("pablo perform takes --episode N (or --output radio --unit N) or --all, not both");
      const where = locate(ctx, args.project);
      if ("exitCode" in where) return where;
      const work = where.work as string;
      // A narrated unit is performed one at a time and never streamed: the listening directory is radio's (AGT-2158).
      if (args.output !== undefined && args.output !== RADIO_ID && isAudioOutput(args.output) && (args.all || args.stream)) {
        return refuse(`pablo perform: --${args.all ? "all" : "stream"} is the radio output's; perform a ${args.output} unit with --output ${args.output} --unit N`);
      }
      if (outputAll) return performOutput(args.output as string, where.vault as string, work, ctx, ctx.casting ?? deps(ctx.env));
      let single: number | undefined;
      let output: AudioOutput = RADIO_ID;
      if (!args.all) {
        const addressed = addressedEpisode(args, work, "perform");
        if ("exitCode" in addressed) return addressed;
        // The output's stage machine first (AGT-1686): an unbound role is refused by name, and nothing is provisioned or run.
        const notReady = stageRefusal(work, "perform", addressed.episode, "perform", addressed.output);
        if (notReady !== undefined) return notReady;
        single = addressed.episode;
        output = addressed.output;
      }
      const machine = ctx.casting ?? deps(ctx.env);
      const casting = { env: audioEnv(ctx.env, output), stderr: ctx.stderr };
      // A real engine and the gates' scorers: the `scorers` extra (mlx-audio included); streaming mixes as it goes: `mix`.
      const ready = ensureProvisioned(casting, machine, work, args.stream ? [SCORERS_EXTRA, MIX_EXTRA] : [SCORERS_EXTRA]);
      if (!ready.ok) return ready.result;
      const relay = args["json-lines"] ? ctx.stdout : undefined;
      const provisioned = { provisioned: ready.outcome.provisioned, ...(ready.outcome.receipt ? { receipt: ready.outcome.receipt } : {}) };

      const performOne = async (episode: number): Promise<VerbResult> => {
        const pythonArgs = [
          "perform",
          ...flag("--episode", episode),
          ...flag("--engine", args.engine),
          ...(args.stream ? ["--stream"] : []),
          ...(relay !== undefined || args.stream ? ["--json-lines"] : []),
          ...flag("--vault", where.vault),
          "--work",
          work,
        ];
        // Streaming runs the child asynchronously, so the writer's queue (progressive.ts) keeps moving meanwhile.
        const result =
          relay === undefined && !args.stream
            ? runPython(ready.layout, machine, casting, pythonArgs)
            : await runPythonStreaming(ready.layout, machine, casting, pythonArgs, (line) => {
                if (relay !== undefined && isProgressEvent(line)) relay.write(`${line}\n`);
              });
        if (result.exitCode !== 0) return result;
        const performed = { ...performedBody(work, episode, "perform", output), ...(result.body as object) };
        if (!args.stream) return { body: performed, exitCode: 0 };
        // The episode file exists: publish it to the listening directory at once.
        const published = publishStream(work, { episode, now: () => machine.now() });
        if (relay !== undefined && published.ok) relay.write(`${JSON.stringify({ event: "published", episode, where: published.where, chapters: published.chapters.length })}\n`);
        return {
          body: { ...performed, published: published.ok ? { where: published.where, chapter: published.chapters.find((c) => c.episode === episode) } : published },
          exitCode: published.ok ? 0 : published.code,
        };
      };

      if (single !== undefined) {
        const result = await performOne(single);
        return { body: { ...(result.body as object), ...provisioned }, exitCode: result.exitCode };
      }
      const units = radioEpisodes(work).filter((episode) => !isPerformed(work, episode));
      if (units.length === 0) return refuse(`pablo perform --all: every episode of ${work} with a script is already performed (or none has a CAST: line); change one with pablo fix`);
      const report = await runProgressive({
        units,
        perform: async (episode) => {
          const result = stageRefusal(work, "perform", episode, "perform") ?? (await performOne(episode));
          return { ok: result.exitCode === 0, exitCode: result.exitCode, body: result.body };
        },
      });
      const episodes = report.units.filter((u) => u.performed !== undefined).map((u) => ({ episode: u.unit, exitCode: u.performed?.outcome.exitCode, ...(u.performed?.outcome.body as object) }));
      const done = episodes.filter((e) => e.exitCode === 0).length;
      return {
        body: {
          ok: report.ok,
          ...(report.ok ? {} : { code: report.exitCode }),
          episodes,
          message: report.ok
            ? `performed ${done} episode(s): ${units.join(", ")}${args.stream ? ", each published to the listening directory as it finished" : ""}`
            : `stopped at episode ${String(report.stopped?.unit)} after ${done} performed: ${String((report.stopped?.outcome.body as { message?: unknown } | undefined)?.message ?? "failed")}`,
          ...provisioned,
        },
        exitCode: report.exitCode,
      };
    },
  };

  const mix: Verb<typeof MIX_ARGS.shape> = {
    name: "mix",
    description:
      "Mix a performed radio episode into its episode file: the takes in line order, each paced by the manifest's stretch, with the script's SFX, BED and MUSIC cues placed from the content-addressed cue library (Stable Audio Open for SFX and beds on MPS, a synthesized tonewheel organ for music; the same description is the same asset in every episode), normalised to -1 dBFS and encoded as AAC in renders/epNN/epNN.v<k>.m4a, with epNN.m4a moved to it and each line's start and end written into the manifest. Mixing a version that already has audio makes a new version with identical takes; earlier versions' audio is never touched. The mix is rendered from a mix document (renders/epNN/mix.v<m>.json: dialogue, sfx, beds and music tracks of clips anchored to lines, with gain, fades and automation): the newest one that fits the version's takes, else the automatic mix written as the next mix version by: auto (mix.v1 on a first mix). Needs the episode performed first; generates cues on the GPU only for descriptions not yet in the library.",
    args: MIX_ARGS,
    run: async (args, ctx) => {
      const where = locate(ctx, args.project);
      if ("exitCode" in where) return where;
      const work = where.work as string;
      const addressed = addressedEpisode(args, work, "mix");
      if ("exitCode" in addressed) return addressed;
      const { episode, output } = addressed;
      const notReady = stageRefusal(work, "mix", episode, "mix", output);
      if (notReady !== undefined) return notReady;
      const machine = ctx.casting ?? deps(ctx.env);
      const casting = { env: audioEnv(ctx.env, output), stderr: ctx.stderr };
      const ready = ensureProvisioned(casting, machine, work, [MIX_EXTRA]);
      if (!ready.ok) return ready.result;
      const result = runPython(ready.layout, machine, casting, [
        "mix",
        ...flag("--episode", episode),
        ...flag("--version", args.version),
        ...(args.auto === true ? ["--auto"] : []),
        ...flag("--sounds", args.sounds),
        ...flag("--vault", where.vault),
        "--work",
        work,
      ]);
      return {
        body: {
          ...(result.exitCode === 0 ? { output, unit: episode } : {}),
          ...(result.body as object),
          provisioned: ready.outcome.provisioned,
          ...(ready.outcome.receipt ? { receipt: ready.outcome.receipt } : {}),
        },
        exitCode: result.exitCode,
      };
    },
  };

  const fix: Verb<typeof FIX_ARGS.shape> = {
    name: "fix",
    description:
      "Fix a performed radio episode from its flags: re-records only the flagged lines (flags.json: the player's, with a reason of clipped, wrong voice, flat, rushed or other, and perform's automatic ones for takes that never passed the gates), with new attempt numbers and, by reason, an adjusted engine temperature (wrong voice: colder, flat: hotter) or a slower pace (rushed); writes the next manifest version through the invariant that no unflagged line's take changes (a violation writes nothing), remixes it into epNN.v<k+1>.m4a with the epNN.m4a link moved, and moves the flags to flags-done.json with the version they landed in. The flags and their reasons are recorded in the manifest's flags_applied. Refuses an episode with no open flags (naming it), an unperformed episode, a script whose unflagged lines changed, or a role bound to a different voice since the version. Loads models and uses the GPU.",
    args: FIX_ARGS,
    run: async (args, ctx) => {
      const where = locate(ctx, args.project);
      if ("exitCode" in where) return where;
      const work = where.work as string;
      const addressed = addressedEpisode(args, work, "fix");
      if ("exitCode" in addressed) return addressed;
      return runFix({
        work,
        episode: addressed.episode,
        output: addressed.output,
        ...(args.line === undefined ? {} : { line: args.line }),
        ...(where.vault === undefined ? {} : { vault: where.vault }),
        ...(args["json-lines"] ? { relay: ctx.stdout } : {}),
        env: ctx.env,
        stderr: ctx.stderr,
        casting: ctx.casting ?? deps(ctx.env),
      });
    },
  };

  const describeVoice: Verb<typeof DESCRIBE_ARGS.shape> = {
    name: "describe_voice",
    description:
      "Normalise a role's CAST: description into the voice traits vocabulary (gender, age, pitch, energy, warmth, register, era, roles) with pablo's deterministic mapper: returns the traits it found, the phrases it could not normalise (freeText), the whole vocabulary, and the designer instruct the traits become. When freeText is not empty, choose traits for it from the vocabulary and pass them to `cast` with auto, design and role-traits. Loads no model and writes nothing.",
    args: DESCRIBE_ARGS,
    run: async (args, ctx) =>
      run(["describe", ...flag("--describe", args.describe), ...flag("--gender", args.gender), ...flag("--role", args.role)], {}, ctx, deps),
  };

  return [audition, cast, voices, perform, mix, fix, describeVoice] as readonly Verb[];
}

/**
 * `pablo perform --output radio --all` (AGT-1700): the radio output's chain over every episode not yet made,
 * on a work whose radio output was added later (`pablo output add radio` once the core is at beats). Each
 * episode with no script is written from the core and accepted (the writer queue), then cast with `cast
 * --auto --design`, performed with `--stream` and published to the listening directory (the engine queue),
 * episode N+1 written while episode N performs (`radio-chain.ts`, loaded only here). The work's other
 * outputs are never touched. A refusal stops both queues and leaves what is published.
 */
async function performOutput(output: string, vault: string, work: string, ctx: VerbContext, machine: CastingDeps): Promise<VerbResult> {
  if (output !== RADIO_ID) return refuseWith(`pablo perform: only the radio output is performed; got --output ${output}`, [`--output ${RADIO_ID}`]);
  const marker = readMarker(work);
  if (!marker.ok) return { body: { ok: false, code: marker.code, message: marker.message, tried: marker.tried }, exitCode: marker.code };
  const resolved = resolveOutput(marker.marker.outputs, RADIO_ID, "perform");
  if (!resolved.ok) return refuseWith(resolved.message, resolved.missing);
  const mod = await import("./radio-chain");
  const chain = {
    vault,
    work,
    slug: marker.marker.slug,
    ctx,
    casting: machine,
    progress: (line: string) => ctx.stderr.write(`pablo perform: ${line}\n`),
    now: () => machine.now(),
  };
  const units = mod.radioUnits(work).filter((unit) => episodeState(work, unit).stage !== "publish");
  if (units.length === 0) return refuse(`pablo perform --output radio --all: every episode of ${work} is already made (change one with pablo fix)`);
  const written: number[] = [];
  const made = await mod.runRadioChain(chain, units, {
    write: async (unit) => {
      chain.progress(`radio: writing episode ${unit}`);
      const result = await mod.writeAndAcceptEpisode(chain, unit, { writer: ctx.writer });
      if (result.ok) written.push(unit);
      return result;
    },
  });
  const { report } = made;
  const episodes = report.units.filter((u) => u.performed !== undefined).map((u) => ({ episode: u.unit, exitCode: u.performed?.outcome.exitCode, ...(u.performed?.outcome.body as object) }));
  const done = episodes.filter((e) => e.exitCode === 0).length;
  const stoppedBody = (report.stopped?.outcome.body ?? {}) as Record<string, unknown>;
  return {
    body: {
      ...(report.ok ? {} : stoppedBody),
      ok: report.ok,
      ...(report.ok ? {} : { code: report.exitCode, stopped: { unit: report.stopped?.unit, queue: report.stopped?.queue } }),
      output: RADIO_ID,
      written,
      episodes,
      published: made.where === undefined ? null : { where: made.where, chapters: made.published },
      message: report.ok
        ? `made ${done} radio episode(s) (${units.join(", ")}): ${written.length} written, each cast, performed and published to the listening directory as it finished`
        : `stopped at episode ${String(report.stopped?.unit)} after ${done} made: ${String(stoppedBody["message"] ?? "failed")}`,
    },
    exitCode: report.exitCode,
  };
}

/** A `perform` progress line (`{"event": ...}`), as opposed to the final body. */
function isProgressEvent(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null && typeof (parsed as { event?: unknown }).event === "string";
  } catch {
    return false;
  }
}
