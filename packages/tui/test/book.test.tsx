import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { bookRail, type BookStage } from "../src/book";
import { initialState, reduce, shownRows } from "../src/state";

afterEach(() => cleanup());
const plain = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RIGHT = "\x1b[C", LEFT = "\x1b[D", DOWN = "\x1b[B", UP = "\x1b[A";

const stage = (id: string, name: string, status: BookStage["status"], extra: Partial<BookStage> = {}): BookStage => ({ id, name, depth: 0, status, missing: [], ...extra });
const STAGES: BookStage[] = [
  stage("premise", "premise", "ready"),
  stage("acts", "acts", "missing", { missing: ["outline/chapters.md has no | Act | table"] }),
  stage("chapters", "chapters (1/2)", "ready", { group: true }),
  stage("chapter:1", "1 Cold Open", "drafted", { depth: 1 }),
  stage("chapter:2", "2", "missing", { depth: 1, missing: ["no beat for chapter 2 in outline/chapters.md"] }),
];

test("bookRail: rows, mark-prefixed labels, the missing reasons of unready stages, chapters folded to start", () => {
  const rail = bookRail(STAGES);
  expect(rail.rows.map((r) => r.id)).toEqual(["premise", "acts", "chapters", "chapter:1", "chapter:2"]);
  expect(rail.labels).toMatchObject({ premise: "✓ premise", acts: "✗ acts", "chapter:1": "● 1 Cold Open" });
  expect(Object.keys(rail.missing)).toEqual(["acts", "chapter:2"]);
  expect(rail.folded).toEqual(["chapters"]);
});

test("rail.loaded folds the named groups on the first load only; → expands and ← collapses", () => {
  const rail = bookRail(STAGES);
  let s = reduce(initialState(), { type: "rail.loaded", rows: rail.rows, folded: rail.folded });
  const ids = () => shownRows(s.book.rail).map((r) => r.row.id);
  expect(ids()).toEqual(["premise", "acts", "chapters"]);
  s = reduce(s, { type: "rail.loaded", rows: rail.rows, folded: rail.folded }); // a reload keeps the author's folds
  expect(ids()).toEqual(["premise", "acts", "chapters"]);
  s = reduce(reduce(reduce(s, { type: "rail.down" }), { type: "rail.down" }), { type: "rail.expand" });
  expect(ids()).toEqual(["premise", "acts", "chapters", "chapter:1", "chapter:2"]);
  s = reduce(s, { type: "rail.collapse" });
  expect(ids()).toEqual(["premise", "acts", "chapters"]);
});

test("the rail lists the stages marked; → opens the chapters, ← closes them", async () => {
  const app = render(<App title="Ice House" format="novel" book={bookRail(STAGES)} size={{ cols: 100, rows: 30 }} />);
  await sleep(30);
  let frame = plain(app.lastFrame());
  expect(frame).toContain("✓ premise");
  expect(frame).toContain("✗ acts");
  expect(frame).toContain("chapters (1/2)");
  expect(frame).not.toContain("Cold Open");
  app.stdin.write(DOWN); await sleep(20); app.stdin.write(DOWN); await sleep(20);
  app.stdin.write(RIGHT); await sleep(30);
  frame = plain(app.lastFrame());
  expect(frame).toContain("● 1 Cold Open");
  app.stdin.write(LEFT); await sleep(30);
  expect(plain(app.lastFrame())).not.toContain("Cold Open");
});

test("a stage that is not ready shows its missing reasons in the content area, and leaving it takes them down", async () => {
  const app = render(<App title="Ice House" format="novel" book={bookRail(STAGES)} size={{ cols: 100, rows: 30 }} />);
  await sleep(30);
  expect(plain(app.lastFrame())).not.toContain("Not ready");
  app.stdin.write(DOWN); await sleep(30);
  let frame = plain(app.lastFrame());
  expect(frame).toContain("Not ready: acts");
  expect(frame).toContain("outline/chapters.md has no | Act | table");
  app.stdin.write(UP); await sleep(30);
  expect(plain(app.lastFrame())).not.toContain("Not ready");
  // a chapter with no beat says so where it is selected
  app.stdin.write(DOWN); await sleep(20); app.stdin.write(DOWN); await sleep(20);
  app.stdin.write(RIGHT); await sleep(20); app.stdin.write(DOWN); await sleep(20); app.stdin.write(DOWN); await sleep(30);
  frame = plain(app.lastFrame());
  expect(frame).toContain("no beat for chapter 2");
});
