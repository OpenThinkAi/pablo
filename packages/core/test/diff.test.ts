import { expect, test } from "bun:test";
import { countLines, detectMoves, parseDiff } from "../src/index";

// Invented fixture: chapter one edits a sentence and moves a paragraph into chapter two.
const DIFF = `diff --git a/ch01.md b/ch01.md
index 1111111..2222222 100644
--- a/ch01.md
+++ b/ch01.md
@@ -1,9 +1,6 @@
 The lamp flickered.
-Mira counted the steps.
+Mira counted the stairs.
 
-The harbor was quiet.
-Gulls wheeled overhead.
-
 Morning came late.
 It brought rain.
 
@@ -20,2 +17,2 @@ Part two
 Closing line.
\\ No newline at end of file
diff --git a/ch02.md b/ch02.md
index 3333333..4444444 100644
--- a/ch02.md
+++ b/ch02.md
@@ -4,2 +4,6 @@
 Dusk fell.
+
+The harbor was quiet.
+Gulls wheeled overhead.
+
 Doors closed.
diff --git a/old name.md b/new name.md
similarity index 100%
rename from old name.md
rename to new name.md
diff --git a/new.md b/new.md
new file mode 100644
--- /dev/null
+++ b/new.md
@@ -0,0 +1 @@
+Brand new.
diff --git a/gone.md b/gone.md
deleted file mode 100644
--- a/gone.md
+++ /dev/null
@@ -1 +0,0 @@
-Goodbye.
diff --git a/cover.png b/cover.png
Binary files a/cover.png and b/cover.png differ
`;

test("files, statuses and hunk headers", () => {
  const files = parseDiff(DIFF);
  expect(files.map((f) => [f.path, f.status])).toEqual([
    ["ch01.md", "modified"],
    ["ch02.md", "modified"],
    ["new name.md", "renamed"],
    ["new.md", "added"],
    ["gone.md", "deleted"],
    ["cover.png", "modified"],
  ]);
  expect(files[2]!.oldPath).toBe("old name.md");
  expect(files[5]!.binary).toBe(true);
  const [h1, h2] = files[0]!.hunks;
  expect([h1!.oldStart, h1!.oldCount, h1!.newStart, h1!.newCount]).toEqual([1, 9, 1, 6]);
  expect(h2!.context).toBe("Part two");
  expect(files[3]!.hunks[0]!.oldCount).toBe(0);
  expect(files[4]!.hunks[0]!.newCount).toBe(0);
  expect(files[4]!.hunks[0]!.oldCount).toBe(1);
});

test("lines carry old and new numbers", () => {
  const lines = parseDiff(DIFF)[0]!.hunks[0]!.lines;
  expect(lines[0]).toEqual({ t: " ", text: "The lamp flickered.", o: 1, n: 1 });
  expect(lines[1]).toEqual({ t: "-", text: "Mira counted the steps.", o: 2, n: null });
  expect(lines[2]).toEqual({ t: "+", text: "Mira counted the stairs.", o: null, n: 2 });
  expect(lines[4]).toEqual({ t: "-", text: "The harbor was quiet.", o: 4, n: null });
});

test("no-newline marker is not a line", () => {
  const h = parseDiff(DIFF)[0]!.hunks[1]!;
  expect(h.lines).toHaveLength(1);
});

test("quoted paths with spaces", () => {
  const f = parseDiff('diff --git "a/my ch.md" "b/my ch.md"\n@@ -1 +1 @@\n-a\n+b\n');
  expect(f[0]!.path).toBe("my ch.md");
});

test("countLines", () => {
  expect(countLines(parseDiff(DIFF)[0]!)).toEqual({ added: 1, removed: 4 });
});

test("a paragraph moved unchanged is a move", () => {
  const moves = detectMoves(parseDiff(DIFF));
  expect(moves).toEqual([
    {
      from: { path: "ch01.md", start: 4, count: 2 },
      to: { path: "ch02.md", start: 6, count: 2 },
      lines: ["The harbor was quiet.", "Gulls wheeled overhead."],
    },
  ]);
});

test("an edited sentence is not a move", () => {
  expect(detectMoves(parseDiff("diff --git a/x.md b/x.md\n@@ -1 +1 @@\n-one\n+two\n"))).toEqual([]);
});

test("a paragraph moved within a file", () => {
  const d = "diff --git a/x.md b/x.md\n@@ -1,5 +1,5 @@\n-A one.\n-A two.\n \n B.\n+\n+A one.\n+A two.\n";
  const m = detectMoves(parseDiff(d));
  expect(m).toHaveLength(1);
  expect(m[0]!.from.start).toBe(1);
  expect(m[0]!.to.start).toBe(4);
});

test("duplicate paragraphs pair one to one", () => {
  const d = "diff --git a/x.md b/x.md\n@@ -1,3 +1,1 @@\n-same\n \n-same\n@@ -9,0 +7,1 @@\n+same\n";
  expect(detectMoves(parseDiff(d))).toHaveLength(1);
});

test("garbage and empty input parse to nothing", () => {
  expect(parseDiff("")).toEqual([]);
  expect(parseDiff("hello\nworld")).toEqual([]);
});
