import { expect, test } from "bun:test";
import type { ReviewDraft } from "../views/reader-protocol";
import { parseDraft } from "../views/reader-protocol";
import {
  canSubmit,
  chapterNote,
  collidingSuggestion,
  diffEdit,
  draftReducer,
  editMark,
  excerpt,
  marksOf,
  ordered,
  MAX_PAGE_PX,
  MIN_PAGE_PX,
  overlaps,
  popoverPlacement,
  readerLayout,
  segments,
  selectedText,
  sliceIn,
} from "../views/reader-logic";

/** AGT-1586: the reader view's pure logic. No DOM, no React: the view only measures and renders. */
const PATH = "novels/ice-house/chapters/03-the-thaw.md";
const sel = (p: number, a: number, b: number) => ({ start: { paragraph: p, offset: a }, end: { paragraph: p, offset: b } });
const empty: ReviewDraft = { summary: "", marks: [] };

test("diffEdit: the replaced span and what replaced it; undefined when nothing changed", () => {
  expect(diffEdit("The river rose.", "The river rose.")).toBeUndefined();
  expect(diffEdit("The river rose.", "The river climbed.")).toEqual({ start: 10, end: 14, replacement: "climbed" });
  expect(diffEdit("The river rose.", "The rose.")).toEqual({ start: 5, end: 11, replacement: "" }); // a deletion, trimmed to the shared prefix "The r" and suffix "ose."
  expect(diffEdit("abc", "abXc")).toEqual({ start: 2, end: 2, replacement: "X" }); // an insertion is a caret
  expect(diffEdit("", "new")).toEqual({ start: 0, end: 0, replacement: "new" });
  expect(diffEdit("aaa", "aa")).toEqual({ start: 2, end: 3, replacement: "" }); // overlapping prefix and suffix do not double count
});

test("editMark records typing as a suggestion on that paragraph", () => {
  expect(editMark(PATH, 2, "The river rose.", "The river climbed.")).toEqual({
    kind: "suggestion",
    path: PATH,
    selection: sel(2, 10, 14),
    replacement: "climbed",
  });
  expect(editMark(PATH, 2, "same", "same")).toBeUndefined();
});

test("ordered, overlaps and sliceIn: selections in reading order, collisions, per-paragraph slices", () => {
  expect(ordered({ paragraph: 1, offset: 3 }, { paragraph: 0, offset: 9 })).toEqual({ start: { paragraph: 0, offset: 9 }, end: { paragraph: 1, offset: 3 } });
  expect(overlaps(sel(0, 0, 5), sel(0, 5, 9))).toBe(false); // touching is not overlapping
  expect(overlaps(sel(0, 0, 6), sel(0, 5, 9))).toBe(true);
  expect(overlaps(sel(0, 4, 4), sel(0, 4, 4))).toBe(true); // two insertions at one place
  expect(overlaps(sel(0, 4, 4), sel(0, 4, 9))).toBe(false);
  const across = { start: { paragraph: 0, offset: 3 }, end: { paragraph: 2, offset: 2 } };
  expect(sliceIn(across, 0, 10)).toEqual({ from: 3, to: 10 });
  expect(sliceIn(across, 1, 6)).toEqual({ from: 0, to: 6 });
  expect(sliceIn(across, 2, 8)).toEqual({ from: 0, to: 2 });
  expect(sliceIn(across, 3, 8)).toBeUndefined();
  expect(selectedText([{ text: "First para." }, { text: "Second para." }], { start: { paragraph: 0, offset: 6 }, end: { paragraph: 1, offset: 6 } })).toBe("para.\n\nSecond");
});

test("draftReducer: add, update (body, replacement, tag), remove, summary", () => {
  let d = draftReducer(empty, { type: "add", mark: { kind: "comment", path: PATH, selection: sel(0, 0, 3), body: "hm" } });
  d = draftReducer(d, { type: "add", mark: { kind: "suggestion", path: PATH, selection: sel(0, 4, 7), replacement: "x" } });
  d = draftReducer(d, { type: "update", index: 0, patch: { body: "better", tag: "fix" } });
  d = draftReducer(d, { type: "update", index: 1, patch: { replacement: "y", tag: "keep" } });
  expect(d.marks).toEqual([
    { kind: "comment", path: PATH, selection: sel(0, 0, 3), body: "better", tag: "fix" },
    { kind: "suggestion", path: PATH, selection: sel(0, 4, 7), replacement: "y", tag: "keep" },
  ]);
  d = draftReducer(d, { type: "update", index: 0, patch: { tag: null } });
  expect("tag" in (d.marks[0] as object)).toBe(false);
  d = draftReducer(d, { type: "remove", index: 0 });
  expect(d.marks).toHaveLength(1);
  expect(draftReducer(d, { type: "summary", summary: "Loved it." }).summary).toBe("Loved it.");
});

test("a chapter note is one mark per chapter: created, replaced in place, removed when blanked", () => {
  let d = draftReducer(empty, { type: "chapterNote", path: PATH, body: "slow middle", tag: "fix" });
  expect(chapterNote(d, PATH)).toEqual({ index: 0, body: "slow middle", tag: "fix" });
  d = draftReducer(d, { type: "chapterNote", path: PATH, body: "slow middle, really" });
  expect(d.marks).toEqual([{ kind: "chapter", path: PATH, body: "slow middle, really" }]);
  expect(draftReducer(d, { type: "chapterNote", path: PATH, body: "  " }).marks).toEqual([]);
  expect(draftReducer(empty, { type: "chapterNote", path: PATH, body: "" })).toBe(empty);
  expect(marksOf(d, "other")).toEqual([]);
});

test("canSubmit needs a summary or a mark", () => {
  expect(canSubmit(empty)).toBe(false);
  expect(canSubmit({ summary: " ", marks: [] })).toBe(false);
  expect(canSubmit({ summary: "ok", marks: [] })).toBe(true);
  expect(canSubmit({ summary: "", marks: [{ kind: "chapter", path: PATH, body: "x" }] })).toBe(true);
});

test("collidingSuggestion finds an overlapping suggestion, never a comment", () => {
  const d: ReviewDraft = {
    summary: "",
    marks: [
      { kind: "comment", path: PATH, selection: sel(0, 0, 9), body: "c" },
      { kind: "suggestion", path: PATH, selection: sel(0, 4, 8), replacement: "x" },
    ],
  };
  expect(collidingSuggestion(d, PATH, sel(0, 6, 12))).toBe(1);
  expect(collidingSuggestion(d, PATH, sel(0, 8, 12))).toBeUndefined();
  expect(collidingSuggestion(d, "other.md", sel(0, 6, 12))).toBeUndefined();
});

test("segments: the stretches join back to the text; comments, strikes and ghosts land on the right stretch", () => {
  const text = "The river rose in March.";
  const marks = [
    { index: 0, mark: { kind: "comment", path: PATH, selection: sel(0, 0, 9), tag: "keep", body: "nice" } as const },
    { index: 1, mark: { kind: "suggestion", path: PATH, selection: sel(0, 10, 14), replacement: "climbed" } as const },
  ];
  const segs = segments(text, 0, marks);
  expect(segs.map((s) => s.text).join("")).toBe(text);
  expect(segs.map((s) => s.text)).toEqual(["The river", " ", "rose", " in March."]);
  expect(segs[0]).toMatchObject({ comments: [0], starts: [0], suggestions: [], ghosts: [], tag: "keep" });
  expect(segs[2]).toMatchObject({ comments: [], suggestions: [1], ghosts: [{ index: 1, text: "climbed" }] });
  expect(segs[3]).toMatchObject({ comments: [], suggestions: [], ghosts: [] });
});

test("segments: a span across paragraphs shows in each; a caret insertion is a ghost; other chapters' marks are not passed in", () => {
  const across = [{ index: 0, mark: { kind: "comment", path: PATH, selection: { start: { paragraph: 0, offset: 4 }, end: { paragraph: 1, offset: 3 } }, body: "x" } as const }];
  const first = segments("One two.", 0, across);
  const second = segments("Three four.", 1, across);
  expect(first.map((s) => [s.text, s.comments.length])).toEqual([["One ", 0], ["two.", 1]]);
  expect(first[1]?.starts).toEqual([0]);
  expect(second.map((s) => [s.text, s.comments.length])).toEqual([["Thr", 1], ["ee four.", 0]]);
  expect(second[0]?.starts).toEqual([]); // the number is drawn once, where the comment starts

  const insert = segments("Ice melted.", 0, [{ index: 3, mark: { kind: "suggestion", path: PATH, selection: sel(0, 3, 3), replacement: " slowly" } }]);
  expect(insert.map((s) => s.text).join("")).toBe("Ice melted.");
  expect(insert.find((s) => s.ghosts.length > 0)).toMatchObject({ text: "Ice", ghosts: [{ index: 3, text: " slowly" }], suggestions: [] });
  expect(segments("", 0, [])).toEqual([{ text: "", comments: [], suggestions: [], starts: [], ghosts: [] }]);
});

test("excerpt collapses and truncates", () => {
  expect(excerpt("a  b\n c")).toBe("a b c");
  expect(excerpt("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
});

test("parseDraft rebuilds a draft field by field and refuses anything malformed", () => {
  const good = { summary: "s", marks: [{ kind: "comment", path: PATH, selection: sel(0, 0, 1), tag: "fix", body: "b", extra: "dropped" }, { kind: "suggestion", path: PATH, selection: sel(0, 0, 1), replacement: "", note: "n" }, { kind: "chapter", path: PATH, body: "c" }] };
  const parsed = parseDraft(good);
  expect(parsed.marks[0]).toEqual({ kind: "comment", path: PATH, selection: sel(0, 0, 1), tag: "fix", body: "b" });
  expect(parsed.marks[1]).toEqual({ kind: "suggestion", path: PATH, selection: sel(0, 0, 1), replacement: "", note: "n" });
  for (const bad of [
    null,
    { summary: 1, marks: [] },
    { summary: "", marks: "x" },
    { summary: "", marks: [{ kind: "nope", path: PATH }] },
    { summary: "", marks: [{ kind: "comment", path: PATH, selection: sel(0, -1, 1), body: "x" }] },
    { summary: "", marks: [{ kind: "comment", path: PATH, selection: sel(0, 0.5, 1), body: "x" }] },
    { summary: "", marks: [{ kind: "comment", path: PATH, selection: sel(0, 0, 1), tag: "praise", body: "x" }] },
    { summary: "", marks: [{ kind: "chapter", path: 5, body: "x" }] },
    { summary: "", marks: [{ kind: "suggestion", path: PATH, selection: sel(0, 0, 1) }] },
    { summary: "x".repeat(20_001), marks: [] },
  ]) expect(() => parseDraft(bad)).toThrow();
});

// --- AGT-1599: window layout and the pop-up's place -----------------------------------------------------

test("readerLayout: marks panel beside the page at 1100px and up, under it below", () => {
  expect(readerLayout(1280, 1).stacked).toBe(false);
  expect(readerLayout(1100, 1).stacked).toBe(false);
  expect(readerLayout(1099, 1).stacked).toBe(true);
  expect(readerLayout(800, 1).columns).toBe("minmax(0, 46rem)");
});

test("readerLayout: a single chapter has no chapter column and no track for one; several do", () => {
  const one = readerLayout(1440, 1);
  expect(one.showNav).toBe(false);
  expect(one.columns).toBe("minmax(0, 46rem) 16rem");
  const many = readerLayout(1440, 3);
  expect(many.showNav).toBe(true);
  expect(many.columns).toBe("12rem minmax(0, 46rem) 16rem");
  expect(readerLayout(1000, 3).showNav).toBe(true); // stacked, the list sits above the page
});

test("readerLayout: the page keeps a 40-46rem measure at common window sizes, with and without a chapter list", () => {
  for (const width of [1280, 1440, 1920]) {
    for (const chapters of [1, 4]) {
      const l = readerLayout(width, chapters);
      expect(l.stacked).toBe(false);
      expect(l.pagePx).toBeGreaterThanOrEqual(MIN_PAGE_PX);
      expect(l.pagePx).toBeLessThanOrEqual(MAX_PAGE_PX);
    }
  }
  // a window too narrow for list + page + panel drops the panel under the page rather than squeezing the text
  expect(readerLayout(1120, 4).stacked).toBe(true);
  expect(readerLayout(1200, 4).stacked).toBe(false);
  expect(readerLayout(1200, 4).pagePx).toBeGreaterThanOrEqual(MIN_PAGE_PX);
});

const VIEW = { width: 1280, height: 800 };
const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

test("popoverPlacement: just below the selection when there is room", () => {
  const p = popoverPlacement(rect(300, 200, 500, 224), VIEW);
  expect(p).toEqual({ left: 300, top: 232, above: false });
});

test("popoverPlacement: above the selection when below has no room, and never over the selected text", () => {
  const r = rect(300, 600, 500, 624);
  const p = popoverPlacement(r, VIEW);
  expect(p.above).toBe(true);
  expect(p.top).toBeLessThanOrEqual(r.top); // its bottom edge sits above the selection
  const low = popoverPlacement(rect(300, 780, 500, 790), VIEW);
  expect(low.above).toBe(true);
});

test("popoverPlacement: below even when cramped if above has even less room; stays inside the window sideways", () => {
  expect(popoverPlacement(rect(10, 20, 100, 40), { width: 1280, height: 200 }).above).toBe(false);
  expect(popoverPlacement(rect(1270, 100, 1275, 120), VIEW).left).toBe(1280 - 320 - 8);
  expect(popoverPlacement(rect(-50, 100, 20, 120), VIEW).left).toBe(8);
  expect(popoverPlacement(rect(0, 100, 20, 120), { width: 300, height: 800 }).left).toBe(8); // narrower than the box: pinned left
});

test("popoverPlacement: document coordinates add the scroll offset", () => {
  const p = popoverPlacement(rect(300, 200, 500, 224), VIEW, { x: 0, y: 1500 });
  expect(p.top).toBe(1732);
});
