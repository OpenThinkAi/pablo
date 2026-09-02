/**
 * How big a piece of text is, in tokens, without asking a model.
 *
 * The estimator is deliberately crude and deliberately a single function: the
 * pack's job is to make size *visible*, and a four-characters-per-token rule is
 * within a few percent on English prose, costs nothing, and cannot fail. It is
 * the same constant the OpenAI-compatible adapter uses to stretch its first-byte
 * timeout, so the wait a pack predicts and the wait the adapter tolerates are
 * computed from the same number.
 *
 * Swap it by passing `estimate` to `assemblePack` (a real tokenizer would be a
 * dependency, and `packages/core` has none).
 */

/** Characters of English prose per token, near enough to size a prompt with. */
export const CHARS_PER_TOKEN = 4;

export type TokenEstimator = (text: string) => number;

export const estimateTokens: TokenEstimator = (text: string): number =>
  text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN);
