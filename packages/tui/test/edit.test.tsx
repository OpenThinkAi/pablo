// `v e` opens the editor at the cursor's file line on an edit branch (the CLI's session, passed in); `v s` saves it
// through the finisher with nothing rejected (AGT-1545). Fake sessions: no editor is ever launched.

import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { bookRail, type BookStage } from "../src/book";
import { fileLineAt } from "../src/document";
import { mainRows } from "../src/hits";
import type { EditRequest, EditResult, Finisher } from "../src/screen";

afterEach(() => cleanup());
const plain = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = "\x1b[B", RIGHT = "\x1b[C";

const STAGES: BookStage[] = [
  { id: "premise", name: "premise", depth: 0, status: "ready", missing: [] },
  { id: "chapter:1", name: "1 Cold Open", depth: 0, status: "ready", missing: [] },
];
const CHAPTER = ["---", "chapter: 1", "---", "", "The well was dry.", "Nobody came.", "", "Edwin stood in the doorway.", ""].join("\n");
const load = (id: string) => (id === "chapter:1" ? { title: "chapters/01-cold-open.md", text: CHAPTER, file: "chapters/01-cold-open.md", editable: "chapters/01-cold-open.md" } : { title: "x", text: "not a file" });

test("fileLineAt: the cursor's display row is the file line whose sentence ends there, frontmatter counted", () => {
  const rows = mainRows(CHAPTER, 60, []);
  expect(rows.map((r) => (r.kind === "text" ? r.text : "box"))).toEqual(["The well was dry. Nobody came.", "", "Edwin stood in the doorway."]);
  expect(fileLineAt(CHAPTER, 60, rows, 0)).toBe(5); // the paragraph's first sentence line (its row ends where line 5's text ends)
  expect(fileLineAt(CHAPTER, 60, rows, 2)).toBe(8);
});

test("fileLineAt: a sentence wrapped over rows is one line; a box under a line counts as that line", () => {
  const text = "One long sentence that needs several rows to fit.\nShort.\n";
  const rows = mainRows(text, 14, []);
  expect(fileLineAt(text, 14, rows, 0)).toBe(1);
  expect(fileLineAt(text, 14, rows, 2)).toBe(1);
  expect(fileLineAt(text, 14, rows, rows.length - 1)).toBe(2);
});

function mount(opts: { session?: (r: EditRequest) => Promise<EditResult>; finisher?: Finisher }) {
  return render(<App title="Ice House" format="novel" book={bookRail(STAGES)} load={load} {...(opts.session ? { editSession: opts.session } : {})} {...(opts.finisher ? { finisher: opts.finisher } : {})} editor="vim" size={{ cols: 110, rows: 32 }} />);
}
async function toChapterMain(app: ReturnType<typeof mount>) {
  app.stdin.write(DOWN); await sleep(20);
  app.stdin.write(RIGHT); await sleep(20); // into the main pane on chapter 1
}

test("v e hands the session the file, the cursor's line and the configured editor, and shows what came of it", async () => {
  const calls: EditRequest[] = [];
  const app = mount({ session: async (r) => { calls.push(r); return { ok: true, branch: "edit/ab12cd", lines: ["committed chapters/01-cold-open.md on edit/ab12cd (1234567)"] }; } });
  await sleep(30);
  await toChapterMain(app);
  app.stdin.write("v"); await sleep(20); app.stdin.write("e"); await sleep(60);
  expect(calls).toEqual([{ file: "chapters/01-cold-open.md", line: 5, editor: "vim" }]);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("Edited on edit/ab12cd");
  expect(frame).toContain("branches to review (1)");
});

test("keys are not read while the editor has the terminal", async () => {
  let finish!: (r: EditResult) => void;
  const calls: EditRequest[] = [];
  const app = mount({ session: (r) => { calls.push(r); return new Promise<EditResult>((res) => { finish = res; }); } });
  await sleep(30);
  await toChapterMain(app);
  app.stdin.write("v"); await sleep(20); app.stdin.write("e"); await sleep(40);
  expect(plain(app.lastFrame())).toContain("Editing chapters/01-cold-open.md");
  app.stdin.write("v"); await sleep(20); app.stdin.write("e"); await sleep(40);
  expect(calls.length).toBe(1);
  finish({ ok: true, branch: null, lines: ["no change"] }); await sleep(40);
  expect(plain(app.lastFrame())).toContain("No change");
});

test("v e on a row that is not one file says so and runs no session", async () => {
  const calls: EditRequest[] = [];
  const app = mount({ session: async (r) => { calls.push(r); return { ok: true, branch: null, lines: [] }; } });
  await sleep(30);
  app.stdin.write(RIGHT); await sleep(20); // premise: a document with no file to edit
  app.stdin.write("v"); await sleep(20); app.stdin.write("e"); await sleep(40);
  expect(calls).toEqual([]);
  expect(plain(app.lastFrame())).toContain("Select a chapter or file to edit.");
});

test("v s merges the open edit branch through the finisher with nothing rejected; with no edits it says so", async () => {
  const saved: { branch: string; rejected: unknown }[] = [];
  const finisher: Finisher = async (branch, rejected) => { saved.push({ branch, rejected }); return { ok: true, lines: [`merged ${branch} into main (abcdef0)`] }; };
  const app = mount({ session: async () => ({ ok: true, branch: "edit/ab12cd", lines: ["committed"] }), finisher });
  await sleep(30);
  app.stdin.write("v"); await sleep(20); app.stdin.write("s"); await sleep(40);
  expect(saved).toEqual([]);
  expect(plain(app.lastFrame())).toContain("There are no edits to save.");
  await toChapterMain(app);
  app.stdin.write("v"); await sleep(20); app.stdin.write("e"); await sleep(60);
  app.stdin.write("v"); await sleep(20); app.stdin.write("s"); await sleep(60);
  expect(saved).toEqual([{ branch: "edit/ab12cd", rejected: { removed: [], added: [] } }]);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("Saved edit/ab12cd");
  expect(frame).not.toContain("branches to review");
});
