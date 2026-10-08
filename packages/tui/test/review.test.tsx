import { afterEach, expect, test } from "bun:test";
import { detectMoves, parseDiff } from "@openthink/pablo-core";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { bookRail, type BookStage } from "../src/book";
import { branchRows, commentRows, loadReview, reviewLines, wrapLine } from "../src/review";
import type { ReviewComment } from "../src/review";
import type { FinishResult, Finisher, Rejected } from "../src/screen";
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

test("y and n mark the change under the cursor and move on to the next undecided one; the same key again clears it", async () => {
  const app = mount();
  await sleep(30);
  for (const k of [DOWN, DOWN, ENTER, DOWN]) { app.stdin.write(k); await sleep(30); } // into the review, onto edit 0
  let frame = plain(app.lastFrame());
  expect(frame).toContain("0 accepted · 0 rejected · 2 pending");
  app.stdin.write("y"); await sleep(30);
  frame = plain(app.lastFrame());
  expect(frame).toMatch(/✓ ~ She never looked up/);
  expect(frame).toContain("1 accepted · 0 rejected · 1 pending");
  expect(frame).toContain("line 22 · change"); // moved on to the next change
  app.stdin.write("k"); await sleep(30);
  app.stdin.write("n"); await sleep(30);
  frame = plain(app.lastFrame());
  expect(frame).toMatch(/✗ ~ She never looked up/);
  expect(frame).toContain("0 accepted · 1 rejected · 1 pending");
  app.stdin.write("k"); await sleep(30);
  app.stdin.write("n"); await sleep(30);
  frame = plain(app.lastFrame());
  expect(frame).toContain("0 accepted · 0 rejected · 2 pending");
  expect(frame).toContain("line 2 · change"); // a cleared mark stays put
});

test("g f and g F step between the changes, wrapping round, from the main pane too", async () => {
  const app = mount();
  await sleep(30);
  for (const k of [DOWN, DOWN, ENTER]) { app.stdin.write(k); await sleep(30); } // into the review, on the file row
  app.stdin.write("g"); await sleep(20); app.stdin.write("f"); await sleep(30);
  expect(plain(app.lastFrame())).toContain("line 2 · change");
  app.stdin.write("l"); await sleep(30); // into the main pane
  app.stdin.write("g"); await sleep(20); app.stdin.write("f"); await sleep(30);
  expect(plain(app.lastFrame())).toContain("line 22 · change");
  app.stdin.write("g"); await sleep(20); app.stdin.write("f"); await sleep(30);
  expect(plain(app.lastFrame())).toContain("line 2 · change"); // wrapped round
  app.stdin.write("g"); await sleep(20); app.stdin.write("F"); await sleep(30);
  expect(plain(app.lastFrame())).toContain("line 22 · change");
});

test("loadReview renders through core's stitcher: a moved paragraph is one row, a paragraph split is labelled as one", () => {
  const moved = loadReview({
    ok: true,
    text: "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1,6 +1,6 @@\n+The harbor was quiet.\n+\n Mid.\n Mid two.\n-\n-The harbor was quiet.\n",
  });
  expect(moved.rows.map((x) => x.id)).toEqual(["file:a.md", "edit:0"]);
  expect(moved.labels["edit:0"]).toBe("⇄ The harbor was quiet.");
  const split = loadReview({ ok: true, text: "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1,2 +1,3 @@\n One.\n+\n Two.\n" });
  expect(split.labels["edit:0"]).toBe("+ (paragraph break)");
});

/** A finisher the test records: it resolves with `result` and notes what the screen handed it. */
const finishing = (result: FinishResult = { ok: true, lines: ["merged draft/ch03 into main (abc1234)", "outline: ran"] }) => {
  const calls: { branch: string; rejected: Rejected }[] = [];
  const finisher: Finisher = async (branch, rejected) => { calls.push({ branch, rejected }); return result; };
  return { finisher, calls };
};
const mountFinish = (finisher: Finisher) =>
  render(<App title="Ice House" format="novel" book={bookRail(STAGES)} branches={["draft/ch03"]} diffOf={() => ({ ok: true, text: DIFF })} finisher={finisher} size={{ cols: 110, rows: 32 }} />);

test("s refuses while a change has no decision; nothing reaches the finisher", async () => {
  const f = finishing();
  const app = mountFinish(f.finisher);
  await sleep(30);
  for (const k of [DOWN, DOWN, ENTER, DOWN, "y", "s"]) { app.stdin.write(k); await sleep(30); }
  const frame = plain(app.lastFrame());
  expect(frame).toContain("Not finished");
  expect(frame).toContain("1 change has no decision yet");
  expect(frame).toContain("review draft/ch03");
  expect(f.calls).toEqual([]);
});

test("s hands the finisher the lines of the rejected edits only, then closes the review and retires the branch", async () => {
  const f = finishing();
  const app = mountFinish(f.finisher);
  await sleep(30);
  for (const k of [DOWN, DOWN, ENTER, DOWN, "n", DOWN, "y", "s"]) { app.stdin.write(k); await sleep(30); }
  await sleep(40);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]!.branch).toBe("draft/ch03");
  // Edit 0 (rejected) owns old lines 2-3 and new lines 2-4; edit 1 (accepted) owns neither list.
  expect(f.calls[0]!.rejected.removed.map((r) => r.line)).toEqual([2, 3]);
  expect(f.calls[0]!.rejected.added.map((r) => r.line)).toEqual([2, 3, 4]);
  expect(f.calls[0]!.rejected.removed.every((r) => r.path === "chapters/03-the-well.md")).toBe(true);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("book ·");
  expect(frame).toContain("Finished draft/ch03");
  expect(frame).toContain("outline: ran");
  expect(frame).not.toContain("branches to review");
});

test("a failed finish stays in the review with the reason", async () => {
  const f = finishing({ ok: false, message: "pablo: git merge failed: conflict" });
  const app = mountFinish(f.finisher);
  await sleep(30);
  for (const k of [DOWN, DOWN, ENTER, DOWN, "y", DOWN, "y", "s"]) { app.stdin.write(k); await sleep(30); }
  await sleep(40);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("Not finished");
  expect(frame).toContain("git merge failed: conflict");
  expect(frame).toContain("review draft/ch03");
});

const critic = (path: string, line: number, label: string, body: string): ReviewComment => ({ source: "critic", path, line, author: "critic", body, label });
const COMMENTS: ReviewComment[] = [
  critic("chapters/03-the-well.md", 3, "continuity", "Edwin died in chapter 1; he cannot sit at the table.\x1b[2J"),
  critic("chapters/03-the-well.md", 22, "tells", "stock intensifier"),
  { source: "reader", tag: "fix", path: "chapters/03-the-well.md", line: 15, author: "atara", body: "on no edit's lines" },
  { source: "reader", tag: "keep", path: "chapters/03-the-well.md", startLine: 2, line: 3, author: "atara", body: "I like the kettle." },
  { source: "author", path: "chapters/03-the-well.md", author: "matt", body: "whole file: tighten" },
  { source: "reader", review: true, path: "", author: "atara", body: "Loved it overall." },
  { source: "reader", tag: "fix", path: "chapters/09-else.md", line: 3, author: "atara", body: "other file" },
];
const text = (rows: readonly { segs: readonly { text: string }[] }[]) => rows.map((x) => x.segs.map((s) => s.text).join("")).join("\n");

test("line comments from any source attach to the edit whose added lines they are on, counted by source and tag", () => {
  const r = loadReview({ ok: true, text: DIFF }, COMMENTS);
  expect([...r.comments.keys()]).toEqual(["edit:0", "edit:1"]);
  expect(r.counts).toEqual({ critic: 2, "reader fix": 2, "reader keep": 1, author: 1, reader: 1 });
  const rows = reviewLines(r, "edit:0", 50).rows;
  const boxes = rows.filter((x) => x.box).map((x) => x.segs.map((s) => s.text).join(""));
  const shown = boxes.join("\n");
  expect(shown).toContain("╭ ▲ critic · continuity · line 3");
  expect(shown).toContain("╭ ▲ reader keep · lines 2-3");
  expect(shown).toContain("atara");
  expect(shown).toContain("Edwin died in chapter 1");
  expect(shown).not.toContain("\x1b");
  expect(boxes.at(-1)).toStartWith("╰");
  // The review summary and the file's comments come first, then the diff rows, then the line boxes under them.
  expect(shown.indexOf("▲ reader · review")).toBeLessThan(shown.indexOf("▲ critic"));
  const firstDiff = rows.findIndex((x) => !x.box);
  expect(rows.slice(0, firstDiff).map((x) => x.segs[0]!.text).join("\n")).toContain("Loved it overall.");
  expect(rows.slice(0, firstDiff).map((x) => x.segs[0]!.text).join("\n")).toContain("▲ author · file");
  expect(rows.slice(0, firstDiff).map((x) => x.segs[0]!.text).join("\n")).toContain("▲ reader fix · line 15");
  expect(rows.slice(firstDiff).findIndex((x) => x.box)).toBe(rows.slice(firstDiff).filter((x) => !x.box).length);
  expect(reviewLines(loadReview({ ok: true, text: DIFF }), "edit:0", 50).rows.some((x) => x.box)).toBe(false);
});

test("a line comment, a file-level comment and the review summary each render; the summary is on every pane, a file's comments on its group row", () => {
  const r = loadReview({ ok: true, text: DIFF }, COMMENTS);
  const group = text(reviewLines(r, "file:chapters/03-the-well.md", 60).rows);
  expect(group).toContain("▲ reader · review");
  expect(group).toContain("▲ author · file");
  expect(group).toContain("whole file: tighten");
  expect(group).not.toContain("other file");
  expect(text(reviewLines(r, "edit:1", 60).rows)).toContain("Loved it overall.");
  expect(text(reviewLines(r, "edit:1", 60).rows)).toContain("▲ critic · tells · line 22");
  expect(text(reviewLines(r, "file:chapters/09-else.md", 60).rows)).toContain("other file");
});

test("commentRows: every row is the same width, and a long body wraps inside the box", () => {
  const rows = commentRows({ source: "reader", tag: "fix", path: "a.md", line: 4, author: "atara", body: "word ".repeat(30) }, 30).map((x) => x.segs[0]!.text);
  expect(rows.length).toBeGreaterThan(3);
  expect(new Set(rows.map((x) => [...x].length))).toEqual(new Set([30]));
});

test("review mode shows the comments as boxes, and the status counts them by source and tag", async () => {
  const app = render(
    <App title="Ice House" format="novel" book={bookRail(STAGES)} branches={["draft/ch03"]} diffOf={() => ({ ok: true, text: DIFF })} commentsOf={() => COMMENTS} size={{ cols: 200, rows: 40 }} />,
  );
  await sleep(30);
  app.stdin.write(DOWN); await sleep(20);
  app.stdin.write(DOWN); await sleep(20);
  app.stdin.write(ENTER); await sleep(40);
  app.stdin.write(DOWN); await sleep(20);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("▲ critic · continuity · line 3");
  expect(frame).toContain("Edwin died in chapter 1");
  expect(frame).toContain("Loved it overall.");
  expect(frame).toContain("2 critic");
  expect(frame).toContain("2 reader fix");
  expect(frame).toContain("1 reader keep");
  expect(frame).toContain("1 author");
});

test("c in a review types a one-line comment on the change's first line; Enter saves it and the box shows at once; Esc cancels", async () => {
  const store: ReviewComment[] = [];
  const saved: { branch: string; comment: ReviewComment }[] = [];
  const saver = (branch: string, comment: ReviewComment) => { saved.push({ branch, comment }); store.push({ ...comment, author: "matt" }); return { ok: true } as const; };
  const app = render(
    <App title="Ice House" format="novel" book={bookRail(STAGES)} branches={["draft/ch03"]} diffOf={() => ({ ok: true, text: DIFF })} commentsOf={() => store} commentSaver={saver} size={{ cols: 120, rows: 36 }} />,
  );
  await sleep(30);
  app.stdin.write(DOWN); await sleep(20);
  app.stdin.write(DOWN); await sleep(20);
  app.stdin.write(ENTER); await sleep(40);
  // On a file's group row there is no change to comment on.
  app.stdin.write("c"); await sleep(30);
  expect(plain(app.lastFrame())).toContain("Move the cursor to a change or a comment first");
  app.stdin.write(ESC); await sleep(20);
  app.stdin.write(DOWN); await sleep(20);
  app.stdin.write("c"); await sleep(30);
  expect(plain(app.lastFrame())).toContain("Comment on chapters/03-the-well.md line 2");
  // Keys are text now: `y` does not accept the change, Esc cancels and saves nothing.
  app.stdin.write("y"); await sleep(20);
  app.stdin.write(ESC); await sleep(30);
  expect(saved).toEqual([]);
  expect(plain(app.lastFrame())).not.toContain("Comment on");
  app.stdin.write("c"); await sleep(30);
  app.stdin.write("too "); await sleep(10);
  app.stdin.write("blunt"); await sleep(10);
  app.stdin.write("\x7f"); await sleep(10);
  app.stdin.write("t"); await sleep(20);
  expect(plain(app.lastFrame())).toContain("too blunt");
  app.stdin.write(ENTER); await sleep(40);
  expect(saved).toEqual([{ branch: "draft/ch03", comment: { source: "author", path: "chapters/03-the-well.md", line: 2, author: "", body: "too blunt" } }]);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("▲ author · line 2");
  expect(frame).toContain("too blunt");
  expect(frame).toContain("1 author");
});

test("an empty comment is not saved; a refusal from the saver stays open with its reason", async () => {
  let refuse = true;
  const saver = (_b: string, _c: ReviewComment) => (refuse ? ({ ok: false, message: "disk full" } as const) : ({ ok: true } as const));
  const app = render(
    <App title="Ice House" format="novel" book={bookRail(STAGES)} branches={["draft/ch03"]} diffOf={() => ({ ok: true, text: DIFF })} commentSaver={saver} size={{ cols: 120, rows: 36 }} />,
  );
  await sleep(30);
  for (let i = 0; i < 3; i++) { app.stdin.write(DOWN); await sleep(20); }
  app.stdin.write(ENTER); await sleep(40);
  app.stdin.write(DOWN); await sleep(20);
  app.stdin.write("c"); await sleep(30);
  app.stdin.write(ENTER); await sleep(30);
  expect(plain(app.lastFrame())).toContain("Comment on");
  app.stdin.write("hm"); await sleep(10);
  app.stdin.write(ENTER); await sleep(30);
  expect(plain(app.lastFrame())).toContain("disk full");
  refuse = false;
  app.stdin.write(ENTER); await sleep(30);
  expect(plain(app.lastFrame())).not.toContain("Comment on");
});

// A reader who only commented (AGT-1641 follow-up): the branch changes nothing, so each comment is its own row with
// the chapter's lines around it, and the review can still be finished.
const CH3 = "novels/vs/chapters/03-yard.md";
const CH3_TEXT = ["---", "chapter: 3", "---", "", "Cora watched from the winery door.", "The man was young, perhaps thirty-seven.", "He was looking for something.", "", "The sun turned the cliffs burnt sienna.", "The heat faded."].join("\n");
const READER_NOTES: ReviewComment[] = [
  { source: "reader", path: "", review: true, author: "Atara", body: "overall really easy to read" },
  { source: "reader", path: CH3, line: 9, author: "Atara", body: "burnt sienna has come up multiple times" },
  { source: "reader", path: CH3, line: 6, author: "Atara", body: "how young is cora?" },
];

test("loadReview: line comments on unchanged text are notes in line order, each with the lines around it", () => {
  const review = loadReview({ ok: true, text: "" }, READER_NOTES, (path) => (path === CH3 ? CH3_TEXT : undefined));
  expect(review.notice).toBeUndefined();
  expect(review.rows.map((r) => r.id)).toEqual([`file:${CH3}`, "note:2", "note:1"]);
  expect(review.labels["note:2"]).toBe("› how young is cora?");
  expect(review.labels[`file:${CH3}`]).toBe(`${CH3} (2)`);
  const { title, rows } = reviewLines(review, "note:2", 80);
  expect(title).toBe(`${CH3} · line 6 · comment`);
  const text = rows.map((r) => r.segs.map((g) => g.text).join(""));
  expect(text.some((t) => t.includes("overall really easy to read"))).toBe(true); // the summary on top
  expect(text).toContain("Cora watched from the winery door.");
  expect(text).toContain("He was looking for something.");
  const rowWith = (words: string) => rows.find((r) => r.segs.map((g) => g.text).join("").includes(words));
  expect(rowWith("perhaps thirty-seven")?.segs.every((g) => g.hl)).toBe(true);
  expect(rowWith("winery door")?.segs.some((g) => g.hl)).toBe(false);
  expect(text.some((t) => t.includes("how young is cora?"))).toBe(true);
});

test("loadReview: without the branch's text, comments on unchanged text stay at the top as before", () => {
  const review = loadReview({ ok: true, text: "" }, READER_NOTES);
  expect(review.rows).toEqual([]);
  expect(review.notice).toBe("No changes against main.");
  expect(review.fileComments.get(CH3)).toHaveLength(2);
});

test("a comments-only reader review: each comment is a row shown in context, and s finishes it with nothing rejected", async () => {
  const f = finishing({ ok: true, lines: ["nothing accepted: discarded reader/atara-2026-10-04"] });
  const app = render(<App title="Ice House" format="novel" book={bookRail(STAGES)} branches={["reader/atara-2026-10-04"]} diffOf={() => ({ ok: true, text: "" })} commentsOf={() => READER_NOTES} fileOf={(_b, path) => (path === CH3 ? CH3_TEXT : undefined)} finisher={f.finisher} size={{ cols: 110, rows: 32 }} />);
  await sleep(30);
  for (const k of [DOWN, DOWN, ENTER]) { app.stdin.write(k); await sleep(30); }
  let frame = plain(app.lastFrame());
  expect(frame).toContain("› how young is cora?");
  expect(frame).toContain("› burnt sienna has come");
  expect(frame).not.toContain("No changes against main.");
  app.stdin.write(DOWN); await sleep(30);
  frame = plain(app.lastFrame());
  expect(frame).toContain("line 6 · comment");
  expect(frame).toContain("The man was young, perhaps thirty-seven.");
  app.stdin.write("s"); await sleep(60);
  expect(f.calls).toEqual([]); // a comment needs a decision too
  expect(plain(app.lastFrame())).toContain("2 changes have no decision yet");
  app.stdin.write("y"); await sleep(30); // the first comment, then on to the second
  frame = plain(app.lastFrame());
  expect(frame).toContain("✓ › how young is cora?");
  expect(frame).toContain("line 9 · comment");
  app.stdin.write("n"); await sleep(30);
  expect(plain(app.lastFrame())).toContain("1 accepted · 1 rejected · 0 pending");
  app.stdin.write("s"); await sleep(60);
  expect(f.calls).toEqual([{ branch: "reader/atara-2026-10-04", rejected: { removed: [], added: [] } }]);
  expect(plain(app.lastFrame())).toContain("discarded reader/atara-2026-10-04");
});
