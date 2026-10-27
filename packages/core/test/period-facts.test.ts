import { expect, test } from "bun:test";
import { factHoldsBy, parsePeriodFacts, periodFactsAt, renderPeriodFactLine, storyDateKey } from "../src/index";
import type { PeriodFact } from "../src/index";

test("AGT-2110: a story date reads as precisely as its text allows", () => {
  expect(storyDateKey("1929-01-09")).toBe("1929-01-09");
  expect(storyDateKey("1929-03")).toBe("1929-03");
  expect(storyDateKey("January 1929")).toBe("1929-01");
  expect(storyDateKey("9 January 1929")).toBe("1929-01-09");
  expect(storyDateKey("Jan 9, 1929")).toBe("1929-01-09");
  expect(storyDateKey("Winter 1931")).toBe("1931");
  expect(storyDateKey("1934")).toBe("1934");
  expect(storyDateKey("the morning after")).toBeUndefined();
  expect(storyDateKey("1931, may be autumn")).toBe("1931");
});

test("AGT-2110: a fact holds by a unit's date, compared at the coarser precision", () => {
  expect(factHoldsBy("1929-01", "1929-03-12")).toBe(true);
  expect(factHoldsBy("1929-05", "1929-03-12")).toBe(false);
  expect(factHoldsBy("1929-05", "1929")).toBe(true);
  expect(factHoldsBy("1930", "1929-12")).toBe(false);
});

const facts: PeriodFact[] = [
  { fact: "Ice sold at forty cents a hundredweight.", source: "prices", date: "1929-01" },
  { fact: "Mechanical refrigerators were in the county's hotels.", source: "fridges", date: "1931-06" },
  { fact: "The cannery ran two shifts.", source: "cannery", date: "1934" },
  { fact: "A pond was cut in squares with a horse-drawn plough.", source: "cutting" },
];

test("AGT-2110: a unit gets undated facts and those dated on or before its latest beat", () => {
  expect(periodFactsAt(facts, ["January 1929"]).map((f) => f.source)).toEqual(["prices", "cutting"]);
  expect(periodFactsAt(facts, ["Winter 1931"]).map((f) => f.source)).toEqual(["prices", "fridges", "cutting"]);
  expect(periodFactsAt(facts, ["January 1929", "1934"]).map((f) => f.source)).toEqual([
    "prices",
    "fridges",
    "cannery",
    "cutting",
  ]);
  // No readable date: every fact, as the story-time gate fails safe.
  expect(periodFactsAt(facts, ["the next morning"])).toHaveLength(4);
});

test("AGT-2110: the writer sees the fact and its date, never its source note", () => {
  expect(renderPeriodFactLine(facts[0] as PeriodFact)).toBe("- Ice sold at forty cents a hundredweight. (from 1929-01)");
  expect(renderPeriodFactLine(facts[3] as PeriodFact)).not.toContain("cutting");
});

test("parsePeriodFacts reads distill's table, escaped pipes included", () => {
  const text = [
    "# Period facts",
    "",
    "| Fact | Source | Story date |",
    "| --- | --- | --- |",
    "| A \\| B | prices | 1929 |",
    "| Undated | cutting |  |",
  ].join("\n");
  expect(parsePeriodFacts(text)).toEqual([
    { fact: "A | B", source: "prices", date: "1929" },
    { fact: "Undated", source: "cutting" },
  ]);
});
