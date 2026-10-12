/**
 * The parts of a streamed HTTP completion that are the same whatever the
 * provider is: a timer that turns silence into a named error rather than a
 * wait, Server-Sent Event framing, and the measurement a finished stream
 * reports.
 *
 * Both adapters use it. It began as the Anthropic adapter's half of what
 * `openai.ts` (AGT-1201) already had; `openai.ts` now imports it too, which is
 * how the SSE framing here — tolerant of `\r\n` line endings and of an event
 * that carries several `data:` lines — became the framing both of them use.
 */

import { EndpointUnreachable } from "./errors";
import type { CompletionStats } from "./types";

const TIMED_OUT = Symbol("timed out");

/**
 * `doFetch` with a connection failure turned into `EndpointUnreachable`. An
 * abort passes through untouched: it is how `waitFor`'s timeout stops a
 * request, and that path already throws `EndpointHung`.
 */
export function reaching(doFetch: typeof fetch, endpoint: string, local: boolean): typeof fetch {
  const wrapped = async (...args: Parameters<typeof fetch>): Promise<Response> => {
    try {
      return await doFetch(...args);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      const code = (error as { code?: unknown } | null)?.code;
      const cause = typeof code === "string" && code !== "" ? code : error instanceof Error ? error.message : String(error);
      throw new EndpointUnreachable(endpoint, cause, local);
    }
  };
  return wrapped as typeof fetch;
}

/** Resolves `work`, or runs `onTimeout` (which throws) after `ms` of silence. */
export async function waitFor<T>(work: Promise<T>, ms: number, onTimeout: () => never): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    const result = await Promise.race([work, expiry]);
    if (result === TIMED_OUT) onTimeout();
    return result as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface SseFrames {
  /** Complete events, in arrival order. */
  readonly events: readonly string[];
  /** The trailing partial event, to prepend to the next chunk. */
  readonly rest: string;
}

/** Splits a decoded buffer on the blank line that ends an SSE event. */
export function frameSse(buffer: string): SseFrames {
  const events = buffer.split(/\r?\n\r?\n/);
  return { rest: events.pop() ?? "", events };
}

/**
 * The `data:` payload of one event. SSE allows an event to carry several data
 * lines, which are joined with newlines; Anthropic sends one, but a parser that
 * only reads the first would silently truncate a longer frame.
 */
export function dataOf(event: string): string | undefined {
  const lines = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());
  return lines.length === 0 ? undefined : lines.join("\n");
}

export function measure(
  started: number,
  firstTokenAt: number,
  ended: number,
  tokensRead: number | undefined,
  tokensWritten: number,
): CompletionStats {
  const generatingMs = Math.max(ended - firstTokenAt, 1);
  return {
    timeToFirstTokenMs: firstTokenAt - started,
    elapsedMs: ended - started,
    tokensRead,
    tokensWritten,
    tokensPerSecond: (tokensWritten * 1000) / generatingMs,
  };
}

/** One line of an endpoint's own words, safe to put in an error message. */
export function truncate(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
}

/** A non-negative finite count, or undefined when the endpoint sent something else. */
export function countOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
