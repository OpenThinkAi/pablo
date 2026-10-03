// check hits as boxes: where a hit's box lands among the display rows, the box itself, the detail, and g f / g F.

import { expect, test } from "bun:test";
import { commentBox } from "../src/comment-box";
import { displayDoc, displayLines } from "../src/document";
import { hitAt, hitDetail, hitRows, mainRows, nextHitRow, type CheckHit } from "../src/hits";

const CHAPTER = [
  "---", "chapter: 3", "status: draft", "---", "",
  "The well had been dry since June.", // 6
  "She did not look up — not once.", // 7
  "", "Edwin stood in the doorway.", // 9
].join("\n");

test("anchors name the display row where each file line ends, frontmatter counted", () => {
  const { lines, anchors } = displayDoc(CHAPTER, 80);
  expect(lines).toEqual(["The well had been dry since June. She did not look up — not once.", "", "Edwin stood in the doorway."]);
  expect([...anchors]).toEqual([[6, 0], [7, 0], [9, 2]]);
  // Narrow: the paragraph wraps, and line 6's sentence ends on the first wrapped row.
  const narrow = displayDoc(CHAPTER, 34);
  expect(narrow.lines.slice(0, 2)).toEqual(["The well had been dry since June.", "She did not look up — not once."]);
  expect(narrow.anchors.get(6)).toBe(0);
  expect(narrow.anchors.get(7)).toBe(1);
  expect(displayLines(CHAPTER, 34)).toEqual(narrow.lines);
});

test("the box rows sit under the line with the hit, three rows each, in the hit's colour", () => {
  const hit: CheckHit = { line: 7, rule: "em-dash", excerpt: "She did not look up — not once." };
  const rows = mainRows(CHAPTER, 34, [hit]);
  expect(rows.map((r) => r.kind)).toEqual(["text", "text", "box", "box", "box", "text", "text"]);
  expect(rows.slice(2, 5).map((r) => r.text)).toEqual([
    "  ╭ ▲ tells · em-dash ───────────╮",
    "  │ She did not look up — not o… │",
    "  ╰──────────────────────────────╯",
  ]);
  expect(rows.every((r) => r.kind === "text" || r.color === "yellow")).toBe(true);
});

test("a hit on a frontmatter or blank line goes under the nearest line before it, or the first", () => {
  expect(mainRows(CHAPTER, 80, [{ line: 2, rule: "x", excerpt: "e" }]).map((r) => r.kind)).toEqual(["text", "box", "box", "box", "text", "text"]);
  expect(mainRows(CHAPTER, 80, [{ line: 8, rule: "x", excerpt: "e" }]).map((r) => r.kind)).toEqual(["text", "box", "box", "box", "text", "text"]);
});

test("hits on one line stack in order; a stock name shows its name", () => {
  const rows = mainRows(CHAPTER, 80, [
    { line: 9, rule: "stock-name", excerpt: "Edwin stood in the doorway.", detail: "Edwin" },
    { line: 9, rule: "foreshadow", excerpt: "Edwin stood in the doorway." },
  ]);
  expect(rows.filter((r) => r.kind === "box").map((r) => (r as { hit: number }).hit)).toEqual([0, 0, 0, 1, 1, 1]);
  expect(rows[3]!.text).toContain("stock-name (Edwin)");
  expect(rows[4]!.text).toContain('"Edwin" appears in this line');
});

test("a box never overflows its width, however long the header or body", () => {
  for (const width of [5, 12, 30, 60]) {
    const box = commentBox({ title: "▲ tells · a very long header that cannot fit", tag: "(and its tag)", body: "x".repeat(200) }, width);
    expect(box.map((r) => [...r.text].length)).toEqual([width, width, width].map((w) => Math.max(5, w)));
  }
  expect(commentBox({ title: "a\x1b[2Jb", body: "c\x07d" }, 20)[0]!.text).not.toContain("\x1b");
});

test("the detail names the rule, the pattern it flagged and the line", () => {
  expect(hitDetail({ line: 7, rule: "em-dash", excerpt: "She did not look up — not once." })).toEqual({
    title: "check · em-dash · line 7",
    body: "rule: em-dash\npattern: an em-dash (—)\nline 7: She did not look up — not once.",
  });
  expect(hitDetail({ line: 9, rule: "stock-name", excerpt: "Edwin stood.", detail: "Edwin" }).body).toContain("name: Edwin");
  expect(hitDetail({ line: 9, rule: "flagged-line", excerpt: "Her eyes were pools." }).body).toContain("flagged line: Her eyes were pools.");
});

test("hitAt finds the hit on the cursor's line or in its box; g f / g F walk the boxes and wrap", () => {
  const rows = mainRows(CHAPTER, 80, [{ line: 7, rule: "em-dash", excerpt: "a" }, { line: 9, rule: "foreshadow", excerpt: "b" }]);
  // rows: 0 text, 1-3 box(0), 4 blank, 5 text, 6-8 box(1)
  expect(hitRows(rows)).toEqual([1, 6]);
  expect(hitAt(rows, 0)).toBe(0);
  expect(hitAt(rows, 2)).toBe(0);
  expect(hitAt(rows, 4)).toBeUndefined();
  expect(hitAt(rows, 5)).toBe(1);
  expect(nextHitRow(rows, 0, 1)).toBe(1);
  expect(nextHitRow(rows, 1, 1)).toBe(6);
  expect(nextHitRow(rows, 2, 1)).toBe(6); // from inside a box, the next one
  expect(nextHitRow(rows, 7, 1)).toBe(1); // wraps
  expect(nextHitRow(rows, 0, -1)).toBe(6); // wraps backwards
  expect(nextHitRow(rows, 6, -1)).toBe(1);
  expect(nextHitRow(rows, 8, -1)).toBe(1); // from inside the second box, the one before it
  expect(nextHitRow(rows, 3, -1)).toBe(6); // from inside the first, round the end
  expect(nextHitRow(mainRows(CHAPTER, 80, []), 0, 1)).toBeUndefined();
});

test("commentBox wraps the body onto up to maxLines rows, every row the same width; the default stays one cut line (AGT-1580)", () => {
  const body = "word ".repeat(30);
  const all = commentBox({ title: "t", body }, 30, { maxLines: Infinity });
  expect(all.length).toBeGreaterThan(3);
  expect(new Set(all.map((r) => [...r.text].length))).toEqual(new Set([30]));
  expect(all.map((r) => r.part)).toEqual(["top", ...all.slice(1, -1).map(() => "body" as const), "bottom"]);
  const two = commentBox({ title: "t", body }, 30, { maxLines: 2 });
  expect(two).toHaveLength(4);
  expect(two[2]!.text).toContain("…");
  expect(commentBox({ title: "t", body }, 30)).toHaveLength(3);
  // A word longer than a row is cut across rows, never overflowing the box.
  expect(new Set(commentBox({ title: "t", body: "x".repeat(70) }, 20, { maxLines: Infinity }).map((r) => [...r.text].length))).toEqual(new Set([20]));
});
