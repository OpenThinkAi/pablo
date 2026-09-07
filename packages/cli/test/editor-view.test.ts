import { describe, expect, test } from "bun:test";
import {
  applyCandidate,
  countWords,
  groupHitsByParagraph,
  joinParagraphs,
  nextSavedText,
  paragraphIndexForLine,
  selectionToBodyOffsets,
  splitParagraphs,
} from "../views/editor-logic";

describe("splitParagraphs / joinParagraphs", () => {
  test("round-trips a multi-paragraph body byte for byte", () => {
    const body = "First paragraph,\nsoft-wrapped once.\n\nSecond paragraph.\n\nThird.";
    const paragraphs = splitParagraphs(body);
    expect(paragraphs).toEqual(["First paragraph,\nsoft-wrapped once.", "Second paragraph.", "Third."]);
    expect(joinParagraphs(paragraphs)).toBe(body);
  });

  test("a single-paragraph body splits to one element", () => {
    expect(splitParagraphs("Just one paragraph.")).toEqual(["Just one paragraph."]);
  });

  test("an empty body is one empty paragraph, not zero", () => {
    expect(splitParagraphs("")).toEqual([""]);
    expect(joinParagraphs([""])).toBe("");
  });
});

describe("countWords", () => {
  test("matches the host's algorithm: split on whitespace runs, drop empties", () => {
    expect(countWords("one two three")).toBe(3);
    expect(countWords("  leading and trailing  ")).toBe(3);
    expect(countWords("multiple\n\nblank\n\n\nlines   between words")).toBe(5);
  });

  test("an empty or whitespace-only body counts zero words", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   \n  \n")).toBe(0);
  });
});

describe("selectionToBodyOffsets", () => {
  const paragraphs = ["Alpha bravo.", "Charlie delta echo.", "Foxtrot."];

  test("offsets within the first paragraph need no adjustment", () => {
    expect(selectionToBodyOffsets(paragraphs, 0, 0, 5)).toEqual({ start: 0, end: 5 });
  });

  test("offsets within a later paragraph are shifted past every prior paragraph and its separator", () => {
    // paragraphs[0].length (12) + separator (2) = 14
    expect(selectionToBodyOffsets(paragraphs, 1, 0, 7)).toEqual({ start: 14, end: 21 });
    // + paragraphs[1].length (19) + separator (2) = 35
    expect(selectionToBodyOffsets(paragraphs, 2, 0, 8)).toEqual({ start: 35, end: 43 });
  });

  test("a reversed in-paragraph range (end before start) is normalised", () => {
    expect(selectionToBodyOffsets(paragraphs, 0, 5, 0)).toEqual({ start: 0, end: 5 });
  });

  test("an empty selection (collapsed caret) is undefined, not a zero-length span", () => {
    expect(selectionToBodyOffsets(paragraphs, 0, 3, 3)).toBeUndefined();
  });

  test("an out-of-range paragraph index is undefined", () => {
    expect(selectionToBodyOffsets(paragraphs, -1, 0, 1)).toBeUndefined();
    expect(selectionToBodyOffsets(paragraphs, 3, 0, 1)).toBeUndefined();
  });

  test("agrees with a plain-string reconstruction for every paragraph", () => {
    const body = joinParagraphs(paragraphs);
    for (let i = 0; i < paragraphs.length; i++) {
      const offsets = selectionToBodyOffsets(paragraphs, i, 1, 3);
      expect(offsets).toBeDefined();
      expect(body.slice(offsets!.start, offsets!.end)).toBe(paragraphs[i]!.slice(1, 3));
    }
  });
});

describe("applyCandidate", () => {
  test("replaces the [start, end) span with the candidate text", () => {
    const body = "The quick brown fox.";
    expect(applyCandidate(body, 4, 9, "slow")).toBe("The slow brown fox.");
  });

  test("a zero-length span is a pure insertion", () => {
    expect(applyCandidate("AB", 1, 1, "-mid-")).toBe("A-mid-B");
  });

  test("clamps an out-of-range span to the body's own bounds instead of throwing", () => {
    const body = "short";
    expect(applyCandidate(body, -5, 999, "replaced")).toBe("replaced");
    expect(applyCandidate(body, 3, 1, "x")).toBe("shoxrt"); // end below start clamps to start, i.e. an insertion at 3
  });
});

describe("paragraphIndexForLine", () => {
  const body = "Line one\nLine two.\n\nSecond paragraph, one line.\n\nThird para,\nspanning two lines.";
  const paragraphs = splitParagraphs(body);
  // body.split("\n") = [
  //   0 "Line one"                    -> line 1, paragraph 0
  //   1 "Line two."                   -> line 2, paragraph 0
  //   2 ""                            -> line 3 (blank separator)
  //   3 "Second paragraph, one line." -> line 4, paragraph 1
  //   4 ""                            -> line 5 (blank separator)
  //   5 "Third para,"                 -> line 6, paragraph 2
  //   6 "spanning two lines."         -> line 7, paragraph 2
  // ]

  test("maps every real line number to the paragraph checkFile would have numbered it inside", () => {
    expect(paragraphIndexForLine(paragraphs, 1)).toBe(0);
    expect(paragraphIndexForLine(paragraphs, 2)).toBe(0);
    expect(paragraphIndexForLine(paragraphs, 4)).toBe(1);
    expect(paragraphIndexForLine(paragraphs, 6)).toBe(2);
    expect(paragraphIndexForLine(paragraphs, 7)).toBe(2);
  });

  test("a line past the body's end clamps to the last paragraph", () => {
    expect(paragraphIndexForLine(paragraphs, 999)).toBe(paragraphs.length - 1);
  });

  test("a single-paragraph body always maps to paragraph 0", () => {
    expect(paragraphIndexForLine(["Only one paragraph here."], 1)).toBe(0);
  });
});

describe("groupHitsByParagraph", () => {
  test("groups hits by the paragraph their line falls in, preserving order within a paragraph", () => {
    const paragraphs = ["Alpha.\nBravo.", "Charlie."];
    const first = { line: 1, rule: "a" };
    const second = { line: 2, rule: "b" };
    const third = { line: 4, rule: "c" };
    const grouped = groupHitsByParagraph(paragraphs, [first, second, third]);
    expect(grouped.get(0)).toEqual([first, second]);
    expect(grouped.get(1)).toEqual([third]);
  });

  test("an empty hit list groups to nothing", () => {
    expect(groupHitsByParagraph(["Only one."], []).size).toBe(0);
  });
});

describe("nextSavedText", () => {
  test("a successful save marks the attempted text as the new saved baseline", () => {
    expect(nextSavedText("old body", "new body", true)).toBe("new body");
  });

  test("a failed save leaves the previous saved baseline untouched", () => {
    expect(nextSavedText("old body", "new body", false)).toBe("old body");
  });

  test("regression (AGT-1270 review): a Take that resets local state before its follow-up save must not be mistaken for a confirmed save if that save then fails — the baseline stays the pre-Take text so `dirty` stays true and Save stays enabled for a retry", () => {
    const beforeTake = "The pond rang under the horse.";
    const afterTakeLocally = "The pond rang first under the horse, then under the saws.";
    // The view resets its local body to `afterTakeLocally` immediately (Take
    // is instant), but only calls this with the save's real outcome.
    const savedTextAfterFailedFollowUpSave = nextSavedText(beforeTake, afterTakeLocally, false);
    expect(savedTextAfterFailedFollowUpSave).toBe(beforeTake);
    expect(savedTextAfterFailedFollowUpSave).not.toBe(afterTakeLocally);
  });
});
