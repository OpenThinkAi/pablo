import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "@openthink/pablo-core";
import { cutEdit, lineOf, manualEdit, markFor, moveEdit, proposalEdit, writeDocument } from "../src/apply";

/**
 * The document edits, without a terminal and without a model. These are the
 * functions that decide what lands on disk, so every one of them is checked by
 * re-parsing the result: a verb that produces text the CriticMarkup parser
 * rejects has corrupted the manuscript, whatever it looks like.
 */

const CHAPTER = "# Twenty-Six\n\nThe cellar was cold.\n\nShe counted the barrels twice.\n\nThere were nineteen.\n";

function doc(text = CHAPTER) {
  return { path: "/tmp/chapter-26.md", text };
}

function spanOf(text: string, phrase: string) {
  const start = text.indexOf(phrase);
  return { start, end: start + phrase.length };
}

test("a plain answer becomes a substitution, and at a boundary an addition (AC1)", () => {
  const base = doc();
  const over = proposalEdit(base, spanOf(CHAPTER, "The cellar was cold."), "The cellar held its cold.");
  expect(over.ok).toBe(true);
  if (!over.ok) return;
  expect(over.doc.text).toContain("{~~The cellar was cold.~>The cellar held its cold.~~}");

  const at = CHAPTER.indexOf("She counted");
  const boundary = proposalEdit(base, { start: at, end: at }, "The lamp guttered.");
  expect(boundary.ok).toBe(true);
  if (!boundary.ok) return;
  expect(boundary.doc.text).toContain("{++The lamp guttered.++}");
});

test("a proposal is a mark, not an application: the old text is still there (AC1)", () => {
  const edit = proposalEdit(doc(), spanOf(CHAPTER, "nineteen"), "twenty-one");
  expect(edit.ok).toBe(true);
  if (!edit.ok) return;

  const model = parse(edit.doc.text);
  expect(model.violations).toEqual([]);
  expect(model.marks).toHaveLength(1);
  expect(model.text).toContain("nineteen");
  expect(edit.doc.text.slice(edit.span.start, edit.span.end)).toBe("{~~nineteen~>twenty-one~~}");
});

test("an answer that is already CriticMarkup is written as the model marked it", () => {
  // The path the pack actually asks for (`output: "text"`): the model marks the
  // words it changed, and the app writes that rather than wrapping it again.
  const marked = "There were {~~nineteen~>twenty-one~~}.";
  const edit = proposalEdit(doc(), spanOf(CHAPTER, "There were nineteen."), marked);
  expect(edit.ok).toBe(true);
  if (!edit.ok) return;

  expect(edit.doc.text).toContain(marked);
  expect(edit.doc.text).not.toContain("{~~There were nineteen.");
  expect(parse(edit.doc.text).marks).toHaveLength(1);
});

test("an answer that would break the markup is refused rather than written", () => {
  // `~~}` closes the substitution early: written unchecked this splits one mark
  // into a mark plus loose delimiters and corrupts everything after it. It is
  // caught whether the model wrote it inside a mark or in plain prose.
  for (const answer of ["twenty ~~} and then", "{~~nineteen~>twenty~~} and a loose ~> arrow"]) {
    const broken = proposalEdit(doc(), spanOf(CHAPTER, "nineteen"), answer);
    expect(broken.ok).toBe(false);
    if (broken.ok) return;
    expect(broken.reason).toContain("CriticMarkup");
  }

  expect(proposalEdit(doc(), spanOf(CHAPTER, "nineteen"), "   ").ok).toBe(false);
});

test("a manual edit replaces the span with no markup at all (AC2)", () => {
  const edit = manualEdit(doc(), spanOf(CHAPTER, "There were nineteen."), "There were nineteen, and one empty.");
  expect(edit.ok).toBe(true);
  if (!edit.ok) return;

  expect(edit.doc.text).toContain("There were nineteen, and one empty.");
  expect(parse(edit.doc.text).marks).toEqual([]);
});

test("a cut removes the span and closes the blank line it left behind (AC3)", () => {
  const edit = cutEdit(doc(), spanOf(CHAPTER, "She counted the barrels twice."));
  expect(edit.ok).toBe(true);
  if (!edit.ok) return;

  expect(edit.doc.text).not.toContain("She counted");
  expect(edit.doc.text).not.toMatch(/\n{3,}/);
  expect(edit.doc.text).toBe("# Twenty-Six\n\nThe cellar was cold.\n\nThere were nineteen.\n");
  expect(cutEdit(doc(), { start: 4, end: 4 }).ok).toBe(false);
});

test("a move carries a paragraph forward and lands it as a block (AC3)", () => {
  const from = spanOf(CHAPTER, "The cellar was cold.");
  const to = CHAPTER.length;
  const edit = moveEdit(doc(), from, to, true);
  expect(edit.ok).toBe(true);
  if (!edit.ok) return;

  expect(edit.doc.text).toBe(
    "# Twenty-Six\n\nShe counted the barrels twice.\n\nThere were nineteen.\n\nThe cellar was cold.\n",
  );
  expect(edit.doc.text.slice(edit.span.start, edit.span.end)).toBe("The cellar was cold.");
});

test("a move backwards keeps the boundary it was given", () => {
  const from = spanOf(CHAPTER, "There were nineteen.");
  const to = CHAPTER.indexOf("The cellar");
  const edit = moveEdit(doc(), from, to, true);
  expect(edit.ok).toBe(true);
  if (!edit.ok) return;

  expect(edit.doc.text).toBe(
    "# Twenty-Six\n\nThere were nineteen.\n\nThe cellar was cold.\n\nShe counted the barrels twice.\n",
  );
});

test("a phrase moves inline, exactly as it was cut", () => {
  const text = "One two three four.\n";
  const edit = moveEdit({ path: "/tmp/x.md", text }, spanOf(text, "two "), text.indexOf("four"), false);
  expect(edit.ok).toBe(true);
  if (!edit.ok) return;
  expect(edit.doc.text).toBe("One three two four.\n");
});

test("a move onto a boundary inside itself is refused", () => {
  const from = spanOf(CHAPTER, "She counted the barrels twice.");
  const edit = moveEdit(doc(), from, from.start + 4, true);
  expect(edit.ok).toBe(false);
  if (edit.ok) return;
  expect(edit.reason).toContain("inside the selection");
});

test("the write is a plain file write, and the mark round-trips through the parser", () => {
  const directory = mkdtempSync(join(tmpdir(), "pablo-apply-"));
  try {
    const path = join(directory, "chapter-26.md");
    const edit = proposalEdit({ path, text: CHAPTER }, spanOf(CHAPTER, "nineteen"), "twenty-one");
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;

    writeDocument(edit.doc);
    const back = readFileSync(path, "utf8");
    expect(back).toBe(edit.doc.text);
    expect(parse(back).violations).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the line handed to $EDITOR is 1-based and counts the newlines before the cursor (AC4)", () => {
  expect(lineOf(CHAPTER, 0)).toBe(1);
  expect(lineOf(CHAPTER, CHAPTER.indexOf("The cellar"))).toBe(3);
  expect(lineOf(CHAPTER, CHAPTER.indexOf("There were"))).toBe(7);
  expect(lineOf(CHAPTER, 10_000)).toBe(8);
});

test("markFor names the two shapes a proposal can take", () => {
  expect(markFor("", "new")).toBe("{++new++}");
  expect(markFor("old", "new")).toBe("{~~old~>new~~}");
});
