/**
 * The one thing the menu-bar helper can ask the daemon to do — AGT-1266,
 * matching `PabloTray.swift`'s `writeTrayRequest` exactly (temp-then-rename,
 * 0600, then `SIGUSR1`) and following insieme's `tray-request.ts` for the
 * listener shape.
 *
 * A click drops a small parcel beside the state file
 * (`{"action":"approve"|"review","id":"<id>"}`) and sends `SIGUSR1` to the
 * daemon's pid. This module is the daemon side: read-and-delete the parcel,
 * and a signal handler that does the same the moment the bell rings.
 *
 * A signal handler must never survive past the caller that installed it — no
 * process-wide handler that outlives a test, and no signal sent to a pid this
 * process did not spawn (`writeTrayRequest`'s job, not this module's). This
 * module never sends a signal; it only listens for one.
 */

import { readFileSync, unlinkSync } from "node:fs";

/** What a click asks for — approve blind, or open the piece in the editor. */
export type TrayRequest = { action: "approve" | "review"; id: string };

function isTrayRequest(value: unknown): value is TrayRequest {
  if (typeof value !== "object" || value === null) return false;
  const action = (value as { action?: unknown }).action;
  const id = (value as { id?: unknown }).id;
  return (action === "approve" || action === "review") && typeof id === "string";
}

/**
 * Reads the parcel at `path` and deletes it, whether or not it parsed. A
 * parcel nobody can read must not be re-serviced on the next signal, so the
 * delete happens even when the content is malformed. Missing or malformed
 * both return `undefined`.
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
    // Already gone, or a race with another reader — either way there is
    // nothing left to clean up.
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return isTrayRequest(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The subset of `process` this module needs — real `process` satisfies it,
 * and a test injects a fake one so no suite ever installs a real, process-wide
 * `SIGUSR1` handler. */
export interface SignalTarget {
  on(signal: "SIGUSR1", handler: () => void): void;
  off(signal: "SIGUSR1", handler: () => void): void;
}

export interface ListenForTrayRequestsOptions {
  /** Where the helper drops its parcel — beside the state file. */
  parcelPath: string;
  /** Called with the request whenever a signal finds one waiting. */
  onRequest: (request: TrayRequest) => void;
  /** Injected in tests; defaults to the real `process`. */
  process?: SignalTarget;
}

/**
 * Installs a `SIGUSR1` handler that reads `parcelPath` on every signal and
 * calls `onRequest` when a well-formed parcel was there. Returns a function
 * that removes the handler — callers (and every test) must call it, since an
 * installed handler otherwise outlives whoever installed it.
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
