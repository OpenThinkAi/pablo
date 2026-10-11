/**
 * The review player's pure logic (AGT-1693): no DOM, no React, no IO, tested directly
 * (`test/review-logic.test.ts`). The view (`review.tsx`) only draws and calls these.
 */

import type { ChapterRow, ReviewFlag, ReviewLine } from "./review-protocol";

/** Seconds: by the time you hit the key, the bad line has usually just ended (the prototype's REACTION). */
export const REACTION = 1.0;

export function clock(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** The index of the line playing at `t` (the last one that has started), or -1 before the first. */
export function lineIndexAt(lines: readonly ReviewLine[], t: number): number {
  let found = -1;
  for (let k = 0; k < lines.length; k++) {
    if ((lines[k] as ReviewLine).start <= t) found = k;
    else break;
  }
  return found;
}

/** The line the flag key pins: the one that was playing `REACTION` seconds ago (the first when none was). */
export function flagTargetIndex(lines: readonly ReviewLine[], t: number): number {
  if (lines.length === 0) return -1;
  const k = lineIndexAt(lines, Math.max(0, t - REACTION));
  return k >= 0 ? k : 0;
}

/**
 * Where to resume in a newly chosen version: the start of the line that was playing, found by line id, so
 * switching v2 to v3 lands on the same sentence rather than the same second. 0 when the line is gone.
 */
export function seekAfterSwitch(oldLines: readonly ReviewLine[], t: number, newLines: readonly ReviewLine[]): number {
  const was = oldLines[lineIndexAt(oldLines, t)];
  if (was === undefined) return 0;
  return newLines.find((line) => line.i === was.i)?.start ?? 0;
}

/** A score for display: three decimals at most, booleans as yes/no. */
export function scoreText(value: number | boolean): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(Math.round(value * 1000) / 1000);
}

/** The current line's scores as `name value` pairs. */
export function gateRows(line: ReviewLine | undefined): { readonly name: string; readonly value: string }[] {
  if (line === undefined) return [];
  return Object.entries(line.gates).map(([name, value]) => ({ name, value: scoreText(value) }));
}

/** The flags of one line, auto ones first (they are the performer's; the listener's follow). */
export function flagsOnLine(flags: readonly ReviewFlag[], line: number): ReviewFlag[] {
  return flags.filter((f) => f.line === line).sort((a, b) => Number(b.source === "auto") - Number(a.source === "auto"));
}

/** Episodes in `next` that `prev` did not have: what just arrived while the player was open. */
export function arrivals(prev: readonly ChapterRow[], next: readonly ChapterRow[]): number[] {
  const had = new Set(prev.map((c) => c.episode));
  return next.filter((c) => !had.has(c.episode)).map((c) => c.episode);
}
