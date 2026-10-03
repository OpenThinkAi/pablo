/**
 * The reader's tray poller (AGT-1589): asks GitHub which rounds are waiting for
 * this reader, cheaply and forever.
 *
 * Cheaply: the question is `listReaderRounds`' own search (`ROUND_SEARCH_ENDPOINT`),
 * asked first as a conditional request (`If-None-Match: <etag>`). GitHub answers
 * 304 when nothing changed, which costs nothing against the rate limit, and then
 * the previous list is reused (with `submit.ts`'s local sent marks re-applied,
 * since submitting changes local state before GitHub drops the review request).
 * Only a changed answer, or the periodic full refresh (so a round Matt closed
 * drops off the "sent" list), runs the full `listReaderRounds`. The new ETag is
 * kept only once the full list succeeded: remembering it earlier would let the
 * next 304 hide a change that was never read.
 *
 * Forever: `nextDelayMs` backs off on consecutive failures (never zero, never
 * unbounded) and `runPollLoop` has no exit but its `AbortSignal`: a failed tick,
 * a thrown tick, a laptop sleep (the timer simply fires late and the next tick is
 * a fresh request) all lead to another tick.
 *
 * Every GitHub call goes through the injected `Runner`; the clock and sleep are
 * injected too, so tests drive the loop with a fake clock and a fake GitHub.
 */

import { cachedRoundDir, listReaderRounds, readCachedRound, ROUND_SEARCH_ENDPOINT, roundSearchFields } from "../read";
import type { ReaderRound } from "../read";
import { READING_ORG } from "../share";
import type { Runner } from "../share";
import { readSent } from "../submit";

type Env = Record<string, string | undefined>;

/** The poll interval is 30-60s (the readers design); the default is the middle. */
export const MIN_INTERVAL_MS = 30_000;
export const MAX_INTERVAL_MS = 60_000;
export const DEFAULT_INTERVAL_MS = 45_000;
/** Consecutive failures stop doubling the wait here. */
export const MAX_BACKOFF_MS = 10 * 60_000;
/** Even when GitHub keeps answering 304, re-read the whole list this often. */
export const FULL_REFRESH_MS = 10 * 60_000;

/** `PABLO_TRAY_POLL_SECONDS`, clamped to 30-60s; anything unreadable is the default. */
export function pollIntervalMs(env: Env = process.env): number {
  const seconds = Number(env["PABLO_TRAY_POLL_SECONDS"]);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_INTERVAL_MS;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(seconds * 1000)));
}

/** The wait before the next poll: the interval when healthy, doubling per consecutive failure up to `MAX_BACKOFF_MS`. */
export function nextDelayMs(failures: number, intervalMs: number): number {
  if (failures <= 0) return intervalMs;
  return Math.min(intervalMs * 2 ** Math.min(failures, 16), Math.max(MAX_BACKOFF_MS, intervalMs));
}

// ---------------------------------------------------------------------------
// The conditional request
// ---------------------------------------------------------------------------

export type ConditionalAnswer =
  | { readonly kind: "modified"; readonly etag: string | undefined }
  | { readonly kind: "unchanged" }
  | { readonly kind: "error"; readonly reason: string };

/** `gh api -i` output: the status code, the (lower-cased) headers, and the body. */
export function parseHttpResponse(stdout: string): { status: number; headers: Map<string, string>; body: string } | undefined {
  const text = stdout.replace(/\r\n/g, "\n");
  const split = text.indexOf("\n\n");
  const head = split < 0 ? text : text.slice(0, split);
  const body = split < 0 ? "" : text.slice(split + 2);
  const lines = head.split("\n");
  const status = /^HTTP\/\S+\s+(\d{3})/.exec(lines[0] ?? "");
  if (!status) return undefined;
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: Number(status[1]), headers, body };
}

/**
 * Asks the rounds search with `If-None-Match` when an ETag is known. `gh api -i`
 * prints the response headers; a 304 makes `gh` exit non-zero, so the status line
 * on stdout is read first and the exit code only decides when there is none.
 */
export function askRounds(run: Runner, etag: string | undefined, org: string = READING_ORG): ConditionalAnswer {
  const args = ["api", "-i", "-X", "GET", ROUND_SEARCH_ENDPOINT, ...roundSearchFields(org).flatMap(([k, v]) => ["-f", `${k}=${v}`])];
  if (etag !== undefined) args.push("-H", `If-None-Match: ${etag}`);
  const result = run("gh", args);
  const response = parseHttpResponse(result.stdout);
  if (response?.status === 304) return { kind: "unchanged" };
  if (response?.status === 200 && result.code === 0) return { kind: "modified", etag: response.headers.get("etag") };
  const reason = response !== undefined ? `GitHub answered ${response.status}` : result.stderr.trim() || `gh exited ${result.code}`;
  return { kind: "error", reason: reason.split("\n").slice(0, 2).join(" / ") };
}

// ---------------------------------------------------------------------------
// One tick
// ---------------------------------------------------------------------------

export type TickResult =
  | { readonly ok: true; readonly rounds: readonly ReaderRound[]; readonly notices: readonly string[]; readonly source: "github" | "not-modified" }
  | { readonly ok: false; readonly reason: string };

export interface RoundPollerOptions {
  readonly run: Runner;
  readonly env?: Env;
  readonly org?: string;
  /** Epoch milliseconds; injected so the full-refresh rule is testable without waiting. */
  readonly now?: () => number;
  readonly fullRefreshMs?: number;
}

/** Re-applies this machine's sent marks to a remembered list (a submit changes local state before GitHub's). */
function withLocalSent(rounds: readonly ReaderRound[], env: Env): ReaderRound[] {
  return rounds.map((round) => {
    if (round.status === "sent") return round;
    const ref = { repo: round.repo, pr: round.pr };
    const cached = readCachedRound(ref, env);
    const sent = cached !== undefined && typeof cached.id === "string" && readSent(cachedRoundDir(ref, env), cached.id) !== undefined;
    return sent ? { ...round, status: "sent" as const } : round;
  });
}

export class RoundPoller {
  private etag: string | undefined;
  private last: readonly ReaderRound[] | undefined;
  private lastFullAt = 0;
  private readonly env: Env;
  private readonly now: () => number;
  private readonly fullRefreshMs: number;

  constructor(private readonly options: RoundPollerOptions) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
    this.fullRefreshMs = options.fullRefreshMs ?? FULL_REFRESH_MS;
  }

  /** Never throws: every failure is a `{ok: false}` the loop backs off on. */
  tick(): TickResult {
    try {
      const answer = askRounds(this.options.run, this.etag, this.options.org);
      if (answer.kind === "error") return { ok: false, reason: answer.reason };
      const due = this.last === undefined || this.now() - this.lastFullAt >= this.fullRefreshMs;
      if (answer.kind === "unchanged" && !due && this.last !== undefined) {
        this.last = withLocalSent(this.last, this.env);
        return { ok: true, rounds: this.last, notices: [], source: "not-modified" };
      }
      const listed = listReaderRounds({ run: this.options.run, env: this.env, org: this.options.org });
      if (!listed.ok) return { ok: false, reason: listed.message };
      if (answer.kind === "modified") this.etag = answer.etag;
      this.last = listed.rounds;
      this.lastFullAt = this.now();
      return { ok: true, rounds: listed.rounds, notices: listed.notices, source: "github" };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}
