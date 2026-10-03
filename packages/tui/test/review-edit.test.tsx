// `e` in a review edits the change under the cursor (AGT-1591): the session gets the review's branch and the change's
// file and line; a committed edit makes the review read the branch's diff again. Fake sessions: no editor is ever launched.

import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { bookRail, type BookStage } from "../src/book";
import { editTarget, loadReview } from "../src/review";
import type { EditRequest, EditResult, FinishResult, Finisher } from "../src/screen";
import { initialState, reduce } from "../src/state";

afterEach(() => cleanup());
const plain = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ENTER = "\r", DOWN = "\x1b[B";
const STAGES: BookStage[] = [{ id: "premise", name: "premise", depth: 0, status: "ready", missing: [] }];

const DIFF = `diff --git a/chapters/03-the-well.md b/chapters/03-the-well.md
index 1111111..2222222 100644
--- a/chapters/03-the-well.md
+++ b/chapters/03-the-well.md
@@ -1,7 +1,8 @@
 The well had been dry since June.
-She did not look up when the door opened.
-Edwin sat at the table.
+She never looked up when the door opened.
+Nobody sat at the table.
+The kettle ticked.
 
 The road was empty.
 It was a long way to town.
@@ -20,3 +21,3 @@
 Dusk came early.
-It was cold.
+It was bitterly cold.
 Nobody spoke.
`;
/** The branch after an edit: the second change's sentence is different. */
const EDITED = DIFF.replace("It was bitterly cold.", "It was cold as iron.");

// A removal at old line 12, after a change that added one more line than it removed (so the new text is one line longer there).
const REMOVAL = "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1,3 +1,4 @@\n One.\n-Two.\n+Two b.\n+Two c.\n Three.\n@@ -10,4 +11,3 @@\n Ten.\n-Eleven.\n Twelve.\n Thirteen.\n";

test("editTarget: a change's first added line; a pure removal is the line before it, carried to the new text", () => {
  const r = loadReview({ ok: true, text: DIFF });
  expect(editTarget(r, "edit:0")).toEqual({ file: "chapters/03-the-well.md", line: 2 });
  expect(editTarget(r, "edit:1")).toEqual({ file: "chapters/03-the-well.md", line: 22 });
  expect(editTarget(r, "file:chapters/03-the-well.md")).toBeUndefined();
  const rm = loadReview({ ok: true, text: REMOVAL });
  // Removal of old line 11: the line before is old 10, which is new line 11 after the earlier change's one extra line.
  expect(editTarget(rm, "edit:1")).toEqual({ file: "a.md", line: 11 });
});

function mount(opts: { session?: (r: EditRequest) => Promise<EditResult>; finisher?: Finisher; diff: () => string }) {
  return render(<App title="Ice House" format="novel" book={bookRail(STAGES)} branches={["draft/ch03"]} diffOf={() => ({ ok: true, text: opts.diff() })} {...(opts.session ? { editSession: opts.session } : {})} {...(opts.finisher ? { finisher: opts.finisher } : {})} editor="vim" size={{ cols: 110, rows: 32 }} />);
}
/** Into the review of draft/ch03 with the cursor on its second change. */
async function toSecondChange(app: ReturnType<typeof mount>) {
  for (const k of [DOWN, DOWN, ENTER, DOWN, DOWN]) { app.stdin.write(k); await sleep(30); }
}

test("e hands the session the review's branch, the change's file and first added line, and the configured editor", async () => {
  const calls: EditRequest[] = [];
  const app = mount({ diff: () => DIFF, session: async (r) => { calls.push(r); return { ok: true, branch: null, lines: ["no change to chapters/03-the-well.md"] }; } });
  await sleep(30);
  await toSecondChange(app);
  app.stdin.write("e"); await sleep(60);
  expect(calls).toEqual([{ file: "chapters/03-the-well.md", line: 22, editor: "vim", branch: "draft/ch03" }]);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("No change");
  expect(frame).toContain("review draft/ch03");
});

test("a committed edit reloads the review from the branch's new diff, and the decisions made on the old one go", async () => {
  let diff = DIFF;
  const app = mount({ diff: () => diff, session: async () => { diff = EDITED; return { ok: true, branch: "draft/ch03", lines: ["committed chapters/03-the-well.md on draft/ch03 (abc1234)"] }; } });
  await sleep(30);
  await toSecondChange(app);
  app.stdin.write("y"); await sleep(30);
  expect(plain(app.lastFrame())).toContain("bitterly cold");
  app.stdin.write("e"); await sleep(80);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("Edited on draft/ch03");
  expect(frame).toContain("decide each change again");
  expect(frame).toContain("cold as iron");
  expect(frame).not.toContain("bitterly cold");
  expect(frame).toContain("review draft/ch03");
});

test("e on a file row, with no session, or while a finish is running is refused with a message and runs no editor", async () => {
  const calls: EditRequest[] = [];
  const session = async (r: EditRequest): Promise<EditResult> => { calls.push(r); return { ok: true, branch: null, lines: [] }; };
  // On the file's group row.
  let app = mount({ diff: () => DIFF, session });
  await sleep(30);
  for (const k of [DOWN, DOWN, ENTER]) { app.stdin.write(k); await sleep(30); }
  app.stdin.write("e"); await sleep(40);
  expect(plain(app.lastFrame())).toContain("Select a change to edit.");
  cleanup();
  // No session wired.
  app = mount({ diff: () => DIFF });
  await sleep(30);
  await toSecondChange(app);
  app.stdin.write("e"); await sleep(40);
  expect(plain(app.lastFrame())).toContain("Editing is not available here.");
  cleanup();
  // A finish that has not come back.
  const finisher: Finisher = () => new Promise<FinishResult>(() => {});
  app = mount({ diff: () => DIFF, session, finisher });
  await sleep(30);
  for (const k of [DOWN, DOWN, ENTER, DOWN, "y", DOWN, "y", "s"]) { app.stdin.write(k); await sleep(30); }
  app.stdin.write("e"); await sleep(40);
  expect(plain(app.lastFrame())).toContain("A finish is running");
  expect(calls).toEqual([]);
});

test("edit.start in a review is refused while a write, a finish, a revise or another edit is running", () => {
  const review = { ...initialState(), mode: { kind: "review" as const, branch: "draft/ch03" } };
  const start = { type: "edit.start" as const, file: "a.md", line: 1, branch: "draft/ch03" };
  expect(reduce(review, start).editing).toEqual({ file: "a.md", line: 1, branch: "draft/ch03" });
  expect(reduce({ ...review, writing: 3 }, start).editing).toBeNull();
  expect(reduce({ ...review, finishing: "draft/ch03" }, start).editing).toBeNull();
  const busy = reduce(review, start);
  expect(reduce(busy, { ...start, line: 9 }).editing).toEqual(busy.editing);
  // `v e` (no branch) is still the book's.
  expect(reduce(review, { type: "edit.start", file: "a.md", line: 1 }).editing).toBeNull();
  // A review edit that committed leaves the book's edit branch alone.
  expect(reduce(busy, { type: "edit.done", branch: "draft/ch03", lines: [] }).editBranch).toBeNull();
});
