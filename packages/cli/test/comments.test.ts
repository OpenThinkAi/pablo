import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { addComment, commentsPath, parseComments, readComments, serializeComments, writeComments } from "../src/comments";
import type { StoredComment } from "../src/comments";
import { critiquePath, reviewCommentsOf } from "../src/critique";

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const temp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "pablo-comments-test-"))); dirs.push(d); return d; };

const LINE: StoredComment = { source: "reader", tag: "fix", path: "novels/x/chapters/01.md", line: 7, author: "atara", body: "unclear" };
const SPAN: StoredComment = { source: "reader", tag: "keep", path: "novels/x/chapters/01.md", startLine: 7, line: 9, author: "atara", body: "lovely" };
const FILE: StoredComment = { source: "author", path: "novels/x/chapters/01.md", author: "matt", body: "tighten the middle" };
const SUMMARY: StoredComment = { source: "reader", review: true, path: "", author: "atara", body: "Great chapter." };

test("the store lives at .pablo/comments/<branch>.json, the slash in the branch made safe", () => {
  expect(commentsPath("/w", "draft/ch03")).toBe(join("/w", ".pablo", "comments", "draft__ch03.json"));
});

test("entries of every kind (line, span, file-level, review summary) write and read back unchanged, in order", () => {
  const w = temp();
  writeComments(w, "draft/ch01", [LINE, SPAN, FILE, SUMMARY]);
  expect(existsSync(commentsPath(w, "draft/ch01"))).toBe(true);
  expect(readComments(w, "draft/ch01")).toEqual([LINE, SPAN, FILE, SUMMARY]);
  expect(readComments(w, "draft/other")).toEqual([]);
});

test("addComment appends to what is stored and refuses a malformed entry", () => {
  const w = temp();
  expect(addComment(w, "b", LINE)).toEqual(LINE);
  expect(addComment(w, "b", FILE)).toEqual(FILE);
  expect(addComment(w, "b", { ...LINE, body: undefined } as unknown as StoredComment)).toBeUndefined();
  expect(readComments(w, "b")).toEqual([LINE, FILE]);
});

test("a missing, empty, malformed or wrongly shaped file reads as no comments", () => {
  const w = temp();
  expect(readComments(w, "b")).toEqual([]);
  mkdirSync(join(w, ".pablo", "comments"), { recursive: true });
  for (const text of ["", "not json", "null", "[]", "{}", '{"comments":"x"}', '{"comments":{}}']) {
    writeFileSync(commentsPath(w, "b"), text);
    expect(readComments(w, "b")).toEqual([]);
    expect(parseComments(text)).toEqual([]);
  }
});

test("a bad entry is skipped without dropping its neighbours; a bad optional field is dropped, not the entry", () => {
  const text = JSON.stringify({
    comments: [
      LINE,
      null,
      "x",
      { ...LINE, source: "stranger" },
      { ...LINE, body: 3 },
      { ...LINE, author: undefined },
      { ...LINE, path: "" },
      { ...LINE, path: undefined },
      { ...SPAN, tag: "maybe", startLine: 12, extra: true }, // startLine after line: not a span; unknown tag and field dropped
      { ...LINE, line: 0 },
      { ...LINE, line: 1.5 },
      SUMMARY,
    ],
  });
  expect(parseComments(text)).toEqual([
    LINE,
    { source: "reader", path: SPAN.path, line: 9, author: "atara", body: "lovely" },
    { source: "reader", tag: "fix", path: LINE.path, author: "atara", body: "unclear" },
    { source: "reader", tag: "fix", path: LINE.path, author: "atara", body: "unclear" },
    SUMMARY,
  ]);
});

test("a summary carries no file or line; serialising normalises so a write reads back identical", () => {
  const odd = { ...SUMMARY, path: "ignored.md", line: 4, startLine: 2 } as StoredComment;
  expect(parseComments(serializeComments([odd]))).toEqual([SUMMARY]);
  expect(parseComments(serializeComments([LINE, SPAN, FILE]))).toEqual([LINE, SPAN, FILE]);
  expect(serializeComments([])).toBe('{\n  "comments": []\n}\n');
});

test("writing replaces the file atomically (no temp file left) and an empty list empties the store", () => {
  const w = temp();
  writeComments(w, "b", [LINE]);
  writeComments(w, "b", []);
  expect(readComments(w, "b")).toEqual([]);
  expect(existsSync(`${commentsPath(w, "b")}.tmp`)).toBe(false);
  expect(readFileSync(commentsPath(w, "b"), "utf8")).toContain('"comments": []');
});

test("reviewCommentsOf joins the critic's survivors (keyed to the branch head) and the store: one list for review mode", () => {
  const w = temp();
  const sh = (...a: string[]) => execFileSync("git", ["-C", w, ...a], { encoding: "utf8" });
  sh("init", "-q", "-b", "main");
  sh("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const head = sh("rev-parse", "main").trim();
  mkdirSync(join(w, ".pablo", "critique"), { recursive: true });
  writeFileSync(critiquePath(w, "main"), JSON.stringify({ head, comments: [{ kind: "continuity", file: "a.md", line: 3, excerpt: "x", claim: "age wrong", evidence: "", refute: "" }] }));
  writeComments(w, "main", [LINE]);
  expect(reviewCommentsOf(w, "main")).toEqual([
    { source: "critic", path: "a.md", line: 3, author: "critic", body: "age wrong", label: "continuity" },
    LINE,
  ]);
  // A critique of a branch that has moved is not shown; the store still is.
  writeFileSync(critiquePath(w, "main"), JSON.stringify({ head: "0".repeat(40), comments: [] }));
  expect(reviewCommentsOf(w, "main")).toEqual([LINE]);
});
