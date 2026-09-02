/**
 * One span-edit run: assemble, price, send, measure (AC1, AC5, AC6).
 *
 * Split in two on purpose. `planSpanEdit` is everything that happens *before*
 * anything is sent — read the vault, assemble the pack, price it against the
 * endpoint's measured rates — and it is what the dry-run key shows instead of
 * sending (AC6). `runSpanEdit` takes that plan and streams the answer.
 *
 * **The run drives `complete()`, not `proposeEdit()`, and that is a deliberate
 * choice.** `proposeEdit` collects its own stream internally, so a caller cannot
 * see time to first token or tokens per second while it waits, and its receipt
 * is wall-clock only — `pack/receipts.ts` says as much in its own header. AC6
 * asks for both numbers *on screen during the run*, so pablo sends
 * `pack.prompt` through `complete()` and watches the stream itself, which also
 * earns a `measurement: "stream"` receipt.
 *
 * That choice decides the other one. The pack prices the closing line of the
 * path the caller says it will take (AGT-1202), and the path pablo actually
 * takes is CriticMarkup as text, not the `propose_edit` tool call: a bare
 * `complete()` has no tools to call. So the plan asks for
 * `output: "text"`, `pack.prompt` is byte-for-byte what goes over the wire, and
 * the receipt's `prompt_hash` identifies the real request. Asking the model to
 * call a tool it has not been given would be both a worse prompt and a lie in
 * the log.
 *
 * Nothing here writes to the manuscript, and nothing here touches a renderer.
 */

import {
  assemblePack,
  duration,
  fileReceiptSink,
  normalizeProposal,
  packTimeoutMs,
  renderPack,
  thousands,
  withReceipts,
  EndpointHung,
  ProviderResponseError,
  type CompletionStats,
  type Document,
  type Intent,
  type OutputMode,
  type Pack,
  type PackPreview,
  type Providers,
  type ReceiptSink,
  type Span,
} from "@openthink/pablo-core";
import { buildSpanEditInputs } from "./pack-inputs";

/** The ad-hoc `prompt` verb's intent. Revising routes to the local writer by default. */
export const PROMPT_INTENT: Intent = { name: "prompt", kind: "revising" };

/** A ceiling on the answer, so a model that will not stop is a failed run and not a hung one. */
const OUTPUT_HEADROOM = 2;

/**
 * The structured path a `complete()`-driven run takes: CriticMarkup in the
 * answer text. See the note at the top of this file.
 */
export const PROMPT_OUTPUT: OutputMode = "text";

export interface PlanOptions {
  readonly providers: Providers;
  readonly doc: Document;
  readonly span: Span;
  readonly instruction: string;
  /** Seam for AGT-1207: see `pack-inputs.ts`. */
  readonly extraContext?: string | undefined;
  readonly intent?: Intent;
  /**
   * Floor on the pack-sized idle timeout. 60s in the app, because that is the
   * adapter's own cold default and a big prefill is work rather than a hang;
   * the tests lower it so an endpoint that never answers fails in milliseconds.
   */
  readonly timeoutFloorMs?: number | undefined;
}

export interface SpanEditPlan {
  readonly pack: Pack;
  readonly preview: PackPreview;
  readonly intent: Intent;
  readonly providerId: string;
  readonly vaultRoot: string | undefined;
  readonly notices: readonly string[];
  /** Sized from the pack, not from the adapter's cold 60s default. */
  readonly timeoutMs: number;
  readonly span: Span;
  readonly instruction: string;
}

/** Live numbers for the status line while the answer streams in (AC6). */
export interface RunProgress {
  readonly timeToFirstTokenMs: number | undefined;
  readonly tokensWritten: number;
  readonly tokensPerSecond: number | undefined;
  readonly elapsedMs: number;
}

export interface RunOutcome {
  /** The model's answer, normalized. Not yet validated, and not yet written. */
  readonly answer: string;
  /** "read 4,900 tokens in 19s, wrote 1,500 in 50s" — stays until the next action. */
  readonly receipt: string;
}

export interface RunHooks {
  readonly onProgress?: (progress: RunProgress) => void;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  /** Receipts go to `<vault>/.pablo/receipts.jsonl`; a file outside a vault logs nowhere. */
  readonly sink?: ReceiptSink;
}

/**
 * Everything short of sending: the pack, its price, and where it would go.
 * Cheap enough to run on every prompt so the size and the wait are on screen
 * before the author commits to it (AC6).
 */
export function planSpanEdit(options: PlanOptions): SpanEditPlan {
  const built = buildSpanEditInputs({
    doc: options.doc,
    span: options.span,
    instruction: options.instruction,
    extraContext: options.extraContext,
    output: PROMPT_OUTPUT,
  });

  const intent = options.intent ?? PROMPT_INTENT;
  const pack = assemblePack("spanEdit", built.inputs);
  const providerId = options.providers.route(intent);
  const rates = options.providers.rates(providerId);

  return {
    pack,
    preview: renderPack(pack, rates),
    intent,
    providerId,
    vaultRoot: built.vaultRoot,
    notices: built.notices,
    timeoutMs:
      options.timeoutFloorMs === undefined
        ? packTimeoutMs(pack, rates)
        : packTimeoutMs(pack, rates, options.timeoutFloorMs),
    span: options.span,
    instruction: options.instruction,
  };
}

/**
 * Streams the plan's prompt and returns the replacement.
 *
 * Throws whatever the provider layer throws — `EndpointHung`,
 * `ProviderResponseError`, `ProviderConfigError` — so the caller decides what a
 * failure looks like on screen. `endpointOf` turns one of those into the
 * endpoint name AC5 wants in the message.
 */
export async function runSpanEdit(
  plan: SpanEditPlan,
  providers: Providers,
  hooks: RunHooks = {},
): Promise<RunOutcome> {
  const now = hooks.now ?? (() => Date.now());
  const sink = hooks.sink ?? (plan.vaultRoot === undefined ? noReceipts : fileReceiptSink(plan.vaultRoot));
  const adapter = withReceipts(providers.adapter(plan.providerId), sink, {
    pack: plan.pack,
    intent: plan.intent.name,
  });

  const started = now();
  let firstTokenAt: number | undefined;
  let text = "";
  let stats: CompletionStats | undefined;

  const stream = adapter.complete({
    prompt: plan.pack.prompt,
    maxTokens: plan.pack.expectedOutputTokens * OUTPUT_HEADROOM,
    timeoutMs: plan.timeoutMs,
    ...(hooks.signal === undefined ? {} : { signal: hooks.signal }),
  });

  for await (const event of stream) {
    if (event.type === "done") {
      stats = event.stats;
      continue;
    }
    text += event.text;
    if (firstTokenAt === undefined) firstTokenAt = now();

    // Tokens are counted here the way the adapter counts them — one per chunk
    // until the endpoint reports usage — which is enough for a rate on screen;
    // the receipt carries the endpoint's own numbers.
    const elapsedMs = now() - started;
    const generatingMs = Math.max(1, now() - firstTokenAt);
    hooks.onProgress?.({
      timeToFirstTokenMs: firstTokenAt - started,
      tokensWritten: countTokens(text),
      tokensPerSecond: (countTokens(text) * 1000) / generatingMs,
      elapsedMs,
    });
  }

  const proposal = normalizeProposal({
    span: plan.span,
    variants: [text.trim()],
    intent: plan.intent,
    providerId: plan.providerId,
    model: adapter.model,
  });

  return {
    // `Proposal.variants` is a non-empty tuple (`[string, ...string[]]`), so
    // the first one is a string and not a `string | undefined`.
    answer: proposal.variants[0],
    receipt: receiptLine(plan.pack, stats, now() - started),
  };
}

/** The line AC6 leaves on screen after a run. */
export function receiptLine(pack: Pack, stats: CompletionStats | undefined, wallMs: number): string {
  // A stream that ended without its `done` event measured nothing, and "wrote 0
  // in 0ms" would read as a fact rather than as the absence of one.
  if (stats === undefined) {
    return `sent ${thousands(pack.totalTokens)} tokens, ${duration(wallMs)} — the endpoint reported no totals`;
  }
  const wroteMs = Math.max(0, stats.elapsedMs - stats.timeToFirstTokenMs);
  return (
    `read ${thousands(stats.tokensRead ?? pack.totalTokens)} tokens in ${duration(stats.timeToFirstTokenMs)}, ` +
    `wrote ${thousands(stats.tokensWritten)} in ${duration(wroteMs)}`
  );
}

/**
 * A failure, worded for the status line (AC5).
 *
 * The two typed provider errors already name their endpoint in their own
 * message and say what to do next, so they are shown as they are; anything else
 * is prefixed with the provider id, which is the name the author configured and
 * the only one they can act on.
 */
export function failureMessage(error: unknown, providerId: string): string {
  if (error instanceof EndpointHung || error instanceof ProviderResponseError) return error.message;
  const detail = error instanceof Error ? error.message : String(error);
  return `${providerId}: ${detail}`;
}

/** A crude count that only has to be stable enough to render a rate that moves. */
function countTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

const noReceipts: ReceiptSink = () => {};
