// The editing pane's modes (AGT-2169, D-18): normal, insert and select, the motions over wrapped lines, and the keys as
// rows of the keymap (so the key panel lists them and the author's `keys` rebind them). Pure: no Ink.

import { expect, test } from "bun:test";
import { openText, paneRows, type EditText } from "../src/edit-pane";
import { effectiveKeys, DEFAULT_KEYMAP, rowsOf, prefixRows, KeysError, type Keymap } from "../src/keys";
import { modalKey, modeOf, wordEnd, wordNext, wordPrev } from "../src/modal";
import { entriesFor, panelTitle } from "../src/panel";
import { initialState, reduce, type Pending, type State } from "../src/state";
import { keyStateOf } from "../src/keys";

const W = 20, H = 10;
const ESC = { escape: true };

/** The pane's text and the model's pending prefix after `keys` (each a character, or [input, key]). */
function run(t: EditText, keys: (string | [string, Record<string, boolean>])[], km: Keymap = DEFAULT_KEYMAP) {
  let text = t;
  let pending: Pending | null = null;
  let closed = false;
  for (const k of keys) {
    const [input, key] = typeof k === "string" ? [k, {}] : k;
    const step = modalKey(modeOf(text), pending, input, key, km, { width: W, height: H });
    if (step === "close") { closed = true; continue; }
    for (const a of step) {
      if (a.type === "pane.edit") text = a.edit(text) as EditText;
      else if (a.type === "prefix.press") pending = { prefix: a.prefix };
      else if (a.type === "prefix.clear") pending = null;
      else throw new Error(`unexpected ${a.type}`);
    }
  }
  return { text, pending, closed, at: text.buffer.cursor };
}
const open = (body: string) => openText(body, "lines", 1);

test("the pane opens in normal mode; letters move rather than type there", () => {
  const t = open("one two");
  expect(t.mode).toBe("normal");
  const r = run(t, ["x", "q", "l"]);
  expect(r.text.buffer.text()).toBe("one two");
  expect(r.at).toEqual({ row: 0, col: 1 });
});

test("i enters insert at the cursor, Esc returns to normal, Esc in normal closes", () => {
  let r = run(open("abc"), ["l", "i", "X", "Y"]);
  expect(r.text.mode).toBe("insert");
  expect(r.text.buffer.text()).toBe("aXYbc");
  r = run(r.text, [["", ESC]]);
  expect(r.text.mode).toBe("normal");
  expect(r.closed).toBe(false);
  expect(run(r.text, [["", ESC]]).closed).toBe(true);
});

test("a appends after the character under the cursor; at the line's end it stays on the line", () => {
  expect(run(open("abc"), ["a", "X"]).text.buffer.text()).toBe("aXbc");
  expect(run(open("abc\nd"), ["$", "a", "X"]).text.buffer.text()).toBe("abcX\nd");
});

test("o opens a line below the cursor's line and inserts there", () => {
  const r = run(open("first line\nsecond"), ["w", "o", "N", "e", "w"]);
  expect(r.text.mode).toBe("insert");
  expect(r.text.buffer.lines).toEqual(["first line", "New", "second"]);
});

test("v toggles select mode: motions extend from the anchor, v again or Esc leaves it", () => {
  let r = run(open("one two three"), ["v"]);
  expect(r.text.mode).toBe("select");
  expect(r.text.anchor).toEqual({ row: 0, col: 0 });
  r = run(r.text, ["w"]);
  expect(r.at).toEqual({ row: 0, col: 4 });
  expect(r.text.anchor).toEqual({ row: 0, col: 0 });
  // The selection is drawn: anchor to cursor, both ends' characters included.
  const row = paneRows(r.text, W, H, new Map())[0]!;
  expect(row.kind === "text" && row.parts).toEqual([{ text: "one ", sel: true }, { text: "t", sel: true, cursor: true }, { text: "wo three" }]);
  expect(run(r.text, ["v"]).text.mode).toBe("normal");
  const esc = run(r.text, [["", ESC]]);
  expect(esc.text.mode).toBe("normal");
  expect(esc.text.anchor).toBeNull();
  expect(esc.closed).toBe(false);
});

test("h j k l move by character and by display row over a wrapped line, keeping the column", () => {
  // At 20 cells (19 for text) the first paragraph wraps into two display rows.
  const t = open("alpha beta gamma delta epsilon\nshort");
  expect(t.buffer.segments(0, W).length).toBe(2);
  let r = run(t, ["l", "l"]);
  expect(r.at).toEqual({ row: 0, col: 2 });
  r = run(r.text, ["j"]); // the second display row of the same paragraph
  expect(r.at.row).toBe(0);
  expect(r.at.col).toBe(t.buffer.segments(0, W)[1]!.start + 2);
  r = run(r.text, ["j"]);
  expect(r.at).toEqual({ row: 1, col: 2 });
  r = run(r.text, ["k", "k"]);
  expect(r.at).toEqual({ row: 0, col: 2 });
  r = run(r.text, ["h", "h", "h"]); // at the start: nowhere to go
  expect(r.at).toEqual({ row: 0, col: 0 });
});

test("w b e: word starts and ends, across punctuation and lines", () => {
  const lines = ["The well, dry.", "", "  Nobody came"];
  expect(wordNext(lines, { row: 0, col: 0 })).toEqual({ row: 0, col: 4 });
  expect(wordNext(lines, { row: 0, col: 4 })).toEqual({ row: 0, col: 8 }); // the comma is a word of its own
  expect(wordNext(lines, { row: 0, col: 13 })).toEqual({ row: 2, col: 2 }); // past the line end and the blank line
  expect(wordEnd(lines, { row: 0, col: 0 })).toEqual({ row: 0, col: 2 });
  expect(wordEnd(lines, { row: 0, col: 2 })).toEqual({ row: 0, col: 7 });
  expect(wordEnd(lines, { row: 0, col: 13 })).toEqual({ row: 2, col: 7 });
  expect(wordPrev(lines, { row: 2, col: 2 })).toEqual({ row: 0, col: 13 });
  expect(wordPrev(lines, { row: 0, col: 6 })).toEqual({ row: 0, col: 4 }); // inside a word: its start
  expect(wordPrev(lines, { row: 0, col: 0 })).toEqual({ row: 0, col: 0 });
  // The last word: w stops at the document's end.
  expect(wordNext(lines, { row: 2, col: 9 })).toEqual({ row: 2, col: 13 });
  // Through the keys too.
  expect(run(open("one two three"), ["w", "w"]).at).toEqual({ row: 0, col: 8 });
  expect(run(open("one two three"), ["e", "e", "b"]).at).toEqual({ row: 0, col: 4 });
});

test("w b e step over whole graphemes", () => {
  const lines = ["café ünï ét"];
  expect(wordNext(lines, { row: 0, col: 0 })).toEqual({ row: 0, col: 5 });
  expect(wordEnd(lines, { row: 0, col: 5 })).toEqual({ row: 0, col: 7 });
  expect(wordEnd(lines, { row: 0, col: 7 })).toEqual({ row: 0, col: 11 }); // "t", after e + combining acute (one grapheme, two code units)
});

test("0 and $ go to the start and last character of the whole paragraph, not the display row", () => {
  const t = open("alpha beta gamma delta epsilon\nshort");
  const r = run(t, ["j", "l", "0"]);
  expect(r.at).toEqual({ row: 0, col: 0 });
  expect(run(t, ["$"]).at).toEqual({ row: 0, col: "alpha beta gamma delta epsilon".length - 1 });
  expect(run(open(""), ["$"]).at).toEqual({ row: 0, col: 0 });
});

test("g g goes to the top through the g prefix, G to the last line; another key after g cancels it", () => {
  const t = open("one\ntwo\nthree");
  let r = run(t, ["G"]);
  expect(r.at).toEqual({ row: 2, col: 0 });
  r = run(r.text, ["l", "g"]);
  expect(r.pending).toEqual({ prefix: "g" });
  r = run(r.text, ["g", "g"]);
  expect(r.at).toEqual({ row: 0, col: 0 });
  expect(r.pending).toBeNull();
  r = run(run(t, ["G"]).text, ["g", "x"]);
  expect(r.at).toEqual({ row: 2, col: 0 });
  expect(r.pending).toBeNull();
  // Esc with g pending clears the prefix and stays open.
  const e = run(t, ["g", ["", ESC]]);
  expect(e.pending).toBeNull();
  expect(e.closed).toBe(false);
});

test("arrows, paging and Ctrl+Z still work in normal mode; Backspace and text do not edit there", () => {
  const t = open("abc\ndef");
  let r = run(t, [["", { rightArrow: true }], ["", { downArrow: true }]]);
  expect(r.at).toEqual({ row: 1, col: 1 });
  r = run(t, [["", { backspace: true }], ["", { return: true }], " "]);
  expect(r.text.buffer.text()).toBe("abc\ndef");
  r = run(t, ["i", "X", ["", ESC], ["z", { ctrl: true }]]);
  expect(r.text.buffer.text()).toBe("abc\ndef");
  expect(r.text.mode).toBe("normal");
});

test("the modal keys are keymap rows: rebinding one moves the key, a clash in a mode is refused", () => {
  const km = effectiveKeys({ "editor.down": "n", "editor.insert": { primary: "I" } });
  const t = open("one\ntwo");
  expect(run(t, ["n"], km).at).toEqual({ row: 1, col: 0 });
  expect(run(t, ["j"], km).at).toEqual({ row: 0, col: 0 }); // j no longer moves
  expect(run(t, ["I"], km).text.mode).toBe("insert");
  expect(() => effectiveKeys({ "editor.down": "w" })).toThrow(KeysError);
  // Normal and select mode list the motions; insert mode has no rows (keys type there).
  const normal = rowsOf({ state: "normal" }).map((a) => a.id);
  expect(normal).toEqual(expect.arrayContaining(["editor.left", "editor.down", "editor.up", "editor.right", "editor.word_next", "editor.word_prev", "editor.word_end", "editor.line_start", "editor.line_end", "editor.bottom", "editor.insert", "editor.append", "editor.open_below", "editor.select"]));
  expect(rowsOf({ state: "select" }).map((a) => a.id)).toEqual(normal);
  expect(rowsOf({ state: "insert" })).toEqual([]);
  expect(prefixRows({ state: "normal" }, "g").map((a) => a.id)).toEqual(["editor.top"]);
  // None of the editor rows act outside the pane.
  for (const s of ["rail", "main", "content"] as const) expect(rowsOf({ state: s, content: true }).some((a) => a.id.startsWith("editor."))).toBe(false);
});

test("while the pane is open the key panel lists its mode's keys and is titled by the mode", () => {
  let s: State = reduce(initialState(), { type: "pane.open", file: "chapters/01.md", storage: "lines", line: 1 });
  s = reduce(s, { type: "pane.opened", branch: "edit/x", text: open("one") });
  expect(keyStateOf(s).state).toBe("normal");
  expect(panelTitle(keyStateOf(s))).toBe("edit: normal");
  const normal = entriesFor(s).map((e) => `${e.keys} ${e.label}`);
  expect(normal).toEqual(expect.arrayContaining(["h/j/k/l ←/↓/↑/→ move", "w/b/e word", "0/$ Home/End line", "i insert", "v select", "g go to…", "Esc close", "ctrl-s save"]));
  const ins = reduce(s, { type: "pane.edit", edit: (t) => run(t as EditText, ["i"]).text });
  expect(entriesFor(ins).map((e) => `${e.keys} ${e.label}`)).toEqual(["ctrl-f focus mode", "ctrl-t typewriter mode", "Esc normal", "ctrl-s save", "ctrl-z undo", "ctrl-y redo"]);
  expect(panelTitle(keyStateOf(ins))).toBe("edit: insert");
  // A rebinding shows in the panel.
  expect(entriesFor(s, effectiveKeys({ "editor.select": "s" })).map((e) => `${e.keys} ${e.label}`)).toContain("s select");
});
