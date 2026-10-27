// `v e` edits the unit in place in the screen's own pane, on the work's `edit/` branch (the CLI's `PaneSession`, passed
// in; AGT-2167); `v s` saves the branch through the finisher with nothing rejected (AGT-1545). Fake sessions: no editor
// is launched and no git runs; the TUI itself is never launched, only rendered by ink-testing-library.

import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { bookRail, type BookStage } from "../src/book";
import { fileLineAt } from "../src/document";
import { mainRows } from "../src/hits";
import type { EditRequest, EditResult, Finisher } from "../src/screen";
import type { PaneSession } from "../src/edit-pane";
import type { CheckHit } from "../src/hits";
import type { BookStage as Stage, UnitRef } from "../src/book";

afterEach(() => cleanup());
const plain = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = "\x1b[B", RIGHT = "\x1b[C", LEFT = "\x1b[D", ESC = "\x1b", CTRL_S = "\x13", CTRL_Z = "\x1a", BACKSPACE = "\x7f";

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

/** A fake pane session over files in memory: what was opened, saved and closed, and the files as the branch holds them. */
function fakeSession(files: Record<string, string>, branch = "edit/ab12cd") {
  const log = { opened: [] as string[], saved: [] as { file: string; branch: string; text: string }[], closed: [] as string[] };
  const session: PaneSession = {
    open: async (file) => { log.opened.push(file); return files[file] === undefined ? { ok: false, message: `pablo: edit: ${file} is not on main yet; commit it first` } : { ok: true, branch, text: files[file]! }; },
    save: async (file, b, text) => { log.saved.push({ file, branch: b, text }); files[file] = text; return { ok: true, branch: b, lines: [`committed ${file} on ${b} (1234567)`, "v s saves it into main"] }; },
    close: async (b) => { log.closed.push(b); },
  };
  return { session, log, files };
}

/** No `$EDITOR` for `v e`: the old editor session is wired and must never be called. */
const noEditor = async (r: EditRequest): Promise<EditResult> => { throw new Error(`the editor was launched for ${r.file}`); };

function mount(opts: { session?: PaneSession; finisher?: Finisher; checks?: (file: string, text: string) => readonly CheckHit[]; stages?: Stage[]; load?: (id: string, unit?: UnitRef) => ReturnType<typeof load> }) {
  return render(<App title="Ice House" format="novel" book={bookRail(opts.stages ?? STAGES)} load={opts.load ?? load} editSession={noEditor} {...(opts.session ? { paneSession: opts.session } : {})} {...(opts.finisher ? { finisher: opts.finisher } : {})} {...(opts.checks ? { checks: opts.checks } : {})} editor="vim" size={{ cols: 110, rows: 32 }} />);
}
async function toRow(app: ReturnType<typeof mount>, index: number) {
  for (let i = 0; i < index; i++) { app.stdin.write(DOWN); await sleep(15); }
  app.stdin.write(RIGHT); await sleep(20); // into the main pane on that row
}
const toChapterMain = (app: ReturnType<typeof mount>) => toRow(app, 1);
async function keys(app: ReturnType<typeof mount>, ...ks: string[]) { for (const k of ks) { app.stdin.write(k); await sleep(15); } await sleep(20); }
async function vE(app: ReturnType<typeof mount>) { await keys(app, "v", "e"); await sleep(30); }

test("v e opens the unit in place, on the edit branch, the cursor on the cursor's line; no editor is launched", async () => {
  const fake = fakeSession({ "chapters/01-cold-open.md": CHAPTER });
  const app = mount({ session: fake.session });
  await sleep(30);
  await toChapterMain(app);
  await keys(app, DOWN, DOWN); // the main pane's cursor on "Edwin stood in the doorway."
  await vE(app);
  expect(fake.log.opened).toEqual(["chapters/01-cold-open.md"]);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("chapters/01-cold-open.md · edit/ab12cd");
  expect(frame).toContain("The well was dry. Nobody came.");
  expect(frame).not.toContain("chapter: 1"); // the frontmatter is not in the pane
  expect(frame).toContain("Ctrl+S saves");
  // The cursor opens on the paragraph `v e` was pressed on: typing lands there.
  await keys(app, "X");
  expect(plain(app.lastFrame())).toContain("XEdwin stood in the doorway.");
});

test("typed text appears at the cursor, a dirty marker shows until Ctrl+S saves, frontmatter kept and sentences split", async () => {
  const fake = fakeSession({ "chapters/01-cold-open.md": CHAPTER });
  const app = mount({ session: fake.session });
  await sleep(30);
  await toChapterMain(app);
  await vE(app);
  expect(plain(app.lastFrame())).not.toContain("[+]");
  await keys(app, "\x1b[F"); // End of the first paragraph
  await keys(app, " ", "S", "o", " ", "i", "t", " ", "g", "o", "e", "s", ".");
  let frame = plain(app.lastFrame());
  expect(frame).toContain("The well was dry. Nobody came. So it goes.");
  expect(frame).toContain("chapters/01-cold-open.md [+] · edit/ab12cd");
  await keys(app, CTRL_S); await sleep(30);
  expect(fake.log.saved).toEqual([{ file: "chapters/01-cold-open.md", branch: "edit/ab12cd", text: ["---", "chapter: 1", "---", "", "The well was dry.", "Nobody came.", "So it goes.", "", "Edwin stood in the doorway.", ""].join("\n") }]);
  frame = plain(app.lastFrame());
  expect(frame).not.toContain("[+]");
  expect(frame).toContain("Saved chapters/01-cold-open.md on edit/ab12cd");
  expect(frame).toContain("committed chapters/01-cold-open.md on edit/ab12cd");
});

test("undo back to the saved text clears the dirty marker; Ctrl+S with nothing changed saves nothing", async () => {
  const fake = fakeSession({ "chapters/01-cold-open.md": CHAPTER });
  const app = mount({ session: fake.session });
  await sleep(30);
  await toChapterMain(app);
  await vE(app);
  await keys(app, "A", "h");
  expect(plain(app.lastFrame())).toContain("[+]");
  await keys(app, CTRL_Z);
  expect(plain(app.lastFrame())).not.toContain("[+]");
  await keys(app, CTRL_S);
  expect(fake.log.saved).toEqual([]);
  expect(plain(app.lastFrame())).toContain("Nothing to save.");
});

test("check-hit boxes render in the editing pane, and follow the text as it is typed", async () => {
  const fake = fakeSession({ "chapters/01-cold-open.md": CHAPTER });
  const checks = (_file: string, text: string): CheckHit[] => text.split("\n").flatMap((l, i) => (l.includes("well") ? [{ line: i + 1, rule: "flagged-line", excerpt: l }] : l.includes("—") ? [{ line: i + 1, rule: "em-dash", excerpt: l }] : []));
  const app = mount({ session: fake.session, checks });
  await sleep(30);
  await toChapterMain(app);
  await vE(app);
  let frame = plain(app.lastFrame());
  expect(frame).toContain("▲ tells · flagged-line");
  expect(frame).not.toContain("em-dash");
  const lines = frame.split("\n");
  const para = lines.findIndex((l) => l.includes("The well was dry."));
  expect(lines[para + 1]).toContain("▲ tells · flagged-line"); // the box sits under its paragraph
  await keys(app, DOWN, DOWN, "\x1b[F", "—");
  frame = plain(app.lastFrame());
  expect(frame).toContain("▲ tells · em-dash");
});

test("Esc with unsaved changes asks; Esc again closes without saving and the branch is let go; the main pane is back", async () => {
  const fake = fakeSession({ "chapters/01-cold-open.md": CHAPTER });
  const app = mount({ session: fake.session });
  await sleep(30);
  await toChapterMain(app);
  await vE(app);
  await keys(app, "x");
  await keys(app, ESC); await sleep(30);
  expect(plain(app.lastFrame())).toContain("Unsaved changes to chapters/01-cold-open.md");
  expect(fake.log.closed).toEqual([]);
  await keys(app, ESC); await sleep(30);
  expect(fake.log.closed).toEqual(["edit/ab12cd"]);
  expect(fake.log.saved).toEqual([]);
  const frame = plain(app.lastFrame());
  expect(frame).not.toContain("edit/ab12cd");
  expect(frame).toContain("The well was dry. Nobody came.");
  // Keys reach the book again: ← goes back to the rail.
  await keys(app, LEFT);
  expect(plain(app.lastFrame())).toContain("book · rail");
});

test("a session that cannot open the file says why and the pane does not open", async () => {
  const fake = fakeSession({});
  const app = mount({ session: fake.session });
  await sleep(30);
  await toChapterMain(app);
  await vE(app);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("Not edited");
  expect(frame).toContain("is not on main yet");
});

test("v e on a row that is not one file says so and opens nothing", async () => {
  const fake = fakeSession({ "chapters/01-cold-open.md": CHAPTER });
  const app = mount({ session: fake.session });
  await sleep(30);
  app.stdin.write(RIGHT); await sleep(20); // premise: a document with no file to edit
  await vE(app);
  expect(fake.log.opened).toEqual([]);
  expect(plain(app.lastFrame())).toContain("Select a chapter or file to edit.");
});

test("v s merges the open edit branch through the finisher with nothing rejected; with no edits it says so", async () => {
  const saved: { branch: string; rejected: unknown }[] = [];
  const finisher: Finisher = async (branch, rejected) => { saved.push({ branch, rejected }); return { ok: true, lines: [`merged ${branch} into main (abcdef0)`] }; };
  const fake = fakeSession({ "chapters/01-cold-open.md": CHAPTER });
  const app = mount({ session: fake.session, finisher });
  await sleep(30);
  await keys(app, "v", "s");
  expect(saved).toEqual([]);
  expect(plain(app.lastFrame())).toContain("There are no edits to save.");
  await toChapterMain(app);
  await vE(app);
  await keys(app, "N", "o", "w", " ", CTRL_S); await sleep(30);
  expect(plain(app.lastFrame())).toContain("branches to review (1)");
  await keys(app, ESC); await sleep(30);
  await keys(app, "v", "s"); await sleep(40);
  expect(saved).toEqual([{ branch: "edit/ab12cd", rejected: { removed: [], added: [] } }]);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("Saved edit/ab12cd");
  expect(frame).not.toContain("branches to review");
});

// AC4: every output's unit, through its rail row's file and storage mode (AGT-2148).
const UNITS: { output: string; file: string; storage: "sentences" | "lines" | "screenplay"; text: string; type: string; saved: string }[] = [
  { output: "novel", file: "chapters/01-cold-open.md", storage: "sentences", text: CHAPTER, type: "Rain fell. ", saved: ["---", "chapter: 1", "---", "", "Rain fell.", "The well was dry.", "Nobody came.", "", "Edwin stood in the doorway.", ""].join("\n") },
  { output: "story", file: "outputs/story/story.md", storage: "sentences", text: "---\noutput: story\n---\n\nIt began. It ended.\n", type: "Rain fell. ", saved: "---\noutput: story\n---\n\nRain fell.\nIt began.\nIt ended.\n" },
  { output: "screenplay", file: "outputs/screenplay/scenes/01-open.fountain", storage: "screenplay", text: "---\nscene: 1\n---\n\nINT. ICE HOUSE - NIGHT\n\nEDWIN\nCold. Very cold.\n", type: "FADE IN:\r\r", saved: "---\nscene: 1\n---\n\nFADE IN:\n\nINT. ICE HOUSE - NIGHT\n\nEDWIN\nCold. Very cold.\n" },
  { output: "radio", file: "outputs/radio/episodes/01-open.md", storage: "lines", text: "---\nepisode: 1\n---\n\nCAST: NED (gruff)\nNED: Cold. Very cold.\n", type: "NARRATOR: Night.\r", saved: "---\nepisode: 1\n---\n\nNARRATOR: Night.\nCAST: NED (gruff)\nNED: Cold. Very cold.\n" },
  { output: "narrated", file: "outputs/narrated/readings/01-open.md", storage: "lines", text: "---\nreading: 1\n---\n\nNARRATOR: The well was dry.\nNARRATOR: Nobody came.\n", type: "CAST: NARRATOR\r", saved: "---\nreading: 1\n---\n\nCAST: NARRATOR\nNARRATOR: The well was dry.\nNARRATOR: Nobody came.\n" },
];

for (const [i, u] of UNITS.entries()) {
  test(`v e edits a ${u.output} unit (${u.storage}) in place and saves it in its storage mode, frontmatter kept`, async () => {
    const stages: Stage[] = [STAGES[0]!, ...UNITS.map((x, k) => ({ id: `unit:${x.output}:1`, name: `${x.output} 1`, depth: 0, status: "drafted" as const, missing: [], output: x.output, unit: 1, file: x.file, storage: x.storage }))];
    const files = Object.fromEntries(UNITS.map((x) => [x.file, x.text]));
    const unitLoad = (id: string, unit?: UnitRef) => (unit ? { title: unit.file, text: files[unit.file]!, file: unit.file, editable: unit.file, storage: unit.storage } : load(id));
    const fake = fakeSession(files);
    const app = mount({ session: fake.session, stages, load: unitLoad });
    await sleep(30);
    await toRow(app, i + 1);
    await vE(app);
    expect(fake.log.opened).toEqual([u.file]);
    expect(plain(app.lastFrame())).toContain(`${u.file} · edit/ab12cd`);
    app.stdin.write(u.type); await sleep(40); // a paste: the whole string in one chunk
    expect(plain(app.lastFrame())).toContain("[+]");
    await keys(app, CTRL_S); await sleep(30);
    expect(fake.log.saved.map((x) => x.text)).toEqual([u.saved]);
    expect(plain(app.lastFrame())).not.toContain("[+]");
  });
}

test("Backspace deletes before the cursor in the pane", async () => {
  const fake = fakeSession({ "chapters/01-cold-open.md": CHAPTER });
  const app = mount({ session: fake.session });
  await sleep(30);
  await toChapterMain(app);
  await vE(app);
  await keys(app, "\x1b[F", BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE);
  expect(plain(app.lastFrame())).toContain("The well was dry. Nobody");
  expect(plain(app.lastFrame())).not.toContain("Nobody came.");
});
