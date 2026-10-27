// Focus and typewriter modes for the editing pane (AGT-2176, D-18): two toggles that make long sessions comfortable.
// Focus dims everything but the paragraph the cursor is in; typewriter keeps the cursor's row in the middle of the pane.
// This file is the pure rules (which rows are the paragraph, where the viewport sits) and the two toggles' persistence in
// ~/.config/pablo/config.json (`editModes`); edit-pane.ts calls the rules, edit-pane-view.tsx the toggles. The keys that
// flip them are the `edit.focus` / `edit.typewriter` rows of keys.ts, so the author can rebind them like any other.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "@openthink/pablo-core";
import type { Keymap } from "./keys";
import type { EditModes } from "./state";

export type Modes = EditModes;
export const NO_MODES: Modes = { focus: false, typewriter: false };
export type ModeName = keyof Modes;

/** The modes in a config file's text (`"editModes": { "focus": true }`); a missing or malformed entry reads as off. */
export function parseModes(text: string): Modes {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return NO_MODES; }
  const m = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>)["editModes"] : undefined;
  if (typeof m !== "object" || m === null || Array.isArray(m)) return NO_MODES;
  const o = m as Record<string, unknown>;
  return { focus: o["focus"] === true, typewriter: o["typewriter"] === true };
}

export interface LoadModesOptions {
  readonly env?: Record<string, string | undefined>;
  /** Injected so tests never read the real file. Returns undefined when there is none. */
  readonly readFile?: (path: string) => string | undefined;
}

/** The modes this machine's config sets: both off when there is none. */
export function loadModes(options: LoadModesOptions = {}): Modes {
  const path = configPath(options.env ?? process.env);
  const read = options.readFile ?? ((p: string) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } });
  const text = read(path);
  return text === undefined ? NO_MODES : parseModes(text);
}

/**
 * Write `modes` into the config file at `path`, keeping every other entry as it is on disk now. Both off removes the
 * entry. A file that is not a JSON object is left alone and the error says so.
 */
export function saveModes(path: string, modes: Modes): void {
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  let obj: Record<string, unknown> = {};
  if (before.trim()) {
    let raw: unknown;
    try { raw = JSON.parse(before); } catch (e) { throw new Error(`${path} is not valid JSON (${(e as Error).message}); the mode was not saved`); }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${path} must contain a JSON object; the mode was not saved`);
    obj = raw as Record<string, unknown>;
  }
  const { editModes: _old, ...rest } = obj;
  const next: Record<string, unknown> = { ...rest };
  if (modes.focus || modes.typewriter) next["editModes"] = { focus: modes.focus, typewriter: modes.typewriter };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, path);
}

/** The mode a pressed key token toggles under `keymap` (the `edit.focus` / `edit.typewriter` rows), if any. */
export function modeOfKey(token: string | null, keymap: Keymap): ModeName | null {
  if (token === null) return null;
  for (const a of keymap.actions) {
    if (a.id !== "edit.focus" && a.id !== "edit.typewriter") continue;
    if (a.key === token || a.secondary === token) return a.id === "edit.focus" ? "focus" : "typewriter";
  }
  return null;
}

export const toggled = (m: Modes, name: ModeName): Modes => ({ ...m, [name]: !m[name] });

/** The buffer rows of the paragraph at `row`: the run of non-blank lines around it (just the row itself when it is blank). */
export function paragraphSpan(lines: readonly string[], row: number): { readonly first: number; readonly last: number } {
  const blank = (r: number) => (lines[r] ?? "").trim() === "";
  if (blank(row)) return { first: row, last: row };
  let first = row, last = row;
  while (first > 0 && !blank(first - 1)) first--;
  while (last < lines.length - 1 && !blank(last + 1)) last++;
  return { first, last };
}

/**
 * The viewport's first display row. Typewriter: the cursor's row in the middle of the `height` rows (rows above the
 * first or below the last show blank, so the first line can sit mid-screen too). Otherwise `top` is kept unless the
 * cursor left the window, then moved just far enough, and kept inside the `total` rows.
 */
export function scrollTop(top: number, cursorAt: number, height: number, total: number, typewriter: boolean): number {
  const h = Math.max(1, height);
  if (typewriter) return cursorAt - Math.floor((h - 1) / 2);
  let t = top;
  if (cursorAt < t) t = cursorAt;
  if (cursorAt >= t + h) t = cursorAt - h + 1;
  return Math.max(0, Math.min(t, Math.max(0, total - 1)));
}
