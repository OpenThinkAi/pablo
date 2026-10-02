import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { bookRail, type BookStage } from "../src/book";
import type { WriteResult } from "../src/screen";
import { initialState, reduce } from "../src/state";

afterEach(() => cleanup());
const plain = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = "\x1b[B", RIGHT = "\x1b[C", ESC = "\x1b";

const stage = (id: string, name: string, status: BookStage["status"], extra: Partial<BookStage> = {}): BookStage => ({ id, name, depth: 0, status, missing: [], ...extra });
const STAGES: BookStage[] = [
  stage("premise", "premise", "ready"),
  stage("chapters", "chapters (0/2)", "ready", { group: true }),
  stage("chapter:1", "1 Cold Open", "ready", { depth: 1 }),
  stage("chapter:2", "2", "missing", { depth: 1, missing: ["no beat for chapter 2"] }),
];
const DIFF = "diff --git a/chapters/01-cold-open.md b/chapters/01-cold-open.md\nnew file mode 100644\n--- /dev/null\n+++ b/chapters/01-cold-open.md\n@@ -0,0 +1,2 @@\n+The well was dry.\n+Nobody came.\n";

/** A writer the test steers: it resolves when `finish` is called, after `progress` lines have streamed. */
function controlled() {
  const calls: number[] = [];
  let emit!: (line: string) => void;
  let finish!: (r: WriteResult) => void;
  const writer = (chapter: number, progress: (l: string) => void) => {
    calls.push(chapter);
    emit = progress;
    return new Promise<WriteResult>((resolve) => { finish = resolve; });
  };
  return { writer, calls, emit: (l: string) => emit(l), finish: (r: WriteResult) => finish(r) };
}

const mount = (writer: ReturnType<typeof controlled>["writer"]) =>
  render(<App title="Ice House" format="novel" book={bookRail(STAGES)} writer={writer} diffOf={() => ({ ok: true, text: DIFF })} size={{ cols: 110, rows: 32 }} />);

/** Opens the chapters and puts the cursor on chapter N's row (1 or 2). */
async function selectChapter(app: ReturnType<typeof mount>, n: number) {
  app.stdin.write(DOWN); await sleep(20);
  app.stdin.write(RIGHT); await sleep(20);
  for (let i = 0; i < n; i++) { app.stdin.write(DOWN); await sleep(20); }
}

test("a w on a chapter streams progress, shows the receipt, and opens review on the new draft branch", async () => {
  const w = controlled();
  const app = mount(w.writer);
  await sleep(30);
  await selectChapter(app, 1);
  app.stdin.write("a"); await sleep(20); app.stdin.write("w"); await sleep(40);
  expect(w.calls).toEqual([1]);
  expect(plain(app.lastFrame())).toContain("Writing chapter 1");
  w.emit("first token after 0.4s"); await sleep(40);
  w.emit("120 tokens, 30.0 tok/s"); await sleep(40);
  let frame = plain(app.lastFrame());
  expect(frame).toContain("first token after 0.4s");
  expect(frame).toContain("120 tokens, 30.0 tok/s");
  w.finish({ ok: true, branch: "draft/ch01", lines: ["wrote chapters/01-cold-open.md (900 words) on branch draft/ch01"] }); await sleep(60);
  frame = plain(app.lastFrame());
  expect(frame).toContain("review draft/ch01");
  expect(frame).toContain("Wrote chapter 1 on draft/ch01");
  expect(frame).toContain("(900 words)");
  expect(frame).toContain("CHANGES");
  app.stdin.write(ESC); await sleep(30); // the receipt comes down first
  app.stdin.write(ESC); await sleep(40); // then the review closes: the new branch waits in the book
  frame = plain(app.lastFrame());
  expect(frame).toContain("book ·");
  expect(frame).toContain("branches to review (1)");
});

test("a refusal shows its message and missing reasons and stays in book mode", async () => {
  const w = controlled();
  const app = mount(w.writer);
  await sleep(30);
  await selectChapter(app, 2);
  app.stdin.write("a"); await sleep(20); app.stdin.write("w"); await sleep(40);
  w.finish({ ok: false, message: "pablo: chapter 2 is not ready to draft", missing: ["no beat for chapter 2 in outline/chapters.md"] }); await sleep(60);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("Not written");
  expect(frame).toContain("chapter 2 is not ready to draft");
  expect(frame).toContain("- no beat for chapter 2 in outline/chapters.md");
  expect(frame).toContain("book ·");
});

test("a w off a chapter says to select one and never calls the writer; a second write is not started while one runs", async () => {
  const w = controlled();
  const app = mount(w.writer);
  await sleep(30);
  app.stdin.write("a"); await sleep(20); app.stdin.write("w"); await sleep(40);
  expect(w.calls).toEqual([]);
  expect(plain(app.lastFrame())).toContain("Select a chapter to write.");
  await selectChapter(app, 1);
  app.stdin.write("a"); await sleep(20); app.stdin.write("w"); await sleep(40);
  app.stdin.write("a"); await sleep(20); app.stdin.write("w"); await sleep(40);
  expect(w.calls).toEqual([1]);
  expect(plain(app.lastFrame())).toContain("chapter 1 is still being written");
});

test("write actions: one write at a time; progress outside a write is ignored; done opens the review and lists the branch", () => {
  let s = reduce(initialState(), { type: "write.progress", line: "stray" });
  expect(s.content).toBeNull();
  s = reduce(s, { type: "write.start", chapter: 3 });
  expect(reduce(s, { type: "write.start", chapter: 4 }).writing).toBe(3);
  s = reduce(s, { type: "write.done", branch: "draft/ch03", lines: ["receipt"] });
  expect(s.writing).toBeNull();
  expect(s.mode).toEqual({ kind: "review", branch: "draft/ch03" });
  expect(s.written).toEqual(["draft/ch03"]);
  expect(s.content?.body).toBe("receipt");
});

test("a writer that throws is shown as a failure, not a crash", async () => {
  const app = mount(() => Promise.reject(new Error("endpoint down")));
  await sleep(30);
  await selectChapter(app, 1);
  app.stdin.write("a"); await sleep(20); app.stdin.write("w"); await sleep(60);
  expect(plain(app.lastFrame())).toContain("endpoint down");
});

test("progress keeps the latest lines, so the newest is in view however long the write runs", () => {
  let s = reduce(initialState(), { type: "write.start", chapter: 1 });
  for (let i = 1; i <= 20; i++) s = reduce(s, { type: "write.progress", line: `line ${i}` });
  expect(s.content?.body.split("\n")).toEqual(["line 16", "line 17", "line 18", "line 19", "line 20"]);
});
