// AI revisions inline in the editing pane (AGT-2177, D-18): a pending revise branch's edits drawn under the text they
// change, the differing words marked, each accepted (the text takes it and it saves through the pane's save path) or
// rejected (nothing changes). A hand-written diff and a fake session: no git, no model; the TUI is only rendered by
// ink-testing-library. The git side (fixture revise branches, the edit branch) is packages/cli/test/inline-diffs.test.ts.

import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { bookRail, type BookStage } from "../src/book";
import { openText, paneRows, type EditText, type PaneSession } from "../src/edit-pane";
import { aiRows, pendingCount, shownHunks, withRevisions, type PaneRevision } from "../src/inline-diff";
import { DEFAULT_KEYMAP, rowsOf, prefixRows } from "../src/keys";
import { modalKey, modeOf } from "../src/modal";
import type { Action, Pending } from "../src/state";
import type { AutosaveClock } from "../src/autosave";
import type { EditRequest, EditResult } from "../src/screen";

afterEach(() => cleanup());
const plain = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = "\x1b[B", RIGHT = "\x1b[C";

const FILE = "chapters/01-cold-open.md";
const CHAPTER = ["---", "chapter: 1", "---", "", "The well was dry.", "Nobody came.", "", "Edwin stood in the doorway.", ""].join("\n");
const DIFF = [
  `diff --git a/novels/x/${FILE} b/novels/x/${FILE}`,
  "index 1111111..2222222 100644",
  `--- a/novels/x/${FILE}`,
  `+++ b/novels/x/${FILE}`,
  "@@ -2,7 +2,7 @@",
  " chapter: 1",
  " ---",
  " ",
  "-The well was dry.",
  "+The well was empty.",
  " Nobody came.",
  " ",
  "-Edwin stood in the doorway.",
  "+Edwin stood in the door.",
  "",
].join("\n");
const REVS: PaneRevision[] = [{ branch: "revise/r1", diff: DIFF }];
const pane = () => withRevisions(openText(CHAPTER, "sentences", 1), REVS);

/** The pane's text after `keys` through the modal keymap, and every action other than a pane edit that they dispatched. */
function run(t: EditText, keys: string[]) {
  let text = t;
  let pending: Pending | null = null;
  const other: Action[] = [];
  for (const k of keys) {
    const step = modalKey(modeOf(text), pending, k, {}, DEFAULT_KEYMAP, { width: 40, height: 10 });
    if (step === "close") throw new Error("closed");
    for (const a of step) {
      if (a.type === "pane.edit") text = a.edit(text) as EditText;
      else if (a.type === "prefix.press") pending = { prefix: a.prefix };
      else if (a.type === "prefix.clear") pending = null;
      else other.push(a);
    }
  }
  return { text, other };
}

test("each edit is drawn under its paragraph: a header, then the sentence out and the sentence in, the changed word marked", () => {
  const t = pane();
  expect(shownHunks(t).map((s) => s.row)).toEqual([0, 2]);
  const rows = paneRows(t, 40, 20, new Map(), {}, aiRows(t, 40));
  const texts = rows.map((r) => r.text);
  expect(texts).toEqual([
    "The well was dry. Nobody came.",
    "  ── AI · revise/r1 · g a accept · g r reject",
    "  - The well was dry.",
    "  + The well was empty.",
    "",
    "Edwin stood in the doorway.",
    "  ── AI · revise/r1 · g f next",
    "  - Edwin stood in the doorway.",
    "  + Edwin stood in the door.",
  ]);
  const added = rows[3]!;
  expect(added.kind === "diff" && added.color).toBe("green");
  expect(added.kind === "diff" && added.parts.filter((p) => p.hl).map((p) => p.text)).toEqual(["empty"]);
});

test("the keys are editor rows under g: next, previous, accept, reject; the key panel lists them", () => {
  const ids = prefixRows({ state: "normal" }, "g", DEFAULT_KEYMAP).map((r) => r.id);
  expect(ids).toEqual(expect.arrayContaining(["editor.ai_next", "editor.ai_prev", "editor.ai_accept", "editor.ai_reject"]));
  expect(rowsOf({ state: "insert" }, DEFAULT_KEYMAP).some((r) => r.id.startsWith("editor.ai_"))).toBe(false);
});

test("g a accepts the edit at the cursor and asks for a save; g r rejects and asks for nothing; g f / g F move between edits", () => {
  let r = run(pane(), ["g", "a"]);
  expect(r.text.buffer.text()).toBe("The well was empty. Nobody came.\n\nEdwin stood in the doorway.");
  expect(r.text.buffer.dirty).toBe(true);
  expect(r.other).toEqual([{ type: "pane.save", auto: true }]);
  expect(pendingCount(r.text)).toBe(1);
  r = run(pane(), ["g", "f"]);
  expect(r.text.buffer.cursor).toEqual({ row: 2, col: 0 });
  r = run(r.text, ["g", "F"]);
  expect(r.text.buffer.cursor).toEqual({ row: 0, col: 0 });
  r = run(pane(), ["g", "r", "g", "r"]);
  expect(pendingCount(r.text)).toBe(0);
  expect(r.text.buffer.dirty).toBe(false);
  expect(r.text.buffer.text()).toBe(openText(CHAPTER, "sentences", 1).buffer.text());
  expect(r.other).toEqual([]);
  // An accept undoes as one step.
  const undone = run(run(pane(), ["g", "a"]).text, []).text;
  undone.buffer.undo();
  expect(undone.buffer.dirty).toBe(false);
});

// ---------------------------------------------------------------- in the screen

const STAGES: BookStage[] = [
  { id: "premise", name: "premise", depth: 0, status: "ready", missing: [] },
  { id: "chapter:1", name: "1 Cold Open", depth: 0, status: "ready", missing: [] },
];
const load = (id: string) => (id === "chapter:1" ? { title: FILE, text: CHAPTER, file: FILE, editable: FILE } : { title: "x", text: "not a file" });
const noEditor = async (r: EditRequest): Promise<EditResult> => { throw new Error(`the editor was launched for ${r.file}`); };
const stillClock: AutosaveClock = { set: () => 0, clear: () => undefined };

function fakeSession() {
  const saved: string[] = [];
  const session: PaneSession = {
    open: async () => ({ ok: true, branch: "edit/ab12cd", text: CHAPTER }),
    save: async (_file, b, text) => { saved.push(text); return { ok: true, branch: b, lines: [`committed ${FILE} on ${b} (1234567)`] }; },
    close: async () => undefined,
    revisions: async () => REVS,
  };
  return { session, saved };
}

async function openPane(session: PaneSession) {
  const app = render(<App title="Ice House" format="novel" book={bookRail(STAGES)} load={load} editSession={noEditor} autosave={{ clock: stillClock }} paneSession={session} editor="vim" size={{ cols: 110, rows: 32 }} />);
  await sleep(30);
  for (const k of [DOWN, RIGHT, "v", "e"]) { app.stdin.write(k); await sleep(20); }
  await sleep(40);
  return app;
}
async function keys(app: ReturnType<typeof render>, ...ks: string[]) { for (const k of ks) { app.stdin.write(k); await sleep(20); } await sleep(30); }

test("in the screen: v e shows the pending revise branch inline; g a accepts it and saves to the edit branch", async () => {
  const fake = fakeSession();
  const app = await openPane(fake.session);
  let frame = plain(app.lastFrame());
  expect(frame).toContain("AI 2");
  expect(frame).toContain("── AI · revise/r1 · g a accept · g r reject");
  expect(frame).toContain("+ The well was empty.");
  await keys(app, "g", "a");
  await sleep(30);
  frame = plain(app.lastFrame());
  expect(frame).toContain("The well was empty. Nobody came.");
  expect(frame).toContain("AI 1");
  expect(fake.saved).toEqual([CHAPTER.replace("was dry.", "was empty.")]);
});

test("in the screen: rejecting every edit saves nothing and leaves the text", async () => {
  const fake = fakeSession();
  const app = await openPane(fake.session);
  await keys(app, "g", "r", "g", "r");
  const frame = plain(app.lastFrame());
  expect(frame).not.toContain("── AI");
  expect(frame).not.toContain("[+]");
  expect(frame).toContain("The well was dry. Nobody came.");
  expect(fake.saved).toEqual([]);
});

test("in the screen: the inline changes are per unit; g n to another unit drops them, g p back fetches them again", async () => {
  const units: BookStage[] = [
    { id: "premise", name: "premise", depth: 0, status: "ready", missing: [] },
    { id: "chapter:1", name: "1 Cold Open", depth: 0, status: "drafted", missing: [], file: "chapters/01.md", storage: "sentences" },
    { id: "chapter:2", name: "2 Thaw", depth: 0, status: "drafted", missing: [], file: "chapters/02.md", storage: "sentences" },
  ];
  const files: Record<string, string> = { "chapters/01.md": "---\nchapter: 1\n---\n\nThe well was dry.\n\nNobody came.\n", "chapters/02.md": "---\nchapter: 2\n---\n\nThe ice broke.\n" };
  const diff = ["diff --git a/chapters/01.md b/chapters/01.md", "--- a/chapters/01.md", "+++ b/chapters/01.md", "@@ -3,3 +3,3 @@", " ---", " ", "-The well was dry.", "+The well was empty.", " ", ""].join("\n");
  const asked: string[] = [];
  const session: PaneSession = {
    open: async (file) => ({ ok: true, branch: "edit/ab12cd", text: files[file]! }),
    save: async (_f, b) => ({ ok: true, branch: b, lines: ["committed"] }),
    close: async () => undefined,
    revisions: async (file) => { asked.push(file); return file === "chapters/01.md" ? [{ branch: "revise/r1", diff }] : []; },
  };
  const loadUnit = (id: string, u?: { file: string; storage: string }) => (u ? { title: u.file, text: files[u.file] ?? "", file: u.file, editable: u.file, storage: u.storage } : { title: id, text: "not a file" });
  const app = render(<App title="Ice House" format="novel" book={bookRail(units)} load={loadUnit as never} editSession={noEditor} autosave={{ clock: stillClock }} paneSession={session} editor="vim" size={{ cols: 110, rows: 32 }} />);
  await sleep(30);
  for (const k of [DOWN, RIGHT, "v", "e"]) { app.stdin.write(k); await sleep(20); }
  await sleep(40);
  expect(plain(app.lastFrame())).toContain("+ The well was empty.");
  await keys(app, "g", "n"); await sleep(60);
  let frame = plain(app.lastFrame());
  expect(frame).toContain("The ice broke.");
  expect(frame).not.toContain("── AI");
  expect(frame).not.toContain("AI 1");
  await keys(app, "g", "p"); await sleep(60);
  frame = plain(app.lastFrame());
  expect(frame).toContain("+ The well was empty.");
  expect(asked).toEqual(["chapters/01.md", "chapters/02.md", "chapters/01.md"]);
});
