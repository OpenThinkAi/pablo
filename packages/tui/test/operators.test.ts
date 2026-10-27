// The editing pane's operators, registers and undo (AGT-2171, D-18): d c y p P x r on the selection (or the character
// under the cursor), named and default registers, u/U, and an insert session or an operator as one undo step. Pure.

import { expect, test } from "bun:test";
import { TextBuffer } from "../src/buffer";
import { openText, type EditText } from "../src/edit-pane";
import { DEFAULT_KEYMAP, rowsOf } from "../src/keys";
import { modalKey, modeOf } from "../src/modal";
import { DEFAULT_REGISTER, type OpText } from "../src/operators";
import { entriesOf, panelTitle } from "../src/panel";
import type { Pending } from "../src/state";

const W = 40, H = 10;
const ESC: [string, Record<string, boolean>] = ["", { escape: true }];
const CTRL_Z: [string, Record<string, boolean>] = ["z", { ctrl: true }];

function run(t: EditText, keys: (string | [string, Record<string, boolean>])[]) {
  let text = t as OpText;
  let pending: Pending | null = null;
  for (const k of keys) {
    const [input, key] = typeof k === "string" ? [k, {}] : k;
    const step = modalKey(modeOf(text), pending, input, key, DEFAULT_KEYMAP, { width: W, height: H });
    if (step === "close") throw new Error("closed");
    for (const a of step) {
      if (a.type === "pane.edit") text = a.edit(text) as OpText;
      else if (a.type === "prefix.press") pending = { prefix: a.prefix };
      else if (a.type === "prefix.clear") pending = null;
      else throw new Error(`unexpected ${a.type}`);
    }
  }
  return { text, pending, body: text.buffer.text(), at: text.buffer.cursor };
}
const open = (body: string) => openText(body, "lines", 1);
const chars = (s: string) => [...s];

test("x and d delete the character under the cursor in normal mode, into the default register", () => {
  let r = run(open("abc"), ["l", "x"]);
  expect(r.body).toBe("ac");
  expect(r.at).toEqual({ row: 0, col: 1 });
  expect(r.text.registers?.[DEFAULT_REGISTER]).toBe("b");
  r = run(open("abc"), ["d", "d"]);
  expect(r.body).toBe("c");
  // At a line's end the character is the line break: the next line joins.
  expect(run(open("ab\ncd"), ["$", "l", "x"]).body).toBe("abcd");
  // The last character of the document: nothing past it to take.
  expect(run(open("ab"), ["$", "l", "x"]).body).toBe("ab");
});

test("d in select mode deletes the selection, both ends included, and goes back to normal", () => {
  const r = run(open("one two three"), ["v", "w", "d"]);
  expect(r.body).toBe("wo three");
  expect(r.text.mode).toBe("normal");
  expect(r.text.anchor).toBeNull();
  expect(r.text.registers?.[DEFAULT_REGISTER]).toBe("one t");
  // Backwards and over lines alike.
  expect(run(open("ab\ncd"), ["j", "l", "v", "k", "h", "d"]).body).toBe("");
});

test("y yanks without changing the text; p pastes after the cursor, P before", () => {
  let r = run(open("one two"), ["v", "e", "y"]);
  expect(r.body).toBe("one two");
  expect(r.text.registers?.[DEFAULT_REGISTER]).toBe("one");
  expect(r.text.mode).toBe("select"); // as Helix: the selection stays
  r = run(r.text, [ESC, "$", "p"]);
  expect(r.body).toBe("one twoone");
  expect(r.at).toEqual({ row: 0, col: 9 }); // on the last character pasted
  r = run(r.text, ["0", "P"]);
  expect(r.body).toBe("oneone twoone");
  // Paste after the character on an empty line, or at a line's end, stays on that line.
  r = run(open("x\n\ny"), ["y", "j", "p"]);
  expect(r.body).toBe("x\nx\ny");
  // An empty register pastes nothing.
  expect(run(open("abc"), ["p"]).body).toBe("abc");
});

test("c deletes into the register and inserts; the change and what is typed undo as one step", () => {
  let r = run(open("one two"), ["v", "e", "c", ...chars("ONE"), ESC]);
  expect(r.body).toBe("ONE two");
  expect(r.text.mode).toBe("normal");
  expect(r.text.registers?.[DEFAULT_REGISTER]).toBe("one");
  r = run(r.text, ["u"]);
  expect(r.body).toBe("one two");
  r = run(r.text, ["U"]);
  expect(r.body).toBe("ONE two");
});

test("r replaces the character, or every character of the selection, with the next key; line breaks stay", () => {
  let r = run(open("abc"), ["l", "r", "X"]);
  expect(r.body).toBe("aXc");
  expect(r.pending).toBeNull();
  r = run(open("ab\ncd"), ["v", "j", "r", "-"]);
  expect(r.body).toBe("--\n-d");
  expect(r.text.mode).toBe("select");
  // r waits for its character: the panel says so, Esc cancels it, and a named key does nothing.
  const w = run(open("abc"), ["r"]);
  expect(w.pending).toEqual({ prefix: "replace" });
  expect(panelTitle({ state: "normal" }, w.pending)).toBe("replace");
  expect(entriesOf({ state: "normal" }, w.pending).map((e) => e.label)).toEqual(["character to replace with", "cancel"]);
  const esc = run(open("abc"), ["r", ESC, "x"]); // Esc cancels the wait only; x then deletes
  expect(esc.pending).toBeNull();
  expect(esc.body).toBe("bc");
  const named = run(open("abc"), ["r", ["", { downArrow: true }]]);
  expect(named.body).toBe("abc");
  expect(named.pending).toBeNull();
  // r is one undo step.
  expect(run(open("abc"), ["v", "$", "r", "z", "u"]).body).toBe("abc");
});

test("named registers: \" a names the register for the next yank, delete or paste; the default is untouched", () => {
  let r = run(open("one two"), ["v", "e", "\"", "a", "y", ESC, "w", "v", "e", "y", ESC]);
  expect(r.text.registers).toEqual({ a: "one", [DEFAULT_REGISTER]: "two" });
  expect(r.text.register).toBeNull(); // the name is used up
  r = run(r.text, ["$", "\"", "a", "p"]);
  expect(r.body).toBe("one twoone");
  r = run(r.text, ["$", "p"]);
  expect(r.body).toBe("one twoonetwo");
  // A delete into a named register.
  r = run(open("xyz"), ["\"", "b", "x"]);
  expect(r.text.registers).toEqual({ b: "x" });
});

test("u undoes and U redoes in normal mode; one insert session undoes as a single step", () => {
  const t = open("start");
  // Several words, a newline and arrow moves inside one session.
  let r = run(t, ["$", "a", ...chars(" the cat sat"), ["", { return: true }], ...chars("on the mat"), ["", { leftArrow: true }], "!", ESC]);
  expect(r.body).toBe("start the cat sat\non the ma!t");
  r = run(r.text, ["u"]);
  expect(r.body).toBe("start");
  expect(r.text.dirty).toBe(false);
  r = run(r.text, ["U"]);
  expect(r.body).toBe("start the cat sat\non the ma!t");
  // Two sessions are two steps; o's new line belongs to its session.
  r = run(open("a"), ["i", "X", ESC, "o", ...chars("new line"), ESC]);
  expect(r.body).toBe("Xa\nnew line");
  r = run(r.text, ["u"]);
  expect(r.body).toBe("Xa");
  r = run(r.text, ["u"]);
  expect(r.body).toBe("a");
  // Ctrl+Z in normal mode is the same undo.
  expect(run(open("a"), ["i", ...chars("one two"), ESC, CTRL_Z]).body).toBe("a");
  // Operators are a step each: two pastes, two undos.
  r = run(open("ab"), ["y", "p", "p"]);
  expect(r.body).toBe("aaab");
  expect(run(r.text, ["u"]).body).toBe("aab");
});

test("the operator keys are rows of normal and select mode", () => {
  const ops = ["editor.delete", "editor.delete_char", "editor.change", "editor.yank", "editor.paste", "editor.paste_before", "editor.replace", "editor.register", "editor.undo", "editor.redo"];
  expect(rowsOf({ state: "normal" }).map((a) => a.id)).toEqual(expect.arrayContaining(ops));
  expect(rowsOf({ state: "select" }).map((a) => a.id)).toEqual(expect.arrayContaining(ops));
});

test("the buffer's undo group: edits inside undo as one step, nested groups as the outer one, a save splits it", () => {
  const b = new TextBuffer("one two three");
  b.group(() => {
    b.cursor = { row: 0, col: 0 };
    b.deleteRange({ row: 0, col: 0 }, { row: 0, col: 4 });
    b.group(() => { b.cursor = { row: 0, col: 4 }; b.insert("2 "); });
    b.insert("x y z");
  });
  expect(b.text()).toBe("two 2 x y zthree");
  b.undo();
  expect(b.text()).toBe("one two three");
  expect(b.undo()).toBe(false);
  // An autosave in the middle of a session: undo comes back to the saved text first.
  const s = new TextBuffer("a");
  s.beginGroup();
  s.insert("b c");
  s.saved();
  s.insert(" d e");
  s.endGroup();
  s.undo();
  expect(s.text()).toBe("b ca");
  expect(s.dirty).toBe(false);
  // slice and deleteRange take their ends either way round.
  const r = new TextBuffer("ab\ncd");
  expect(r.slice({ row: 1, col: 1 }, { row: 0, col: 1 })).toBe("b\nc");
  expect(r.deleteRange({ row: 1, col: 1 }, { row: 0, col: 1 })).toBe("b\nc");
  expect(r.text()).toBe("ad");
});
