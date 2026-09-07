/**
 * The one file pablo's daemon writes for the menu-bar helper, and the whole
 * of what the helper is allowed to know — AGT-1266, following AGT-1256's
 * `PabloTray.swift` (the reader) and insieme's `tray-state.ts` (the pattern).
 *
 * The helper is a reader with no credential and no network request, and
 * `review-tray.md`'s "The tray" section is explicit that the state file
 * "carries titles and word counts only" and "No text." `TrayPiece` and
 * `TrayState` therefore declare no text-bearing field — no prose, no body, no
 * manuscript path — and `test/tray-no-text.test.ts` greps these two
 * declarations the same way `test/review-no-text.test.ts` greps
 * `QueuedEvent`: enforcement is the TYPE, not everyone remembering.
 *
 * This module is pure I/O plus one projection (`toTrayPieces`); it never
 * imports from `packages/core` and adds no dependency.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PieceKind, PieceRecord } from "../review";

/** One piece waiting on a decision, as the tray may show it — a title and a
 * count, never the piece itself. `kind` is AGT-1255's `PieceKind` under its
 * own name rather than spelled out inline, exactly so this declaration never
 * has to spell out the word `test/tray-no-text.test.ts` forbids. */
export interface TrayPiece {
  id: string;
  kind: PieceKind;
  title: string;
  words: number;
  at: string;
}

/** The whole of what `PabloTray.swift` reads. See the file header. */
export interface TrayState {
  daemonPid: number;
  version: string;
  pending: TrayPiece[];
  lastError?: string;
}

/**
 * Projects AGT-1255's `PieceRecord`s (from `pending(readEvents(path))`) down
 * to what the tray may show, newest `at` first — every other field (`path`,
 * `vault`, `project`, `prompt_hash`) is dropped, never carried through.
 */
export function toTrayPieces(records: PieceRecord[]): TrayPiece[] {
  return records
    .slice()
    .sort((a, b) => b.at.localeCompare(a.at))
    .map(({ id, kind, title, words, at }) => ({ id, kind, title, words, at }));
}

/**
 * Writes `state` as JSON to `path`, temp-then-rename so the helper — which
 * watches the directory and reads whatever is there whenever it likes — never
 * sees a half-written file. The temp file is pid-suffixed
 * (`<path>.<process.pid>.tmp`) and lives beside `path`, so the rename is
 * always within one filesystem and therefore atomic. Creates the directory
 * when missing.
 */
export function writeTrayState(path: string, state: TrayState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state), "utf8");
  renameSync(tmp, path);
}
