import { expect, test } from "bun:test";
import { parseBeatList, parsePlanRows } from "../src";

test("parseBeatList reads numbers, lists and ranges, deduplicated in order", () => {
  expect(parseBeatList("2")).toEqual([2]);
  expect(parseBeatList("2-3")).toEqual([2, 3]);
  expect(parseBeatList("1, 3–5")).toEqual([1, 3, 4, 5]);
  expect(parseBeatList("2, 2-3")).toEqual([2, 3]);
  expect(parseBeatList("")).toEqual([]);
  expect(parseBeatList("theme")).toEqual([]);
  expect(parseBeatList("5-3")).toEqual([]);
});

test("parsePlanRows skips the header, keeps an escaped pipe in a title, and reads beats", () => {
  const rows = parsePlanRows(
    ["# Plan: novel", "", "| unit | title | beats | status |", "|---|---|---|---|", "| 1 | A \\| B | 1 | draft |", "| 2 | Two | 2-3 | beat |", ""].join("\n"),
  );
  expect(rows).toEqual([
    { unit: 1, title: "A | B", beats: [1], status: "draft" },
    { unit: 2, title: "Two", beats: [2, 3], status: "beat" },
  ]);
});
