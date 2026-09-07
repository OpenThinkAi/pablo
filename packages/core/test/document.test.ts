import { expect, test } from "bun:test";
import { isWithin, locatePassage, selectionText, type Document } from "../src/index";

const doc: Document = { path: "/tmp/chapter-01.md", text: "The valley kept its own time." };

test("a span selects the text it addresses", () => {
  expect(selectionText(doc, { start: 4, end: 10 })).toBe("valley");
});

test("an empty span is a legal insertion point", () => {
  expect(isWithin(doc, { start: 4, end: 4 })).toBe(true);
  expect(selectionText(doc, { start: 4, end: 4 })).toBe("");
});

test("a span ending exactly at the end of the text is in bounds", () => {
  expect(isWithin(doc, { start: 0, end: doc.text.length })).toBe(true);
});

test("out-of-bounds and inverted spans are rejected", () => {
  expect(isWithin(doc, { start: 0, end: doc.text.length + 1 })).toBe(false);
  expect(isWithin(doc, { start: 10, end: 4 })).toBe(false);
  expect(isWithin(doc, { start: -1, end: 4 })).toBe(false);
  expect(isWithin(doc, { start: 0.5, end: 4 })).toBe(false);
});

test("selecting an out-of-bounds span names the document and its length", () => {
  expect(() => selectionText(doc, { start: 0, end: 999 })).toThrow(
    /\/tmp\/chapter-01\.md \(29 characters\)/,
  );
});

/**
 * `locatePassage` (AGT-1257): find a quoted passage in a chapter body,
 * ignoring whitespace-run differences, so the `pablo revise` verb (AGT-1264)
 * can turn the author's pasted-back quote into a span without demanding
 * byte-for-byte whitespace fidelity.
 */
test("locatePassage finds an exact match and reports it as the original body's span", () => {
  const body = "The valley kept its own time. Frost came early that year.";
  const quoted = "Frost came early";

  const result = locatePassage(body, quoted);

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(selectionText({ path: "/tmp/x.md", text: body }, result.span)).toBe(quoted);
  }
});

test("locatePassage matches across a whitespace-run difference (a hard wrap the quote doesn't have)", () => {
  const body = "The valley kept its\nown time, and nobody minded.";
  const quoted = "kept its own time";

  const result = locatePassage(body, quoted);

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(selectionText({ path: "/tmp/x.md", text: body }, result.span)).toBe("kept its\nown time");
  }
});

test("locatePassage reports zero matches when the passage is not present", () => {
  expect(locatePassage("The valley kept its own time.", "a sentence never written")).toEqual({
    ok: false,
    matches: 0,
  });
});

test("locatePassage reports the count when the passage appears more than once", () => {
  const body = "It was quiet. It was quiet. Nobody spoke.";

  expect(locatePassage(body, "It was quiet.")).toEqual({ ok: false, matches: 2 });
});

test("locatePassage treats an empty or whitespace-only quote as zero matches", () => {
  const body = "The valley kept its own time.";

  expect(locatePassage(body, "")).toEqual({ ok: false, matches: 0 });
  expect(locatePassage(body, "   \n\t  ")).toEqual({ ok: false, matches: 0 });
});
