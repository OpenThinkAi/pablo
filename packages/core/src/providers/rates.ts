/**
 * What an endpoint has actually been measured doing, so a wait can be
 * estimated instead of spun. Prompt rate comes from the prefill (tokens read
 * over time to first token); output rate from generation after it.
 */

import type { CompletionStats } from "./types";

const WINDOW = 8;

export interface EndpointRates {
  /** Prompt tokens per second during prefill; undefined until an endpoint reports usage. */
  readonly promptTokensPerSecond: number | undefined;
  readonly outputTokensPerSecond: number | undefined;
  readonly samples: number;
}

/** A rolling average over the last few completions on one endpoint. */
export class RateMeter {
  #prompt: number[] = [];
  #output: number[] = [];
  #samples = 0;

  record(stats: CompletionStats): void {
    this.#samples += 1;
    if (stats.tokensRead !== undefined && stats.tokensRead > 0 && stats.timeToFirstTokenMs > 0) {
      push(this.#prompt, (stats.tokensRead * 1000) / stats.timeToFirstTokenMs);
    }
    if (stats.tokensPerSecond > 0) push(this.#output, stats.tokensPerSecond);
  }

  rates(): EndpointRates {
    return {
      promptTokensPerSecond: average(this.#prompt),
      outputTokensPerSecond: average(this.#output),
      samples: this.#samples,
    };
  }

  /** Milliseconds this endpoint is expected to take, or undefined before it has been measured. */
  estimateMs(promptTokens: number, expectedOutputTokens: number): number | undefined {
    const { promptTokensPerSecond, outputTokensPerSecond } = this.rates();
    if (promptTokensPerSecond === undefined || outputTokensPerSecond === undefined) return undefined;
    return ((promptTokens / promptTokensPerSecond) + (expectedOutputTokens / outputTokensPerSecond)) * 1000;
  }

  /**
   * How long prefill alone should take. The idle timeout is stretched to cover
   * it: a 37k-token pack at a measured 260 tok/s is two minutes of silence that
   * is work, not a hang.
   */
  estimatePrefillMs(promptTokens: number): number | undefined {
    const rate = this.rates().promptTokensPerSecond;
    return rate === undefined ? undefined : (promptTokens / rate) * 1000;
  }
}

function push(window: number[], value: number): void {
  window.push(value);
  if (window.length > WINDOW) window.shift();
}

function average(window: readonly number[]): number | undefined {
  if (window.length === 0) return undefined;
  return window.reduce((sum, value) => sum + value, 0) / window.length;
}
