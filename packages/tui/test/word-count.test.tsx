// The editor's live word count and per-unit / per-work targets (AGT-2175, D-18). The pure parts, then the status line
// with the pane open over a fake session and an in-memory target store (no git, no model).

import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { bookRail, type BookStage } from "../src/book";
import { openText } from "../src/edit-pane";
import type { PaneSession } from "../src/edit-pane";
import { fitFields, statusFields } from "../src/status";
import { otherWords, parseTarget, paneWords, progressText, readTargets, withTarget, wordsValue, type TargetStore, type Targets } from "../src/word-count";

afterEach(() => cleanup());
const plain = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = "\x1b[B", RIGHT = "\x1b[C", ESC = "\x1b", ENTER = "\r", CTRL_G = "\x07", BACKSPACE = "\x7f";

const CHAPTER = ["---", "chapter: 1", "words: 99", "---", "", "The well was dry.", "Nobody came.", "", "Edwin stood in the doorway.", ""].join("\n");
// 4 + 2 + 5 body words; the frontmatter's tokens do not count.
const BODY_WORDS = 4 + 2 + 5;

test("parseTarget: a bare number is this unit's, `w N` the work's, 0 or clear removes; anything else is refused", () => {
  expect(parseTarget("600")).toEqual({ ok: true, scope: "unit", words: 600 });
  expect(parseTarget("w 80,000")).toEqual({ ok: true, scope: "work", words: 80000 });
  expect(parseTarget("work 5000")).toEqual({ ok: true, scope: "work", words: 5000 });
  expect(parseTarget("0")).toEqual({ ok: true, scope: "unit", words: null });
  expect(parseTarget("w clear")).toEqual({ ok: true, scope: "work", words: null });
  expect(parseTarget("lots").ok).toBe(false);
  expect(parseTarget("").ok).toBe(false);
  expect(parseTarget("-5").ok).toBe(false);
});

test("withTarget sets and clears a unit's or the work's target without touching the other; readTargets keeps only positive integers", () => {
  let t: Targets = { outputs: {}, units: {} };
  t = withTarget(t, "unit", "a.md", 500);
  t = withTarget(t, "work", "a.md", 9000, "novel");
  expect(t).toEqual({ outputs: { novel: 9000 }, units: { "a.md": 500 } });
  t = withTarget(t, "unit", "a.md", null);
  expect(t).toEqual({ outputs: { novel: 9000 }, units: {} });
  expect(withTarget(t, "work", "a.md", null, "novel")).toEqual({ outputs: {}, units: {} });
  expect(readTargets({ outputs: { novel: 10, radio: -2 }, units: { a: 5, b: -1, c: "x", d: 1.5 } })).toEqual({ outputs: { novel: 10 }, units: { a: 5 } });
  expect(readTargets("junk")).toEqual({ outputs: {}, units: {} });
});

test("wordsValue: the count, then each target's progress; the work's total counts the other units plus the live one", () => {
  expect(progressText(412, 500)).toBe("412/500 · 82%");
  expect(wordsValue(1, { outputs: {}, units: {} }, "a.md", 0)).toBe("1 word");
  expect(wordsValue(412, { outputs: { novel: 1000 }, units: { "a.md": 500 } }, "a.md", 188, "novel")).toBe("412 words · unit 412/500 · 82% · novel 600/1000 · 60%");
  const book = bookRail([
    { id: "unit:radio:1", name: "1", depth: 1, output: "radio", unit: 1, status: "drafted", missing: [], words: 100 },
    { id: "unit:radio:2", name: "2", depth: 1, output: "radio", unit: 2, status: "drafted", missing: [], words: 50 },
    { id: "chapter:1", name: "1", depth: 1, output: "novel", unit: 1, status: "drafted", missing: [], words: 7000 },
  ]);
  expect(otherWords(book, "unit:radio:1")).toBe(50);
  expect(otherWords(undefined, "x")).toBe(0);
});

test("the count is of the body only, so the editor's number is the saved file's (core's fileWords)", () => {
  expect(paneWords(openText(CHAPTER, "sentences", 6))).toBe(BODY_WORDS);
});

test("the words field leaves a narrow status line last, before the progress", () => {
  const fields = statusFields({ format: "novel", drafted: 1, total: 2, branch: "main", comments: {}, words: { value: "10 words" } });
  expect(fitFields(fields, 200).map((f) => f.key)).toContain("words");
  expect(fitFields(fields, 20).map((f) => f.key)).toEqual(["progress"]);
});

const STAGES: BookStage[] = [
  { id: "premise", name: "premise", depth: 0, status: "ready", missing: [] },
  { id: "chapter:1", name: "1 Cold Open", depth: 0, status: "ready", missing: [] },
  { id: "chapter:2", name: "2 Two", depth: 0, status: "ready", missing: [] },
];
STAGES[1] = { ...STAGES[1]!, output: "novel", unit: 1, words: BODY_WORDS };
STAGES[2] = { ...STAGES[2]!, output: "novel", unit: 2, words: 100 };
const load = (id: string) => (id === "chapter:1" ? { title: "chapters/01-cold-open.md", text: CHAPTER, file: "chapters/01-cold-open.md", editable: "chapters/01-cold-open.md" } : { title: "x", text: "not a file" });

function mount(store: TargetStore) {
  const files: Record<string, string> = { "chapters/01-cold-open.md": CHAPTER };
  const session: PaneSession = {
    open: async (file) => ({ ok: true, branch: "edit/ab12cd", text: files[file]! }),
    save: async (file, b, text) => { files[file] = text; return { ok: true, branch: b, lines: ["saved"] }; },
    close: async () => {},
  };
  return render(<App title="Ice House" format="novel" book={bookRail(STAGES)} load={load} paneSession={session} targetStore={store} editor="vim" size={{ cols: 130, rows: 32 }} />);
}
async function keys(app: ReturnType<typeof mount>, ...ks: string[]) { for (const k of ks) { app.stdin.write(k); await sleep(15); } await sleep(20); }
const status = (app: ReturnType<typeof mount>) => plain(app.lastFrame()).split("\n").slice(0, 4).join("\n");

test("the status line shows the live count while editing and follows every keystroke; a target's progress shows and persists", async () => {
  let saved: unknown;
  const store: TargetStore = { load: () => undefined, save: (t) => { saved = t; } };
  const app = mount(store);
  await sleep(30);
  expect(status(app)).not.toContain("words");
  await keys(app, DOWN, RIGHT); // chapter 1, into the main pane
  await keys(app, "v", "e"); await sleep(30);
  expect(status(app)).toContain(`${BODY_WORDS} words`);
  await keys(app, "i", "\x1b[F", " ", "o", "n", "e", " ", "t", "w", "o");
  expect(status(app)).toContain(`${BODY_WORDS + 2} words`);
  await keys(app, BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE);
  expect(status(app)).toContain(`${BODY_WORDS + 1} words`);

  // Ctrl+G (the `edit.target` row): the prompt holds the keys (nothing typed reaches the text), Enter sets the unit's target.
  await keys(app, CTRL_G, "5", "0", "0");
  expect(status(app)).toContain("target");
  expect(status(app)).toContain("› 500");
  await keys(app, ENTER);
  expect(status(app)).toContain(`${BODY_WORDS + 1} words · unit ${BODY_WORDS + 1}/500`);
  expect(saved).toEqual({ outputs: {}, units: { "chapters/01-cold-open.md": 500 } });
  expect(plain(app.lastFrame()).split("\n").slice(4).join("\n")).not.toContain("500"); // the typed digits never reached the text
  // The work's target counts the other chapters (100 words) plus the live one.
  await keys(app, CTRL_G, "w", " ", "1", "0", "0", "0", ENTER);
  expect(status(app)).toContain(`novel ${100 + BODY_WORDS + 1}/1000`);
  expect(saved).toEqual({ outputs: { novel: 1000 }, units: { "chapters/01-cold-open.md": 500 } });
  // Esc cancels a prompt without closing the pane; 0 clears.
  await keys(app, CTRL_G, "9", ESC);
  expect(status(app)).not.toContain("target (");
  expect(plain(app.lastFrame())).toContain("chapters/01-cold-open.md");
  await keys(app, CTRL_G, "0", ENTER);
  expect(status(app)).not.toContain("unit ");
  expect(saved).toEqual({ outputs: { novel: 1000 }, units: {} });
});

test("targets saved earlier are read when the editor opens", async () => {
  const store: TargetStore = { load: () => ({ units: { "chapters/01-cold-open.md": 40 } }), save: () => {} };
  const app = mount(store);
  await sleep(30);
  await keys(app, DOWN, RIGHT);
  await keys(app, "v", "e"); await sleep(30);
  expect(status(app)).toContain(`${BODY_WORDS} words · unit ${BODY_WORDS}/40 · ${Math.round((BODY_WORDS / 40) * 100)}%`);
});

test("a target that will not save is said on the status line and the session keeps it", async () => {
  const store: TargetStore = { load: () => undefined, save: () => { throw new Error("read-only"); } };
  const app = mount(store);
  await sleep(30);
  await keys(app, DOWN, RIGHT);
  await keys(app, "v", "e"); await sleep(30);
  await keys(app, CTRL_G, "7", ENTER);
  expect(status(app)).toContain("target not saved: read-only");
  expect(status(app)).toContain("unit ");
});

test("the target prompt and the search prompt are never open together", async () => {
  const app = mount({ load: () => undefined, save: () => {} });
  await sleep(30);
  await keys(app, DOWN, RIGHT);
  await keys(app, "v", "e"); await sleep(30);
  await keys(app, "/", CTRL_G); // search prompt open: Ctrl+G is just a key it ignores
  expect(status(app)).not.toContain("target (");
  await keys(app, ESC); await sleep(60); await keys(app, CTRL_G); // search closed: now the target prompt opens, and "/" is typed into it, not a search
  expect(status(app)).toContain("target (");
  await keys(app, "/");
  expect(status(app)).toContain("› /");
});
