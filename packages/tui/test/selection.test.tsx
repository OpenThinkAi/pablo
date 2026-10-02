// Selecting sentences in the main pane: the pieces of a line to highlight, and what a command acting on the selection receives.

import { expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { displayDoc } from "../src/document";
import { mainPane } from "../src/hits";
import { piecesOf, selectedOf } from "../src/selection";
import { initialState, reduce, viewOf, type Action, type State } from "../src/state";

/** The display lines with their sentence marks, as the pane draws them. */
const paneOf = (text: string, width: number) => {
  const d = displayDoc(text, width);
  return { lines: d.lines.map((t, i) => ({ text: t, marks: d.marks[i]! })), sentences: d.sentences };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FILE = "---\nstatus: draft\n---\n\nThe well had been dry since June.\nShe did not look up.\n\nEdwin stood in the doorway.";

const run = (...actions: Action[]): State => actions.reduce(reduce, initialState());

/** A state with the main pane holding `FILE` at `width`, in the main pane with the cursor on line 0. */
function loaded(width = 80, ...more: Action[]): State {
  const pane = paneOf(FILE, width);
  return run({ type: "rail.loaded", rows: [{ id: "ch1", depth: 0 }] }, { type: "main.loaded", lines: pane.lines.length, sentences: pane.sentences, doc: "ch1" },
    { type: "measured", measure: { main: 10 } }, { type: "rail.expand" }, ...more);
}
const main = (s: State) => viewOf(s).main;

test("the first ⇧↓ selects the sentence under the cursor; each further press extends by a whole sentence; the ends hold", () => {
  let s = loaded();
  expect(main(s).selection).toBeNull();
  s = reduce(s, { type: "select.down" });
  expect(main(s).selection).toEqual({ anchor: 0, head: 0 });
  s = reduce(s, { type: "select.down" });
  expect(main(s).selection).toEqual({ anchor: 0, head: 1 });
  s = reduce(reduce(s, { type: "select.down" }), { type: "select.down" });
  expect(main(s).selection).toEqual({ anchor: 0, head: 2 }); // three sentences in the document
});

test("⇧↑ shrinks a selection back toward its anchor and extends past it the other way", () => {
  let s = loaded(80, { type: "select.down" }, { type: "select.down" }); // 0..1
  s = reduce(s, { type: "select.up" });
  expect(main(s).selection).toEqual({ anchor: 0, head: 0 });
  s = reduce(s, { type: "select.up" }); // already at the first sentence: holds
  expect(main(s).selection).toEqual({ anchor: 0, head: 0 });
  const down = loaded(80, { type: "main.end" }, { type: "select.up" });
  expect(main(down).selection).toEqual({ anchor: 2, head: 2 });
  expect(main(reduce(down, { type: "select.up" })).selection).toEqual({ anchor: 2, head: 1 });
});

test("the cursor follows the head, so a long selection scrolls into view", () => {
  const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i + 1}.`).join("\n");
  const pane = paneOf(long, 80); // one wrapped paragraph
  let s = run({ type: "rail.loaded", rows: [{ id: "a", depth: 0 }] }, { type: "main.loaded", lines: pane.lines.length, sentences: pane.sentences, doc: "a" }, { type: "measured", measure: { main: 2 } });
  expect(pane.lines.length).toBeGreaterThan(4);
  for (let i = 0; i < 20; i++) s = reduce(s, { type: "select.down" });
  const m = main(s);
  expect(m.cursor).toBe(pane.sentences[m.selection!.head]!.first);
  expect(m.cursor).toBeGreaterThanOrEqual(m.scroll);
  expect(m.cursor).toBeLessThan(m.scroll + m.visible);
});

test("Esc clears the selection before it backs out of anything else; a plain move keeps it; select.clear is a no-op with none", () => {
  const s = loaded(80, { type: "select.down" }, { type: "select.down" }, { type: "content.show", content: { title: "t", body: "b" } });
  expect(main(reduce(s, { type: "main.down" })).selection).not.toBeNull();
  const esc = reduce(s, { type: "escape" });
  expect(main(esc).selection).toBeNull();
  expect(esc.content).not.toBeNull(); // the content area is still open: one thing at a time
  expect(reduce(esc, { type: "escape" }).content).toBeNull();
  expect(reduce(esc, { type: "select.clear" })).toEqual(esc);
});

test("the selection survives a rewrap of the same document, and is dropped by a different document or a different sentence count", () => {
  const s = loaded(80, { type: "select.down" }, { type: "select.down" });
  const narrow = paneOf(FILE, 20);
  const rewrapped = reduce(s, { type: "main.loaded", lines: narrow.lines.length, sentences: narrow.sentences, doc: "ch1" });
  expect(main(rewrapped).selection).toEqual({ anchor: 0, head: 1 });
  expect(main(reduce(s, { type: "main.loaded", lines: 3, sentences: narrow.sentences, doc: "ch2" })).selection).toBeNull();
  expect(main(reduce(s, { type: "main.loaded", lines: 1, sentences: narrow.sentences.slice(0, 1), doc: "ch1" })).selection).toBeNull();
});

test("a pane with no sentences (lines handed in as text) has nothing to select", () => {
  const s = run({ type: "main.loaded", lines: 3 }, { type: "select.down" });
  expect(main(s).selection).toBeNull();
});

test("piecesOf cuts a line at the edges of the selected sentences", () => {
  const pane = paneOf("The well had been dry since June. She did not look up.", 20);
  const line = pane.lines[1]!; // "dry since June. She"
  expect(piecesOf(line, null)).toEqual([{ text: "dry since June. She", selected: false }]);
  expect(piecesOf(line, { first: 1, last: 1 })).toEqual([{ text: "dry since June. ", selected: false }, { text: "She", selected: true }]);
  expect(piecesOf(line, { first: 0, last: 1 })).toEqual([{ text: "dry since June.", selected: true }, { text: " ", selected: false }, { text: "She", selected: true }]);
  expect(piecesOf(pane.lines[0]!, { first: 1, last: 1 }).every((p) => !p.selected)).toBe(true);
});

test("selectedOf: the selected sentences and the stored lines they span, across paragraphs; null with no selection", () => {
  const pane = paneOf(FILE, 80);
  expect(selectedOf(main(loaded()), pane.sentences)).toBeNull();
  const two = selectedOf(main(loaded(80, { type: "select.down" }, { type: "select.down" })), pane.sentences);
  expect(two).toEqual({ sentences: ["The well had been dry since June.", "She did not look up."], stored: { from: 4, to: 5 } });
  const all = selectedOf(main(loaded(80, { type: "select.down" }, { type: "select.down" }, { type: "select.down" })), pane.sentences);
  expect(all!.stored).toEqual({ from: 4, to: 7 });
});

test("on the screen: ⇧↓ marks the selected lines, `a v` hands the selection to onCommand, Esc clears it", async () => {
  cleanup();
  const calls: unknown[] = [];
  const app = render(<App title="T" format="novel" rows={[{ id: "ch1", depth: 0 }]} labels={{ ch1: "ch 1" }} load={() => ({ title: "chapters/01.md", text: FILE })} onCommand={(c, sel) => calls.push([c.id, sel])} size={{ cols: 100, rows: 28 }} />);
  await sleep(30);
  app.stdin.write("\x1b[C"); await sleep(30); // → into the main pane
  expect(app.lastFrame()).not.toContain("▌");
  app.stdin.write("\x1b[1;2B"); await sleep(30); // ⇧↓
  app.stdin.write("\x1b[1;2B"); await sleep(30);
  expect(app.lastFrame()).toContain("▌");
  app.stdin.write("a"); await sleep(20); app.stdin.write("v"); await sleep(30);
  expect(calls).toEqual([["ai.voice", { sentences: ["The well had been dry since June.", "She did not look up."], stored: { from: 4, to: 5 } }]]);
  app.stdin.write("\x1b"); await sleep(40);
  expect(app.lastFrame()).not.toContain("▌");
  cleanup();
});

test("check boxes between lines are never sentences: the spans are in rows, a box inside a sentence's span is not selectable on its own", () => {
  const text = "The well had been dry since June. She did not look up.\n\nEdwin stood in the doorway.";
  const hit = { line: 1, rule: "flagged-line", excerpt: "The well", detail: undefined } as never;
  const { rows, sentences } = mainPane(text, 80, [hit]);
  const boxAt = rows.findIndex((r) => r.kind === "box");
  expect(boxAt).toBe(1);
  // the paragraph's two sentences share row 0; the box (rows 1-3) is in neither; the blank row 4, the next paragraph at 5
  expect(sentences.map((x) => [x.first, x.last])).toEqual([[0, 0], [0, 0], [boxAt + 4, boxAt + 4]]);
  expect(rows[sentences[2]!.first]).toMatchObject({ kind: "text", text: "Edwin stood in the doorway." });
  expect(rows.filter((r) => r.kind === "box").every((r) => !("marks" in r))).toBe(true);
});
