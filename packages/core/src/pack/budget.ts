/**
 * The visible token budget.
 *
 * A pack that grows silently is the failure this module exists to prevent: on
 * 2026-09-01 a 37k-token prompt was two and a half minutes of prefill that
 * looked, from the outside, exactly like a hung endpoint. So every slice
 * declares how much of it may be given up and in what order, and every cut the
 * budget takes comes back as a `SliceAdjustment` the dry-run table prints.
 */

import type { TokenEstimator } from "./estimate";
import type { PackKind, Slice, SliceAdjustment } from "./types";

/**
 * Default ceiling per kind.
 *
 * `spanEdit` follows the design doc's per-edit table (neighbourhood, entity
 * sheets, echoes, style and intent: under 10k, seconds of prefill).
 * `drafting` is set from the measured drafting run: the chapter-1 pack that
 * worked was 4,888 tokens, and 16k is about a minute of prefill at the local
 * writer's measured ~260 tokens/second — comfortably above a real pack and
 * comfortably below the 37k one that made the wait invisible.
 */
export const PACK_BUDGETS: Readonly<Record<PackKind, number>> = {
  spanEdit: 10_000,
  drafting: 16_000,
};

/** Marker left in the prompt where the budget cut, so the model sees the seam too. */
export const TRUNCATION_MARKER = "[pablo: this section was truncated to fit the pack budget]";

/** A slice before the budget has had its say. */
export interface SliceSpec {
  readonly name: string;
  readonly heading: string;
  readonly text: string;
  readonly source: string | undefined;
  /** Never dropped entirely; may still be truncated down to `minTokens`. */
  readonly required: boolean;
  /** Which end of the text survives a truncation. */
  readonly keep: "head" | "tail";
  /** Floor a required slice may not be cut below. Ignored when `reducible` is false. */
  readonly minTokens: number;
  /** False for the slices that carry the ask itself: the span, the instruction, the task. */
  readonly reducible: boolean;
  /** Higher is cut first. Ties break on `name`, so the outcome is deterministic. */
  readonly cutOrder: number;
}

export interface FitResult {
  readonly slices: readonly Slice[];
  readonly totalTokens: number;
  readonly adjustments: readonly SliceAdjustment[];
}

/** The prompt text of a slice: heading, blank line, body. A headingless slice is its body. */
export function renderSlice(heading: string, text: string): string {
  return heading === "" ? text : `${heading}\n\n${text}`;
}

/**
 * Cuts the pack down to `budgetTokens`, most-cuttable slice first, and reports
 * every cut. Slices with empty text are dropped before any of this runs (an
 * absent `continuity.md` is not an adjustment, it is just absent).
 */
export function fitToBudget(
  specs: readonly SliceSpec[],
  budgetTokens: number,
  estimate: TokenEstimator,
): FitResult {
  const present = specs.filter((spec) => spec.text.trim() !== "");
  const bodies = new Map(present.map((spec) => [spec.name, spec.text]));
  const adjustments: SliceAdjustment[] = [];
  const dropped = new Set<string>();

  const tokensOf = (spec: SliceSpec): number =>
    estimate(renderSlice(spec.heading, bodies.get(spec.name) ?? ""));

  let total = present.reduce((sum, spec) => sum + tokensOf(spec), 0);

  const cuttable = [...present]
    .filter((spec) => spec.reducible)
    .sort((a, b) => (b.cutOrder - a.cutOrder) || a.name.localeCompare(b.name));

  for (const spec of cuttable) {
    if (total <= budgetTokens) break;

    const before = tokensOf(spec);
    const floor = spec.required ? Math.max(spec.minTokens, estimate(spec.heading)) : 0;
    const takeable = before - floor;
    if (takeable <= 0) continue;

    const want = total - budgetTokens;
    const take = Math.min(takeable, want);
    const target = before - take;

    if (!spec.required && target <= estimate(renderSlice(spec.heading, TRUNCATION_MARKER))) {
      dropped.add(spec.name);
      bodies.set(spec.name, "");
      total -= before;
      adjustments.push({
        name: spec.name,
        action: "dropped",
        beforeTokens: before,
        afterTokens: 0,
        droppedTokens: before,
        source: spec.source,
      });
      continue;
    }

    const body = truncateToTokens(spec, target, estimate);
    bodies.set(spec.name, body);
    const after = estimate(renderSlice(spec.heading, body));
    total -= before - after;
    adjustments.push({
      name: spec.name,
      action: "truncated",
      beforeTokens: before,
      afterTokens: after,
      droppedTokens: before - after,
      source: spec.source,
    });
  }

  const slices: Slice[] = present
    .filter((spec) => !dropped.has(spec.name))
    .map((spec) => {
      const text = bodies.get(spec.name) ?? "";
      return {
        name: spec.name,
        heading: spec.heading,
        text,
        tokens: estimate(renderSlice(spec.heading, text)),
        source: spec.source,
      };
    });

  return {
    slices,
    totalTokens: slices.reduce((sum, slice) => sum + slice.tokens, 0),
    adjustments,
  };
}

/**
 * The longest prefix (or suffix) of the body whose rendered slice fits
 * `targetTokens`, backed off to a whitespace boundary and marked.
 *
 * Binary search rather than `targetTokens * CHARS_PER_TOKEN` so this keeps
 * working when a caller swaps in a real tokenizer.
 */
function truncateToTokens(spec: SliceSpec, targetTokens: number, estimate: TokenEstimator): string {
  const source = spec.text;
  const fits = (length: number): boolean =>
    estimate(renderSlice(spec.heading, withMarker(spec.keep, cut(source, spec.keep, length)))) <= targetTokens;

  if (fits(source.length)) return source;

  let low = 0;
  let high = source.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }

  return withMarker(spec.keep, atWordBoundary(cut(source, spec.keep, low), spec.keep));
}

function cut(text: string, keep: "head" | "tail", length: number): string {
  return keep === "head" ? text.slice(0, length) : text.slice(text.length - length);
}

/** Back off to whitespace so a cut never lands mid-word. */
function atWordBoundary(text: string, keep: "head" | "tail"): string {
  if (keep === "head") {
    const at = text.search(/\s+\S*$/);
    return (at <= 0 ? text : text.slice(0, at)).trimEnd();
  }
  const match = /^\S*\s+/.exec(text);
  return (match === null ? text : text.slice(match[0].length)).trimStart();
}

function withMarker(keep: "head" | "tail", text: string): string {
  return keep === "head" ? `${text}\n\n${TRUNCATION_MARKER}` : `${TRUNCATION_MARKER}\n\n${text}`;
}
