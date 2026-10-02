import { afterEach, expect, test } from "bun:test";
import { detectMoves, parseDiff } from "@openthink/pablo-core";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { bookRail, type BookStage } from "../src/book";
import { branchRows, loadReview, reviewLines, wrapLine } from "../src/review";
import { markWords, stitch } from "../src/stitch";

afterEach(() => cleanup());
const plain = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ENTER = "\r", ESC = "\x1b", DOWN = "\x1b[B";

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

test("markWords highlights only the words that differ", () => {
  const { removed, added } = markWords(["She did not look up."], ["She never looked up."]);
  expect(removed[0]!.filter((s) => s.hl).map((s) => s.text.trim())).toEqual(["did not look"]);
  expect(added[0]!.filter((s) => s.hl).map((s) => s.text.trim())).toEqual(["never looked"]);
  expect(removed[0]!.map((s) => s.text).join("")).toBe("She did not look up.");
});

test("stitch: adjacent changed sentences are one edit; a separate hunk is another", () => {
  const edits = stitch(parseDiff(DIFF));
  expect(edits.map((e) => [e.kind, e.removed, e.added, e.line])).toEqual([["change", 2, 3, 2], ["change", 1, 1, 22]]);
  // One line of context either side.
  expect(edits[0]!.rows.map((r) => r.sign).join("")).toBe(" --+++ ");
});

test("stitch: pure additions and removals have no word marking; a moved paragraph is one move, not two edits", () => {
  const add = stitch(parseDiff("diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1,1 +1,2 @@\n One.\n+Two.\n"));
  expect(add.map((e) => e.kind)).toEqual(["add"]);
  expect(add[0]!.rows[1]!.segs).toEqual([{ text: "Two.", hl: false }]);
  const moved = parseDiff(
    "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1,7 +1,7 @@\n-Para one a.\n-Para one b.\n+Para two a.\n+Para two b.\n \n Mid.\n \n-Para two a.\n-Para two b.\n+Para one a.\n+Para one b.\n",
  );
  expect(detectMoves(moved)).toHaveLength(2);
  const edits = stitch(moved, detectMoves(moved));
  expect(edits.map((e) => e.kind)).toEqual(["move", "move"]);
  expect(edits[0]!.from).toEqual({ path: "a.md", line: 6 });
});

test("loadReview: file groups and edit rows; control characters in the diff never reach the rows", () => {
  const r = loadReview({ ok: true, text: DIFF.replace("kettle", "ke\x1b[31mttle") });
  expect(r.rows.map((x) => x.id)).toEqual(["file:chapters/03-the-well.md", "edit:0", "edit:1"]);
  expect(r.labels["file:chapters/03-the-well.md"]).toBe("chapters/03-the-well.md (2)");
  expect(JSON.stringify([...r.edits.values()])).not.toContain("\\u001b");
  expect(loadReview({ ok: true, text: "" }).notice).toBe("No changes against main.");
  expect(loadReview({ ok: false, notice: "pablo: git\x1b[2J failed" }).notice).toBe("pablo: git failed");
  expect(loadReview(undefined).notice).toContain("could not be read");
});

test("wrapLine wraps on words, keeps highlights, and cuts a word longer than the pane", () => {
  const rows = wrapLine({ sign: "+", segs: [{ text: "one two ", hl: false }, { text: "three four", hl: true }] }, 8);
  expect(rows.map((r) => r.segs.map((s) => s.text).join(""))).toEqual(["one two", "three", "four"]);
  expect(rows.map((r) => !!r.cont)).toEqual([false, true, true]);
  expect(rows[1]!.segs[0]!.hl).toBe(true);
  expect(wrapLine({ sign: "+", segs: [{ text: "abcdefghij", hl: false }] }, 4).map((r) => r.segs[0]!.text)).toEqual(["abcd", "efgh", "ij"]);
  expect(reviewLines(loadReview({ ok: true, text: DIFF }), "edit:0", 40).title).toBe("chapters/03-the-well.md · line 2 · change");
});

test("branchRows: a group and a row per branch; none waiting, no rows", () => {
  expect(branchRows([])).toEqual({ rows: [], labels: {} });
  const r = branchRows(["draft/ch03", "revise/ab12"]);
  expect(r.rows.map((x) => x.id)).toEqual(["branches", "branch:draft/ch03", "branch:revise/ab12"]);
  expect(r.labels["branches"]).toBe("branches to review (2)");
});

const stage = (id: string, name: string, status: BookStage["status"]): BookStage => ({ id, name, depth: 0, status, missing: [] });
const STAGES = [stage("premise", "premise", "ready")];
const mount = (extra: { branches?: string[]; diff?: string } = {}) =>
  render(
    <App title="Ice House" format="novel" book={bookRail(STAGES)} branches={extra.branches ?? ["draft/ch03"]} diffOf={() => ({ ok: true, text: extra.diff ?? DIFF })} size={{ cols: 110, rows: 32 }} />,
  );

test("book mode lists the branches; Enter opens one: the rail lists its changes, the main pane the removed and added lines; Esc returns", async () => {
  const app = mount();
  await sleep(30);
  let frame = plain(app.lastFrame());
  expect(frame).toContain("branches to review (1)");
  expect(frame).toContain("draft/ch03");
  app.stdin.write(DOWN); await sleep(20); // the branches group
  app.stdin.write(DOWN); await sleep(20); // the branch
  app.stdin.write(ENTER); await sleep(40);
  frame = plain(app.lastFrame());
  expect(frame).toContain("review draft/ch03");
  expect(frame).toContain("CHANGES");
  expect(frame).toContain("chapters/03-the-well.md (2)");
  app.stdin.write(DOWN); await sleep(20); // onto the first edit
  frame = plain(app.lastFrame());
  expect(frame).toContain("- She did not look up when the door opened.");
  expect(frame).toContain("+ She never looked up when the door opened.");
  expect(frame).toContain("+ The kettle ticked.");
  app.stdin.write(DOWN); await sleep(30); // the second edit
  frame = plain(app.lastFrame());
  expect(frame).toContain("- It was cold.");
  expect(frame).toContain("+ It was bitterly cold.");
  app.stdin.write(ESC); await sleep(60);
  frame = plain(app.lastFrame());
  expect(frame).toContain("book ·");
  expect(frame).toContain("branches to review (1)");
  expect(frame).not.toContain("CHANGES");
});

test("a branch name is cleaned wherever it is shown; an empty diff says so", async () => {
  const app = mount({ branches: ["draft/ch\x1b]0;pwned\x07"], diff: "" });
  await sleep(30);
  app.stdin.write(DOWN); await sleep(20);
  app.stdin.write(DOWN); await sleep(20);
  app.stdin.write(ENTER); await sleep(40);
  const raw = app.lastFrame() ?? "";
  expect(raw).not.toContain("pwned\x07");
  expect(raw).not.toContain("\x1b]0;");
  expect(plain(raw)).toContain("No changes against main.");
});

test("y and n mark the change under the cursor; the rail and the status counts show it; pressing again changes it", async () => {
  const app = mount();
  await sleep(30);
  for (const k of [DOWN, DOWN, ENTER, DOWN]) { app.stdin.write(k); await sleep(30); } // into the review, onto edit 0
  let frame = plain(app.lastFrame());
  expect(frame).toContain("0 accepted · 0 rejected · 2 pending");
  app.stdin.write("y"); await sleep(30);
  frame = plain(app.lastFrame());
  expect(frame).toMatch(/✓ ~ She never looked up/);
  expect(frame).toContain("1 accepted · 0 rejected · 1 pending");
  app.stdin.write("n"); await sleep(30);
  frame = plain(app.lastFrame());
  expect(frame).toMatch(/✗ ~ She never looked up/);
  expect(frame).toContain("0 accepted · 1 rejected · 1 pending");
  app.stdin.write("n"); await sleep(30);
  expect(plain(app.lastFrame())).toContain("0 accepted · 0 rejected · 2 pending");
});
