// `a r` (AGT-1544): the instruction, the candidate that streams in and can be edited, Take onto a revise branch.

import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { reviseAction, type ReviseRequest, type ReviseResult, type Reviser, type TakeRequest, type TakeResult } from "../src/revise";
import { initialState, reduce, reviseContent, type Action, type State } from "../src/state";

afterEach(() => cleanup());
const plain = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FILE = "---\nstatus: draft\n---\n\nThe well had been dry since June.\nShe did not look up.\n\nEdwin stood in the doorway.";
const DIFF = "diff --git a/chapters/01.md b/chapters/01.md\n--- a/chapters/01.md\n+++ b/chapters/01.md\n@@ -5,2 +5,2 @@\n-The well had been dry since June.\n+The well was dry.\n She did not look up.\n";
const SHIFT_DOWN = "\x1b[1;2B", BACKSPACE = "\x7f", LEFT = "\x1b[D", ENTER = "\r", ESC = "\x1b";

const run = (...actions: Action[]): State => actions.reduce(reduce, initialState());
const OPEN: Action = { type: "revise.open", file: "chapters/01.md", sentences: ["The well had been dry since June."], stored: { from: 4, to: 4 } };
const typed = (text: string): Action[] => [...text].map((c) => ({ type: "revise.type", text: c }));

// ---------------------------------------------------------------- the model

test("ask: typing fills the instruction at the cursor; Enter with nothing typed says so and stays", () => {
  let s = run(OPEN, ...typed("shorter"));
  expect(s.revise).toMatchObject({ phase: "ask", instruction: "shorter", cursor: 7 });
  s = run(OPEN, ...typed("shortr"), { type: "revise.left" }, { type: "revise.type", text: "e" });
  expect(s.revise?.instruction).toBe("shorter");
  expect(reduce(run(OPEN), { type: "revise.run" }).revise).toMatchObject({ phase: "ask", note: "Say what should change first." });
  expect(s.content?.title).toContain("what should change");
  expect(s.content?.body).toContain("The well had been dry since June.");
});

test("run, partial and done: the candidate streams in, then is editable with its cursor at the end", () => {
  let s = run(OPEN, ...typed("shorter"), { type: "revise.run" });
  expect(s.revise?.phase).toBe("running");
  expect(s.full).toBe(true);
  s = reduce(s, { type: "revise.partial", id: 1, text: "The well was" });
  expect(s.content?.body).toContain("The well was");
  s = reduce(s, { type: "revise.done", id: 1, candidate: "The well was dry.", receipt: "abc1234def", model: "m" });
  expect(s.revise).toMatchObject({ phase: "edit", candidate: "The well was dry.", offered: "The well was dry.", cursor: 17 });
  // typing edits the candidate, not the instruction
  s = [...typed(" Again"), { type: "revise.backspace" } as Action].reduce(reduce, s);
  expect(s.revise).toMatchObject({ candidate: "The well was dry. Agai", instruction: "shorter", offered: "The well was dry." });
  expect(s.content?.body).toContain("The well was dry. Agai▏");
  expect(s.content?.body).toContain("--- was ---");
});

test("a late answer to a cancelled revise is ignored, and Esc cancels at every phase but the commit", () => {
  const running = run(OPEN, ...typed("x"), { type: "revise.run" });
  const cancelled = reduce(running, { type: "escape" });
  expect(cancelled.revise).toBeNull();
  expect(cancelled.content).toBeNull();
  expect(cancelled.full).toBe(false);
  expect(reduce(cancelled, { type: "revise.done", id: 1, candidate: "late", receipt: "r", model: "m" }).revise).toBeNull();
  // a new revise is a new id: the old one's answer cannot land on it
  const again = reduce(cancelled, OPEN);
  expect(again.revise?.id).toBe(2);
  expect(reduce(again, { type: "revise.done", id: 1, candidate: "late", receipt: "r", model: "m" })).toEqual(again);
  const taking = [...[{ type: "revise.done", id: 1, candidate: "c", receipt: "r", model: "m" }, { type: "revise.take" }] as Action[]].reduce(reduce, run(OPEN, ...typed("x"), { type: "revise.run" }));
  expect(taking.revise?.phase).toBe("taking");
  expect(reduce(taking, { type: "escape" }).revise?.phase).toBe("taking");
});

test("a failed run returns to the instruction, a failed take to the candidate, each with the reason", () => {
  const ran = run(OPEN, ...typed("x"), { type: "revise.run" });
  const failed = reduce(ran, { type: "revise.failed", id: 1, message: "the endpoint is down" });
  expect(failed.revise).toMatchObject({ phase: "ask", instruction: "x", note: "the endpoint is down" });
  expect(failed.content?.body).toContain("the endpoint is down");
  const done = reduce(ran, { type: "revise.done", id: 1, candidate: "c", receipt: "r", model: "m" });
  const failedTake = reduce(reduce(done, { type: "revise.take" }), { type: "revise.failed", id: 1, message: "chapter changed" });
  expect(failedTake.revise).toMatchObject({ phase: "edit", candidate: "c", note: "chapter changed" });
});

test("take with an emptied candidate is refused; taken opens the review on the branch and lists it as waiting", () => {
  const done = run(OPEN, ...typed("x"), { type: "revise.run" }, { type: "revise.done", id: 1, candidate: "c", receipt: "r", model: "m" });
  const emptied = reduce(done, { type: "revise.backspace" });
  expect(reduce(emptied, { type: "revise.take" }).revise).toMatchObject({ phase: "edit", note: "The candidate is empty; Esc discards it." });
  const taken = reduce(reduce(done, { type: "revise.take" }), { type: "revise.taken", id: 1, branch: "revise/abc1234", lines: ["revised chapters/01.md on revise/abc1234"] });
  expect(taken.revise).toBeNull();
  expect(taken.mode).toEqual({ kind: "review", branch: "revise/abc1234" });
  expect(taken.written).toEqual(["revise/abc1234"]);
  expect(taken.content?.title).toBe("Revised on revise/abc1234");
});

test("revise.open only applies in the book, with nothing else running", () => {
  expect(reduce(run({ type: "write.start", chapter: 1 }), OPEN).revise).toBeNull();
  expect(reduce(run({ type: "review.open", branch: "draft/ch01" }), OPEN).revise).toBeNull();
  expect(reduce(run(OPEN), { ...OPEN, sentences: ["other"] } as Action).revise?.sentences).toEqual(["The well had been dry since June."]);
  expect(reduce(run(OPEN), { type: "write.start", chapter: 1 }).writing).toBeNull();
  expect(reviseContent(run(OPEN).revise!).kind).toBe("revise");
});

test("reviseAction: text and editing keys in ask and edit, Esc always, nothing else while running", () => {
  const key = (k: object = {}) => ({ upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageUp: false, pageDown: false, return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false, ...k }) as never;
  const ask = run(OPEN).revise!;
  expect(reviseAction(ask, "q", key())).toEqual({ type: "revise.type", text: "q" });
  expect(reviseAction(ask, "a", key())).toEqual({ type: "revise.type", text: "a" }); // a prefix key is just a letter here
  expect(reviseAction(ask, "", key({ return: true }))).toEqual({ type: "revise.run" });
  expect(reviseAction(ask, "", key({ escape: true }))).toEqual({ type: "escape" });
  expect(reviseAction(ask, "", key({ backspace: true }))).toEqual({ type: "revise.backspace" });
  expect(reviseAction(ask, "", key({ leftArrow: true }))).toEqual({ type: "revise.left" });
  expect(reviseAction(ask, "\x1b[1;2B", key())).toBeNull();
  const edit = reduce(reduce(run(OPEN, ...typed("x"), { type: "revise.run" }), { type: "revise.done", id: 1, candidate: "c", receipt: "r", model: "m" }), { type: "revise.left" }).revise!;
  expect(reviseAction(edit, "", key({ return: true }))).toEqual({ type: "revise.take" });
  expect(reviseAction(edit, "n", key({ ctrl: true }))).toEqual({ type: "revise.type", text: "\n\n" });
  const running = run(OPEN, ...typed("x"), { type: "revise.run" }).revise!;
  expect(reviseAction(running, "q", key())).toBeNull();
  expect(reviseAction(running, "", key({ escape: true }))).toEqual({ type: "escape" });
});

// ---------------------------------------------------------------- on the screen

/** A reviser the test steers: revise streams partial text and resolves on `finish`; take records its request. */
function controlled() {
  const revises: ReviseRequest[] = [];
  const takes: TakeRequest[] = [];
  let partial!: (text: string) => void;
  let finish!: (r: ReviseResult) => void;
  let taken!: (r: TakeResult) => void;
  const reviser: Reviser = {
    revise: (request, p) => { revises.push(request); partial = p; return new Promise<ReviseResult>((resolve) => { finish = resolve; }); },
    take: (request) => { takes.push(request); return new Promise<TakeResult>((resolve) => { taken = resolve; }); },
  };
  return { reviser, revises, takes, partial: (t: string) => partial(t), finish: (r: ReviseResult) => finish(r), taken: (r: TakeResult) => taken(r) };
}

const mount = (reviser: Reviser | undefined, file: string | undefined = "chapters/01.md") =>
  render(<App title="T" format="novel" rows={[{ id: "ch1", depth: 0 }]} labels={{ ch1: "ch 1" }} reviser={reviser} diffOf={() => ({ ok: true, text: DIFF })}
    load={() => ({ title: "chapters/01.md", text: FILE, ...(file ? { file } : {}) })} size={{ cols: 110, rows: 30 }} />);

async function select(app: ReturnType<typeof mount>, n: number) {
  await sleep(30);
  app.stdin.write("\x1b[C"); await sleep(30); // into the main pane
  for (let i = 0; i < n; i++) { app.stdin.write(SHIFT_DOWN); await sleep(30); }
}
const type = async (app: ReturnType<typeof mount>, text: string) => { for (const c of text) { app.stdin.write(c); await sleep(15); } };

test("a r asks for an instruction, runs the revise on the selection, streams the candidate, lets it be edited, and Take opens the review", async () => {
  const c = controlled();
  const app = mount(c.reviser);
  await select(app, 1);
  app.stdin.write("a"); await sleep(20); app.stdin.write("r"); await sleep(40);
  expect(plain(app.lastFrame())).toContain("what should change");
  await type(app, "make it plain");
  expect(plain(app.lastFrame())).toContain("make it plain");
  app.stdin.write(ENTER); await sleep(40);
  expect(c.revises).toEqual([{ file: "chapters/01.md", sentences: ["The well had been dry since June."], stored: { from: 4, to: 4 }, instruction: "make it plain" }]);
  c.partial("The well was"); await sleep(40);
  expect(plain(app.lastFrame())).toContain("The well was");
  c.finish({ ok: true, candidate: "The well was dry.", receipt: "abc1234def56", model: "m", lines: [] }); await sleep(40);
  let frame = plain(app.lastFrame());
  expect(frame).toContain("Candidate");
  expect(frame).toContain("The well was dry.");
  // the candidate is editable: a typed word, a deleted letter, a cursor move, all before Take
  app.stdin.write(BACKSPACE); await sleep(20);
  await type(app, ", hard");
  app.stdin.write(LEFT); await sleep(20);
  expect(plain(app.lastFrame())).toContain("The well was dry, har▏d");
  app.stdin.write(ENTER); await sleep(40);
  expect(c.takes).toHaveLength(1);
  expect(c.takes[0]).toMatchObject({ candidate: "The well was dry, hard", offered: "The well was dry.", receipt: "abc1234def56", model: "m", instruction: "make it plain", stored: { from: 4, to: 4 } });
  c.taken({ ok: true, branch: "revise/abc1234", lines: ["revised chapters/01.md on revise/abc1234"] }); await sleep(60);
  frame = plain(app.lastFrame());
  expect(frame).toContain("review revise/abc1234");
  expect(frame).toContain("Revised on revise/abc1234");
});

test("Esc discards the candidate without taking it; a failed run shows its reason at the instruction", async () => {
  const c = controlled();
  const app = mount(c.reviser);
  await select(app, 1);
  app.stdin.write("a"); await sleep(20); app.stdin.write("r"); await sleep(40);
  await type(app, "x");
  app.stdin.write(ENTER); await sleep(40);
  c.finish({ ok: false, message: "the local model is not answering" }); await sleep(40);
  expect(plain(app.lastFrame())).toContain("the local model is not answering");
  app.stdin.write(ENTER); await sleep(40); // the instruction is kept: Enter retries
  expect(c.revises).toHaveLength(2);
  c.finish({ ok: true, candidate: "Candidate text.", receipt: "r", model: "m", lines: [] }); await sleep(40);
  expect(plain(app.lastFrame())).toContain("Candidate text.");
  app.stdin.write(ESC); await sleep(60);
  expect(c.takes).toEqual([]);
  expect(plain(app.lastFrame())).not.toContain("Candidate text.");
});

test("a r with nothing selected, no file, or no reviser says why instead of asking", async () => {
  const c = controlled();
  let app = mount(c.reviser);
  await select(app, 0);
  app.stdin.write("a"); await sleep(20); app.stdin.write("r"); await sleep(40);
  expect(plain(app.lastFrame())).toContain("Select the sentences to revise first");
  cleanup();
  app = mount(c.reviser, "");
  await select(app, 1);
  app.stdin.write("a"); await sleep(20); app.stdin.write("r"); await sleep(40);
  expect(plain(app.lastFrame())).toContain("Open a chapter");
  cleanup();
  app = mount(undefined);
  await select(app, 1);
  app.stdin.write("a"); await sleep(20); app.stdin.write("r"); await sleep(40);
  expect(plain(app.lastFrame())).toContain("not available");
  expect(c.revises).toEqual([]);
});
