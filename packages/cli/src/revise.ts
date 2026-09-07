/**
 * `pablo revise --project <slug> --file F (--passage "<quoted text>" | --start N --end N)
 *   --instruction "<text>" [--dry-run] [--json]` (AGT-1264): sends ONE located
 * passage of a manuscript through the local model and returns a candidate.
 * **Writes nothing** — the file on disk is byte-identical before and after
 * every call. See the design doc's `revise` row
 * (`~/saltline-digital-vault/projects/ai-terminal/README.md`) and
 * `review-tray.md`'s "The editor" section: the author (or, later, the ui-leaf
 * editor view, AGT-1269) takes the candidate, edits it, or drops it — `save`
 * is the only thing that ever commits a change to the chapter file.
 *
 * `locatePassage` and the `revise` pack kind (`ReviseInputs`, `reviseSpecs`,
 * `PACK_BUDGETS.revise`, `REVISE_CLOSING`) are AGT-1257's core additions; this
 * file is the send half — assembling those inputs from a real chapter file and
 * a real project's style/work-rules, then routing, streaming, and receipting
 * exactly the way `prose.ts`'s `sendProse` does (AGT-1242), reused rather than
 * reimplemented: same `withReceipts` wrapper, same `packTimeoutMs`, same
 * `EndpointHung`/`ProviderResponseError`/`ProviderConfigError` refusals, same
 * injectable `{adapter, now, stderr}` so no test touches the network.
 *
 * Split mirrors `proseCore`/`runProse` (and `saveCore`/`runSave`): `runRevise`
 * is the CLI's thin printing wrapper; `reviseCore` is the pure-data half (never
 * prints, never throws — every failure is returned data) that both `runRevise`
 * and `verbs.ts`'s MCP `run` call. `assembleRevise` goes one layer further
 * still: given an ALREADY-LOCATED span (no `--passage`/`--start`/`--end`
 * parsing, no `locatePassage` call), it reads the file, strips frontmatter,
 * takes the paragraph before/after, and assembles the pack — the exact shape
 * AGT-1269's editor host needs (it already knows the span it is asking about;
 * it has no argv to parse).
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  assemblePack,
  createProviders,
  EndpointHung,
  fileReceiptSink,
  isWithin,
  loadConfig,
  locatePassage,
  normalizeOutput,
  packTimeoutMs,
  ProviderConfigError,
  ProviderResponseError,
  readStyle,
  readWorkRules,
  renderPack,
  withReceipts,
} from "@openthink/pablo-core";
import type { Adapter, CompletionStats, Intent, Pack, Span, SliceAction, SliceAdjustment } from "@openthink/pablo-core";

/** A minimal `process.stderr`-shaped sink — mirrors `write.ts`'s/`prose.ts`'s `ProgressSink`. */
export interface ProgressSink {
  write(text: string): void;
}

/** Dependencies a caller can inject; production code omits all of them. Mirrors `prose.ts`'s `ProseDeps`. */
export interface ReviseDeps {
  /** Overrides the provider registry's adapter entirely — the only way tests avoid the network. */
  readonly adapter?: Adapter | undefined;
  /** Overrides where streaming progress is written. Defaults to `process.stderr`. */
  readonly stderr?: ProgressSink | undefined;
}

/** `reviseCore`'s own fields, already the right *types* — the CLI's raw string argv and MCP's already-typed zod args each map onto this the same way. */
export interface ReviseCoreArgs {
  /** Work-relative or absolute path to the chapter file to read. */
  readonly file: string;
  /** The passage to rewrite, quoted verbatim (whitespace-run tolerant — see `locatePassage`). Exactly one of `passage` or `start`+`end` is required. */
  readonly passage: string | undefined;
  /** UTF-16 offset into the frontmatter-stripped body where the passage begins (half-open, with `end`). Alternative to `passage`. */
  readonly start: number | undefined;
  /** UTF-16 offset into the frontmatter-stripped body where the passage ends (half-open, with `start`). */
  readonly end: number | undefined;
  /** What to change about the passage, in the author's own words. */
  readonly instruction: string | undefined;
  readonly dryRun: boolean;
}

/** What `reviseCore` needs beyond its own args: the resolved project it operates in. */
export interface ReviseCoreContext {
  readonly vaultRoot: string;
  readonly projectPath: string;
  readonly env: Record<string, string | undefined>;
}

export interface ReviseRefusalBody {
  readonly ok: false;
  readonly code: number;
  readonly message: string;
}

/** AC4's `--dry-run --json`: the pack slice by slice, exactly `write --dry-run`'s and `prose --dry-run`'s shape. */
export interface ReviseDryRunSlice {
  readonly name: string;
  readonly heading: string;
  readonly source: string | undefined;
  readonly tokens: number;
  readonly action?: SliceAction;
}

export interface ReviseDryRunBody {
  readonly ok: true;
  readonly dryRun: true;
  readonly slices: readonly ReviseDryRunSlice[];
  readonly totalTokens: number;
  readonly expectedOutputTokens: number;
  readonly prompt_hash: string;
  readonly adjustments: readonly SliceAdjustment[];
}

/** The receipt a send returns (AC3) — the same fields `write`'s/`prose`'s own receipts carry, minus anything specific to writing a file. */
export interface ReviseReceiptSummary {
  readonly prompt_hash: string;
  readonly model: string;
  readonly tokensRead: number;
  readonly tokensWritten: number;
  readonly timeToFirstTokenMs: number;
  readonly wallMs: number;
  readonly words: number;
}

/** AC3's exact send body: the candidate is returned, never written. */
export interface ReviseSendBody {
  readonly ok: true;
  readonly candidate: string;
  readonly span: Span;
  readonly receipt: ReviseReceiptSummary;
}

export type ReviseBody = ReviseRefusalBody | ReviseDryRunBody | ReviseSendBody;

export interface ReviseOutcome {
  readonly body: ReviseBody;
  readonly exitCode: number;
  /** Present only alongside a successful dry-run body — the CLI's non-JSON rendering needs the `Pack` itself, not just its JSON-safe body. */
  readonly pack?: Pack;
}

/**
 * The intent every revise call routes under (AC1): `kind: "revising"` already
 * routes local by default (`route()`'s `kind !== "planning" -> local` rule,
 * `providers/registry.ts`) — a config's `intents: {"revise": "anthropic"}`
 * mapping moves it, same as any other intent.
 */
const REVISE_INTENT: Intent = { name: "revise", kind: "revising" };

/** How often (ms) the streaming progress line refreshes once tokens are flowing — `write.ts`'s/`prose.ts`'s interval. */
const PROGRESS_INTERVAL_MS = 2000;

function seconds(ms: number): string {
  return (Math.max(ms, 0) / 1000).toFixed(1);
}

function refuse(code: number, message: string): ReviseOutcome {
  return { body: { ok: false, code, message }, exitCode: code };
}

/**
 * `--instruction` is untrusted, model-controlled text over MCP, landing
 * directly in the assembled prompt as the "# What to change" slice,
 * immediately before the closing directive. Flattened to one line for the
 * same reason `prose.ts`'s `sanitizeInstruction` flattens its own —
 * heading-injection via an embedded CR/LF is exactly the risk AGT-1243's
 * security review (and AGT-1244's, on this exact field's `prose` sibling)
 * already found once; duplicated here rather than imported since `prose.ts`
 * doesn't export it and this build must not widen that file's surface for a
 * one-line utility.
 */
function sanitizeInstruction(raw: string): string {
  return raw.replace(/[\r\n]+/g, " ").trim();
}

/** Strips a leading YAML frontmatter block, same regex `chapterTail`/`prose.ts`'s `stripDraftFrontmatter` use — but keeps the body untrimmed, so the offsets `--start`/`--end` name stay exactly the ones a caller would compute against this same slice. */
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\s*/;

function stripFrontmatter(text: string): string {
  const match = FRONTMATTER_RE.exec(text);
  return match === null ? text : text.slice(match[0].length);
}

/**
 * Non-empty-paragraph spans of `body`, split on runs of 2+ newlines (a blank
 * line), in document order and in `body`'s own offsets — the same "split on
 * blank lines" the ticket's implementation notes ask for.
 */
function paragraphSpans(body: string): readonly Span[] {
  const spans: Span[] = [];
  const breakRe = /\n{2,}/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = breakRe.exec(body)) !== null) {
    spans.push({ start: cursor, end: match.index });
    cursor = match.index + match[0].length;
  }
  spans.push({ start: cursor, end: body.length });
  return spans.filter((span) => body.slice(span.start, span.end).trim() !== "");
}

/** The last paragraph span whose start is at or before `pos` — the paragraph `pos` falls inside (or, for a `pos` inside a blank-line gap, the nearest one before it). */
function paragraphIndexAt(spans: readonly Span[], pos: number): number {
  let index = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (span !== undefined && span.start <= pos) index = i;
    else break;
  }
  return index;
}

/**
 * The manuscript's own paragraph immediately before and after `span` — the
 * continuity context `ReviseInputs.before`/`.after` carry. An empty string at
 * either end when the passage opens or closes the document.
 */
export function neighbourParagraphs(body: string, span: Span): { readonly before: string; readonly after: string } {
  const spans = paragraphSpans(body);
  if (spans.length === 0) return { before: "", after: "" };

  const startIdx = paragraphIndexAt(spans, span.start);
  const endPos = span.end > span.start ? span.end - 1 : span.end;
  const endIdx = paragraphIndexAt(spans, endPos);

  const beforeSpan = startIdx > 0 ? spans[startIdx - 1] : undefined;
  const afterSpan = endIdx + 1 < spans.length ? spans[endIdx + 1] : undefined;

  return {
    before: beforeSpan === undefined ? "" : body.slice(beforeSpan.start, beforeSpan.end).trim(),
    after: afterSpan === undefined ? "" : body.slice(afterSpan.start, afterSpan.end).trim(),
  };
}

type FileReadResult = { readonly ok: true; readonly resolved: string; readonly body: string };
type FileReadOutcome = FileReadResult | { readonly ok: false; readonly code: 2; readonly message: string };

/**
 * `file` resolved against `projectPath` (or used as-is if absolute), read,
 * and frontmatter-stripped. Must resolve INSIDE `projectPath` — the same "a
 * manuscript path never leaves its own work" rule `check.ts`'s `checkWork`
 * already enforces for every caller, CLI or MCP alike, not just a
 * model-controlled one. The one place this bound/read is written; both
 * `reviseCore` (which needs the body before it can run `locatePassage`) and
 * `assembleRevise` (called with a span already in hand) go through it rather
 * than each re-deriving the same resolve-then-existsSync check.
 */
function readManuscriptBody(projectPath: string, file: string): FileReadOutcome {
  const resolved = isAbsolute(file) ? resolve(file) : resolve(projectPath, file);
  const rel = relative(projectPath, resolved);
  if (rel === "" || rel === ".." || rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, code: 2, message: `pablo: revise --file ${file} resolves outside the work (${projectPath})` };
  }
  if (!existsSync(resolved)) {
    return { ok: false, code: 2, message: `pablo: revise --file ${file} does not exist (${resolved})` };
  }
  const raw = readFileSync(resolved, "utf8");
  return { ok: true, resolved, body: stripFrontmatter(raw) };
}

export interface AssembleReviseOptions {
  /** Work-relative or absolute path to the chapter file. */
  readonly file: string;
  /** The already-located span, in the frontmatter-stripped body's own UTF-16 offsets. */
  readonly span: Span;
  /** What to change about the passage, in the caller's own words — raw, untrimmed text is fine; see `buildRevisePack`. */
  readonly instruction: string;
}

export type AssembleReviseResult =
  | { readonly ok: true; readonly pack: Pack; readonly body: string; readonly filePath: string }
  | { readonly ok: false; readonly code: 2; readonly message: string };

/**
 * Builds the `revise` pack from an already-read `body` and an already-valid
 * `span` — the one place `style`/`workRules`/`before`/`passage`/`after` are
 * turned into a `Pack`, shared by `assembleRevise` (which reads the file
 * itself) and `reviseCore` (which already has `body` in hand from resolving
 * `--passage`/`--start`/`--end` and must not read the file a second time —
 * `standards` review on this ticket's first pass caught exactly that TOCTOU
 * double-read).
 *
 * `instruction` is sanitized HERE, not by each caller: `security` review on
 * this ticket's first pass flagged that a future caller of `assembleRevise`
 * (AGT-1269's editor host) could skip a caller-side `sanitizeInstruction`
 * step and silently reopen the heading-injection risk AGT-1243/AGT-1244
 * already found on `prose`'s sibling field. Sanitizing inside the one
 * function every caller (CLI, MCP, and the future editor host) funnels
 * through makes it impossible to skip; calling it twice (as `reviseCore`
 * does, on top of `runRevise`'s CLI path) is harmless — flatten-and-trim is
 * idempotent.
 */
function buildRevisePack(vaultRoot: string, projectPath: string, body: string, span: Span, instruction: string): Pack {
  const passage = body.slice(span.start, span.end);
  const { before, after } = neighbourParagraphs(body, span);
  return assemblePack("revise", {
    style: readStyle(vaultRoot),
    workRules: readWorkRules(vaultRoot, projectPath),
    before,
    passage,
    after,
    instruction: sanitizeInstruction(instruction),
  });
}

/**
 * The pure "read file, locate, build inputs" half AGT-1269's editor host
 * calls directly, with a span it already has — no argv, no `locatePassage`.
 * Reads files; sends nothing, writes nothing.
 */
export function assembleRevise(vaultRoot: string, projectPath: string, options: AssembleReviseOptions): AssembleReviseResult {
  const read = readManuscriptBody(projectPath, options.file);
  if (!read.ok) return read;
  const { resolved, body } = read;

  if (!isWithin({ path: resolved, text: body }, options.span)) {
    return {
      ok: false,
      code: 2,
      message: `pablo: revise: span [${options.span.start}, ${options.span.end}) does not address ${relative(projectPath, resolved)} (${body.length} characters after frontmatter)`,
    };
  }

  const pack = buildRevisePack(vaultRoot, projectPath, body, options.span, options.instruction);
  return { ok: true, pack, body, filePath: resolved };
}

function dryRunBody(pack: Pack): ReviseDryRunBody {
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

type ResolvedSpan = { readonly ok: true; readonly span: Span } | { readonly ok: false; readonly outcome: ReviseOutcome };

/**
 * AC1/AC2's selector rules: exactly one of `--passage` or `--start`+`--end`.
 * `--passage` is located with `locatePassage` (zero or many matches refuse,
 * naming the count); `--start`/`--end` are validated against the
 * frontmatter-stripped `body` with `isWithin` — the same precondition
 * `selectionText` enforces.
 */
function resolveSpan(args: ReviseCoreArgs, body: string, filePath: string): ResolvedSpan {
  const passageGiven = args.passage !== undefined;
  const startGiven = args.start !== undefined;
  const endGiven = args.end !== undefined;
  const rangeGiven = startGiven && endGiven;
  const rangePartial = startGiven !== endGiven;

  if (rangePartial) {
    return { ok: false, outcome: refuse(2, "pablo: revise --start requires --end (and vice versa)") };
  }
  if (passageGiven && rangeGiven) {
    return { ok: false, outcome: refuse(2, "pablo: revise: pass --passage OR --start/--end, not both") };
  }
  if (!passageGiven && !rangeGiven) {
    return { ok: false, outcome: refuse(2, 'pablo: revise requires --passage "<text>" or --start <n> --end <n>') };
  }

  if (passageGiven) {
    const located = locatePassage(body, args.passage as string);
    if (!located.ok) {
      const message =
        located.matches === 0
          ? "pablo: revise: --passage was not found in the manuscript"
          : `pablo: revise: --passage matched ${located.matches} places; it must match exactly one`;
      return { ok: false, outcome: refuse(2, message) };
    }
    return { ok: true, span: located.span };
  }

  const span: Span = { start: args.start as number, end: args.end as number };
  if (!isWithin({ path: filePath, text: body }, span)) {
    return {
      ok: false,
      outcome: refuse(
        2,
        `pablo: revise: --start/--end [${span.start}, ${span.end}) does not address the manuscript (${body.length} characters after frontmatter)`,
      ),
    };
  }
  return { ok: true, span };
}

interface Routed {
  readonly providerId: string;
  readonly adapter: Adapter;
  readonly timeoutMs: number;
}

/**
 * Which provider this call goes to (AC1): `route()`'s default for a
 * `revising`-kind intent, unless a config's `intents` mapping says otherwise.
 * `loadConfig` reads `ctx.env`, never the ambient environment, so a test (or
 * an MCP caller) pointing `XDG_CONFIG_HOME` at a temp directory is never
 * bypassed — the same AGT-1244 lesson `prose.ts`'s `routeProse` already
 * documents: one smoke call leaked to the real Anthropic API when this
 * override was omitted.
 */
function routeRevise(pack: Pack, ctx: ReviseCoreContext, deps: ReviseDeps): Routed | ReviseOutcome {
  let providers: ReturnType<typeof createProviders>;
  try {
    providers = createProviders(loadConfig({ env: ctx.env }));
  } catch (error) {
    if (error instanceof ProviderConfigError) return refuse(2, error.message);
    throw error;
  }

  const providerId = providers.route(REVISE_INTENT);

  try {
    const adapter = deps.adapter ?? providers.adapter(providerId);
    return { providerId, adapter, timeoutMs: packTimeoutMs(pack, providers.rates(providerId)) };
  } catch (error) {
    if (error instanceof ProviderConfigError) return refuse(2, error.message);
    throw error;
  }
}

/**
 * Sends `pack` once and turns the answer into AC3's body: stream to the
 * routed provider (progress to stderr only), normalize, refuse on an empty
 * answer, and return `{candidate, span, receipt}` — nothing is ever written.
 * The receipt itself is appended by `withReceipts`, whichever way the call
 * ends, at `<project>/.pablo/receipts.jsonl` (`write.ts`'s own convention:
 * one receipt log per work, not one per vault).
 */
async function sendRevise(pack: Pack, span: Span, ctx: ReviseCoreContext, deps: ReviseDeps): Promise<ReviseOutcome> {
  const routed = routeRevise(pack, ctx, deps);
  if ("body" in routed) return routed;

  const wrapped = withReceipts(routed.adapter, fileReceiptSink(ctx.projectPath), { pack, intent: "revise" });

  const stderr = deps.stderr ?? process.stderr;

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
    return refuse(2, "pablo: the model returned an empty answer; nothing revised");
  }

  const words = normalized.split(/\s+/).filter((word) => word !== "").length;

  const receipt: ReviseReceiptSummary = {
    prompt_hash: pack.hash,
    model: routed.adapter.model,
    tokensRead: stats.tokensRead ?? pack.totalTokens,
    tokensWritten: stats.tokensWritten,
    timeToFirstTokenMs: Math.round(stats.timeToFirstTokenMs),
    wallMs: Math.round(stats.elapsedMs),
    words,
  };

  return { body: { ok: true, candidate: normalized, span, receipt }, exitCode: 0 };
}

/**
 * The core: read the file, resolve the span (from `--passage` or
 * `--start`/`--end`), assemble the pack (`buildRevisePack` sanitizes
 * `--instruction`), then either return the dry-run body or send the pack
 * once. Every failure is returned data, never a thrown exception, exactly
 * like `proseCore`.
 */
export async function reviseCore(args: ReviseCoreArgs, ctx: ReviseCoreContext, deps: ReviseDeps = {}): Promise<ReviseOutcome> {
  if (args.instruction === undefined || args.instruction.trim() === "") {
    return refuse(2, 'pablo: revise requires --instruction "<text>"');
  }

  const read = readManuscriptBody(ctx.projectPath, args.file);
  if (!read.ok) return refuse(read.code, read.message);
  const { resolved, body } = read;

  const spanResult = resolveSpan(args, body, resolved);
  if (!spanResult.ok) return spanResult.outcome;

  // `buildRevisePack` sanitizes `instruction` itself (see its own doc
  // comment) — passed through here unsanitized rather than sanitized twice.
  const pack = buildRevisePack(ctx.vaultRoot, ctx.projectPath, body, spanResult.span, args.instruction);

  if (args.dryRun) {
    return { body: dryRunBody(pack), exitCode: 0, pack };
  }

  return await sendRevise(pack, spanResult.span, ctx, deps);
}

/** The CLI's own argv shape — `start`/`end` still raw strings (`node:util`'s `parseArgs` only knows string/boolean). */
export interface ReviseCliArgs {
  readonly file: string | undefined;
  readonly passage: string | undefined;
  readonly start: string | undefined;
  readonly end: string | undefined;
  readonly instruction: string | undefined;
  readonly dryRun: boolean;
  readonly json: boolean;
}

/** A UTF-16 offset as a non-negative integer, or `undefined` for anything else (including absent). */
function parseOffset(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

/** One line per `pablo check`-style hit format is not used here — `revise` reports no hits (AC3's body is exactly `{candidate, span, receipt}`). */
export async function runRevise(args: ReviseCliArgs, ctx: ReviseCoreContext, deps: ReviseDeps = {}): Promise<number> {
  if (args.file === undefined) {
    const message = "pablo: revise requires --file <path>";
    if (args.json) console.log(JSON.stringify({ ok: false, code: 2, message }));
    else console.error(message);
    return 2;
  }

  // A raw --start/--end that doesn't parse as a non-negative integer is
  // treated as "not given" here and caught by resolveSpan's own pairing/range
  // refusals downstream — `--start abc` and `--start` omitted both end up at
  // the same "requires --passage or --start/--end" (or "does not address")
  // message rather than a parse error with a different shape.
  const outcome = await reviseCore(
    {
      file: args.file,
      passage: args.passage,
      start: parseOffset(args.start),
      end: parseOffset(args.end),
      instruction: args.instruction,
      dryRun: args.dryRun,
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

  if ("candidate" in outcome.body) {
    console.log(outcome.body.candidate);
    return outcome.exitCode;
  }

  // Non-JSON --dry-run rendering: `createProviders`/`rates` can throw
  // `ProviderConfigError` on a malformed config, exactly the failure
  // `routeRevise` already guards on the send path — guarded the same way here
  // rather than letting it propagate as an uncaught exception.
  try {
    const providers = createProviders(loadConfig({ env: ctx.env }));
    const providerId = providers.route(REVISE_INTENT);
    console.log(renderPack(outcome.pack as Pack, providers.rates(providerId)).text);
    return outcome.exitCode;
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}
