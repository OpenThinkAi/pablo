/** AGT-1526: the book's stages for the screen's rail come from the stage machine's own state, over a temp copy of the fixture work. */
import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bookStages } from "../src/book";
import { chapterPreconditions, readNovelState } from "../src/novel/machine";

const FIXTURE = fileURLToPath(new URL("./fixtures/vault/novels/ice-house", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pablo-book-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function work(name: string): string {
  const dir = join(root, name);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

test("the stages follow the machine: premise, bible, acts, beats, then each chapter drafted, ready or missing", () => {
  const state = readNovelState(work("a"));
  const stages = bookStages(state);
  expect(stages.slice(0, 5).map((s) => [s.id, s.status])).toEqual([
    ["premise", "ready"], ["bible", "ready"], ["acts", "ready"], ["beats", "ready"], ["chapters", "ready"],
  ]);
  expect(stages.find((s) => s.id === "chapters")?.group).toBe(true);
  const chapters = stages.filter((s) => s.depth === 1);
  expect(chapters.map((s) => [s.id, s.status])).toEqual([
    ["chapter:1", "drafted"], ["chapter:2", "ready"], ["chapter:3", "missing"], ["chapter:4", "missing"],
  ]);
});

test("a chapter's missing reasons are the ones status gives, not a second reading", () => {
  const state = readNovelState(work("b"));
  const stages = bookStages(state);
  for (const n of [3, 4]) {
    expect(stages.find((s) => s.id === `chapter:${n}`)?.missing).toEqual(chapterPreconditions(state, n).missing);
  }
});

test("a work with no premise, acts or beats shows those stages missing with why", () => {
  const dir = work("c");
  unlinkSync(join(dir, "outline", "chapters.md"));
  unlinkSync(join(dir, "bible", "overview.md"));
  const stages = bookStages(readNovelState(dir));
  const by = (id: string) => stages.find((s) => s.id === id)!;
  expect(by("premise")).toMatchObject({ status: "missing", missing: ["bible/overview.md has no text under ## Logline"] });
  expect(by("acts").status).toBe("missing");
  expect(by("beats")).toMatchObject({ status: "missing", name: "beats" });
  expect(by("chapters").status).toBe("ready"); // the drafted chapter file is still there
});
