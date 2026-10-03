/**
 * The one thing the menu-bar helper can ask the daemon to do (AGT-1589): open
 * a round. It matches `PabloTray.swift`'s `writeTrayRequest` exactly
 * (temp-then-rename, 0600, then `SIGUSR1`) and follows insieme's
 * `tray-request.ts` for the listener shape.
 *
 * A click drops a small parcel beside the state file
 * (`{"action":"open","ref":"OpenThinkAi/<slug>-reading#<pr>"}`) and sends
 * `SIGUSR1` to the daemon's pid. This module is the daemon side: read-and-
 * delete the parcel, and a signal handler that does the same the moment the
 * bell rings. The parcel is a trust boundary (any local process could write
 * one), so `ref` is parsed with `parseRoundRef` and the daemon only opens a
 * round it has itself listed.
 *
 * This module never sends a signal; it only listens for one, and a handler
 * never outlives the caller that installed it.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { parseRoundRef, roundRefLabel } from "../read";
import type { RoundRef } from "../read";

/** What a click asks for: open this round's view. */
export interface TrayRequest {
  readonly action: "open";
  readonly ref: RoundRef;
}

/** A parcel's payload as the helper writes it, checked into a `TrayRequest` (or nothing). */
export function parseTrayRequest(value: unknown): TrayRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { action, ref } = value as { action?: unknown; ref?: unknown };
  if (action !== "open" || typeof ref !== "string") return undefined;
  const parsed = parseRoundRef(ref);
  // Only the canonical form the daemon itself publishes: `OpenThinkAi/<slug>-reading#<pr>`.
  return parsed !== undefined && roundRefLabel(parsed) === ref ? { action, ref: parsed } : undefined;
}

/**
 * Reads the parcel at `path` and deletes it, whether or not it parsed: a
 * parcel nobody can read must not be re-serviced on the next signal. Missing
 * or malformed both return `undefined`.
 */
export function readTrayRequest(path: string): TrayRequest | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    unlinkSync(path);
  } catch {
    // Already gone, or a race with another reader.
  }
  try {
    return parseTrayRequest(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** The subset of `process` this module needs; a test injects a fake so no suite installs a real, process-wide `SIGUSR1` handler. */
export interface SignalTarget {
  on(signal: "SIGUSR1", handler: () => void): void;
  off(signal: "SIGUSR1", handler: () => void): void;
}

export interface ListenForTrayRequestsOptions {
  /** Where the helper drops its parcel, beside the state file. */
  parcelPath: string;
  /** Called with the request whenever a signal finds one waiting. */
  onRequest: (request: TrayRequest) => void;
  /** Injected in tests; defaults to the real `process`. */
  process?: SignalTarget;
}

/**
 * Installs a `SIGUSR1` handler that reads `parcelPath` on every signal and
 * calls `onRequest` when a well-formed parcel was there. Returns a function
 * that removes the handler; callers (and every test) must call it.
 */
export function listenForTrayRequests(opts: ListenForTrayRequestsOptions): () => void {
  const target: SignalTarget = opts.process ?? (process as unknown as SignalTarget);
  const handler = (): void => {
    const request = readTrayRequest(opts.parcelPath);
    if (request !== undefined) opts.onRequest(request);
  };
  target.on("SIGUSR1", handler);
  return () => {
    target.off("SIGUSR1", handler);
  };
}
