// The main pane's document: frontmatter hidden, sentence lines read as paragraphs, text sanitised, ids mapped to files.

import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { displayDoc, displayLines, sourceOf, stripFrontmatter } from "../src/document";
import { loadDocument } from "../src/source";

const VAULT = fileURLToPath(new URL("../../cli/test/fixtures/vault", import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), "pablo-tui-doc-"));
  dirs.push(dir);
  cpSync(join(VAULT, "novels", "ice-house"), dir, { recursive: true });
  return dir;
};

test("frontmatter is hidden; text with none, or an unclosed block, is whole", () => {
  expect(stripFrontmatter("---\nchapter: 1\ntitle: x\n---\n\nThe well.")).toBe("The well.");
  expect(stripFrontmatter("The well.\n---\nmore")).toBe("The well.\n---\nmore");
  expect(stripFrontmatter("---\nnever closed\nThe well.")).toBe("---\nnever closed\nThe well.");
  expect(displayLines("---\nstatus: draft\n---\n\nShe waited.", 40)).toEqual(["She waited."]);
});

test("consecutive lines are one wrapped paragraph: a chapter reads the same before and after the sentence split", () => {
  const joined = "The well had been dry since June. She did not look up when the door opened.\n\nEdwin stood in the doorway.";
  const split = "The well had been dry since June.\nShe did not look up when the door opened.\n\nEdwin stood in the doorway.";
  expect(displayLines(split, 30)).toEqual(displayLines(joined, 30));
  expect(displayLines(split, 30)).toEqual(["The well had been dry since", "June. She did not look up when", "the door opened.", "", "Edwin stood in the doorway."]);
  expect(displayLines(split, 80)).toEqual(["The well had been dry since June. She did not look up when the door opened.", "", "Edwin stood in the doorway."]);
});

test("headings and tables keep their own lines; control characters never reach the pane", () => {
  const lines = displayLines("# Acts\n\n| Act | Years |\n| I | 1929 |\n\nOne.\nTwo.\x1b]0;pwned\x07", 40);
  expect(lines).toEqual(["# Acts", "", "| Act | Years |", "| I | 1929 |", "", "One. Two."]);
  expect(lines.join("\n")).not.toContain("\x1b");
});

test("row ids name their files", () => {
  expect(sourceOf("premise")).toEqual({ kind: "file", file: "bible/overview.md" });
  expect(sourceOf("beats")).toEqual({ kind: "file", file: "outline/chapters.md" });
  expect(sourceOf("chapter:3")).toEqual({ kind: "chapter", number: 3 });
  expect(sourceOf("ch2")).toEqual({ kind: "chapter", number: 2 });
  expect(sourceOf("chapter-12")).toEqual({ kind: "chapter", number: 12 });
  expect(sourceOf("bible")).toEqual({ kind: "bible" });
  expect(sourceOf("notes/x.md")).toEqual({ kind: "path", path: "notes/x.md" });
});

test("loadDocument reads the fixture project: a chapter with its status, a missing one as a notice, nothing outside the project", () => {
  const root = project();
  const ch1 = loadDocument(root, "chapter:1")!;
  expect(ch1.title).toBe("chapters/01-the-last-full-cut.md · draft");
  expect(displayLines(ch1.text, 60)[0]).toContain("The pond rang under the horse");
  expect(displayLines(ch1.text, 60).join("\n")).not.toContain("pov: Odile");
  expect(loadDocument(root, "chapter:2")).toEqual({ title: "chapter 2", text: "Chapter 2 has no draft yet." });
  expect(loadDocument(root, "premise")!.title).toBe("bible/overview.md");
  const bible = loadDocument(root, "bible")!;
  expect(bible.text).toContain("# bible/overview.md");
  expect(bible.text).toContain("# bible/timeline.md");
  expect(loadDocument(root, "../../etc/passwd")).toBeUndefined();
  writeFileSync(join(root, "outline", "chapters.md"), "# Beats\n");
  expect(loadDocument(root, "beats")!.text).toBe("# Beats\n");
});

// ---------------------------------------------------------------- sentences: display back to stored lines

/** The display lines with their sentence marks, as the pane draws them. */
const paneOf = (text: string, width: number) => {
  const d = displayDoc(text, width);
  return { lines: d.lines.map((t, i) => ({ text: t, marks: d.marks[i]! })), sentences: d.sentences };
};

const FILE = "---\nstatus: draft\n---\n\nThe well had been dry since June.\nShe did not look up when the door opened.\n\n# Part two\n\nEdwin stood in the doorway. He said nothing.\nThe lamp guttered.";

test("paneOf: sentences of the prose paragraphs, each mapped to the stored lines (frontmatter counted) and the display lines it covers", () => {
  const pane = paneOf(FILE, 80);
  expect(pane.lines.map((l) => l.text)).toEqual(displayLines(FILE, 80));
  expect(pane.sentences.map((s) => s.text)).toEqual([
    "The well had been dry since June.", "She did not look up when the door opened.",
    "Edwin stood in the doorway.", "He said nothing.", "The lamp guttered.",
  ]);
  // stored lines are 0-based in the file as stored: line 4 is the first sentence's, 5 the second's
  expect(pane.sentences.map((s) => s.stored)).toEqual([{ from: 4, to: 4 }, { from: 5, to: 5 }, { from: 9, to: 9 }, { from: 9, to: 9 }, { from: 10, to: 10 }]);
  // the heading is drawn but is not a sentence; the first paragraph is display line 0 (wide enough to be one line)
  expect(pane.lines.map((l) => l.text)).toContain("# Part two");
  expect(pane.sentences[0]).toMatchObject({ first: 0, last: 0 });
  expect(pane.sentences[2]!.first).toBe(pane.sentences[3]!.first); // two sentences of one stored line share a display line
});

test("paneOf: a wrapped sentence covers several lines, and the marks name where on each line it sits", () => {
  const pane = paneOf("The well had been dry since June. She did not look up.", 20);
  expect(pane.lines.map((l) => l.text)).toEqual(["The well had been", "dry since June. She", "did not look up."]);
  expect(pane.sentences.map((s) => [s.first, s.last])).toEqual([[0, 1], [1, 2]]);
  expect(pane.lines[1]!.marks).toEqual([{ start: 0, end: 15, sentence: 0 }, { start: 16, end: 19, sentence: 1 }]);
  expect(pane.lines[1]!.text.slice(16, 19)).toBe("She");
});

test("paneOf: a paragraph stored as one line, or as one sentence per line, gives the same sentences; the stored lines differ", () => {
  const joined = paneOf("One. Two. Three.", 40);
  const split = paneOf("One.\nTwo.\nThree.", 40);
  expect(joined.sentences.map((s) => s.text)).toEqual(split.sentences.map((s) => s.text));
  expect(joined.sentences.map((s) => s.stored.from)).toEqual([0, 0, 0]);
  expect(split.sentences.map((s) => s.stored.from)).toEqual([0, 1, 2]);
});

test("paneOf: tables, fences and lists are drawn, never selected; nothing to select in an empty or all-structure document", () => {
  expect(paneOf("| a | b |\n| - | - |\n\n- one\n- two", 40).sentences).toEqual([]);
  expect(paneOf("", 40)).toEqual({ lines: [], sentences: [] });
});
