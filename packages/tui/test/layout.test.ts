// The layout's geometry, without a terminal: the regions add up at every size, and the measure reaches the model.

import { expect, test } from "bun:test";
import { BOTTOM_MAX, BOTTOM_MIN, FOOTER_H, MIDDLE_MIN, NARROW, NARROW_RAIL, STATUS_H, bottomHeight, layoutOf, measureOf, rowsFor, wrapText } from "../src/layout";
import { MIN_COLS, MIN_ROWS } from "../src/resize";
import { initialState, reduce, viewOf } from "../src/state";

const SIZES: [number, number][] = [[MIN_COLS, MIN_ROWS], [80, 24], [99, 30], [100, 32], [120, 40], [200, 60]];

test("the regions fill the screen at every size: status, middle, bottom panel, footer", () => {
  for (const [cols, rows] of SIZES) {
    const l = layoutOf(cols, rows);
    expect(STATUS_H + l.middleH + l.bottomH + FOOTER_H).toBe(rows);
    expect(l.railW + 1 + l.mainW).toBe(cols);
    expect(l.contentW + l.panelW).toBe(cols);
    expect(l.middleH).toBeGreaterThanOrEqual(MIDDLE_MIN);
  }
});

test("the bottom panel is a third of the screen, 8 to 14 rows, and gives up rows to the middle on a short terminal", () => {
  expect(bottomHeight(24)).toBe(BOTTOM_MIN);
  expect(bottomHeight(40)).toBe(13);
  expect(bottomHeight(100)).toBe(BOTTOM_MAX);
  expect(bottomHeight(20)).toBe(20 - STATUS_H - FOOTER_H - MIDDLE_MIN);
});

test("below 100 columns the rail is a narrow strip; above, a quarter of the width within 24 to 34", () => {
  expect(layoutOf(NARROW - 1, 30).railW).toBe(NARROW_RAIL);
  expect(layoutOf(NARROW - 1, 30).narrow).toBe(true);
  expect(layoutOf(100, 30).railW).toBe(28);
  expect(layoutOf(100, 30).narrow).toBe(false);
  expect(layoutOf(300, 30).railW).toBe(34);
});

test("zen hides the rail and gives the main pane its width", () => {
  const l = layoutOf(120, 40, { zen: true });
  expect(l.railW).toBe(0);
  expect(l.mainW).toBe(120);
});

test("full makes the bottom panel the whole screen under the status area, with no middle", () => {
  const l = layoutOf(120, 40, { full: true });
  expect(l.middleH).toBe(0);
  expect(STATUS_H + l.bottomH + FOOTER_H).toBe(40);
  expect(l.contentRows).toBe(l.bottomH - 3);
  expect(l.panelW).toBe(layoutOf(120, 40).panelW);
});

test("each pane shows its rows under a heading; the content area keeps at least one row", () => {
  const l = layoutOf(80, 24);
  expect(l.railRows).toBe(l.middleH - 1);
  expect(l.mainRows).toBe(l.middleH - 1);
  expect(layoutOf(MIN_COLS, MIN_ROWS).contentRows).toBeGreaterThanOrEqual(1);
  expect(layoutOf(10, 5).mainInner).toBeGreaterThanOrEqual(1);
});

test("wrapText breaks on words, keeps blank lines, and breaks a word wider than the box", () => {
  expect(wrapText("the well had been dry", 10)).toEqual(["the well", "had been", "dry"]);
  expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"]);
  expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  expect(rowsFor(25, 10)).toBe(3);
  expect(rowsFor(0, 10)).toBe(1);
});

test("measureOf: the rows each pane shows, and the content's wrapped length only while it holds text", () => {
  const l = layoutOf(80, 24);
  expect(measureOf(l, null)).toEqual({ rail: l.railRows, main: l.mainRows });
  const m = measureOf(l, "word ".repeat(100));
  expect(m.content?.visible).toBe(l.contentRows);
  expect(m.content?.lines).toBe(wrapText("word ".repeat(100), l.contentInner).length);
});

test("a new size reaches the model through `measured`, and the cursors follow", () => {
  let s = reduce(initialState(), { type: "main.loaded", lines: 100 });
  s = reduce(s, { type: "measured", measure: measureOf(layoutOf(80, 24), null) });
  s = reduce(s, { type: "main.goto", line: 60 });
  const small = viewOf(s).main;
  expect(small.visible).toBe(layoutOf(80, 24).mainRows);
  expect(small.cursor).toBe(59);
  expect(small.scroll + small.visible).toBeGreaterThan(59);
  s = reduce(s, { type: "measured", measure: measureOf(layoutOf(120, 50), null) });
  const big = viewOf(s).main;
  expect(big.visible).toBe(layoutOf(120, 50).mainRows);
  expect(big.cursor).toBe(59);
  expect(big.scroll <= 59 && 59 < big.scroll + big.visible).toBe(true);
});
