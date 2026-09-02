/**
 * The provider-neutral vocabulary: what pablo asks a model for, and what it
 * gets back. Nothing in this file names a vendor — an adapter's own request
 * shape, tool-call format and streaming protocol stop at its module boundary,
 * so a second adapter (Anthropic) is a registry entry, not a new type.
 *
 * The model has no write tool. Every method here returns a proposal or text
 * for the app to apply; none of them touch the filesystem.
 */

import type { Document, Span } from "../document";

/**
 * The routing class of an intent, and the only thing routing looks at when the
 * config has no explicit mapping: planning wants the strongest model available,
 * the other three want the local writer.
 */
export type IntentKind = "planning" | "drafting" | "revising" | "extraction";

/** A named thing the author asked for (`tighten`, `draft-chapter`), plus how it routes. */
export interface Intent {
  readonly name: string;
  readonly kind: IntentKind;
}

/**
 * A model's answer to an intent, before the author has accepted anything.
 *
 * One or more replacements for one span: a single variant is the common case,
 * several are the "give me three openings" case. The app decides what to write;
 * a proposal is inert until then.
 */
export interface Proposal {
  readonly span: Span;
  /** Non-empty; `variants[0]` is the replacement when only one was asked for. */
  readonly variants: readonly [string, ...string[]];
  readonly intent: Intent;
  readonly providerId: string;
  readonly model: string;
}

/** What a finished stream measured, for the wait estimate and the receipt. */
export interface CompletionStats {
  readonly timeToFirstTokenMs: number;
  readonly elapsedMs: number;
  /** Prompt tokens, when the endpoint reports usage; some local servers do not. */
  readonly tokensRead: number | undefined;
  readonly tokensWritten: number;
  /** Output tokens per second, measured after the first token. */
  readonly tokensPerSecond: number;
}

/** A streamed completion: text as it arrives, then exactly one `done`. */
export type CompletionEvent =
  | { readonly type: "token"; readonly text: string }
  | { readonly type: "done"; readonly stats: CompletionStats };

export interface CompletionRequest {
  readonly prompt: string;
  /** Overrides the provider's configured model — the bake-off and smoke tests use it. */
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** Raised for a large context pack; see `Adapter.complete` on the idle timeout. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** An edit asked for on one span, with the context pack the caller assembled. */
export interface EditRequest {
  readonly intent: Intent;
  /** What to do to the span, in the author's terms ("cut this by a third"). */
  readonly instruction: string;
  /** The assembled context pack; empty when the neighbourhood is all the model needs. */
  readonly context?: string;
  readonly document: Document;
  readonly span: Span;
  /** How many replacements to ask for; defaults to one. */
  readonly variants?: number;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Facts to pull out of a passage, one per line, for the continuity ledger. */
export interface ExtractRequest {
  readonly text: string;
  /** What kind of fact to look for ("people, places and dates stated as true"). */
  readonly instruction: string;
  readonly context?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface Adapter {
  /** The configured provider id this adapter serves (`local`, `anthropic`). */
  readonly id: string;
  /** The model used when a request does not override it. */
  readonly model: string;
  /**
   * Streams a completion. Throws `EndpointHung` when the endpoint sends no
   * bytes for the idle timeout, so a wait is always either visible progress or
   * a named error.
   */
  complete(request: CompletionRequest): AsyncIterable<CompletionEvent>;
  proposeEdit(request: EditRequest): Promise<Proposal>;
  extractFacts(request: ExtractRequest): Promise<readonly string[]>;
}
