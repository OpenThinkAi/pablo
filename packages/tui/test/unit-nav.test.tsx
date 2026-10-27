// Next and previous unit inside the editing pane (AGT-2174, D-18): `g n` / `g p` autosave the unit through the Ctrl+S
// save path, open the neighbour's file and storage from the rail's unit rows (across outputs), and put each unit's cursor
// back within the session. Fake sessions: no git, no model; the TUI is only rendered by ink-testing-library.

import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { bookRail, type BookStage, type UnitRef } from "../src/book";
import type { PaneSession } from "../src/edit-pane";
import type { AutosaveClock } from "../src/autosave";
import { adjacentUnit, clampCursor, unitStops } from "../src/unit-nav";
import { initialState, reduce } from "../src/state";

afterEach(() => cleanup());
const plain = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = "\x1b[B", RIGHT = "\x1b[C", ESC = "\x1b", CTRL_S = "\x13";

const STAGES: BookStage[] = [
  { id: "premise", name: "premise", depth: 0, status: "ready", missing: [] },
  { id: "chapter:1", name: "1 Cold Open", depth: 0, status: "drafted", missing: [], file: "chapters/01.md", storage: "sentences" },
  { id: "chapter:2", name: "2 Thaw", depth: 0, status: "drafted", missing: [], file: "chapters/02.md", storage: "sentences" },
  { id: "chapter:3", name: "3 Undrafted", depth: 0, status: "ready", missing: [] },
  { id: "radio:1", name: "radio 1", depth: 1, status: "drafted", missing: [], output: "radio", unit: 1, file: "outputs/radio/01.md", storage: "lines" },
];
const FILES = (): Record<string, string> => ({
  "chapters/01.md": "---\nchapter: 1\n---\n\nThe well was dry.\n\nNobody came.\n",
  "chapters/02.md": "---\nchapter: 2\n---\n\nThe ice broke.\n\nEdwin ran.\n",
  "outputs/radio/01.md": "---\nunit: 1\n---\n\nNARRATOR: Cold.\nEDWIN: Who is there?\n",
});

function fakeSession(files: Record<string, string>) {
  const log = { opened: [] as string[], saved: [] as { file: string; text: string }[], closed: [] as string[] };
  const session: PaneSession = {
    open: async (file) => { log.opened.push(file); return { ok: true, branch: "edit/ab12cd", text: files[file]!, ...(log.opened.length > 1 ? { unmerged: 1 } : {}) }; },
    save: async (file, b, text) => { log.saved.push({ file, text }); files[file] = text; return { ok: true, branch: b, lines: ["committed"] }; },
    close: async (b) => { log.closed.push(b); },
  };
  return { session, log };
}
const clock: AutosaveClock = { set: () => 0, clear: () => undefined };

function mount(files: Record<string, string>, session: PaneSession) {
  const load = (id: string, u?: UnitRef) => (u ? { title: u.file, text: files[u.file] ?? "", file: u.file, editable: u.file, storage: u.storage } : { title: id, text: "not a file" });
  return render(<App title="Ice House" format="novel" book={bookRail(STAGES)} load={load} paneSession={session} autosave={{ clock }} editor="vim" size={{ cols: 110, rows: 32 }} />);
}
async function keys(app: ReturnType<typeof mount>, ...ks: string[]) { for (const k of ks) { app.stdin.write(k); await sleep(15); } await sleep(30); }
async function openPane(app: ReturnType<typeof mount>, row: number) {
  for (let i = 0; i < row; i++) { app.stdin.write(DOWN); await sleep(15); }
  app.stdin.write(RIGHT); await sleep(20);
  await keys(app, "v", "e"); await sleep(40);
}

test("unitStops and adjacentUnit: drafted unit rows in rail order across outputs, no wrap, null for a file off the rail", () => {
  const rail = bookRail(STAGES);
  expect(unitStops(rail).map((u) => u.id)).toEqual(["chapter:1", "chapter:2", "radio:1"]);
  expect(adjacentUnit(rail, "chapters/01.md", 1)).toMatchObject({ id: "chapter:2", file: "chapters/02.md", storage: "sentences" });
  expect(adjacentUnit(rail, "chapters/02.md", 1)).toMatchObject({ id: "radio:1", storage: "lines" });
  expect(adjacentUnit(rail, "outputs/radio/01.md", -1)?.id).toBe("chapter:2");
  expect(adjacentUnit(rail, "chapters/01.md", -1)).toBeNull();
  expect(adjacentUnit(rail, "outputs/radio/01.md", 1)).toBeNull();
  expect(adjacentUnit(rail, "notes/x.md", 1)).toBeNull();
});

test("clampCursor keeps a remembered cursor inside the text as it is now", () => {
  expect(clampCursor(["ab", "cde"], { row: 9, col: 9 })).toEqual({ row: 1, col: 3 });
  expect(clampCursor(["ab"], { row: 0, col: 1 })).toEqual({ row: 0, col: 1 });
});

test("pane.unit on a clean pane moves at once; on a dirty one it saves first (the autosave path) and moves when the commit lands", () => {
  const rows = STAGES.map((s) => ({ id: s.id, depth: s.depth }));
  const open = reduce(reduce(reduce(initialState(), { type: "rail.loaded", rows }), { type: "pane.open", file: "chapters/01.md", storage: "sentences", line: 1 }), { type: "pane.opened", branch: "edit/ab12cd", text: { dirty: false, empty: false, cursor: { row: 2, col: 1 } } });
  const to = { file: "chapters/02.md", storage: "sentences", row: "chapter:2" };
  const clean = reduce(open, { type: "pane.unit", to });
  expect(clean.editPane).toMatchObject({ file: "chapters/02.md", phase: "opening", branch: "edit/ab12cd", moved: true });
  expect(clean.paneCursors["chapters/01.md"]).toEqual({ row: 2, col: 1 });
  expect(clean.book.rail.rows[clean.book.rail.cursor]!.id).toBe("chapter:2");

  const dirty = reduce(open, { type: "pane.edit", edit: (t) => ({ ...t, dirty: true }) });
  const saving = reduce(dirty, { type: "pane.unit", to });
  expect(saving.editPane).toMatchObject({ file: "chapters/01.md", phase: "saving", auto: true, saveSeq: 1, next: to });
  const landed = reduce(saving, { type: "pane.saved", branch: "edit/ab12cd", lines: ["c"], edit: (t) => ({ ...t, dirty: false }) });
  expect(landed.editPane).toMatchObject({ file: "chapters/02.md", phase: "opening" });
  // A failed save stays on the unit, edits kept.
  const failed = reduce(saving, { type: "pane.save_failed", message: "no" });
  expect(failed.editPane).toMatchObject({ file: "chapters/01.md", phase: "open", next: null });
  // Typing while the save ran: stay put.
  const typed = reduce(saving, { type: "pane.saved", branch: "edit/ab12cd", lines: ["c"], edit: (t) => ({ ...t, dirty: true }) });
  expect(typed.editPane).toMatchObject({ file: "chapters/01.md", phase: "open", next: null });
  // A blank body is not autosaved: asks instead of moving.
  const blank = reduce(open, { type: "pane.edit", edit: (t) => ({ ...t, dirty: true, empty: true }) });
  expect(reduce(blank, { type: "pane.unit", to }).editPane).toMatchObject({ file: "chapters/01.md", phase: "open" });
  // Closing keeps the cursor too.
  expect(reduce(open, { type: "pane.close" }).paneCursors["chapters/01.md"]).toEqual({ row: 2, col: 1 });
});

test("g n saves the unit, opens the next one in the same pane, and g p comes back with the cursor where it was", async () => {
  const files = FILES();
  const fake = fakeSession(files);
  const app = mount(files, fake.session);
  await sleep(30);
  await openPane(app, 1);
  await keys(app, "w"); // normal mode: the cursor to the word "dry"
  await keys(app, "i", "X", ESC); // an edit, then back to normal
  await keys(app, "g", "n");
  await sleep(60);
  expect(fake.log.saved.map((s) => s.file)).toEqual(["chapters/01.md"]);
  expect(fake.log.saved[0]!.text).toContain("The Xwell was dry.");
  expect(fake.log.opened).toEqual(["chapters/01.md", "chapters/02.md"]);
  expect(plain(app.lastFrame())).toContain("chapters/02.md");
  expect(plain(app.lastFrame())).toContain("The ice broke.");
  expect(plain(app.lastFrame())).not.toContain("Resuming"); // moving is not resuming an earlier session's branch
  // Into the radio script (lines storage, another output), then back two units.
  await keys(app, "g", "n"); await sleep(60);
  expect(plain(app.lastFrame())).toContain("EDWIN: Who is there?");
  expect(fake.log.saved.length).toBe(1); // clean: nothing to save
  await keys(app, "g", "n"); await sleep(30); // the last unit: nowhere to go
  expect(plain(app.lastFrame())).toContain("No next unit.");
  await keys(app, "g", "p", "g", "p"); await sleep(60);
  expect(plain(app.lastFrame())).toContain("chapters/01.md");
  await keys(app, "i", "Z"); // the cursor is where it was left (after the X)
  expect(plain(app.lastFrame())).toContain("The XZwell was dry.");
  app.unmount();
});

test("the registers go with the pane to the next unit, so a yank pastes there; a search prompt open takes g n as text, not a move", async () => {
  const files = FILES();
  const fake = fakeSession(files);
  const app = mount(files, fake.session);
  await sleep(30);
  await openPane(app, 1);
  await keys(app, "x"); // deletes "T" into the register
  await keys(app, "/"); // the search prompt takes every key
  await keys(app, "g", "n");
  expect(fake.log.opened).toEqual(["chapters/01.md"]); // no switch
  expect(plain(app.lastFrame())).toContain("gn");
  await keys(app, ESC);
  await keys(app, "g", "n"); await sleep(60);
  expect(fake.log.opened).toEqual(["chapters/01.md", "chapters/02.md"]);
  await keys(app, "P"); // paste before the cursor: the "T" from the other unit
  expect(plain(app.lastFrame())).toContain("TThe ice broke.");
  app.unmount();
});
