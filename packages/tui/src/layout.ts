// The geometry of the screen, pure so the corner cases (an 80-column terminal, a 24-row one, text longer than the
// content area) are tested without drawing anything. Copied from prview's layout.ts and adapted: pablo's main pane
// shows a document's sentence lines, not a diff, so there is no code gutter or finding box. Top to bottom:
//
//   status area    the title, then the fields (status.ts)               STATUS_H rows: border, two lines, border
//   middle         the rail (the table of contents) and the main pane    what is left
//   bottom panel   the content area (left) and the key panel (right)     a third of the screen, 8 to 14 rows
//   footer         what a key just did, or the chord being typed         one row
//
// `view.zen` hides the rail and gives the main pane its width; `view.full` makes the bottom panel the whole screen
// under the status area, so the content area can be read at length (the key panel stays beside it).
//
// The layout only measures. It tells the model how many rows each region shows (`measure`, dispatched as `measured`)
// and the model keeps every cursor in view; nothing here is state.

import type { Measure } from "./state";

/** Below this many columns the rail shrinks to a narrow strip so the main pane keeps the room. */
export const NARROW = 100;
export const NARROW_RAIL = 8;
export const STATUS_H = 4;
export const FOOTER_H = 1;
/** The bottom panel's height: a third of the screen, never below 8 rows or above 14. */
export const BOTTOM_MIN = 8;
export const BOTTOM_MAX = 14;
/** The middle keeps this many rows (a heading and a few lines); on a short terminal the bottom panel gives them up first. */
export const MIDDLE_MIN = 8;
/** The bottom panel's border and its title row, around the content area's text. */
const PANEL_CHROME = 3;

/** Rows of the bottom panel, borders and title included, for `rows` rows of screen. */
export function bottomHeight(rows: number): number {
  const want = Math.max(BOTTOM_MIN, Math.min(BOTTOM_MAX, Math.floor(rows / 3)));
  return Math.max(4, Math.min(want, rows - STATUS_H - FOOTER_H - MIDDLE_MIN));
}

export interface Layout {
  readonly narrow: boolean; readonly zen: boolean; readonly full: boolean;
  /** The middle: the rail (0 wide in zen) and the main pane beside it, each with a heading row above its lines. */
  readonly middleH: number; readonly railW: number; readonly railRows: number;
  readonly mainW: number; readonly mainInner: number; readonly mainRows: number;
  /** The bottom panel: the content area, whose text is `contentInner` wide and `contentRows` tall, and the key panel. */
  readonly bottomH: number; readonly contentW: number; readonly contentInner: number; readonly contentRows: number; readonly panelW: number;
}

export function layoutOf(cols: number, rows: number, { zen = false, full = false }: { zen?: boolean; full?: boolean } = {}): Layout {
  const narrow = cols < NARROW;
  const railW = zen ? 0 : narrow ? NARROW_RAIL : Math.min(34, Math.max(24, Math.floor(cols * 0.28)));
  // One column between the rail and the main pane draws the divider; in zen there is no divider.
  const mainW = cols - railW - (zen ? 0 : 1);
  const bottomH = full ? Math.max(4, rows - STATUS_H - FOOTER_H) : bottomHeight(rows);
  const middleH = full ? 0 : Math.max(0, rows - STATUS_H - FOOTER_H - bottomH);
  // The key panel is about a third of the width: room for two columns of keys at 120 columns and up.
  const panelW = Math.max(24, Math.floor(cols * 0.36));
  const contentW = cols - panelW;
  return {
    narrow, zen, full, middleH, railW, railRows: Math.max(0, middleH - 1),
    mainW, mainInner: Math.max(1, mainW - 2), mainRows: Math.max(0, middleH - 1),
    bottomH, contentW, contentInner: Math.max(1, contentW - 4), contentRows: Math.max(1, bottomH - PANEL_CHROME), panelW,
  };
}

/** Rows a line of `len` columns takes when wrapped to `width`. */
export const rowsFor = (len: number, width: number) => Math.max(1, Math.ceil(len / Math.max(1, width)));

/** `s` wrapped to `width` columns on word breaks; a word wider than the width is broken across rows rather than cut. */
export function wrapText(s: string, width: number): string[] {
  const out: string[] = [];
  for (const para of s.split("\n")) {
    let cur = "";
    const words = para.split(/\s+/).filter(Boolean).flatMap((w) => (w.length <= width || width < 1 ? [w] : w.match(new RegExp(`.{1,${width}}`, "g"))!));
    for (const w of words) {
      if (cur && (cur + " " + w).length > width) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
    }
    out.push(cur);
  }
  return out;
}

/**
 * What the layout tells the model at this size: the rows the rail and main pane show and, when the content area
 * holds text, how many rows it shows and how many lines the text wraps to at its width.
 */
export function measureOf(l: Layout, contentBody: string | null): Measure {
  return {
    rail: l.railRows, main: l.mainRows,
    ...(contentBody === null ? {} : { content: { visible: l.contentRows, lines: wrapText(contentBody, l.contentInner).length } }),
  };
}
