/**
 * `pablo prose --voice <name> --brief <file|-> [--context <file>]...
 *   [--format email|post|page|reply|note] [--words N] [--out <path>]
 *   [--force] [--json] [--dry-run]`: the freeform prose path — a voice plus a
 * brief, no stage machine, no `--project`. See the design doc's extension
 * (`~/saltline-digital-vault/projects/ai-terminal/prose.md`).
 *
 * AGT-1241 wired assembly and `--dry-run`; AGT-1242 wires the rest: route
 * (the `copy` intent, or the voice's own `model:`), send once, normalize,
 * hand the text back on stdout / in `--json` / to `--out`, append a receipt,
 * and run `check` over the answer with the voice's own flagged lines. The
 * send path deliberately mirrors `write.ts`'s (AGT-1237) step for step —
 * same `withReceipts` wrapper, same `packTimeoutMs`, same
 * `EndpointHung`/`ProviderResponseError`/`ProviderConfigError` refusals, same
 * injectable `{adapter, now, stderr}` so no test touches the network.
 *
 * `proseCore` is the core `saveCore`/`checkWork` already are for this file's
 * siblings: it resolves the voice, reads the brief and context files,
 * assembles the pack, sends it, and returns the exact `--json` body — never
 * prints, never throws (every failure is returned data). It is `async` since
 * AGT-1242 because the send is; the assembly half stays synchronous and pure
 * in `assembleProse`. `runProse` is the CLI's thin printing wrapper over it
 * (mirroring `runSave` over `saveCore`); `verbs.ts`'s `runProseVerb` calls it
 * directly for MCP, after its own vault-boundary check (see that file's
 * comment on why `--brief`/`--context`/`--out` are bounded there, not here).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve as resolvePath } from "node:path";
import {
  assemblePack,
  createProviders,
  EndpointHung,
  fileReceiptSink,
  loadConfig,
  normalizeOutput,
  packTimeoutMs,
  ProviderConfigError,
  ProviderResponseError,
  renderPack,
  withReceipts,
} from "@openthink/pablo-core";
import type {
  Adapter,
  CompletionStats,
  Intent,
  Pack,
  ReceiptSink,
  SliceAction,
  SliceAdjustment,
  TextSource,
} from "@openthink/pablo-core";
import { checkFile, checkRulesFromVoice } from "./check";
import type { Hit } from "./check";
import { FORMAT_STANZAS, KNOWN_FORMATS } from "./formats";
import { gitCommit } from "./init";
import { parseFrontmatter } from "./novel/machine";
import { jsonlReceiptSink, stateDraftsDir, stateReceiptsPath, stateReviewPath } from "./paths";
import { findVault } from "./project";
import { appendEvent, mintPieceId } from "./review";
import type { QueuedEvent } from "./review";
import { readVoice, resolveVoice } from "./voice";
import type { Voice } from "./voice";
import { yamlScalar } from "./write";
import type { ProgressSink, WriteReceiptSummary } from "./write";

/** No `prompt_hash` in the draft's own frontmatter (or no frontmatter at all): AC3's literal `"unknown"`. */
const UNKNOWN_REVISED_FROM = "unknown";

/** What `proseCore` needs beyond the CLI's own env/cwd — mirrors `write.ts`'s minimal context shape. */
export interface ProseCoreContext {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}

/**
 * `proseCore`'s own fields, already the right *types* (voice resolved by
 * name, words a number, `dryRun` a boolean) — the CLI's raw string argv and
 * MCP's already-typed zod args each map onto this the same way.
 */
export interface ProseCoreArgs {
  readonly voice: string | undefined;
  /** A file path, or `"-"` for stdin (CLI only — see `readBrief`). */
  readonly brief: string | undefined;
  /** File paths, in the order they were given. */
  readonly context: readonly string[];
  /** `email` | `post` | `page` | `reply` | `note`. */
  readonly format: string | undefined;
  readonly words: number | undefined;
  readonly dryRun: boolean;
  /** `--out <path>`: where to write the answer, resolved against `ctx.cwd`. Absent = stdout only. */
  readonly out: string | undefined;
  /** `--force`: overwrite an existing `--out` file. */
  readonly force: boolean;
  /** `--draft <file>` (AGT-1244): the previous piece to revise. Requires `instruction`; see `assembleProse`'s AC2 refusal. */
  readonly draft: string | undefined;
  /** `--instruction "<text>"` (AGT-1244): what to change about `draft`. Requires `draft`. */
  readonly instruction: string | undefined;
}

/** The CLI's own argv shape — `words` still a raw string, `json` added for the printing wrapper. */
export interface ProseCliArgs {
  readonly voice: string | undefined;
  readonly brief: string | undefined;
  readonly context: readonly string[];
  readonly format: string | undefined;
  readonly words: string | undefined;
  readonly dryRun: boolean;
  readonly json: boolean;
  readonly out: string | undefined;
  readonly force: boolean;
  readonly draft: string | undefined;
  readonly instruction: string | undefined;
}

/** Dependencies a caller can inject; production code omits all of them. Mirrors `write.ts`'s `RunWriteDeps`. */
export interface ProseDeps {
  /** Overrides the provider registry's adapter entirely — the only way tests avoid the network. */
  readonly adapter?: Adapter | undefined;
  /** Overrides the clock used for the `--out` frontmatter's `generated` timestamp. */
  readonly now?: (() => Date) | undefined;
  /** Overrides where streaming progress is written. Defaults to `process.stderr`. */
  readonly stderr?: ProgressSink | undefined;
}

export interface ProseRefusalBody {
  readonly ok: false;
  readonly code: number;
  readonly message: string;
  readonly tried?: readonly string[];
}

/** AC2's exact `--dry-run --json` shape. */
export interface ProseDryRunSlice {
  readonly name: string;
  readonly heading: string;
  readonly source: string | undefined;
  readonly tokens: number;
  readonly action?: SliceAction;
}

export interface ProseDryRunBody {
  readonly ok: true;
  readonly dryRun: true;
  readonly slices: readonly ProseDryRunSlice[];
  readonly totalTokens: number;
  readonly expectedOutputTokens: number;
  readonly prompt_hash: string;
  readonly adjustments: readonly SliceAdjustment[];
}

/**
 * The receipt a send returns (AC2). `write`'s own shape, extended rather than
 * aliased: `revised_from` (AGT-1244) is a `prose`-only field with no `write`
 * equivalent (a chapter is never "revised from" another chapter's receipt),
 * so it does not belong on `WriteReceiptSummary` itself — that type is
 * `write.ts`'s and this build must not change its shape or its callers'
 * expectations. Present only for a `--draft`/`--instruction` revise call.
 */
export interface ProseReceiptSummary extends WriteReceiptSummary {
  readonly revised_from?: string;
}

/**
 * AC2's exact send body. `path`/`committed`/`notice` appear only with
 * `--out`. `piece` (AGT-1262 AC4) is the review queue's id for this piece,
 * always present on a completed send. `queue` (AGT-1262 AC2) appears only
 * when the queue append itself failed — `"failed: <detail>"` — and never
 * changes `exitCode`.
 */
export interface ProseSendBody {
  readonly ok: true;
  readonly text: string;
  readonly receipt: ProseReceiptSummary;
  readonly check: readonly Hit[];
  readonly piece: string;
  readonly queue?: string;
  readonly path?: string;
  readonly committed?: boolean;
  readonly notice?: string;
}

export type ProseBody = ProseRefusalBody | ProseDryRunBody | ProseSendBody;

export interface ProseOutcome {
  readonly body: ProseBody;
  readonly exitCode: number;
  /** Present only alongside a successful dry-run body — the CLI's non-JSON rendering needs the `Pack` itself, not just its JSON-safe body. */
  readonly pack?: Pack;
}

/**
 * The intent every prose call routes under (AGT-1242 widened `IntentKind`
 * with `"copy"` for it, as the design doc's "Model routing" section asks).
 * `route()`'s only default branch is `kind !== "planning" -> local`, so this
 * lands on the local writer out of the box, exactly like drafting; a config's
 * `"intents": {"prose": "anthropic"}` mapping — or a voice's own `model:` —
 * moves it. A dry run uses the same intent purely to price the wait:
 * `createProviders`/`loadConfig` never open a connection, and
 * `providers.rates()` just reads back what the endpoint's `RateMeter` has
 * already measured.
 */
const PROSE_INTENT: Intent = { name: "prose", kind: "copy" };

/** How often (ms) the streaming progress line refreshes once tokens are flowing — `write.ts`'s interval. */
const PROGRESS_INTERVAL_MS = 2000;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type ReadResult = { readonly ok: true; readonly source: TextSource } | { readonly ok: false; readonly code: number; readonly message: string };

function readProseFile(path: string, flagLabel: string): ReadResult {
  try {
    return { ok: true, source: { path, text: readFileSync(path, "utf8") } };
  } catch (err) {
    return { ok: false, code: 1, message: `pablo: prose: could not read ${flagLabel} ${path}: ${errMessage(err)}` };
  }
}

/**
 * `--brief -` reads stdin to end (`readFileSync(0, ...)`, not
 * `Bun.stdin.text()`, so `proseCore` stays synchronous — the same reasoning
 * `save.ts`'s `readSaveInput` already documents). A TTY with no piped input
 * refuses (exit 2) rather than blocking forever. Over MCP, `"-"` is refused
 * before this is ever called (`verbs.ts`'s `runProseVerb` — there is no
 * stdin to read in a tool call, mirroring `save`'s MCP rule), so this
 * function only ever sees `"-"` from the CLI.
 */
function readBrief(raw: string): ReadResult {
  if (raw !== "-") return readProseFile(raw, "--brief");

  if (process.stdin.isTTY) {
    return { ok: false, code: 2, message: "pablo: prose: --brief - reads stdin; pipe input or pass a file" };
  }
  try {
    return { ok: true, source: { path: "(stdin)", text: readFileSync(0, "utf8") } };
  } catch (err) {
    return { ok: false, code: 1, message: `pablo: prose: could not read stdin: ${errMessage(err)}` };
  }
}

export interface BuildProseOptions {
  readonly brief: TextSource;
  readonly context: readonly TextSource[];
  /** A format *name* (`email`, `post`, ...) — resolved to its stanza text here, not in core. */
  readonly format: string | undefined;
  readonly words: number | undefined;
  /** AGT-1244: the previous piece, frontmatter already stripped by the caller. */
  readonly draft?: TextSource | undefined;
  /** AGT-1244: what to change about `draft`, already sanitized by the caller (see `sanitizeInstruction`). */
  readonly instruction?: string | undefined;
}

export type BuildProseResult = { readonly ok: true; readonly pack: Pack } | { readonly ok: false; readonly code: 2; readonly message: string };

/**
 * Pure over already-read `TextSource`s (AC1/AC5): resolves `--format` to its
 * fixed stanza (refusing an unknown one, AC4) and calls
 * `@openthink/pablo-core`'s `assemblePack("prose", ...)`. No filesystem, no
 * network, no clock — same inputs, same `Pack`, same hash (AC3).
 */
export function buildProsePack(voice: Voice, options: BuildProseOptions): BuildProseResult {
  if (options.format !== undefined && !(options.format in FORMAT_STANZAS)) {
    return {
      ok: false,
      code: 2,
      message: `pablo: prose: unknown --format "${options.format}" (expected ${KNOWN_FORMATS.join(", ")})`,
    };
  }

  const pack = assemblePack("prose", {
    voice: { rules: voice.rules, exemplars: voice.exemplars, never: voice.never },
    format: options.format === undefined ? undefined : FORMAT_STANZAS[options.format],
    context: options.context,
    brief: options.brief,
    wordTarget: options.words,
    draft: options.draft,
    instruction: options.instruction,
  });

  return { ok: true, pack };
}

/**
 * Strips a leading YAML frontmatter block from a `--draft` file — the same
 * regex `packages/core`'s `chapterTail` and `voice.ts`'s `stripFrontmatter`
 * both use, so a draft that is itself a previous `pablo prose --out` (or a
 * chapter file) reads back the same way pablo wrote it. Unlike `chapterTail`,
 * this keeps the WHOLE body: revise wants the complete previous piece, not a
 * tail cut to N words.
 */
function stripDraftFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "").trim();
}

/**
 * `--instruction` is untrusted, model-controlled text over MCP: unlike
 * `--voice`/`--brief`/`--context`/`--draft`/`--out`, it never names a file
 * (there is nothing to bind to a vault boundary), it is inline text that
 * lands directly in the assembled prompt as the "# What to change" slice,
 * immediately before the closing directive. A CR/LF inside it could open a
 * new line starting with "#" or "---", forging what looks like one of the
 * pack's own slice headings — or, worse, a fake closing line placed to read
 * as if it came after the real one. This is exactly the heading-injection
 * risk `voice.ts`'s `flagLine` already defends `line` AND `section` against
 * (AGT-1243, security review — that ticket was gate-blocked once for
 * sanitising `line` but not `section`, its sibling raw-string argument; there
 * is only one raw-string argument here, but the lesson is the same: every
 * argument of this shape gets the same treatment, not just the obvious one).
 * Flattened to a single line before it is ever wrapped in a slice, so no line
 * inside it can begin a fresh section.
 */
function sanitizeInstruction(raw: string): string {
  return raw.replace(/[\r\n]+/g, " ").trim();
}

function refuse(code: number, message: string): ProseOutcome {
  return { body: { ok: false, code, message }, exitCode: code };
}

function dryRunBody(pack: Pack): ProseDryRunBody {
  const actionByName = new Map(pack.adjustments.map((adjustment) => [adjustment.name, adjustment.action]));
  return {
    ok: true,
    dryRun: true,
    slices: pack.slices.map((slice) => {
      const action = actionByName.get(slice.name);
      return {
        name: slice.name,
        heading: slice.heading,
        source: slice.source,
        tokens: slice.tokens,
        ...(action !== undefined ? { action } : {}),
      };
    }),
    totalTokens: pack.totalTokens,
    expectedOutputTokens: pack.expectedOutputTokens,
    prompt_hash: pack.hash,
    adjustments: pack.adjustments,
  };
}

type AssembleOutcome =
  | {
      readonly ok: true;
      readonly pack: Pack;
      readonly voice: Voice;
      readonly revisedFrom: string | undefined;
      /** AGT-1262: the brief's own raw text, threaded to `sendProse` so an out-less queued title can use its first line (AC2) without re-reading `--brief -`'s stdin a second time. */
      readonly briefText: string;
    }
  | { readonly ok: false; readonly outcome: ProseOutcome };

/**
 * The synchronous, side-effect-free half: resolve `--voice` (AC4: works with
 * no vault at all — a global voice resolves from `~/.config/pablo/voices/`,
 * `resolveVoice`'s own fallback), read the brief, every `--context` file and
 * `--draft` (AGT-1244), and assemble the pack. Reads files; sends nothing,
 * writes nothing.
 */
function assembleProse(args: ProseCoreArgs, ctx: ProseCoreContext): AssembleOutcome {
  const fail = (outcome: ProseOutcome): AssembleOutcome => ({ ok: false, outcome });

  // AC2: --draft and --instruction are a pair or neither is given. Checked
  // first and independent of every other argument, so it refuses (exit 2)
  // even before an otherwise-missing --voice/--brief would.
  if ((args.draft === undefined) !== (args.instruction === undefined)) {
    return fail(
      refuse(
        2,
        args.draft === undefined
          ? "pablo: prose --instruction requires --draft <file>"
          : "pablo: prose --draft requires --instruction \"<text>\"",
      ),
    );
  }

  if (args.voice === undefined) {
    return fail(refuse(2, "pablo: prose requires --voice <name>"));
  }

  const resolution = resolveVoice(args.voice, { cwd: ctx.cwd, env: ctx.env });
  if (!resolution.ok) {
    return fail({
      body: { ok: false, code: resolution.code, message: resolution.message, tried: resolution.tried },
      exitCode: resolution.code,
    });
  }
  const voice = readVoice(resolution.path);

  if (args.brief === undefined) {
    return fail(refuse(2, "pablo: prose requires --brief <file|->"));
  }

  const briefResult = readBrief(args.brief);
  if (!briefResult.ok) {
    return fail({ body: { ok: false, code: briefResult.code, message: briefResult.message }, exitCode: briefResult.code });
  }

  const context: TextSource[] = [];
  for (const path of args.context) {
    const result = readProseFile(path, "--context");
    if (!result.ok) return fail({ body: { ok: false, code: result.code, message: result.message }, exitCode: result.code });
    context.push(result.source);
  }

  let draft: TextSource | undefined;
  let instruction: string | undefined;
  let revisedFrom: string | undefined;
  if (args.draft !== undefined) {
    const draftResult = readProseFile(args.draft, "--draft");
    if (!draftResult.ok) return fail({ body: { ok: false, code: draftResult.code, message: draftResult.message }, exitCode: draftResult.code });
    // AC3: the draft's OWN `prompt_hash`, from its own frontmatter (pablo's
    // provenance block, written by a prior `pablo prose --out` or `write`) —
    // "unknown" when the draft carries no frontmatter at all, or frontmatter
    // with no `prompt_hash` field, rather than a refusal: a hand-edited or
    // hand-written draft is a legitimate thing to revise.
    const draftFrontmatter = parseFrontmatter(draftResult.source.text);
    revisedFrom = draftFrontmatter["prompt_hash"] ?? UNKNOWN_REVISED_FROM;
    draft = { path: draftResult.source.path, text: stripDraftFrontmatter(draftResult.source.text) };
    // The pairing check above guarantees instruction is defined here too.
    instruction = sanitizeInstruction(args.instruction as string);
  }

  const built = buildProsePack(voice, { brief: briefResult.source, context, format: args.format, words: args.words, draft, instruction });
  if (!built.ok) return fail({ body: built, exitCode: built.code });

  return { ok: true, pack: built.pack, voice, revisedFrom, briefText: briefResult.source.text };
}

/**
 * The core: assemble, then either return the dry-run body (AGT-1241's AC2) or
 * send the pack once and return the send body (AGT-1242's AC2). Every failure
 * is returned data, never a thrown exception, exactly like
 * `saveCore`/`checkWork`.
 */
export async function proseCore(args: ProseCoreArgs, ctx: ProseCoreContext, deps: ProseDeps = {}): Promise<ProseOutcome> {
  const assembled = assembleProse(args, ctx);
  if (!assembled.ok) return assembled.outcome;

  if (args.dryRun) {
    return { body: dryRunBody(assembled.pack), exitCode: 0, pack: assembled.pack };
  }

  return await sendProse(assembled.pack, assembled.voice, assembled.revisedFrom, assembled.briefText, args, ctx, deps);
}

// ---------------------------------------------------------------------------
// The send path (AGT-1242) — routing, one model call, --out, receipt, check.
// ---------------------------------------------------------------------------

/** `seconds(ms)` for the progress lines — `write.ts`'s own formatting. */
function seconds(ms: number): string {
  return (Math.max(ms, 0) / 1000).toFixed(1);
}

interface Routed {
  readonly providerId: string;
  readonly adapter: Adapter;
  readonly timeoutMs: number;
}

/**
 * Which provider this call goes to (AC1): the voice's own `model:` frontmatter
 * when it names a CONFIGURED provider id, else whatever `route` picks for the
 * `prose`/`copy` intent (the local writer, out of the box). A `model:` naming
 * something that is not a configured provider is a refusal that says so rather
 * than a silent fallback to the default — the author asked for a specific
 * model and quietly using another one is exactly the failure a receipt is
 * meant to make impossible.
 *
 * `loadConfig` reads `ctx.env`, never the ambient environment, so a test (or
 * an MCP caller) pointing `XDG_CONFIG_HOME` at a temp directory is never
 * bypassed. A malformed config file throws `ProviderConfigError`; AC5 makes
 * that a refusal, so it is caught here.
 */
function routeProse(pack: Pack, voice: Voice, ctx: ProseCoreContext, deps: ProseDeps): Routed | ProseOutcome {
  let providers: ReturnType<typeof createProviders>;
  try {
    providers = createProviders(loadConfig({ env: ctx.env }));
  } catch (error) {
    if (error instanceof ProviderConfigError) return refuse(2, error.message);
    throw error;
  }

  let providerId: string;
  if (voice.model !== undefined) {
    if (!providers.ids.includes(voice.model)) {
      return refuse(
        2,
        `pablo: prose: voice "${voice.name}" names model "${voice.model}", which is not a configured provider ` +
          `(configured: ${providers.ids.join(", ")})`,
      );
    }
    providerId = voice.model;
  } else {
    providerId = providers.route(PROSE_INTENT);
  }

  try {
    // An injected adapter replaces the routed one entirely (tests), but the
    // resolution above still runs — a test still exercises AC1's real routing,
    // and `providers.rates(providerId)` still prices the timeout from the
    // routed endpoint's own measurements either way.
    const adapter = deps.adapter ?? providers.adapter(providerId);
    return { providerId, adapter, timeoutMs: packTimeoutMs(pack, providers.rates(providerId)) };
  } catch (error) {
    if (error instanceof ProviderConfigError) return refuse(2, error.message);
    throw error;
  }
}

/**
 * Where this run's receipt lands (AC3): `<vault>/.pablo/receipts.jsonl` when
 * there is a vault, else `$XDG_STATE_HOME/pablo/receipts.jsonl` (default
 * `~/.local/state/pablo/`). Both are created on first use — core's
 * `fileReceiptSink` and `paths.ts`'s `jsonlReceiptSink` each `mkdir -p` before
 * appending. An email drafted from a random directory still leaves a receipt.
 */
function receiptSinkFor(ctx: ProseCoreContext): ReceiptSink {
  const vault = findVault(ctx.cwd, ctx.env);
  if (vault.ok) return fileReceiptSink(vault.path);
  return jsonlReceiptSink(stateReceiptsPath(ctx.env));
}

/**
 * The `--out` file's provenance frontmatter (AC2), key order fixed: `voice`,
 * `model`, `generated`, `prompt_hash`, `revised_from` (AGT-1244, only for a
 * revise call), `words`. `yamlScalar` is `write.ts`'s one quoting rule,
 * imported rather than re-implemented.
 */
function proseFrontmatter(fields: {
  readonly voice: string;
  readonly model: string;
  readonly generated: string;
  readonly promptHash: string;
  readonly revisedFrom: string | undefined;
  readonly words: number;
}): string {
  return [
    "---",
    `voice: ${yamlScalar(fields.voice)}`,
    `model: ${yamlScalar(fields.model)}`,
    `generated: ${fields.generated}`,
    `prompt_hash: ${fields.promptHash}`,
    ...(fields.revisedFrom !== undefined ? [`revised_from: ${yamlScalar(fields.revisedFrom)}`] : []),
    `words: ${fields.words}`,
    "---",
  ].join("\n");
}

/** The first non-empty line of `text`, trimmed, cut to `maxLen` characters — AGT-1262 AC2's out-less queued title. */
function firstNonEmptyLine(text: string, maxLen: number): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return (line ?? "").slice(0, maxLen);
}

interface QueuePieceInput {
  readonly env: Record<string, string | undefined>;
  readonly id: string;
  readonly at: string;
  readonly title: string;
  readonly path: string;
  readonly cwd: string;
  readonly words: number;
  readonly promptHash: string;
}

/**
 * Appends this piece's `queued` event to `stateReviewPath(env)` — the same
 * one global queue `write.ts`'s `queue` ritual appends to, never
 * vault-relative (AGT-1262, the design doc's "one global queue"). `vault` is
 * included when `findVault` resolves one from `cwd`, omitted otherwise (a
 * `prose` call has no `--project` and often no vault at all).
 *
 * Never throws: an append failure (an unwritable state directory) is caught
 * and returned as `"failed: <detail>"` for the caller to surface as
 * `ProseSendBody.queue`, exactly as `write.ts`'s `queue` ritual reports a
 * `"failed"` status — a review-queue write is never allowed to fail the
 * prose call that already produced its text.
 */
function queuePiece(input: QueuePieceInput): string | undefined {
  const vault = findVault(input.cwd, input.env);

  const event: QueuedEvent = {
    type: "queued",
    id: input.id,
    at: input.at,
    kind: "prose",
    title: input.title,
    path: input.path,
    ...(vault.ok ? { vault: vault.path } : {}),
    words: input.words,
    prompt_hash: input.promptHash,
  };

  try {
    appendEvent(stateReviewPath(input.env), event);
    return undefined;
  } catch (err) {
    return `failed: ${errMessage(err)}`;
  }
}

/**
 * Sends the pack once and turns the answer into AC2's body: stream to the
 * routed provider (progress to stderr only, so `--json` stdout stays one
 * line — AC5), normalize, refuse on an empty answer, write `--out` if asked,
 * check the text against the voice's own rules, and return the receipt. The
 * receipt itself is appended by `withReceipts`, whichever way the call ends.
 * AGT-1262: also writes the out-less drafts file (AC3) and appends this
 * piece's `queued` event to the review queue (AC2) — a queue-append failure
 * is reported in the body as `queue: "failed: <detail>"` and never changes
 * `exitCode`, the same failure-isolation `write.ts`'s `queue` ritual gives
 * `pablo write`.
 */
async function sendProse(
  pack: Pack,
  voice: Voice,
  revisedFrom: string | undefined,
  briefText: string,
  args: ProseCoreArgs,
  ctx: ProseCoreContext,
  deps: ProseDeps,
): Promise<ProseOutcome> {
  // The `--out` file is checked BEFORE anything is sent: an existing file
  // without `--force` must refuse without having spent a model call (AC2), and
  // AC5's "no --out file" on a failure is easiest to guarantee by never
  // creating one until the answer is in hand.
  const outPath = args.out === undefined ? undefined : resolvePath(ctx.cwd, args.out);
  if (outPath !== undefined && existsSync(outPath) && !args.force) {
    return refuse(2, `pablo: ${outPath} already exists; use --force to overwrite`);
  }

  const routed = routeProse(pack, voice, ctx, deps);
  if ("body" in routed) return routed;

  const wrapped = withReceipts(routed.adapter, receiptSinkFor(ctx), { pack, intent: "prose" });

  const stderr = deps.stderr ?? process.stderr;
  const now = deps.now ?? (() => new Date());

  const startedAt = Date.now();
  let firstTokenAt: number | undefined;
  let lastProgressAt = startedAt;
  let tokenEvents = 0;
  let text = "";
  let stats: CompletionStats | undefined;

  stderr.write("waiting for first token…\n");

  try {
    for await (const ev of wrapped.complete({
      prompt: pack.prompt,
      maxTokens: pack.expectedOutputTokens * 2,
      timeoutMs: routed.timeoutMs,
    })) {
      if (ev.type === "token") {
        text += ev.text;
        tokenEvents += 1;
        const nowMs = Date.now();
        if (firstTokenAt === undefined) {
          firstTokenAt = nowMs;
          lastProgressAt = nowMs;
          stderr.write(`first token after ${seconds(nowMs - startedAt)}s\n`);
        } else if (nowMs - lastProgressAt >= PROGRESS_INTERVAL_MS) {
          const rate = tokenEvents / Math.max((nowMs - firstTokenAt) / 1000, 0.001);
          stderr.write(`${tokenEvents} tokens, ${rate.toFixed(1)} tok/s\n`);
          lastProgressAt = nowMs;
        }
      } else {
        stats = ev.stats;
      }
    }
  } catch (error) {
    stderr.write("\n");
    if (error instanceof EndpointHung || error instanceof ProviderResponseError || error instanceof ProviderConfigError) {
      return refuse(2, error.message);
    }
    throw error;
  }

  stderr.write("\n");

  const normalized = normalizeOutput(text);
  if (normalized === "" || stats === undefined) {
    return refuse(2, "pablo: the model returned an empty answer; nothing written");
  }

  const words = normalized.split(/\s+/).filter((word) => word !== "").length;

  // AC4: the mechanical rules plus this voice's own `Flagged:` lines — for
  // `fiction` those come from `style/prose.md`, which `readVoice` has already
  // put in `voice.rules`, so there is no special case here.
  const hits = checkFile(normalized, outPath ?? `(${voice.name})`, checkRulesFromVoice(voice));

  const receipt: ProseReceiptSummary = {
    prompt_hash: pack.hash,
    model: routed.adapter.model,
    tokensRead: stats.tokensRead ?? pack.totalTokens,
    tokensWritten: stats.tokensWritten,
    timeToFirstTokenMs: Math.round(stats.timeToFirstTokenMs),
    wallMs: Math.round(stats.elapsedMs),
    words,
    ...(revisedFrom !== undefined ? { revised_from: revisedFrom } : {}),
  };

  const generated = now().toISOString();
  // AGT-1262 AC2/AC4: minted once this piece is a real, completed send — a
  // dry run or a refusal earlier in this function never mints one.
  const pieceId = mintPieceId(now(), voice.name);

  if (outPath === undefined) {
    // AC3: an out-less piece still prints to stdout unchanged (the caller
    // does that with `body.text`), but also lands on disk — the same
    // frontmatter `--out` would write — at `stateDraftsDir()/<id>.md`, so
    // the review queue's `path` names a file the editor can actually open.
    const draftPath = join(stateDraftsDir(ctx.env), `${pieceId}.md`);
    const draftFrontmatter = proseFrontmatter({
      voice: voice.name,
      model: routed.adapter.model,
      generated,
      promptHash: pack.hash,
      revisedFrom,
      words,
    });
    mkdirSync(dirname(draftPath), { recursive: true });
    writeFileSync(draftPath, `${draftFrontmatter}\n\n${normalized}\n`, "utf8");

    const queueFailure = queuePiece({
      env: ctx.env,
      id: pieceId,
      at: generated,
      title: firstNonEmptyLine(briefText, 60),
      path: draftPath,
      cwd: ctx.cwd,
      words,
      promptHash: pack.hash,
    });

    return {
      body: {
        ok: true,
        text: normalized,
        receipt,
        check: hits,
        piece: pieceId,
        ...(queueFailure !== undefined ? { queue: queueFailure } : {}),
      },
      exitCode: 0,
    };
  }

  const frontmatter = proseFrontmatter({
    voice: voice.name,
    model: routed.adapter.model,
    generated,
    promptHash: pack.hash,
    revisedFrom,
    words,
  });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${frontmatter}\n\n${normalized}\n`, "utf8");

  // Committed by pathspec from the file's own directory, so this works
  // anywhere inside a working tree without knowing the repo root (the pattern
  // `voice.ts` already uses). Outside a repository — or with nothing to
  // commit — `gitCommit` returns a notice; a git failure is never fatal to a
  // file that is already on disk (CLAUDE.md's git convention).
  const { committed, notice } = gitCommit(dirname(outPath), `prose: ${basename(outPath)}`, [outPath]);

  // AC2: a --out piece's title is the --out basename without its extension.
  const queueFailure = queuePiece({
    env: ctx.env,
    id: pieceId,
    at: generated,
    title: basename(outPath, extname(outPath)),
    path: outPath,
    cwd: ctx.cwd,
    words,
    promptHash: pack.hash,
  });

  return {
    body: {
      ok: true,
      text: normalized,
      receipt,
      check: hits,
      path: outPath,
      committed,
      ...(notice ? { notice } : {}),
      piece: pieceId,
      ...(queueFailure !== undefined ? { queue: queueFailure } : {}),
    },
    exitCode: 0,
  };
}

/** `--words`'s value as a positive integer, or `undefined` for anything else (including absent) — mirrors `write.ts`'s own parser, duplicated rather than imported since `write.ts` is another ticket's file this build must not touch. */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value > 0 ? value : undefined;
}

/** One line per `check` hit, in the exact format `check.ts`'s `runCheck` and `write.ts` both print. */
function formatHitLine(hit: Hit): string {
  const detail = hit.detail !== undefined ? ` (${hit.detail})` : "";
  return `${hit.path}:${hit.line} ${hit.rule} — ${hit.excerpt}${detail}`;
}

/**
 * `pablo prose`'s CLI entry point: parses `--words`, calls `proseCore`, and
 * prints — JSON (AC2's exact shape, one line) or, for a human, either the
 * answer itself followed by its `check` hits (AC4) or, with `--dry-run`, the
 * pack's rendered table and estimated wait via `renderPack` (the same view
 * `pablo write --dry-run` uses). Returns the process exit code; never throws.
 */
export async function runProse(args: ProseCliArgs, ctx: ProseCoreContext, deps: ProseDeps = {}): Promise<number> {
  const outcome = await proseCore(
    {
      voice: args.voice,
      brief: args.brief,
      context: args.context,
      format: args.format,
      words: parsePositiveInt(args.words),
      dryRun: args.dryRun,
      out: args.out,
      force: args.force,
      draft: args.draft,
      instruction: args.instruction,
    },
    ctx,
    deps,
  );

  if (!outcome.body.ok) {
    if (args.json) {
      console.log(JSON.stringify(outcome.body));
    } else {
      console.error(outcome.body.message);
    }
    return outcome.exitCode;
  }

  if (args.json) {
    console.log(JSON.stringify(outcome.body));
    return outcome.exitCode;
  }

  if ("text" in outcome.body) {
    // AC2/AC4: the normalized answer, then the check hits after it. stdout
    // carries the piece and nothing else — the hits, the `--out` path and any
    // git notice go to stderr, so `pablo prose ... > email.txt` captures the
    // prose alone. (`write` prints its hits on stdout, but there stdout is a
    // one-line report about a file; here it IS the deliverable.) On a terminal
    // both streams still arrive together, in this order.
    console.log(outcome.body.text);
    const stderr = deps.stderr ?? process.stderr;
    if (outcome.body.path !== undefined) {
      stderr.write(`wrote ${outcome.body.path}${outcome.body.committed === true ? " (committed)" : ""}\n`);
    }
    if (outcome.body.notice !== undefined) stderr.write(`${outcome.body.notice}\n`);
    for (const hit of outcome.body.check) stderr.write(`${formatHitLine(hit)}\n`);
    if (outcome.body.queue !== undefined) stderr.write(`queue: ${outcome.body.queue}\n`);
    // AGT-1262 AC4: the review queue's piece id, trailing every other line —
    // stdout stays the deliverable alone (AC2/AC5), so this goes to stderr
    // with the rest of the report.
    stderr.write(`piece ${outcome.body.piece}\n`);
    return outcome.exitCode;
  }

  const providers = createProviders(loadConfig({ env: ctx.env }));
  const providerId = providers.route(PROSE_INTENT);
  console.log(renderPack(outcome.pack as Pack, providers.rates(providerId)).text);
  return outcome.exitCode;
}
