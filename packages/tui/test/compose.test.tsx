// The compose view (AGT-1566): the model's conversation, the pure lines and keys, and the screen over a fake
// Composer. Nothing here starts a session; the Composer is a function that yields scripted events.

import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { composeAction, composeLayout, composeLines, composeMeasure, inputTail, visibleLines } from "../src/compose";
import type { Composer } from "../src/compose";
import { initialState, reduce, viewOf } from "../src/state";
import type { Action, ComposeEvent, State } from "../src/state";

afterEach(() => cleanup());
const plain = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const then = (s: State, ...actions: Action[]) => actions.reduce(reduce, s);
const typed = (s: State, text: string) => then(s, { type: "compose.open" }, { type: "compose.type", text });
const ev = (event: ComposeEvent): Action => ({ type: "compose.event", event });

// ---------------------------------------------------------------- the model

test("compose.open remembers the mode Esc returns to; the book's cursor and the conversation survive the trip", () => {
  let s = then(initialState(), { type: "rail.loaded", rows: [{ id: "a", depth: 0 }, { id: "b", depth: 0 }] }, { type: "rail.down" });
  s = then(typed(s, "hello"), { type: "compose.submit" });
  expect(s.mode).toEqual({ kind: "compose", from: { kind: "book" } });
  expect(viewOf(s).rail.cursor).toBe(1);
  const back = then(s, { type: "escape" });
  expect(back.mode).toEqual({ kind: "book" });
  expect(back.compose.entries).toEqual([{ kind: "author", text: "hello" }]);
  expect(then(back, { type: "compose.open" }).compose).toEqual(back.compose);
  // From a review, Esc returns to the review.
  const review = then(initialState(), { type: "review.open", branch: "draft/ch01" }, { type: "compose.open" }, { type: "escape" });
  expect(review.mode).toEqual({ kind: "review", branch: "draft/ch01" });
});

test("submit sends the trimmed input once; an empty input or a turn in flight sends nothing", () => {
  const empty = then(initialState(), { type: "compose.open" }, { type: "compose.type", text: "   " }, { type: "compose.submit" });
  expect(empty.compose.sendSeq).toBe(0);
  const sent = then(typed(initialState(), "  where are we?  "), { type: "compose.submit" });
  expect(sent.compose).toMatchObject({ busy: true, outbox: "where are we?", sendSeq: 1, input: "" });
  const second = then(sent, { type: "compose.type", text: "and?" }, { type: "compose.submit" });
  expect(second.compose.sendSeq).toBe(1);
  expect(second.compose.input).toBe("and?");
});

test("session events build the conversation: the id, pablo's text, a tool call with its result, the result ends the turn", () => {
  let s = then(typed(initialState(), "go"), { type: "compose.submit" });
  s = then(s,
    ev({ kind: "session", id: "sess-1" }),
    ev({ kind: "assistant", text: "Checking." }),
    ev({ kind: "tool_call", id: "t1", tool: "resume", input: { project: "ice-house" } }),
  );
  expect(s.compose.activity).toBe("calling resume");
  s = then(s, ev({ kind: "tool_result", id: "t1", text: "bible done", isError: false }), ev({ kind: "result", ok: true, errors: [] }));
  expect(s.compose).toMatchObject({ sessionId: "sess-1", busy: false, outbox: null, activity: "" });
  expect(s.compose.entries.map((e) => e.kind)).toEqual(["author", "pablo", "tool"]);
  expect(s.compose.entries[2]).toMatchObject({ result: { text: "bible done", isError: false } });
});

test("a failed result or a failed stream is an error entry and frees the input", () => {
  const base = then(typed(initialState(), "go"), { type: "compose.submit" });
  const failed = then(base, ev({ kind: "result", ok: false, errors: ["credit exhausted"] }));
  expect(failed.compose).toMatchObject({ busy: false, entries: [{ kind: "author" }, { kind: "error", text: "credit exhausted" }] });
  const broke = then(base, { type: "compose.failed", message: "the harness session failed" });
  expect(broke.compose.busy).toBe(false);
  expect(broke.compose.entries.at(-1)).toEqual({ kind: "error", text: "the harness session failed" });
});

test("the conversation is open to a question card: compose.add appends one and it draws in place", () => {
  const s = then(initialState(), { type: "compose.add", entry: { kind: "question", id: "q1", question: "Does Cora know?", options: ["yes", "no"], why: "it changes chapter 4" } });
  const text = composeLines(s.compose.entries, 60).map((l) => l.text).join("\n");
  expect(text).toContain("? Does Cora know?");
  expect(text).toContain("1. yes");
  expect(text).toContain("why: it changes chapter 4");
  expect(text).toContain("waiting for your answer");
});

test("scrolling back is held within the conversation and a new line brings the view to the newest", () => {
  let s = then(initialState(), { type: "measured", measure: { compose: { visible: 5, lines: 12 } } });
  s = then(s, { type: "compose.page_up" }, { type: "compose.page_up" }, { type: "compose.page_up" });
  expect(s.compose.offset).toBe(7);
  expect(then(s, { type: "compose.down" }).compose.offset).toBe(6);
  expect(then(s, ev({ kind: "assistant", text: "more" })).compose.offset).toBe(0);
});

// ---------------------------------------------------------------- the pure parts

test("composeLines wraps to the width, hangs the author's prompt, and cuts tool lines to one row", () => {
  const lines = composeLines([
    { kind: "author", text: "a long sentence that has to wrap across more than one row of the screen" },
    { kind: "tool", id: "t", tool: "read", input: { path: "x".repeat(200) }, result: { text: "ok", isError: false } },
  ], 30);
  expect(lines.filter((l) => l.style === "author").length).toBeGreaterThan(1);
  expect(lines[0]!.text.startsWith("› ")).toBe(true);
  expect(lines[1]!.text.startsWith("  ")).toBe(true);
  expect(lines.every((l) => [...l.text].length <= 30)).toBe(true);
});

test("text from the model never carries a control sequence into the lines", () => {
  const lines = composeLines([{ kind: "pablo", text: "fine\x1b]0;pwned\x07 text" }], 40);
  expect(lines.map((l) => l.text).join("")).not.toContain("\x1b");
});

test("composeAction: typing, a paste, Enter, Backspace, scrolling and Esc; modified keys and sequences are not text", () => {
  expect(composeAction("a", {})).toEqual({ type: "compose.type", text: "a" });
  expect(composeAction("q", {})).toEqual({ type: "compose.type", text: "q" });
  expect(composeAction(" ", {})).toEqual({ type: "compose.type", text: " " });
  expect(composeAction("two\nlines", {})).toEqual({ type: "compose.type", text: "two lines" });
  expect(composeAction("\r", { return: true })).toEqual({ type: "compose.submit" });
  expect(composeAction("", { backspace: true })).toEqual({ type: "compose.backspace" });
  expect(composeAction("", { upArrow: true })).toEqual({ type: "compose.up" });
  expect(composeAction("", { pageDown: true })).toEqual({ type: "compose.page_down" });
  expect(composeAction("", { escape: true })).toEqual({ type: "escape" });
  expect(composeAction("c", { ctrl: true })).toBeNull();
  expect(composeAction("[1;2B", {})).toBeNull();
  expect(composeAction("", { tab: true })).toBeNull();
});

test("the geometry: the conversation takes what the status area, activity line, input box and footer leave", () => {
  expect(composeLayout(80, 24)).toEqual({ rows: 24 - 4 - 1 - 1 - 1 - 3, inner: 78, inputInner: 74 });
  const entries = [{ kind: "pablo" as const, text: "word ".repeat(60) }];
  expect(composeMeasure(composeLayout(80, 24), entries).compose!.lines).toBeGreaterThan(3);
  const lines = composeLines([{ kind: "pablo", text: "1\n2\n3\n4\n5\n6" }], 20);
  expect(visibleLines(lines, 3, 0).map((l) => l.text)).toEqual(["5", "6", ""]);
  expect(visibleLines(lines, 3, 2).map((l) => l.text)).toEqual(["3", "4", "5"]);
  expect(inputTail("abcdefghij", 5)).toBe("ghij");
});

// ---------------------------------------------------------------- the screen

const SIZE = { cols: 100, rows: 30 };
const props = { title: "Ice House", format: "novel", size: SIZE };

/** A Composer that answers each message with a scripted turn and records what it was sent. */
function fakeComposer(turn: (message: string) => ComposeEvent[], gate?: Promise<void>): Composer & { sent: string[]; closed: boolean } {
  const fake = {
    sent: [] as string[], closed: false,
    async *send(message: string) {
      fake.sent.push(message);
      if (gate) await gate;
      yield* turn(message);
    },
    close() { fake.closed = true; },
  };
  return fake;
}

const turn = (message: string): ComposeEvent[] => [
  { kind: "session", id: "abcdef123456" },
  { kind: "assistant", text: `You said: ${message}` },
  { kind: "tool_call", id: "t1", tool: "resume", input: { project: "ice-house" } },
  { kind: "tool_result", id: "t1", text: "bible done, acts next", isError: false },
  { kind: "assistant", text: "The bible is in; acts come next." },
  { kind: "result", ok: true, errors: [] },
];

const keys = async (app: ReturnType<typeof render>, text: string) => { for (const ch of text) { app.stdin.write(ch); await sleep(5); } };

test("a c opens the compose view full screen; the book is gone and the input is waiting", async () => {
  const app = render(<App {...props} composer={fakeComposer(turn)} />);
  await sleep(20);
  await keys(app, "a");
  await sleep(30);
  expect(plain(app.lastFrame())).toMatch(/c\s+compose/); // the key panel lists the AI prefix's second keys
  await keys(app, "c");
  await sleep(30);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("COMPOSE");
  expect(frame).toContain("Talk to pablo about the book");
  expect(frame).not.toContain("BOOK");
  expect(frame).toContain("Esc back to the book");
  expect(frame.split("\n").length).toBeLessThanOrEqual(SIZE.rows);
});

test("typing and Enter send a message and the reply streams into the conversation", async () => {
  const composer = fakeComposer(turn);
  const app = render(<App {...props} composer={composer} />);
  await sleep(20);
  await keys(app, "ac");
  await keys(app, "q hello"); // q is text here, not quit
  await sleep(30);
  expect(plain(app.lastFrame())).toContain("q hello");
  app.stdin.write("\r");
  await sleep(80);
  const frame = plain(app.lastFrame());
  expect(composer.sent).toEqual(["q hello"]);
  expect(frame).toContain("› q hello");
  expect(frame).toContain("You said: q hello");
  expect(frame).toContain("→ resume");
  expect(frame).toContain("← bible done, acts next");
  expect(frame).toContain("The bible is in; acts come next.");
  expect(frame).toContain("session abcdef12");
  expect(frame).not.toContain("working");
});

test("Esc returns to book mode with the session kept: the conversation is there when a c comes back, and a second message continues it", async () => {
  const composer = fakeComposer(turn);
  const app = render(<App {...props} composer={composer} rows={[{ id: "premise", depth: 0 }]} />);
  await sleep(20);
  await keys(app, "ac");
  await keys(app, "one");
  app.stdin.write("\r");
  await sleep(80);
  app.stdin.write("\x1b");
  await sleep(40);
  expect(plain(app.lastFrame())).toContain("BOOK");
  expect(plain(app.lastFrame())).toContain("book · rail");
  expect(composer.closed).toBe(false);
  await keys(app, "ac");
  await sleep(30);
  expect(plain(app.lastFrame())).toContain("You said: one");
  await keys(app, "two");
  app.stdin.write("\r");
  await sleep(80);
  expect(composer.sent).toEqual(["one", "two"]);
  expect(plain(app.lastFrame())).toContain("You said: two");
});

test("a reply still streaming when Esc is pressed lands in the kept conversation, and the footer says pablo is working", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const app = render(<App {...props} composer={fakeComposer(turn, gate)} />);
  await sleep(20);
  await keys(app, "ac");
  await keys(app, "slow");
  app.stdin.write("\r");
  await sleep(40);
  expect(plain(app.lastFrame())).toContain("thinking");
  app.stdin.write("\x1b");
  await sleep(40);
  expect(plain(app.lastFrame())).toMatch(/book · rail · pablo: thinking/);
  release();
  await sleep(80);
  expect(plain(app.lastFrame())).not.toContain("pablo: thinking");
  await keys(app, "ac");
  await sleep(30);
  expect(plain(app.lastFrame())).toContain("You said: slow");
});

test("a failing session shows the reason in the conversation and the next message tries again", async () => {
  let calls = 0;
  const composer: Composer = {
    async *send() {
      calls++;
      if (calls === 1) throw new Error("pablo's session failed (not logged in). Run `claude` once to log in.");
      yield { kind: "assistant", text: "back again" };
      yield { kind: "result", ok: true, errors: [] };
    },
  };
  const app = render(<App {...props} composer={composer} />);
  await sleep(20);
  await keys(app, "ac");
  await keys(app, "hi");
  app.stdin.write("\r");
  await sleep(60);
  expect(plain(app.lastFrame())).toContain("✗ pablo's session failed (not logged in)");
  await keys(app, "again");
  app.stdin.write("\r");
  await sleep(60);
  expect(plain(app.lastFrame())).toContain("back again");
});

test("with no session attached the view still opens and says so on the first message", async () => {
  const app = render(<App {...props} />);
  await sleep(20);
  await keys(app, "ac");
  await keys(app, "hi");
  app.stdin.write("\r");
  await sleep(60);
  expect(plain(app.lastFrame())).toContain("pablo isn't connected to this screen");
});

test("the arrows scroll a long conversation back and the newest is shown again on the next reply", async () => {
  const long: ComposeEvent[] = [...Array.from({ length: 40 }, (_, i) => ({ kind: "assistant", text: `line number ${i}` }) as ComposeEvent), { kind: "result", ok: true, errors: [] }];
  const app = render(<App {...props} composer={fakeComposer(() => long)} />);
  await sleep(20);
  await keys(app, "ac");
  await keys(app, "go");
  app.stdin.write("\r");
  await sleep(100);
  expect(plain(app.lastFrame())).toContain("line number 39");
  expect(plain(app.lastFrame())).not.toContain("line number 0\n");
  app.stdin.write("\x1b[5~");
  await sleep(40);
  expect(plain(app.lastFrame())).toContain("scrolled back");
  expect(plain(app.lastFrame())).not.toContain("line number 39");
});

test("a question card waits for an answer: the next line answers it (a number picks an option) instead of sending a message", () => {
  let s = then(typed(initialState(), "plan"), { type: "compose.submit" });
  s = then(s, ev({ kind: "question", id: "q1", question: "Does Cora know?", options: ["yes", "no"], why: "chapter 4" }));
  expect(s.compose).toMatchObject({ busy: true, activity: "waiting for your answer" });
  s = then(s, { type: "compose.type", text: "2" }, { type: "compose.submit" });
  expect(s.compose).toMatchObject({ sendSeq: 1, replySeq: 1, reply: { id: "q1", text: "no" }, input: "" });
  expect(s.compose.entries.at(-1)).toMatchObject({ kind: "question", answer: "no" });
  // Answered, a line typed during the turn is held again (busy), not sent.
  const held = then(s, { type: "compose.type", text: "more" }, { type: "compose.submit" });
  expect(held.compose.sendSeq).toBe(1);
  // In the author's own words:
  const own = then(then(typed(initialState(), "x"), { type: "compose.submit" }, ev({ kind: "question", id: "q2", question: "Who?", options: [], why: "w" })), { type: "compose.type", text: "Edwin, 7" }, { type: "compose.submit" });
  expect(own.compose.reply).toEqual({ id: "q2", text: "Edwin, 7" });
});

test("the screen shows the card in place, the author answers it there, and the composer is handed the answer", async () => {
  const answers: [string, string][] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const composer: Composer = {
    async *send() {
      yield { kind: "question", id: "q1", question: "Does Cora know?", options: ["yes", "no"], why: "it changes chapter 4" };
      await gate;
      yield { kind: "assistant", text: "Then chapter 4 is a confession." };
      yield { kind: "result", ok: true, errors: [] };
    },
    answer: (id, text) => { answers.push([id, text]); release(); },
  };
  const app = render(<App {...props} composer={composer} />);
  await sleep(20);
  await keys(app, "ac");
  await keys(app, "plan");
  app.stdin.write("\r");
  await sleep(60);
  let frame = plain(app.lastFrame());
  expect(frame).toContain("? Does Cora know?");
  expect(frame).toContain("1. yes");
  expect(frame).toContain("waiting for your answer");
  await keys(app, "1");
  app.stdin.write("\r");
  await sleep(80);
  frame = plain(app.lastFrame());
  expect(answers).toEqual([["q1", "yes"]]);
  expect(frame).toContain("→ yes");
  expect(frame).toContain("Then chapter 4 is a confession.");
});
