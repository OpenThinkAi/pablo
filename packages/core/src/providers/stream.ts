/**
 * The parts of a streamed HTTP completion that are the same whatever the
 * provider is: a timer that turns silence into a named error rather than a
 * wait, Server-Sent Event framing, and the measurement a finished stream
 * reports.
 *
 * `openai.ts` (AGT-1201) still carries its own copies of `waitFor`, `measure`
 * and `truncate`. It is deliberately not edited here — AGT-1202 and AGT-1206
 * are in flight against the same package — so folding it onto this module is a
 * follow-up with no behaviour change in it.
 */

import type { CompletionStats } from "./types";

const TIMED_OUT = Symbol("timed out");

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
