// The screen's state model, without a terminal: every action, applied to a state built by earlier actions.

import { expect, test } from "bun:test";
import { openSettings } from "../src/settings";
import { DEFAULT_KEYMAP } from "../src/keys";
import { initialState, pendingText, railRow, reduce, reviewCounts, shownRows, viewOf, type Action, type ActionType, type RailRow, type State } from "../src/state";

/** A state after `actions`, from the initial one. */
const after = (...actions: Action[]): State => actions.reduce(reduce, initialState());
const then = (s: State, ...actions: Action[]): State => actions.reduce(reduce, s);

/** A book's rail: four stages, then the chapters as a group holding three. */
const ROWS: readonly RailRow[] = [
  { id: "premise", depth: 0 }, { id: "bible", depth: 0 }, { id: "acts", depth: 0 }, { id: "beats", depth: 0 },
  { id: "chapters", depth: 0, group: true }, { id: "ch1", depth: 1 }, { id: "ch2", depth: 1 }, { id: "ch3", depth: 1 },
];
const book = (...actions: Action[]) => after({ type: "rail.loaded", rows: ROWS }, ...actions);
const ids = (s: State) => shownRows(viewOf(s).rail).map((r) => r.row.id);
const at = (s: State) => railRow(viewOf(s).rail)?.id;

// ---------------------------------------------------------------- the model

test("the initial state: book mode, the cursor in the rail, nothing open, nothing pending", () => {
  const s = initialState();
  expect(s.mode).toEqual({ kind: "book" });
  expect(s.pane).toBe("rail");
  expect(s.focus).toBe("rail");
  expect(s.content).toBeNull();
  expect(s.pending).toBeNull();
  expect(s.zen).toBe(false);
  expect(s.full).toBe(false);
  expect(viewOf(s).rail.rows).toEqual([]);
});

test("reduce never mutates the state it is given", () => {
  const s = book();
  const frozen = JSON.stringify(s);
  const actions: Action[] = [
    { type: "rail.down" }, { type: "rail.collapse" }, { type: "main.loaded", lines: 5 }, { type: "main.down" }, { type: "content.show", content: { title: "t", body: "b" } },
    { type: "focus.content" }, { type: "prefix.press", prefix: "g" }, { type: "prefix.digit", digit: "3" }, { type: "view.zen" }, { type: "review.open", branch: "draft/ch01" }, { type: "write.start", chapter: 1 }, { type: "write.progress", line: "x" }, { type: "write.done", branch: "draft/ch01", lines: ["r"] }, { type: "write.failed", message: "m", missing: [] }, { type: "escape" },
    { type: "measured", measure: { rail: 3, main: 3, content: { visible: 2, lines: 9 } } },
  ];
  for (const a of actions) reduce(s, a);
  expect(JSON.stringify(s)).toBe(frozen);
});

test("every action type has a case: each applies to the initial state and to a loaded book without throwing", () => {
  const every: Record<ActionType, Action> = {
    "rail.loaded": { type: "rail.loaded", rows: ROWS }, "rail.down": { type: "rail.down" }, "rail.up": { type: "rail.up" },
    "rail.next_group": { type: "rail.next_group" }, "rail.prev_group": { type: "rail.prev_group" }, "rail.expand": { type: "rail.expand" }, "rail.collapse": { type: "rail.collapse" }, "rail.open": { type: "rail.open" },
    "main.loaded": { type: "main.loaded", lines: 3 }, "main.down": { type: "main.down" }, "main.up": { type: "main.up" }, "main.page_down": { type: "main.page_down" }, "main.page_up": { type: "main.page_up" },
    "main.top": { type: "main.top" }, "main.end": { type: "main.end" }, "main.goto": { type: "main.goto", line: 2 }, "main.to_rail": { type: "main.to_rail" },
    "content.show": { type: "content.show", content: { title: "t", body: "b" } }, "content.close": { type: "content.close" }, "content.down": { type: "content.down" }, "content.up": { type: "content.up" },
    "content.page_down": { type: "content.page_down" }, "content.page_up": { type: "content.page_up" },
    "focus.content": { type: "focus.content" }, "focus.back": { type: "focus.back" },
    "prefix.press": { type: "prefix.press", prefix: "a" }, "prefix.digit": { type: "prefix.digit", digit: "1" }, "prefix.backspace": { type: "prefix.backspace" }, "prefix.clear": { type: "prefix.clear" },
    "view.zen": { type: "view.zen" }, "view.full": { type: "view.full" },
    "review.open": { type: "review.open", branch: "draft/ch02" }, "review.close": { type: "review.close" }, "review.mark": { type: "review.mark", mark: "accepted" },
    "edit.start": { type: "edit.start", file: "chapters/01-a.md", line: 3 }, "edit.done": { type: "edit.done", branch: "edit/ab12cd", lines: ["l"] }, "edit.failed": { type: "edit.failed", message: "m" }, "edit.refused": { type: "edit.refused", message: "m" },
    "save.start": { type: "save.start", branch: "edit/ab12cd" }, "save.done": { type: "save.done", branch: "edit/ab12cd", lines: ["l"] }, "save.failed": { type: "save.failed", message: "m" },
    "voice.offer": { type: "voice.offer", sentences: ["s"] }, "voice.start": { type: "voice.start", kind: "flag" }, "voice.done": { type: "voice.done", lines: ["l"] }, "voice.failed": { type: "voice.failed", message: "m" },
    "finish.start": { type: "finish.start", branch: "draft/ch02" }, "finish.done": { type: "finish.done", branch: "draft/ch02", lines: ["l"] }, "finish.failed": { type: "finish.failed", message: "m" },
    "settings.open": { type: "settings.open", settings: openSettings(DEFAULT_KEYMAP, "", "/tmp/none.json") }, "settings.set": { type: "settings.set", settings: openSettings(DEFAULT_KEYMAP, "", "/tmp/none.json") }, "settings.close": { type: "settings.close" },
    "write.start": { type: "write.start", chapter: 2 }, "write.progress": { type: "write.progress", line: "x" }, "write.done": { type: "write.done", branch: "draft/ch02", lines: ["ok"] }, "write.failed": { type: "write.failed", message: "no", missing: ["a"] },
    "revise.open": { type: "revise.open", file: "chapters/01-x.md", sentences: ["A."], stored: { from: 0, to: 0 } }, "revise.type": { type: "revise.type", text: "x" }, "revise.backspace": { type: "revise.backspace" },
    "revise.left": { type: "revise.left" }, "revise.right": { type: "revise.right" }, "revise.run": { type: "revise.run" }, "revise.partial": { type: "revise.partial", id: 1, text: "p" },
    "revise.done": { type: "revise.done", id: 1, candidate: "c", receipt: "r", model: "m" }, "revise.take": { type: "revise.take" }, "revise.taken": { type: "revise.taken", id: 1, branch: "revise/abc1234", lines: ["l"] },
    "revise.failed": { type: "revise.failed", id: 1, message: "m" }, "revise.cancel": { type: "revise.cancel" },
    "compose.open": { type: "compose.open" }, "compose.close": { type: "compose.close" }, "compose.type": { type: "compose.type", text: "hi" }, "compose.backspace": { type: "compose.backspace" },
    "compose.submit": { type: "compose.submit" }, "compose.event": { type: "compose.event", event: { kind: "assistant", text: "hello" } },
    "compose.add": { type: "compose.add", entry: { kind: "question", id: "q1", question: "Which way?" } }, "compose.failed": { type: "compose.failed", message: "no" }, "compose.done": { type: "compose.done" },
    "compose.pick": { type: "compose.pick" }, "compose.pick_move": { type: "compose.pick_move", by: 1 }, "compose.open_branch": { type: "compose.open_branch" },
    "compose.up": { type: "compose.up" }, "compose.down": { type: "compose.down" }, "compose.page_up": { type: "compose.page_up" }, "compose.page_down": { type: "compose.page_down" },
    "select.down": { type: "select.down" }, "select.up": { type: "select.up" }, "select.clear": { type: "select.clear" },
    escape: { type: "escape" }, measured: { type: "measured", measure: { rail: 4, main: 4, content: { visible: 2, lines: 3 } } },
  };
  for (const a of Object.values(every)) {
    expect(reduce(initialState(), a)).toBeDefined();
    expect(reduce(book(), a)).toBeDefined();
  }
});

// ---------------------------------------------------------------- the rail

test("rail.loaded: the cursor starts on the first row; a reload keeps it on the same row by id, or in place when that row is gone", () => {
  const s = book();
  expect(at(s)).toBe("premise");
  const moved = then(s, { type: "rail.down" }, { type: "rail.down" });
  expect(at(moved)).toBe("acts");
  // The stage machine re-read after a write: a new row in front shifts the index, the id stays.
  const reloaded = then(moved, { type: "rail.loaded", rows: [{ id: "research", depth: 0 }, ...ROWS] });
  expect(at(reloaded)).toBe("acts");
  // The row under the cursor is gone: the row now at its place.
  const gone = then(moved, { type: "rail.loaded", rows: ROWS.filter((r) => r.id !== "acts") });
  expect(at(gone)).toBe("beats");
  // Fewer rows than the cursor: the last one. No rows: the cursor is nowhere.
  expect(at(then(moved, { type: "rail.loaded", rows: ROWS.slice(0, 2) }))).toBe("bible");
  expect(at(then(moved, { type: "rail.loaded", rows: [] }))).toBeUndefined();
});

test("rail.down and rail.up move row by row and stop at the ends", () => {
  let s = book();
  expect(at(then(s, { type: "rail.up" }))).toBe("premise");
  for (let i = 0; i < 20; i++) s = then(s, { type: "rail.down" });
  expect(at(s)).toBe("ch3");
  expect(at(then(s, { type: "rail.up" }))).toBe("ch2");
  expect(at(then(initialState(), { type: "rail.down" }))).toBeUndefined();
});

test("rail.collapse folds the group under the cursor; the moves skip its rows; rail.expand unfolds it", () => {
  const onChapters = book({ type: "rail.down" }, { type: "rail.down" }, { type: "rail.down" }, { type: "rail.down" });
  expect(at(onChapters)).toBe("chapters");
  const folded = then(onChapters, { type: "rail.collapse" });
  expect(ids(folded)).toEqual(["premise", "bible", "acts", "beats", "chapters"]);
  expect(at(folded)).toBe("chapters");
  expect(at(then(folded, { type: "rail.down" }))).toBe("chapters");
  // Folded, → unfolds and stays on the group; → again steps to its first row.
  const unfolded = then(folded, { type: "rail.expand" });
  expect(ids(unfolded)).toEqual(ids(onChapters));
  expect(at(unfolded)).toBe("chapters");
  expect(at(then(unfolded, { type: "rail.expand" }))).toBe("ch1");
  // ← on a row inside the group goes up to the group; ← on the folded group stays.
  expect(at(then(unfolded, { type: "rail.expand" }, { type: "rail.down" }, { type: "rail.collapse" }))).toBe("chapters");
  expect(at(then(folded, { type: "rail.collapse" }))).toBe("chapters");
  // A stage has nothing to fold: ← and → fold nothing (→ enters the main pane instead, below).
  expect(ids(book({ type: "rail.collapse" }))).toEqual(ids(book()));
});

test("a fold survives a reload while its group does, and a cursor the reload puts inside a fold goes up to the group", () => {
  const folded = book({ type: "rail.next_group" }, { type: "rail.collapse" });
  const kept = then(folded, { type: "rail.loaded", rows: ROWS });
  expect(viewOf(kept).rail.collapsed.has("chapters")).toBe(true);
  // The group is gone: its fold goes with it.
  const flat = then(folded, { type: "rail.loaded", rows: ROWS.map((r) => ({ id: r.id, depth: 0 })) });
  expect(viewOf(flat).rail.collapsed.size).toBe(0);
  // The cursor's row is gone and the row at its place is inside a fold: the cursor goes up to the folded group.
  const onCh2 = book({ type: "rail.next_group" }, { type: "rail.collapse" }, { type: "rail.up" });
  expect(at(onCh2)).toBe("beats");
  expect(viewOf(onCh2).rail.collapsed.has("chapters")).toBe(true);
  const reshaped = then(onCh2, { type: "rail.loaded", rows: [{ id: "premise", depth: 0 }, { id: "chapters", depth: 0, group: true }, { id: "ch1", depth: 1 }, { id: "ch2", depth: 1 }, { id: "ch3", depth: 1 }] });
  expect(at(reshaped)).toBe("chapters");
  expect(ids(reshaped)).toEqual(["premise", "chapters"]);
});

test("rail.next_group and rail.prev_group walk the groups at the cursor's level", () => {
  const rows: RailRow[] = [
    { id: "acts", depth: 0, group: true }, { id: "act1", depth: 1 }, { id: "act2", depth: 1 },
    { id: "chapters", depth: 0, group: true }, { id: "ch1", depth: 1 }, { id: "ch2", depth: 1 },
    { id: "notes", depth: 0, group: true }, { id: "n1", depth: 1 },
  ];
  const s = after({ type: "rail.loaded", rows });
  expect(at(then(s, { type: "rail.next_group" }))).toBe("chapters");
  expect(at(then(s, { type: "rail.next_group" }, { type: "rail.next_group" }))).toBe("notes");
  expect(at(then(s, { type: "rail.next_group" }, { type: "rail.next_group" }, { type: "rail.next_group" }))).toBe("notes");
  // From inside a group: the next group after it, the previous group before it.
  const inside = then(s, { type: "rail.next_group" }, { type: "rail.expand" });
  expect(at(inside)).toBe("ch1");
  expect(at(then(inside, { type: "rail.next_group" }))).toBe("notes");
  expect(at(then(inside, { type: "rail.prev_group" }))).toBe("acts");
  expect(at(then(s, { type: "rail.prev_group" }))).toBe("acts");
  // With a folded group between, it is still a stop.
  const folded = then(s, { type: "rail.next_group" }, { type: "rail.collapse" }, { type: "rail.prev_group" });
  expect(at(then(folded, { type: "rail.next_group" }))).toBe("chapters");
  expect(at(then(initialState(), { type: "rail.next_group" }))).toBeUndefined();
});

test("rail.expand on a row that does not fold enters the main pane; main.to_rail goes back", () => {
  const s = book({ type: "rail.expand" });
  expect(s.pane).toBe("main");
  expect(s.focus).toBe("main");
  expect(at(s)).toBe("premise");
  const back = then(s, { type: "main.to_rail" });
  expect(back.pane).toBe("rail");
  expect(back.focus).toBe("rail");
  // With focus in the content area, the pane changes under it and focus stays there.
  const inContent = then(s, { type: "content.show", content: { title: "t", body: "b" } }, { type: "focus.content" }, { type: "main.to_rail" });
  expect(inContent.pane).toBe("rail");
  expect(inContent.focus).toBe("content");
});

test("the rail's scroll follows the cursor among the shown rows once measured", () => {
  const s = book({ type: "measured", measure: { rail: 3 } });
  let m = s;
  for (let i = 0; i < 4; i++) m = then(m, { type: "rail.down" });
  expect(at(m)).toBe("chapters");
  expect(viewOf(m).rail.scroll).toBe(2);
  // Folding the chapters leaves the group at the bottom of the window; going up pulls the window up.
  const folded = then(m, { type: "rail.collapse" });
  expect(viewOf(folded).rail.scroll).toBe(2);
  let up = folded;
  for (let i = 0; i < 4; i++) up = then(up, { type: "rail.up" });
  expect(viewOf(up).rail.scroll).toBe(0);
  // Unmeasured, nothing scrolls.
  let u = book();
  for (let i = 0; i < 7; i++) u = then(u, { type: "rail.down" });
  expect(viewOf(u).rail.scroll).toBe(0);
  // A smaller window keeps the cursor in view.
  const shrunk = then(m, { type: "measured", measure: { rail: 2 } });
  expect(viewOf(shrunk).rail.scroll).toBe(3);
});

// ---------------------------------------------------------------- the main pane

test("main.loaded with a document id: a different document starts at its top, the same one keeps the line", () => {
  const s = after({ type: "main.loaded", lines: 20, doc: "ch1" }, { type: "measured", measure: { main: 4 } }, { type: "main.goto", line: 12 });
  expect(viewOf(s).main).toMatchObject({ cursor: 11, doc: "ch1" });
  expect(viewOf(then(s, { type: "main.loaded", lines: 25, doc: "ch1" })).main).toMatchObject({ cursor: 11, length: 25 });
  expect(viewOf(then(s, { type: "main.loaded", lines: 9, doc: "ch2" })).main).toMatchObject({ cursor: 0, scroll: 0, length: 9, doc: "ch2" });
  expect(viewOf(then(s, { type: "main.loaded", lines: 5 })).main).toMatchObject({ cursor: 4, doc: "ch1" }); // no id: a reload only
});

test("the main pane's cursor moves line by line, pages, jumps to the ends and to a line, within the document", () => {
  const s = after({ type: "main.loaded", lines: 10 }, { type: "measured", measure: { main: 4 } });
  const main = (x: State) => viewOf(x).main;
  expect(main(s)).toEqual({ cursor: 0, scroll: 0, length: 10, visible: 4, sentences: [], selection: null });
  expect(main(then(s, { type: "main.up" })).cursor).toBe(0);
  expect(main(then(s, { type: "main.down" })).cursor).toBe(1);
  expect(main(then(s, { type: "main.end" }))).toEqual({ cursor: 9, scroll: 6, length: 10, visible: 4, sentences: [], selection: null });
  expect(main(then(s, { type: "main.end" }, { type: "main.down" })).cursor).toBe(9);
  expect(main(then(s, { type: "main.end" }, { type: "main.top" }))).toEqual({ cursor: 0, scroll: 0, length: 10, visible: 4, sentences: [], selection: null });
  // A page is the window less one line; past the end it stops at the last line.
  expect(main(then(s, { type: "main.page_down" }))).toEqual({ cursor: 3, scroll: 0, length: 10, visible: 4, sentences: [], selection: null });
  expect(main(then(s, { type: "main.page_down" }, { type: "main.page_down" }))).toEqual({ cursor: 6, scroll: 3, length: 10, visible: 4, sentences: [], selection: null });
  expect(main(then(s, { type: "main.page_down" }, { type: "main.page_down" }, { type: "main.page_down" }, { type: "main.page_down" })).cursor).toBe(9);
  expect(main(then(s, { type: "main.end" }, { type: "main.page_up" })).cursor).toBe(6);
  // Lines count from 1; out of range lands on the nearest end.
  expect(main(then(s, { type: "main.goto", line: 7 })).cursor).toBe(6);
  expect(main(then(s, { type: "main.goto", line: 0 })).cursor).toBe(0);
  expect(main(then(s, { type: "main.goto", line: 99 })).cursor).toBe(9);
  // Unmeasured, a page is one line and nothing scrolls.
  const u = after({ type: "main.loaded", lines: 10 }, { type: "main.page_down" }, { type: "main.page_down" });
  expect(main(u)).toEqual({ cursor: 2, scroll: 0, length: 10, visible: 0, sentences: [], selection: null });
  // An empty document has nowhere to go.
  expect(main(after({ type: "main.down" }, { type: "main.end" }))).toEqual({ cursor: 0, scroll: 0, length: 0, visible: 0, sentences: [], selection: null });
});

test("main.loaded with fewer lines pulls the cursor back inside; the scroll follows", () => {
  const s = after({ type: "main.loaded", lines: 10 }, { type: "measured", measure: { main: 4 } }, { type: "main.end" });
  const shorter = then(s, { type: "main.loaded", lines: 3 });
  expect(viewOf(shorter).main).toEqual({ cursor: 2, scroll: 0, length: 3, visible: 4, sentences: [], selection: null });
});

// ---------------------------------------------------------------- the content area and focus

test("content.show opens the content area at the top; it scrolls once measured, within its lines", () => {
  const shown = after({ type: "content.show", content: { title: "Beat", body: "one\ntwo" } });
  expect(shown.content).toEqual({ title: "Beat", body: "one\ntwo" });
  expect(shown.contentScroll).toEqual({ scroll: 0, length: 0, visible: 0 });
  // Unmeasured, there is nothing to scroll into.
  expect(then(shown, { type: "content.down" }).contentScroll.scroll).toBe(0);
  const measured = then(shown, { type: "measured", measure: { content: { visible: 3, lines: 8 } } });
  expect(then(measured, { type: "content.down" }).contentScroll.scroll).toBe(1);
  expect(then(measured, { type: "content.page_down" }).contentScroll.scroll).toBe(2);
  expect(then(measured, { type: "content.page_down" }, { type: "content.page_down" }, { type: "content.page_down" }, { type: "content.page_down" }).contentScroll.scroll).toBe(5);
  expect(then(measured, { type: "content.page_down" }, { type: "content.page_down" }, { type: "content.up" }).contentScroll.scroll).toBe(3);
  expect(then(measured, { type: "content.page_down" }, { type: "content.page_down" }, { type: "content.page_up" }).contentScroll.scroll).toBe(2);
  expect(then(measured, { type: "content.up" }).contentScroll.scroll).toBe(0);
  // Fewer lines than the window: no scroll at all. A new measure after scrolling holds the scroll inside.
  expect(then(measured, { type: "measured", measure: { content: { visible: 9, lines: 8 } } }, { type: "content.down" }).contentScroll.scroll).toBe(0);
  expect(then(measured, { type: "content.page_down" }, { type: "content.page_down" }, { type: "measured", measure: { content: { visible: 6, lines: 8 } } }).contentScroll.scroll).toBe(2);
  // New content starts at the top again.
  expect(then(measured, { type: "content.down" }, { type: "content.show", content: { title: "Receipt", body: "x" } }).contentScroll.scroll).toBe(0);
});

test("Tab moves focus into the content area only while it shows something, and back to the pane the cursor is in", () => {
  expect(after({ type: "focus.content" }).focus).toBe("rail");
  const open = after({ type: "content.show", content: { title: "t", body: "b" } }, { type: "focus.content" });
  expect(open.focus).toBe("content");
  expect(open.pane).toBe("rail");
  expect(then(open, { type: "focus.back" }).focus).toBe("rail");
  const fromMain = after({ type: "rail.loaded", rows: ROWS }, { type: "rail.expand" }, { type: "content.show", content: { title: "t", body: "b" } }, { type: "focus.content" });
  expect(fromMain.focus).toBe("content");
  expect(then(fromMain, { type: "focus.back" }).focus).toBe("main");
  // Closing the content while focus is in it gives focus back to the pane.
  expect(then(fromMain, { type: "content.close" }).focus).toBe("main");
  expect(then(fromMain, { type: "content.close" }).content).toBeNull();
});

test("view.zen hides the rail; view.full takes the screen for the content area while there is content", () => {
  expect(after({ type: "view.zen" }).zen).toBe(true);
  expect(after({ type: "view.zen" }, { type: "view.zen" }).zen).toBe(false);
  expect(after({ type: "view.full" }).full).toBe(false);
  const full = after({ type: "content.show", content: { title: "t", body: "b" } }, { type: "view.full" });
  expect(full.full).toBe(true);
  expect(then(full, { type: "view.full" }).full).toBe(false);
  expect(then(full, { type: "content.close" }).full).toBe(false);
});

// ---------------------------------------------------------------- the pending prefix

test("a prefix waits for its second key; after g, digits make a line number; backspace takes one back, then the prefix", () => {
  const g = after({ type: "prefix.press", prefix: "g" });
  expect(g.pending).toEqual({ prefix: "g" });
  expect(pendingText(g.pending)).toBe("g");
  const n = then(g, { type: "prefix.digit", digit: "1" }, { type: "prefix.digit", digit: "2" });
  expect(n.pending).toEqual({ prefix: "g", digits: "12" });
  expect(pendingText(n.pending)).toBe("g 12");
  expect(then(n, { type: "prefix.backspace" }).pending).toEqual({ prefix: "g", digits: "1" });
  expect(then(n, { type: "prefix.backspace" }, { type: "prefix.backspace" }).pending).toBeNull();
  // Backspace with no number typed, or a digit with nothing pending, does nothing; a non-digit is refused.
  expect(then(g, { type: "prefix.backspace" }).pending).toEqual({ prefix: "g" });
  expect(after({ type: "prefix.digit", digit: "1" }).pending).toBeNull();
  expect(then(g, { type: "prefix.digit", digit: "x" }).pending).toEqual({ prefix: "g" });
  expect(then(n, { type: "prefix.clear" }).pending).toBeNull();
  expect(pendingText(null)).toBe("");
  // A second prefix replaces the first.
  expect(then(g, { type: "prefix.press", prefix: "v" }).pending).toEqual({ prefix: "v" });
});

// ---------------------------------------------------------------- modes

test("review.open enters review mode on a branch with a fresh rail; review.close returns to the book where it was", () => {
  const b = book({ type: "rail.down" }, { type: "rail.down" }, { type: "content.show", content: { title: "t", body: "b" } });
  const r = then(b, { type: "review.open", branch: "draft/ch03" });
  expect(r.mode).toEqual({ kind: "review", branch: "draft/ch03" });
  expect(viewOf(r).rail.rows).toEqual([]);
  expect(r.content).toBeNull();
  expect(r.focus).toBe("rail");
  // The review's own rail and cursor, apart from the book's.
  const changes: RailRow[] = [{ id: "c1", depth: 0 }, { id: "c2", depth: 0 }];
  const moved = then(r, { type: "rail.loaded", rows: changes }, { type: "rail.down" });
  expect(at(moved)).toBe("c2");
  expect(railRow(moved.book.rail)?.id).toBe("acts");
  const closed = then(moved, { type: "review.close" });
  expect(closed.mode).toEqual({ kind: "book" });
  expect(at(closed)).toBe("acts");
  expect(ids(closed)).toEqual(ids(b));
  // Closing in book mode changes nothing.
  expect(then(b, { type: "review.close" })).toBe(b);
});

test("Esc backs out one thing at a time: the prefix, full-screen, content focus, the content, then the review", () => {
  const deep = after(
    { type: "review.open", branch: "revise/ab12" }, { type: "content.show", content: { title: "t", body: "b" } }, { type: "focus.content" }, { type: "view.full" }, { type: "prefix.press", prefix: "a" },
  );
  const steps: State[] = [deep];
  for (let i = 0; i < 6; i++) steps.push(reduce(steps[steps.length - 1]!, { type: "escape" }));
  expect(steps[1]!.pending).toBeNull();
  expect(steps[1]!.full).toBe(true);
  expect(steps[2]!.full).toBe(false);
  expect(steps[2]!.focus).toBe("content");
  expect(steps[3]!.focus).toBe("rail");
  expect(steps[3]!.content).not.toBeNull();
  expect(steps[4]!.content).toBeNull();
  expect(steps[4]!.mode.kind).toBe("review");
  expect(steps[5]!.mode).toEqual({ kind: "book" });
  // With nothing open, Esc is nothing.
  expect(steps[6]).toBe(steps[5]);
});

// ---------------------------------------------------------------- settings

const settings = () => openSettings(DEFAULT_KEYMAP, "", "/tmp/none.json");

test("settings.open is a mode over the place it came from; settings.close returns there with that place's cursors", () => {
  const s = book({ type: "rail.down" }, { type: "rail.down" });
  const open = then(s, { type: "settings.open", settings: settings() });
  expect(open.mode).toEqual({ kind: "settings", from: { kind: "book" } });
  expect(open.settings).not.toBeNull();
  expect(at(open)).toBe("acts"); // the book's rail is still the view
  const closed = then(open, { type: "settings.close" });
  expect(closed.mode).toEqual({ kind: "book" });
  expect(closed.settings).toBeNull();
  expect(at(closed)).toBe("acts");
  // From a review, back to that review.
  const rev = then(after({ type: "review.open", branch: "draft/ch02" }), { type: "settings.open", settings: settings() }, { type: "settings.close" });
  expect(rev.mode).toEqual({ kind: "review", branch: "draft/ch02" });
});

test("settings: Esc and the review and prefix actions leave it alone; settings.set only applies inside it; close can carry a save", () => {
  const open = after({ type: "settings.open", settings: settings() });
  expect(then(open, { type: "escape" })).toBe(open);
  expect(then(open, { type: "review.open", branch: "x" })).toBe(open);
  expect(then(open, { type: "settings.open", settings: settings() })).toBe(open);
  const idle = initialState();
  expect(then(idle, { type: "settings.set", settings: settings() })).toBe(idle);
  expect(then(idle, { type: "settings.close" })).toBe(idle);
  const saved = { overrides: { "rail.down": { primary: "n", secondary: "" } }, editor: "hx" };
  expect(then(open, { type: "settings.close", saved }).saved).toEqual(saved);
});

test("rail.open on a branch row of the book opens that branch as a review; elsewhere it is rail.expand", () => {
  const rows = [...ROWS, { id: "branches", depth: 0, group: true }, { id: "branch:draft/ch03", depth: 1 }];
  let s = then(initialState(), { type: "rail.loaded", rows });
  // On a stage, Enter enters the main pane like →.
  expect(then(s, { type: "rail.open" }).pane).toBe("main");
  expect(then(s, { type: "rail.open" }).mode.kind).toBe("book");
  while (at(s) !== "branch:draft/ch03") s = then(s, { type: "rail.down" });
  const r = then(s, { type: "rail.open" });
  expect(r.mode).toEqual({ kind: "review", branch: "draft/ch03" });
  expect(viewOf(r).rail.rows).toEqual([]);
  // Esc returns to the book on the same row.
  const back = then(r, { type: "escape" });
  expect(back.mode).toEqual({ kind: "book" });
  expect(at(back)).toBe("branch:draft/ch03");
  // Inside a review a row that happens to look like a branch row opens nothing.
  const inside = then(r, { type: "rail.loaded", rows: [{ id: "branch:x", depth: 0 }] }, { type: "rail.open" });
  expect(inside.mode).toEqual({ kind: "review", branch: "draft/ch03" });
});

// ---------------------------------------------------------------- accept and reject (AGT-1539)

const CHANGES: readonly RailRow[] = [{ id: "file:a.md", depth: 0, group: true }, { id: "edit:0", depth: 1 }, { id: "edit:1", depth: 1 }, { id: "edit:2", depth: 1 }];
const review = (...actions: Action[]) => after({ type: "review.open", branch: "draft/ch01" }, { type: "rail.loaded", rows: CHANGES }, ...actions);

test("review.mark sets the mark on the change under the cursor; the same mark again clears it, the other changes it", () => {
  let s = review({ type: "rail.down" });
  expect(at(s)).toBe("edit:0");
  s = then(s, { type: "review.mark", mark: "accepted" });
  expect(s.marks).toEqual({ "edit:0": "accepted" });
  s = then(s, { type: "review.mark", mark: "rejected" });
  expect(s.marks).toEqual({ "edit:0": "rejected" });
  s = then(s, { type: "review.mark", mark: "rejected" });
  expect(s.marks).toEqual({});
});

test("review.mark does nothing on a file row, in a book, or under settings; marks are per change and reset on open and close", () => {
  const onFile = review();
  expect(then(onFile, { type: "review.mark", mark: "accepted" })).toBe(onFile);
  const b = book({ type: "rail.down" });
  expect(then(b, { type: "review.mark", mark: "accepted" })).toBe(b);
  const marked = review({ type: "rail.down" }, { type: "review.mark", mark: "accepted" }, { type: "rail.down" }, { type: "review.mark", mark: "rejected" });
  expect(marked.marks).toEqual({ "edit:0": "accepted", "edit:1": "rejected" });
  expect(reviewCounts(marked)).toEqual({ accepted: 1, rejected: 1, pending: 1 });
  expect(then(marked, { type: "review.close" }).marks).toEqual({});
  expect(then(marked, { type: "review.close" }, { type: "review.open", branch: "draft/ch01" }).marks).toEqual({});
  expect(reviewCounts(b)).toEqual({ accepted: 0, rejected: 0, pending: 0 });
});

test("finish.start shows the merge in progress; finish.done closes the review, shows the result and retires the branch; finish.failed stays in the review", () => {
  const started = review({ type: "finish.start", branch: "draft/ch01" });
  expect(started.finishing).toBe("draft/ch01");
  expect(started.content?.title).toBe("Finishing draft/ch01");
  expect(then(started, { type: "finish.start", branch: "draft/ch01" })).toBe(started); // one at a time
  const done = then(started, { type: "finish.done", branch: "draft/ch01", lines: ["merged draft/ch01 into main (abc1234)", "outline: ran"] });
  expect(done.mode.kind).toBe("book");
  expect(done.finishing).toBeNull();
  expect(done.finished).toEqual(["draft/ch01"]);
  expect(done.content).toMatchObject({ title: "Finished draft/ch01", body: "merged draft/ch01 into main (abc1234)\noutline: ran" });
  const failed = then(started, { type: "finish.failed", message: "conflict" });
  expect(failed.mode).toEqual({ kind: "review", branch: "draft/ch01" });
  expect(failed.finishing).toBeNull();
  expect(failed.content).toMatchObject({ title: "Not finished", body: "conflict" });
  // Outside a review a finish does not start; a done with nothing finishing changes nothing.
  const b = book();
  expect(then(b, { type: "finish.start", branch: "x" })).toBe(b);
  expect(then(b, { type: "finish.done", branch: "x", lines: [] })).toBe(b);
});
