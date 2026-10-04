/**
 * The one file the daemon writes for the menu-bar helper, and the whole of what
 * the helper is allowed to know (AGT-1589; the pattern is AGT-1266's and
 * insieme's `tray-state.ts`). The helper is a reader with no credential and no
 * network request: it shows what is in this file and can ask for one thing, to
 * open a round (`request.ts`).
 *
 * Also the daemon's small memory: `notified.json` records which rounds already
 * raised a notification, so a restart (or a crash loop) never re-announces a
 * round the reader has been told about.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ReaderRound } from "../read";

/** One round as the tray shows it: who sent it, its title, and whether this reader has submitted. */
export interface TrayRound {
  /** `OpenThinkAi/<slug>-reading#<pr>`: what a click asks to open. */
  ref: string;
  title: string;
  sender: string;
  /** `waiting` rounds are open for the reader; `sent` ones are "sent to Matt". */
  status: "waiting" | "sent";
}

/** The whole of what `PabloTray.swift` reads. */
export interface TrayState {
  daemonPid: number;
  version: string;
  rounds: TrayRound[];
  lastError?: string;
  /** Set after a self-update, while that version is the running one: the menu says "Updated to <v>". */
  updatedTo?: string;
}

/** `$XDG_STATE_HOME/pablo/tray` (default `~/.local/state/pablo/tray`): the daemon's state, the parcel and `notified.json`. */
export function trayDir(env: Record<string, string | undefined> = process.env): string {
  const state = env["XDG_STATE_HOME"] && env["XDG_STATE_HOME"] !== "" ? env["XDG_STATE_HOME"] : join(env["HOME"] ?? homedir(), ".local", "state");
  return join(state, "pablo", "tray");
}

export const trayStatePath = (dir: string): string => join(dir, "tray-state.json");
export const trayParcelPath = (dir: string): string => join(dir, "tray-request.json");
export const notifiedPath = (dir: string): string => join(dir, "notified.json");

/** Projects the listed rounds down to what the tray shows, waiting first (the list's own order within each group). */
export function toTrayRounds(rounds: readonly ReaderRound[]): TrayRound[] {
  return rounds.map(({ ref, title, sender, status }) => ({ ref, title, sender, status }));
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

/** Writes `state` temp-then-rename so the helper, which watches the directory, never sees a half-written file. */
export function writeTrayState(path: string, state: TrayState): void {
  writeAtomic(path, JSON.stringify(state));
}

/** The refs already announced; a missing or damaged file means none (worst case: one repeated notification). */
export function readNotified(path: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function writeNotified(path: string, refs: ReadonlySet<string>): void {
  writeAtomic(path, JSON.stringify([...refs].sort()));
}
