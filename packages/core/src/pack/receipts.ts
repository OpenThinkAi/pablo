/**
 * Receipts: what was actually sent, to whom, and what it cost.
 *
 * A receipt is written per model call and keyed to the proposal the call
 * produced, so "read 4.9k tokens in 19s, wrote 1.5k in 50s" is a fact on disk
 * rather than a feeling. It hooks in by *wrapping* an adapter — `withReceipts`
 * returns an `Adapter`, so nothing above or below it knows the log exists, and
 * the provider layer stays untouched.
 *
 * Fidelity differs by method, and the receipt says which it got:
 *
 * - `complete()` streams, so `measurement: "stream"` carries the endpoint's own
 *   `CompletionStats`: real time to first token, real tokens, real rate.
 * - `proposeEdit()` and `extractFacts()` drive the adapter's own internal
 *   stream, which a wrapper cannot observe. Those receipts are
 *   `measurement: "wall"`: wall time is measured, token counts are the pack's
 *   estimate and the estimator over the returned text, and `ttft_ms` /
 *   `gen_tok_s` are null rather than guessed.
 *
 * The way to a fully measured proposal receipt is to assemble the pack, send
 * `pack.prompt` through `complete()`, and parse the result — which is what the
 * span verbs will do once they own the CriticMarkup round trip.
 */

import type {
  Adapter,
  CompletionEvent,
  CompletionRequest,
  CompletionStats,
  EditRequest,
  ExtractRequest,
  Proposal,
} from "../providers/types";
import { selectionText } from "../document";
import { hashPrompt } from "./assemble";
import type { TokenEstimator } from "./estimate";
import { estimateTokens } from "./estimate";
import type { Pack, PackKind } from "./types";

/** How the numbers in a receipt were obtained. */
export type ReceiptMeasurement = "stream" | "wall";

export interface ReceiptSlice {
  readonly name: string;
  readonly tokens: number;
  readonly source: string | null;
}

/** Which proposal this receipt belongs to: the file and span it replaces. */
export interface ReceiptProposal {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly variants: number;
}

/** One line of `<vault>/.pablo/receipts.jsonl`. */
export interface Receipt {
  /** ISO 8601, UTC. */
  readonly at: string;
  readonly intent: string;
  readonly pack_kind: PackKind | null;
  readonly prompt_hash: string;
  readonly slices: readonly ReceiptSlice[];
  readonly provider: string;
  readonly model: string;
  readonly params: Readonly<Record<string, number>>;
  readonly tokens_read: number | null;
  readonly tokens_written: number | null;
  readonly ttft_ms: number | null;
  readonly gen_tok_s: number | null;
  readonly wall_ms: number;
  readonly measurement: ReceiptMeasurement;
  readonly proposal: ReceiptProposal | null;
  /** The error a failed call ended in; null when it succeeded. */
  readonly error: string | null;
}

export type ReceiptSink = (receipt: Receipt) => void | Promise<void>;

export interface WithReceiptsOptions {
  /** The pack the calls through this wrapper were built from, if any. */
  readonly pack?: Pack | undefined;
  /** Names the call in the log when the request carries no intent. */
  readonly intent?: string | undefined;
  readonly estimate?: TokenEstimator | undefined;
  readonly now?: (() => number) | undefined;
  readonly clock?: (() => Date) | undefined;
  /**
   * Called when the sink throws. A failed receipt write must never lose a
   * proposal the author waited a minute for, so the default is to carry on
   * silently; pass this to surface it.
   */
  readonly onLogError?: ((error: unknown) => void) | undefined;
}

/**
 * Wraps an adapter so every call it serves writes a receipt to `log`.
 *
 * One wrapper per pack: assemble, wrap, call. Calls made through an unwrapped
 * reference to the same adapter are not logged, which is the point — the
 * wrapper is where the pack is known.
 */
export function withReceipts(adapter: Adapter, log: ReceiptSink, options: WithReceiptsOptions = {}): Adapter {
  const estimate = options.estimate ?? estimateTokens;
  const now = options.now ?? (() => Date.now());
  const clock = options.clock ?? (() => new Date());
  const { pack } = options;

  async function write(receipt: Receipt): Promise<void> {
    try {
      await log(receipt);
    } catch (error) {
      options.onLogError?.(error);
    }
  }

  function base(
    promptHash: string,
    wallMs: number,
    model: string | undefined,
  ): Omit<Receipt, "measurement" | "params" | "intent"> {
    return {
      at: clock().toISOString(),
      pack_kind: pack?.kind ?? null,
      prompt_hash: promptHash,
      slices: pack === undefined ? [] : pack.slices.map(toReceiptSlice),
      provider: adapter.id,
      model: model ?? adapter.model,
      tokens_read: null,
      tokens_written: null,
      ttft_ms: null,
      gen_tok_s: null,
      wall_ms: wallMs,
      proposal: null,
      error: null,
    };
  }

  return {
    id: adapter.id,
    model: adapter.model,
    preferredOutput: adapter.preferredOutput,

    async *complete(request: CompletionRequest): AsyncIterable<CompletionEvent> {
      const started = now();
      const promptHash = pack?.hash ?? hashPrompt(request.prompt);
      let stats: CompletionStats | undefined;
      try {
        for await (const event of adapter.complete(request)) {
          if (event.type === "done") stats = event.stats;
          yield event;
        }
      } catch (error) {
        await write({
          ...base(promptHash, now() - started, request.model),
          intent: options.intent ?? "complete",
          params: numericParams(request),
          measurement: "wall",
          error: messageOf(error),
        });
        throw error;
      }

      await write({
        ...base(promptHash, stats?.elapsedMs ?? now() - started, request.model),
        intent: options.intent ?? "complete",
        params: numericParams(request),
        measurement: "stream",
        tokens_read: stats?.tokensRead ?? pack?.totalTokens ?? null,
        tokens_written: stats?.tokensWritten ?? null,
        ttft_ms: stats === undefined ? null : Math.round(stats.timeToFirstTokenMs),
        gen_tok_s: stats === undefined ? null : round(stats.tokensPerSecond, 2),
      });
    },

    async proposeEdit(request: EditRequest): Promise<Proposal> {
      const started = now();
      const promptHash =
        pack?.hash ??
        hashPrompt([request.context ?? "", request.instruction, selectionText(request.document, request.span)].join("\n\n"));

      try {
        const proposal = await adapter.proposeEdit(request);
        await write({
          ...base(promptHash, now() - started, request.model),
          intent: request.intent.name,
          params: numericParams(request, request.variants ?? 1),
          measurement: "wall",
          tokens_read: pack?.totalTokens ?? estimate(request.context ?? "") + estimate(request.instruction),
          tokens_written: proposal.variants.reduce((sum, variant) => sum + estimate(variant), 0),
          proposal: {
            path: request.document.path,
            start: proposal.span.start,
            end: proposal.span.end,
            variants: proposal.variants.length,
          },
        });
        return proposal;
      } catch (error) {
        await write({
          ...base(promptHash, now() - started, request.model),
          intent: request.intent.name,
          params: numericParams(request, request.variants ?? 1),
          measurement: "wall",
          error: messageOf(error),
        });
        throw error;
      }
    },

    async extractFacts(request: ExtractRequest): Promise<readonly string[]> {
      const started = now();
      const promptHash = pack?.hash ?? hashPrompt([request.context ?? "", request.instruction, request.text].join("\n\n"));

      try {
        const facts = await adapter.extractFacts(request);
        await write({
          ...base(promptHash, now() - started, request.model),
          intent: options.intent ?? "extract",
          params: numericParams(request),
          measurement: "wall",
          tokens_read: pack?.totalTokens ?? estimate(request.context ?? "") + estimate(request.text),
          tokens_written: facts.reduce((sum, fact) => sum + estimate(fact), 0),
        });
        return facts;
      } catch (error) {
        await write({
          ...base(promptHash, now() - started, request.model),
          intent: options.intent ?? "extract",
          params: numericParams(request),
          measurement: "wall",
          error: messageOf(error),
        });
        throw error;
      }
    },
  };
}

function toReceiptSlice(slice: { name: string; tokens: number; source: string | undefined }): ReceiptSlice {
  return { name: slice.name, tokens: slice.tokens, source: slice.source ?? null };
}

/** Only the numbers: a receipt records the shape of the call, never its content. */
function numericParams(
  request: { maxTokens?: number | undefined; temperature?: number | undefined; timeoutMs?: number | undefined },
  variants?: number,
): Readonly<Record<string, number>> {
  const params: Record<string, number> = {};
  if (request.maxTokens !== undefined) params["max_tokens"] = request.maxTokens;
  if (request.temperature !== undefined) params["temperature"] = request.temperature;
  if (request.timeoutMs !== undefined) params["timeout_ms"] = request.timeoutMs;
  if (variants !== undefined) params["variants"] = variants;
  return params;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
