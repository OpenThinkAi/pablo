/**
 * The vocabulary of the context pack: what pablo decided to send, how big each
 * part of it is, and what it had to give up to stay inside the budget.
 *
 * A pack is a *value*. Assembling one reads no files, calls no model and asks
 * no clock: the same inputs produce the same bytes and the same hash, which is
 * what makes the hash in a receipt worth recording.
 */

import type { Document, Span } from "../document";
import type { OutputMode } from "../providers/types";
import type { TokenEstimator } from "./estimate";

/** The two shapes of prompt pablo assembles today. */
export type PackKind = "spanEdit" | "drafting";

/** One named, sourced section of the prompt. */
export interface Slice {
  /** Stable identifier (`style`, `timeline`); the table and the receipt key on it. */
  readonly name: string;
  /** The markdown heading this slice is introduced by; `""` for a bare paragraph. */
  readonly heading: string;
  /** The body as it appears in the prompt, after any truncation. */
  readonly text: string;
  /** Estimated tokens of the slice *as rendered* (heading included). */
  readonly tokens: number;
  /** Where the text came from: a file path, or a short phrase for caller-supplied text. */
  readonly source: string | undefined;
}

export type SliceAction = "truncated" | "dropped";

/** What the budget took, from which slice, and how much. Never silent. */
export interface SliceAdjustment {
  readonly name: string;
  readonly action: SliceAction;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly droppedTokens: number;
  readonly source: string | undefined;
}

export interface Pack {
  readonly kind: PackKind;
  /** In prompt order. */
  readonly slices: readonly Slice[];
  readonly totalTokens: number;
  readonly budgetTokens: number;
  readonly withinBudget: boolean;
  /** Empty when nothing had to give. Ordered by the order the cuts were taken. */
  readonly adjustments: readonly SliceAdjustment[];
  /**
   * The slices an adapter takes as `EditRequest.context` / `ExtractRequest.context`:
   * everything except the passage, the instruction and the closing directive, which
   * the adapter composes itself. Equal to `prompt` for kinds with no such tail.
   */
  readonly context: string;
  /** The exact bytes pablo sends when it drives the endpoint through `complete()`. */
  readonly prompt: string;
  /** `sha256(prompt)`, hex. Stable across runs; the receipt's `prompt_hash`. */
  readonly hash: string;
  /** What the answer is expected to cost, for the wait estimate and `maxTokens`. */
  readonly expectedOutputTokens: number;
}

/** A style or rules file read out of the vault, kept with its path for the table. */
export interface TextSource {
  /** Path as it should appear in the dry-run table and the receipt. */
  readonly path: string;
  readonly text: string;
}

export interface SpanEditInputs {
  readonly document: Document;
  readonly span: Span;
  /** What to do to the span, in the author's terms ("cut this by a third"). */
  readonly instruction: string;
  /** `<vault>/style/*.md`, in the order they should appear. */
  readonly style: readonly TextSource[];
  /** The work's own rules file (`QWEN.md`) when it has one. */
  readonly workRules?: TextSource | undefined;
  /**
   * Which structured path the adapter will take, so the closing line priced
   * here is the one that goes over the wire. Defaults to the tool call, the
   * OpenAI-compatible adapter's measured preference (AGT-1202).
   */
  readonly output?: OutputMode | undefined;
  /** Paragraphs of the manuscript to keep on each side of the span. Default 2. */
  readonly neighborhoodParagraphs?: number | undefined;
}

/** One row of `outline/chapters.md`: `# | story date | title | beat | POV | status`. */
export interface BeatRow {
  readonly chapter: number;
  readonly storyDate: string;
  readonly title: string;
  readonly beat: string;
  readonly pov: string;
  readonly status: string;
  /** Path of the outline the row came from. */
  readonly source: string;
}

/** `bible/timeline.md` split by the chapter's story date. */
export interface TimelineGate {
  /** Rows dated at or before the chapter, rendered one per line. */
  readonly exists: readonly string[];
  /** Rows dated after it: the "do not mention or foreshadow" list. */
  readonly later: readonly string[];
  readonly source: string;
}

/** The work being drafted, for the opening line of the prompt. */
export interface WorkIdentity {
  readonly title: string;
  /** How to describe the form ("a literary historical novel set in Napa Valley"). */
  readonly description?: string | undefined;
}

export interface DraftingInputs {
  readonly work: WorkIdentity;
  readonly beat: BeatRow;
  /** `<vault>/style/*.md`. The built-in craft rules are added on top, always. */
  readonly style: readonly TextSource[];
  /** The work's period and place facts, usually a section of its `QWEN.md`. */
  readonly periodFacts?: TextSource | undefined;
  /** `bible/characters/*`: who exists. */
  readonly cast?: TextSource | undefined;
  /** `bible/places.md`. */
  readonly places?: TextSource | undefined;
  readonly timeline: TimelineGate;
  /** `continuity.md`: what the text has already established. */
  readonly continuity?: TextSource | undefined;
  /** The tail of the previous chapter, to continue from. */
  readonly previousTail?: TextSource | undefined;
  readonly wordTarget: number;
  /** Minimum scenes to ask for. Default 3; a floor moves length more than words do. */
  readonly minScenes?: number | undefined;
}

export interface AssembleOptions {
  /** Defaults to the chars-per-token estimator in `estimate.ts`. */
  readonly estimate?: TokenEstimator | undefined;
  /** Overrides the kind's default budget from `PACK_BUDGETS`. */
  readonly budgetTokens?: number | undefined;
}
