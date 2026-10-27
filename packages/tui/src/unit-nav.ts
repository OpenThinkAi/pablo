// Next and previous unit inside the editing pane (AGT-2174, D-18). The units are the rail's drafted unit rows, in rail
// order across every output (a novel's chapters, then a radio script's scenes ...); each row carries its file and storage
// (AGT-2148). Pure: the pane's view asks for the neighbour, the model does the autosave and the switch.

import type { BookRail, Storage } from "./book";
import type { Pos } from "./buffer";

/** What navigation needs of the rail. */
export type UnitRail = Pick<BookRail, "rows" | "units">;

export interface UnitStop { readonly id: string; readonly file: string; readonly storage: Storage }

/** The drafted unit rows in rail order. */
export function unitStops(book: UnitRail): UnitStop[] {
  const stops: UnitStop[] = [];
  for (const r of book.rows) {
    const u = book.units[r.id];
    if (u) stops.push({ id: r.id, file: u.file, storage: u.storage });
  }
  return stops;
}

/** The unit after (`dir` 1) or before (-1) the one in `file`, or null at either end (no wrap) or when `file` is no unit of the rail. */
export function adjacentUnit(book: UnitRail, file: string, dir: 1 | -1): UnitStop | null {
  const stops = unitStops(book);
  const at = stops.findIndex((s) => s.file === file);
  return at < 0 ? null : stops[at + dir] ?? null;
}

/** A cursor held for a file, clamped to the lines it has now. */
export function clampCursor(lines: readonly string[], at: Pos): Pos {
  const row = Math.max(0, Math.min(at.row, lines.length - 1));
  return { row, col: Math.max(0, Math.min(at.col, lines[row]?.length ?? 0)) };
}
