import { describe, expect, test } from "bun:test";
import { formatFactLine, formatProvenance, parseFactLine, scanFacts, withProvenance } from "../src/index";

// Invented fixtures only: no manuscript text belongs in this public repo.

const CANONICAL = [
  "- The harbour freezes in January [researched: Smith, Harbour Almanac 1902, p. 12]",
  "- Ines keeps bees [invented]",
  "- The ship sails in March [author]",
  "- Ines is 34 [ch03] [invented]",
  "- The key is in the loft [ch04, anchor not found] [researched: field notes]",
  "- Ines is 34 [ch03]",
  "- A plain untagged fact",
];

describe("parseFactLine", () => {
  test("round-trips canonical lines", () => {
    for (const line of CANONICAL) {
      const fact = parseFactLine(line);
      expect(fact).toBeDefined();
      expect(formatFactLine(fact!)).toBe(line);
    }
  });

  test("reads each tag kind and the chapter tag beside it", () => {
    expect(parseFactLine(CANONICAL[0]!)?.provenance).toEqual({ kind: "researched", source: "Smith, Harbour Almanac 1902, p. 12" });
    expect(parseFactLine(CANONICAL[1]!)?.provenance).toEqual({ kind: "invented" });
    expect(parseFactLine(CANONICAL[2]!)?.provenance).toEqual({ kind: "author" });
    const both = parseFactLine(CANONICAL[4]!);
    expect(both?.text).toBe("The key is in the loft");
    expect(both?.tags).toEqual(["ch04, anchor not found"]);
    expect(both?.provenance?.kind).toBe("researched");
  });

  test("untagged lines have no provenance", () => {
    expect(parseFactLine(CANONICAL[5]!)).toMatchObject({ provenance: undefined, conflicting: false, tags: ["ch03"] });
    expect(parseFactLine(CANONICAL[6]!)?.provenance).toBeUndefined();
  });

  test("non-bullets are not facts", () => {
    expect(parseFactLine("## Dates")).toBeUndefined();
    expect(parseFactLine("Ines keeps bees [invented]")).toBeUndefined();
  });

  test("unrelated or malformed brackets stay in the fact", () => {
    expect(parseFactLine("- Pick a name [pick]")).toMatchObject({ text: "Pick a name [pick]", provenance: undefined });
    expect(parseFactLine("- Odd [researched:]")).toMatchObject({ text: "Odd [researched:]", provenance: undefined });
    expect(parseFactLine("- Odd [Invented]")?.provenance).toBeUndefined();
  });

  test("a tag mid-line is not the line's provenance", () => {
    expect(parseFactLine("- Ines [invented] keeps bees")?.provenance).toBeUndefined();
  });

  test("two provenance tags are reported as conflicting, not guessed", () => {
    const fact = parseFactLine("- Ines keeps bees [invented] [author]");
    expect(fact).toMatchObject({ provenance: undefined, conflicting: true, text: "Ines keeps bees" });
  });

  test("accepts a * bullet and writes a - bullet", () => {
    expect(formatFactLine(parseFactLine("* Ines keeps bees [invented]")!)).toBe("- Ines keeps bees [invented]");
  });
});

describe("formatProvenance / withProvenance", () => {
  test("formats each kind", () => {
    expect(formatProvenance({ kind: "invented" })).toBe("[invented]");
    expect(formatProvenance({ kind: "author" })).toBe("[author]");
    expect(formatProvenance({ kind: "researched", source: "  a\nb " })).toBe("[researched: a b]");
  });

  test("rejects a researched fact without a usable source", () => {
    expect(() => formatProvenance({ kind: "researched", source: "  " })).toThrow(RangeError);
    expect(() => formatProvenance({ kind: "researched", source: "x [1]" })).toThrow(RangeError);
  });

  test("tags an untagged line, keeping its chapter tag", () => {
    expect(withProvenance("- Ines is 34 [ch03]", { kind: "author" })).toBe("- Ines is 34 [ch03] [author]");
  });

  test("replaces an existing or conflicting tag", () => {
    expect(withProvenance("- Ines keeps bees [invented]", { kind: "author" })).toBe("- Ines keeps bees [author]");
    expect(withProvenance("- X [invented] [author]", { kind: "invented" })).toBe("- X [invented]");
  });

  test("leaves a non-fact line alone", () => {
    expect(withProvenance("## Dates", { kind: "author" })).toBe("## Dates");
  });
});

describe("scanFacts", () => {
  const TEXT = [
    "# Continuity",
    "",
    "## Names and ages",
    "- Ines is 34 [ch03] [invented]",
    "- Tomas is 40 [ch03]",
    "",
    "## Dates",
    "- Frost came early [researched: Almanac]",
    "- Sailing date [author] [invented]",
    "Some prose, not a fact.",
  ].join("\n");

  test("lists facts with their line and heading", () => {
    const { facts } = scanFacts(TEXT);
    expect(facts.map((f) => [f.line, f.heading])).toEqual([
      [3, "## Names and ages"],
      [4, "## Names and ages"],
      [7, "## Dates"],
      [8, "## Dates"],
    ]);
  });

  test("reports untagged and conflicting lines as untagged", () => {
    expect(scanFacts(TEXT).untagged.map((f) => f.line)).toEqual([4, 8]);
  });

  test("an empty file has no facts", () => {
    expect(scanFacts("")).toEqual({ facts: [], untagged: [] });
  });
});
