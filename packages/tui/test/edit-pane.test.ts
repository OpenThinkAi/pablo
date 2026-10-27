// The editing pane's pure parts (AGT-2167): the file to the buffer and back (frontmatter kept, sentences split or lines
// kept, an untouched file saved byte for byte), the cursor's row as drawn, hit boxes by paragraph, keys as edits.

import { expect, test } from "bun:test";
import { splitManuscript } from "@openthink/pablo-core";
import { openText, paneHits, paneKey, paneRows, saveText, savedEdit, type EditText } from "../src/edit-pane";
import type { CheckHit } from "../src/hits";

const CHAPTER = "---\nchapter: 1\n---\n\nThe well was dry.\nNobody came.\n\nEdwin stood in the doorway.\n";
const key = (k: Record<string, boolean> = {}) => k;
const press = (t: EditText, input: string, k: Record<string, boolean> = {}) => paneKey(input, key(k), 40, 10)!(t) as EditText;

test("openText: the body as paragraphs, no frontmatter, the cursor on the paragraph that holds the file line", () => {
  const t = openText(CHAPTER, "sentences", 8);
  expect(t.buffer.lines).toEqual(["The well was dry. Nobody came.", "", "Edwin stood in the doorway."]);
  expect(t.buffer.cursor).toEqual({ row: 2, col: 0 });
  expect(openText(CHAPTER, "sentences", 6).buffer.cursor.row).toBe(0);
  expect(openText(CHAPTER, "sentences", 1).buffer.cursor.row).toBe(0); // a frontmatter line opens at the top
  expect(t.dirty).toBe(false);
});

test("saveText: untouched text saves as the file was, byte for byte, even when it is not in the split form", () => {
  const odd = "---\r\ntitle: x\r\n---\r\n\r\nOne. Two.\r\n";
  const t = openText(odd, "sentences", 1);
  expect(saveText(odd, t.buffer.text(), "sentences")).toBe(odd);
  expect(saveText(CHAPTER, openText(CHAPTER, "sentences", 1).buffer.text(), "sentences")).toBe(CHAPTER);
});

test("saveText: an edit keeps the frontmatter and splits the body one sentence per line (splitManuscript)", () => {
  const edited = "The well was dry. Nobody came. So it goes.\n\nEdwin stood in the doorway.";
  expect(saveText(CHAPTER, edited, "sentences")).toBe(`---\nchapter: 1\n---\n\n${splitManuscript(edited)}\n`);
  expect(saveText("No frontmatter.\n", "No frontmatter. Now two.", "sentences")).toBe("No frontmatter.\nNow two.\n");
});

test("saveText: a line-stored unit (radio, narrated, screenplay) saves line for line, never split", () => {
  const script = "---\nepisode: 1\n---\n\nNED: Cold. Very cold.\n";
  expect(openText(script, "lines", 5).buffer.lines).toEqual(["NED: Cold. Very cold."]);
  expect(saveText(script, "NED: Cold. Very cold.\nMAE: Yes.\n\n", "lines")).toBe("---\nepisode: 1\n---\n\nNED: Cold. Very cold.\nMAE: Yes.\n");
  expect(saveText(script, "INT. HOUSE\r\n\r\nNED\r\nHi.", "screenplay")).toBe("---\nepisode: 1\n---\n\nINT. HOUSE\n\nNED\nHi.\n");
});

test("paneKey: text, a paste with CR line ends, Enter, Backspace, undo; a key the pane does not use is null", () => {
  let t = openText("abc\n", "lines", 1);
  t = press(t, "x");
  expect(t.buffer.text()).toBe("xabc");
  expect(t.dirty).toBe(true);
  t = press(t, "1\r2");
  expect(t.buffer.lines).toEqual(["x1", "2abc"]);
  t = press(t, "", { return: true });
  t = press(t, "", { backspace: true });
  expect(t.buffer.lines).toEqual(["x1", "2abc"]);
  expect(paneKey("", key({ tab: true }), 40, 10)).toBeNull();
  expect(paneKey("q", key({ ctrl: true }), 40, 10)).toBeNull();
  expect(paneKey("[1;2B", key(), 40, 10)).toBeNull(); // shift-down: not text
});

test("paneKey never changes the text it is given: each edit is a new buffer", () => {
  const t = openText(CHAPTER, "sentences", 1);
  const before = t.buffer.text();
  const after = press(t, "Z");
  expect(t.buffer.text()).toBe(before);
  expect(t.dirty).toBe(false);
  expect(after.buffer.text()).toBe(`Z${before}`);
});

test("savedEdit: the text that was saved is clean; what was typed after it stays dirty", () => {
  let t = press(openText("abc\n", "lines", 1), "x");
  const savedText = t.buffer.text();
  t = press(t, "y");
  const after = savedEdit(savedText, "xabc\n")(t) as EditText;
  expect(after.dirty).toBe(true);
  expect(after.raw).toBe("xabc\n");
  expect((savedEdit(after.buffer.text(), "yxabc\n")(after) as EditText).dirty).toBe(false);
});

test("paneRows: the cursor's row splits around the grapheme under it; a wide character is one cursor cell", () => {
  const t = openText("a 日本 b\n", "lines", 1);
  t.buffer.cursor = { row: 0, col: 2 };
  const [row] = paneRows(t, 40, 5, new Map());
  expect(row).toEqual({ kind: "text", text: "a 日本 b", cursor: { before: "a ", at: "日", after: "本 b" } });
  t.buffer.cursor = { row: 0, col: 6 };
  expect(paneRows(t, 40, 5, new Map())[0]).toMatchObject({ cursor: { before: "a 日本 b", at: " ", after: "" } });
});

test("paneHits and paneRows: a hit's box under its paragraph, and the view scrolls so the cursor stays on screen", () => {
  const t = openText(CHAPTER, "sentences", 1);
  const checks = (_f: string, text: string): CheckHit[] => text.split("\n").flatMap((l, i) => (l === "Nobody came." ? [{ line: i + 1, rule: "flagged-line", excerpt: l }] : []));
  const hits = paneHits(t, "chapters/01.md", checks);
  expect([...hits.keys()]).toEqual([0]);
  const rows = paneRows(t, 60, 20, hits);
  expect(rows.map((r) => r.kind)).toEqual(["text", "box", "box", "box", "text", "text"]);
  const end = press(press(t, "", { downArrow: true }), "", { downArrow: true });
  const small = paneRows(end, 60, 2, hits);
  expect(small.at(-1)).toMatchObject({ kind: "text", cursor: { at: "E" } });
});
