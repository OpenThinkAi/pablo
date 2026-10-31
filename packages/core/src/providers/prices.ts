/**
 * What a model's tokens cost (AGT-2120, decision D-12): the agent loop's
 * `result` entry reports `costUsd` as the turns' usage times a per-model price
 * table. A local provider costs nothing whatever its model is called; a model
 * the table does not know costs nothing too, because a guessed price is worse
 * than a visible zero.
 *
 * Prices are US dollars per million tokens, Anthropic's first-party rates as
 * published on 2026-10-06. A caller may pass its own table (a config's, a
 * test's) in place of `DEFAULT_PRICES`.
 */

import type { ChatUsage } from "./types";

export interface ModelPrice {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
}

export type PriceTable = Readonly<Record<string, ModelPrice>>;

export const DEFAULT_PRICES: PriceTable = {
  "claude-fable-5-1": { inputPerMillion: 10, outputPerMillion: 50 },
  "claude-fable-5": { inputPerMillion: 10, outputPerMillion: 50 },
  "claude-opus-5-5": { inputPerMillion: 4, outputPerMillion: 20 },
  "claude-opus-5": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-8": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-7": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-opus-4-6": { inputPerMillion: 5, outputPerMillion: 25 },
  "claude-sonnet-5-5": { inputPerMillion: 2, outputPerMillion: 10 },
  "claude-sonnet-5": { inputPerMillion: 2, outputPerMillion: 10 },
  "claude-sonnet-4-6": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-haiku-5-5": { inputPerMillion: 0.1, outputPerMillion: 0.5 },
  "claude-haiku-4-5": { inputPerMillion: 1, outputPerMillion: 5 },
};

/**
 * The price for a model: an exact entry, else the longest entry the model id
 * starts with (`claude-opus-5-5-20260401` prices as `claude-opus-5-5`), else
 * undefined.
 */
export function priceFor(model: string, table: PriceTable = DEFAULT_PRICES): ModelPrice | undefined {
  const exact = table[model];
  if (exact !== undefined) return exact;
  let best: { readonly key: string; readonly price: ModelPrice } | undefined;
  for (const [key, price] of Object.entries(table)) {
    if (model.startsWith(`${key}-`) && (best === undefined || key.length > best.key.length)) best = { key, price };
  }
  return best?.price;
}

export interface CostOptions {
  /** A local provider: the cost is 0 whatever the model is called. */
  readonly local?: boolean | undefined;
  /** Paid by the author's plan, not per token (AGT-2281, `claude -p` on the Claude login): the cost is 0 and the model is never "unpriced". */
  readonly subscription?: boolean | undefined;
  readonly prices?: PriceTable | undefined;
}

/** One turn's cost in US dollars: usage times the model's price; 0 for a local or subscription provider, an unknown model, or unreported usage. */
export function costUsd(usage: ChatUsage, model: string, options: CostOptions = {}): number {
  if (options.local === true || options.subscription === true) return 0;
  const price = priceFor(model, options.prices);
  if (price === undefined) return 0;
  const input = ((usage.inputTokens ?? 0) / 1_000_000) * price.inputPerMillion;
  const output = ((usage.outputTokens ?? 0) / 1_000_000) * price.outputPerMillion;
  return input + output;
}
