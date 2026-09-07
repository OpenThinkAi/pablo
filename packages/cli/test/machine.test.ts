import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chapterPreconditions, readNovelState } from "../src/novel/machine";

/**
 * The synthetic fixture novel: 4 beats, 1 written chapter, and (added for
 * AGT-1228) a `[pick]` row in `bible/characters/family-tree.md` — "Mrs.
 * Frayne" — whose name appears in beat 3's text, so a pick failure has
 * something real to exercise.
 */
const WORK = fileURLToPath(new URL("./fixtures/vault/novels/ice-house", import.meta.url));

function tempWork(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-machine-test-"));
  const work = join(dir, "ice-house");
  cpSync(WORK, work, { recursive: true });
  return work;
}

test("readNovelState reads the fixture's premise, bible, acts, beats, and chapters", () => {
  // AGT-1263: an isolated, empty XDG_STATE_HOME so `review` reads "none" from
  // a queue that provably doesn't exist, never from whatever happens to be on
  // the machine running this test.
  const stateHome = mkdtempSync(join(tmpdir(), "pablo-machine-test-state-"));
  const state = readNovelState(WORK, { XDG_STATE_HOME: stateHome });

  expect(state.premise).toBe(true);

  expect(state.bible.files).toEqual([
    { file: "bible/characters/family-tree.md", exists: true },
    { file: "bible/places.md", exists: true },
    { file: "bible/timeline.md", exists: true },
  ]);
  expect(state.bible.picks).toEqual([{ file: "bible/characters/family-tree.md", name: "Mrs. Frayne" }]);

  expect(state.acts).toEqual([
    { act: "I", years: "1929 to 1934", summary: "The ice trade contracts. Odile takes the books, Wilfred takes the risk." },
    { act: "II", years: "1935 to 1942", summary: "The cannery converts. The pond house closes." },
  ]);

  expect(state.beats.map((b) => b.chapter)).toEqual([1, 2, 3, 4]);
  expect(state.beats[1]?.title).toBe("Black Ice");

  expect(state.chapters).toEqual([
    { number: 1, file: "chapters/01-the-last-full-cut.md", status: "draft", title: "The Last Full Cut", review: "none" },
  ]);
});

test("readNovelState says premise is missing when overview.md has no Logline text", () => {
  const work = tempWork();
  writeFileSync(join(work, "bible", "overview.md"), "# Overview\n\nNo logline heading here.\n", "utf8");

  expect(readNovelState(work).premise).toBe(false);

  rmSync(work, { recursive: true, force: true });
});

test("chapter 2 is ready: its beat exists, chapter 1 is written, the timeline covers 1931, and no pick row names it", () => {
  const state = readNovelState(WORK);
  const result = chapterPreconditions(state, 2);

  expect(result).toEqual({ ready: true, missing: [] });
});

test("chapter 3 is missing chapter 2 (unwritten) and the Mrs. Frayne pick its own beat names", () => {
  const state = readNovelState(WORK);
  const result = chapterPreconditions(state, 3);

  expect(result.ready).toBe(false);
  expect(result.missing).toEqual([
    "chapter 2 is not written",
    "Mrs. Frayne still has a [pick] in bible/characters/family-tree.md",
  ]);
});

test("chapter 9 is missing exactly one thing: it has no beat row", () => {
  const state = readNovelState(WORK);
  const result = chapterPreconditions(state, 9);

  expect(result).toEqual({
    ready: false,
    missing: ["no beat for chapter 9 in outline/chapters.md"],
  });
});

test("chapter 1 needs no previous chapter", () => {
  const state = readNovelState(WORK);
  expect(chapterPreconditions(state, 1).missing).not.toContain("chapter 0 is not written");
});

test("a chapter whose year has no timeline row at or before it is missing the timeline check", () => {
  const work = tempWork();
  const timelinePath = join(work, "bible", "timeline.md");
  const timeline = readFileSync(timelinePath, "utf8");
  // Drop the row dated 1931 or earlier that chapter 2 (story date "Winter
  // 1931") relies on, leaving only rows dated after it.
  const withoutEarlyRows = timeline
    .split("\n")
    .filter((line) => !/^\|\s*(1888|1901|1912|1918|1922|1929|1931)\s*\|/.test(line))
    .join("\n");
  writeFileSync(timelinePath, withoutEarlyRows, "utf8");

  const state = readNovelState(work);
  const result = chapterPreconditions(state, 2);

  expect(result.ready).toBe(false);
  expect(result.missing).toContain("bible/timeline.md has no row dated 1931 or earlier");

  rmSync(work, { recursive: true, force: true });
});
