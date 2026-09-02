/**
 * How a structured answer goes wrong, named.
 *
 * A pass rate on its own does not tell you which path to keep: an answer can
 * satisfy `validateProposal` and still have arrived with its newlines escaped
 * or its dialogue stripped of quotes, and those two failures are exactly the
 * ones the design doc predicted for long prose inside a JSON string argument.
 * These are the four classes AGT-1202 measures, as pure functions of the
 * passage and the answer, so they are testable without an endpoint.
 *
 * Everything here is a heuristic over model output and is only ever used to
 * label a bench result. Nothing decides whether a proposal is applied — that is
 * `validateProposal`'s job, and it runs first.
 */

export type ManglingClass = "escaped-newlines" | "lost-quotes" | "truncated" | "extra-prose";

export const MANGLING_CLASSES: readonly ManglingClass[] = [
  "escaped-newlines",
  "lost-quotes",
  "truncated",
  "extra-prose",
];

export interface Answer {
  /** The passage the model was asked to replace. */
  readonly passage: string;
  /**
   * What the model said, decoded: the tool call's `replacement` argument, or
   * the CriticMarkup body of a text answer. Undefined when nothing could be
   * decoded, in which case only `raw` is classified.
   */
  readonly replacement: string | undefined;
  /** The raw answer as it came off the wire, for the cases where decoding failed. */
  readonly raw: string;
}

/** Every class the answer falls into, in a stable order. Empty means it came back clean. */
export function classify(answer: Answer): readonly ManglingClass[] {
  const text = answer.replacement ?? answer.raw;
  return MANGLING_CLASSES.filter((mangling) => {
    switch (mangling) {
      case "escaped-newlines":
        return hasEscapedNewlines(text);
      case "lost-quotes":
        return lostQuotes(answer.passage, text);
      case "truncated":
        return isTruncated(answer.passage, text);
      case "extra-prose":
        return hasExtraProse(text);
    }
  });
}

/**
 * A literal backslash-n (two characters) in prose that should carry a real
 * newline: the JSON string argument came back escaped one level too many.
 */
export function hasEscapedNewlines(text: string): boolean {
  return /\\[nrt]/.test(text);
}

/**
 * Quotation marks the passage had and the answer does not, or quotes that
 * arrived still escaped. A passage with no quotes at all cannot lose any.
 */
export function lostQuotes(passage: string, text: string): boolean {
  if (/\\["']/.test(text)) return true;
  const before = countQuotes(passage);
  return before > 0 && countQuotes(text) === 0;
}

const QUOTES = /["'‘’“”«»]/g;

function countQuotes(text: string): number {
  return (text.match(QUOTES) ?? []).length;
}

/**
 * The answer stops mid-thought: it does not end on sentence-terminal
 * punctuation, or it is a small fraction of the passage it replaces. The
 * fraction is deliberately low — several fixtures ask for a cut — so it catches
 * a generation that hit the token ceiling, not one that did as it was told.
 */
export function isTruncated(passage: string, text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return true;
  if (words(trimmed) < words(passage) * 0.25) return true;
  // Ignore trailing closers so `…said."` and `(…)` still count as finished.
  const withoutClosers = trimmed.replace(/[\s"'’”»)\]}*_~]+$/u, "");
  return !/[.!?…]$/u.test(withoutClosers);
}

/**
 * Chat wrapping around the proposal: a preamble, a sign-off, or a code fence.
 * The prompts on both paths ask for the replacement and nothing else, so any of
 * these is the model ignoring the contract, and each one would land verbatim in
 * the manuscript if it were applied.
 */
export function hasExtraProse(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.includes("```")) return true;
  if (/^(sure|certainly|of course|okay|ok|absolutely|great)\b/i.test(trimmed)) return true;
  if (/^(here('s| is| are)|below is|this is my|i've|i have|i would)\b/i.test(trimmed)) return true;
  if (/\b(let me know|i hope this|feel free to|would you like me to)\b/i.test(trimmed)) return true;
  return /^\s*(note|explanation|changes made|rationale)\s*:/im.test(trimmed);
}

function words(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}
