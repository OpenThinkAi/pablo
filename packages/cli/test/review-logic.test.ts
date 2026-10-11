import { expect, test } from "bun:test";
import { arrivals, clock, flagTargetIndex, flagsOnLine, gateRows, lineIndexAt, scoreText, seekAfterSwitch } from "../views/review-logic";
import type { ChapterRow, ReviewFlag, ReviewLine } from "../views/review-protocol";

const line = (i: number, start: number, end: number, extra: Partial<ReviewLine> = {}): ReviewLine => ({ i, speaker: "HOST", text: `Line ${i}`, start, end, gates: {}, failing: [], ...extra });
const LINES = [line(0, 0.5, 3), line(1, 3.4, 7), line(2, 7.5, 11)];

test("clock formats seconds as m:ss and survives junk", () => {
  expect(clock(0)).toBe("0:00");
  expect(clock(75.9)).toBe("1:15");
  expect(clock(-3)).toBe("0:00");
  expect(clock(Number.NaN)).toBe("0:00");
});

test("lineIndexAt is the last line that has started; -1 before the first", () => {
  expect(lineIndexAt(LINES, 0)).toBe(-1);
  expect(lineIndexAt(LINES, 0.5)).toBe(0);
  expect(lineIndexAt(LINES, 7.2)).toBe(1);
  expect(lineIndexAt(LINES, 99)).toBe(2);
  expect(lineIndexAt([], 5)).toBe(-1);
});

test("the flag key pins the line that was playing a second ago, the first line when none was, nothing when empty", () => {
  expect(flagTargetIndex(LINES, 7.9)).toBe(1); // line 2 began 0.4 s ago: the bad one just ended
  expect(flagTargetIndex(LINES, 9)).toBe(2);
  expect(flagTargetIndex(LINES, 0.6)).toBe(0);
  expect(flagTargetIndex([], 3)).toBe(-1);
});

test("switching version resumes at the start of the same line in the new timings", () => {
  const v2 = [line(0, 0.5, 3), line(1, 3.4, 9), line(2, 9.5, 13)];
  expect(seekAfterSwitch(LINES, 8, v2)).toBe(9.5); // was in line 2
  expect(seekAfterSwitch(LINES, 4, v2)).toBe(3.4);
  expect(seekAfterSwitch(LINES, 0.1, v2)).toBe(0); // before the first line
  expect(seekAfterSwitch(LINES, 8, [line(0, 0, 1)])).toBe(0); // the line is gone
});

test("scores show three decimals at most and booleans as yes/no; gate rows keep manifest order", () => {
  expect(scoreText(0.812345)).toBe("0.812");
  expect(scoreText(4)).toBe("4");
  expect(scoreText(true)).toBe("yes");
  expect(gateRows(line(0, 0, 1, { gates: { sim_card: 0.8164, tail_ok: false } }))).toEqual([
    { name: "sim_card", value: "0.816" },
    { name: "tail_ok", value: "no" },
  ]);
  expect(gateRows(undefined)).toEqual([]);
});

test("flagsOnLine lists the performer's auto flag before the listener's", () => {
  const f = (id: string, l: number, source: "human" | "auto"): ReviewFlag => ({ id, episode: 1, line: l, reason: "r", time: 0, source, failing: [] });
  expect(flagsOnLine([f("h", 1, "human"), f("a", 1, "auto"), f("x", 2, "auto")], 1).map((x) => x.id)).toEqual(["a", "h"]);
});

test("arrivals names the episodes that were not in the list before", () => {
  const row = (episode: number): ChapterRow => ({ episode, title: "", versions: [], latest: 1, flags: { human: 0, auto: 0 } });
  expect(arrivals([row(1)], [row(1), row(2), row(3)])).toEqual([2, 3]);
  expect(arrivals([], [row(1)])).toEqual([1]);
  expect(arrivals([row(1)], [row(1)])).toEqual([]);
});
