// The own buffer (D-23, carried from the AGT-2149 spike): wrap covers every offset, the cursor maps to the right row,
// vertical moves keep the goal column, undo steps are word-sized; and columns are graphemes and terminal cells.

import { expect, test } from "bun:test";
import { TextBuffer, wrapLine } from "../src/buffer";

test("wrapLine: rows break after a space, cover the line with no gaps, and break an over-long word", () => {
  const line = "The pond rang under the horse before it rang under the saws.";
  const segs = wrapLine(line, 20);
  expect(segs.map((s) => line.slice(s.start, s.end))).toEqual(["The pond rang under ", "the horse before it ", "rang under the saws."]);
  for (let i = 1; i < segs.length; i++) expect(segs[i]!.start).toBe(segs[i - 1]!.end);
  expect(wrapLine("abcdefghij", 4).map((s) => "abcdefghij".slice(s.start, s.end))).toEqual(["abcd", "efgh", "ij"]);
  expect(wrapLine("", 10)).toEqual([{ start: 0, end: 0 }]);
});

test("the cursor on a wrap boundary sits at the start of the next row; at the line end it stays on the last row", () => {
  const b = new TextBuffer("aaaa bbbb cccc");
  // pane width 6 -> wrap width 5
  b.cursor = { row: 0, col: 5 };
  expect(b.visualCursor(6)).toEqual({ y: 1, x: 0 });
  b.cursor = { row: 0, col: 14 };
  expect(b.visualCursor(6)).toEqual({ y: 2, x: 4 });
});

test("up and down move by display row and keep the goal column across a short row", () => {
  const b = new TextBuffer("aaaa bbbb cc\nxy\nlonger line here");
  b.cursor = { row: 0, col: 3 };
  b.down(6); // "bbbb " row
  expect(b.cursor).toEqual({ row: 0, col: 8 });
  b.down(6); // "cc" row, clamped to its end
  expect(b.cursor).toEqual({ row: 0, col: 12 });
  b.down(6); // "xy"
  expect(b.cursor).toEqual({ row: 1, col: 2 });
  b.down(6); // "longer " row: the goal column 3 comes back
  expect(b.cursor).toEqual({ row: 2, col: 3 });
  b.up(6);
  b.up(6);
  expect(b.cursor).toEqual({ row: 0, col: 12 });
});

test("insert, newline, backspace across lines, forward delete", () => {
  const b = new TextBuffer("hello world");
  b.cursor = { row: 0, col: 5 };
  b.insert(",\nnew");
  expect(b.lines).toEqual(["hello,", "new world"]);
  expect(b.cursor).toEqual({ row: 1, col: 3 });
  b.cursor = { row: 1, col: 0 };
  b.backspace();
  expect(b.lines).toEqual(["hello,new world"]);
  b.deleteForward();
  expect(b.text()).toBe("hello,ew world");
});

test("undo takes back a word at a time; redo puts it back; an edit clears redo", () => {
  const b = new TextBuffer("");
  for (const ch of "the cat") b.insert(ch);
  expect(b.text()).toBe("the cat");
  b.undo();
  expect(b.text()).toBe("the ");
  b.undo();
  expect(b.text()).toBe("");
  b.redo();
  expect(b.text()).toBe("the ");
  b.insert("!");
  expect(b.redo()).toBe(false);
  b.backspace(); b.backspace();
  b.undo();
  expect(b.text()).toBe("the !");
});

test("view scrolls to keep the cursor visible and reports the cursor inside the window", () => {
  const b = new TextBuffer(Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
  b.cursor = { row: 30, col: 2 };
  const v = b.view(20, 10);
  expect(v.rows[v.cursor.y]).toBe("line 30");
  expect(v.cursor.x).toBe(2);
  expect(v.rows).toHaveLength(10);
});

// --- graphemes and cells ----------------------------------------------------------------------------------------

const EMOJI = "👩‍👩‍👧"; // one grapheme, 8 UTF-16 units, 2 cells
const COMBINING = "é"; // é as e + combining acute: one grapheme, 2 units, 1 cell
const CJK = "漢"; // one grapheme, 1 unit, 2 cells

for (const [name, ch, cells] of [["an emoji", EMOJI, 2], ["a combining-mark sequence", COMBINING, 1], ["a CJK character", CJK, 2]] as const) {
  test(`the cursor moves one visible character over ${name}, and its column counts cells`, () => {
    const b = new TextBuffer(`a${ch}b`);
    b.cursor = { row: 0, col: 1 };
    b.right();
    expect(b.cursor).toEqual({ row: 0, col: 1 + ch.length });
    expect(b.visualCursor(40)).toEqual({ y: 0, x: 1 + cells });
    b.left();
    expect(b.cursor).toEqual({ row: 0, col: 1 });
    // Deleting takes the whole character, never half of it.
    b.deleteForward();
    expect(b.text()).toBe("ab");
    b.undo();
    b.cursor = { row: 0, col: 1 + ch.length };
    b.backspace();
    expect(b.text()).toBe("ab");
    expect(b.cursor).toEqual({ row: 0, col: 1 });
  });
}

test("CJK text wraps at its cell width, not its code-unit count", () => {
  const line = "漢字漢字漢字漢字"; // 8 characters, 16 cells
  // 6 cells a row: three characters, not six.
  expect(wrapLine(line, 6).map((s) => line.slice(s.start, s.end))).toEqual(["漢字漢", "字漢字", "漢字"]);
  // An odd width never splits a character: 5 cells holds two.
  expect(wrapLine(line, 5).map((s) => line.slice(s.start, s.end))).toEqual(["漢字", "漢字", "漢字", "漢字"]);
  // A character wider than the row still takes a row of its own.
  expect(wrapLine("漢字", 1).map((s) => "漢字".slice(s.start, s.end))).toEqual(["漢", "字"]);
  // Words with CJK break on the space, measured in cells.
  const mixed = "漢字 漢字 漢字";
  expect(wrapLine(mixed, 6).map((s) => mixed.slice(s.start, s.end))).toEqual(["漢字 ", "漢字 ", "漢字"]);
});

test("an emoji is never split across a wrap", () => {
  const line = `ab${EMOJI}cd`;
  expect(wrapLine(line, 3).map((s) => line.slice(s.start, s.end))).toEqual(["ab", EMOJI + "c", "d"]);
});

test("up and down keep the goal in cells across wide rows", () => {
  // pane width 7 -> wrap width 6
  const b = new TextBuffer("abcdef\n漢字漢\nabcdef");
  b.cursor = { row: 0, col: 3 };
  b.down(7); // 3 cells into "漢字漢" falls inside 字: the cursor stays before it
  expect(b.cursor).toEqual({ row: 1, col: 1 });
  expect(b.visualCursor(7)).toEqual({ y: 1, x: 2 });
  b.down(7); // the goal (3 cells) comes back on a narrow row
  expect(b.cursor).toEqual({ row: 2, col: 3 });
});

test("view reports the cursor's x in cells", () => {
  const b = new TextBuffer(`${CJK}${CJK}x`);
  b.cursor = { row: 0, col: 2 };
  expect(b.view(20, 3).cursor).toEqual({ x: 4, y: 0 });
});
