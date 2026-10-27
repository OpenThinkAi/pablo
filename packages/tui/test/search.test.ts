// Search and replace in the editing pane (AGT-2172): the prompt, n/N, highlights, and replace as one undo step.

import { expect, test } from "bun:test";
import { openText, paneRows, type EditText } from "../src/edit-pane";
import { DEFAULT_KEYMAP } from "../src/keys";
import { modalKey, modeOf } from "../src/modal";
import { findMatches, matchesOnLine, promptKey, searchStatus } from "../src/search";
import type { Pending } from "../src/state";

const ESC = { escape: true };
const ENTER = { return: true };
const BS = { backspace: true };

function run(t: EditText, keys: (string | [string, Record<string, boolean>])[]) {
  let text = t;
  let pending: Pending | null = null;
  for (const k of keys) {
    const [input, key] = typeof k === "string" ? [k, {}] : k;
    const typing = promptKey(text, input, key);
    const step: ReturnType<typeof modalKey> = typing ?? modalKey(modeOf(text), pending, input, key, DEFAULT_KEYMAP, { width: 30, height: 10 });
    if (step === "close") continue;
    for (const a of step) {
      if (a.type === "pane.edit") text = a.edit(text) as EditText;
      else if (a.type === "prefix.press") pending = { prefix: a.prefix };
      else if (a.type === "prefix.clear") pending = null;
    }
  }
  return text;
}
const open = (body: string) => openText(body, "lines", 1);
const type = (s: string) => [...s];
const search = (q: string) => ["/", ...type(q), ["", ENTER] as [string, Record<string, boolean>]];

test("matching is literal, ignores case unless the query has a capital", () => {
  expect(matchesOnLine("Cat cat CAT", "cat")).toHaveLength(3);
  expect(matchesOnLine("Cat cat CAT", "Cat")).toHaveLength(1);
  expect(matchesOnLine("a.b axb", "a.b")).toEqual([{ start: 0, end: 3 }]);
  expect(matchesOnLine("abc", "")).toEqual([]);
  expect(findMatches(["ab", "ab"], "b").map((m) => m.row)).toEqual([0, 1]);
});

test("/ jumps to the next match after the cursor; n and N step and wrap", () => {
  let t = run(open("one fox\ntwo fox\nthree fox"), search("fox"));
  expect(t.buffer.cursor).toEqual({ row: 0, col: 4 });
  expect(searchStatus(t)).toBe("/fox 1/3");
  t = run(t, ["n"]);
  expect(t.buffer.cursor).toEqual({ row: 1, col: 4 });
  t = run(t, ["n", "n"]);
  expect(t.buffer.cursor).toEqual({ row: 0, col: 4 });
  t = run(t, ["N"]);
  expect(t.buffer.cursor).toEqual({ row: 2, col: 6 });
});

test("the prompt takes keys, Backspace erases, Esc cancels without moving", () => {
  let t = run(open("abc abd"), ["/", "a", "b", "x", ["", BS], "d"]);
  expect(t.prompt?.text).toBe("abd");
  t = run(t, [["", ESC]]);
  expect(t.prompt).toBeNull();
  expect(t.search ?? null).toBeNull();
  expect(t.buffer.cursor).toEqual({ row: 0, col: 0 });
});

test("no match is said, and the cursor stays", () => {
  const t = run(open("abc"), search("zzz"));
  expect(t.buffer.cursor).toEqual({ row: 0, col: 0 });
  expect(searchStatus(t)).toBe("no match for zzz");
  expect(searchStatus(run(open("abc"), ["n"]))).toContain("no search yet");
});

test("matches are highlighted in the rows", () => {
  const t = run(open("a fox and a fox"), search("fox"));
  const rows = paneRows(t, 30, 5, new Map());
  const parts = rows[0]!.kind === "text" ? rows[0]!.parts! : [];
  expect(parts.filter((p) => p.match || p.cursor).map((p) => p.text).join("")).toBe("foxfox"); // the cursor cell is its own run
  expect(parts.some((p) => p.match)).toBe(true);
});

test("search in select mode extends the selection", () => {
  const t = run(open("one fox here"), ["v", ...search("fox")]);
  expect(t.mode).toBe("select");
  expect(t.anchor).toEqual({ row: 0, col: 0 });
  expect(t.buffer.cursor).toEqual({ row: 0, col: 4 });
});

const replace = (a: string, b: string) => ["R", ...type(a), ["", ENTER] as [string, Record<string, boolean>], ...type(b), ["", ENTER] as [string, Record<string, boolean>]];

test("R replaces across the whole unit and undoes as one step", () => {
  const t = run(open("cat sat\nthe cat\ndog"), replace("cat", "hen"));
  expect(t.buffer.text()).toBe("hen sat\nthe hen\ndog");
  expect(searchStatus(t)).toBe("2 replacements");
  expect(t.dirty).toBe(true);
  t.buffer.undo();
  expect(t.buffer.text()).toBe("cat sat\nthe cat\ndog");
  expect(t.buffer.undo()).toBe(false);
});

test("R in select mode replaces only inside the selection", () => {
  let t = run(open("cat cat cat"), ["v", "e"]);
  expect(t.buffer.cursor).toEqual({ row: 0, col: 2 });
  t = run(t, replace("cat", "x"));
  expect(t.buffer.text()).toBe("x cat cat");
  expect(t.mode).toBe("normal");
  t = run(t, replace("cat", "y"));
  expect(t.buffer.text()).toBe("x y y");
});

test("replace with nothing deletes; an empty find reuses the last search; replacement text is literal", () => {
  let t = run(open("a$&b a$&b"), search("$&"));
  t = run(t, ["R", ["", ENTER], "-", ["", ENTER]]);
  expect(t.buffer.text()).toBe("a-b a-b");
  t = run(t, replace("-", ""));
  expect(t.buffer.text()).toBe("ab ab");
});

test("a replace with no match changes nothing and pushes no undo step", () => {
  const t = run(open("abc"), replace("zzz", "y"));
  expect(t.buffer.text()).toBe("abc");
  expect(t.dirty).toBe(false);
  expect(t.buffer.undo()).toBe(false);
});

test("typing after a replace is its own undo step", () => {
  let t = run(open("cat"), replace("cat", "hen"));
  t = run(t, ["i", "X", ["", ESC]]);
  t.buffer.undo();
  expect(t.buffer.text()).toBe("hen");
});

test("the note goes at the next edit or move", () => {
  let t = run(open("cat"), replace("cat", "hen"));
  expect(searchStatus(t)).toBe("2 replacements".replace("2", "1").replace("replacements", "replacement"));
  t = run(t, ["l"]);
  expect(t.note).toBeNull();
});
