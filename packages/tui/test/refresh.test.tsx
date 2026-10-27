import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { bookRail, type BookStage } from "../src/book";
import type { BookSnapshot } from "../src/screen";

afterEach(() => cleanup());
const plain = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = "\x1b[B", ENTER = "\r";

const stage = (id: string, name: string, status: BookStage["status"], extra: Partial<BookStage> = {}): BookStage => ({ id, name, depth: 0, status, missing: [], ...extra });
const STAGES: BookStage[] = [
  stage("premise", "premise", "ready"),
  stage("chapters", "chapters (1/2)", "ready", { group: true }),
  stage("chapter:1", "1 Cold Open", "drafted", { depth: 1 }),
  stage("chapter:2", "2", "ready", { depth: 1 }),
];
const DIFF = "diff --git a/chapters/03-a.md b/chapters/03-a.md\n--- a/chapters/03-a.md\n+++ b/chapters/03-a.md\n@@ -1 +1 @@\n-The well was dry.\n+The well had been dry since June.\n";

const mount = (props: Partial<Parameters<typeof App>[0]> = {}) =>
  render(<App title="Ice House" format="novel" book={bookRail(STAGES)} diffOf={() => ({ ok: true, text: DIFF })} size={{ cols: 110, rows: 32 }} {...props} />);

test("the rail reads the book again on each tick: a branch made outside the screen shows, and the cursor keeps its row", async () => {
  let snap: BookSnapshot = { stages: STAGES, branches: [] };
  const app = mount({ refresh: () => snap, refreshMs: 50 });
  await sleep(40);
  app.stdin.write(DOWN); await sleep(20); // onto chapters
  expect(plain(app.lastFrame())).not.toContain("branches to review");
  snap = { stages: STAGES.map((s) => (s.id === "chapter:2" ? { ...s, status: "waiting", branch: "draft/ch02" } : s)), branches: ["draft/ch02"] };
  await sleep(150);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("branches to review (1)");
  expect(frame).toContain("draft/ch02");
  expect(frame).toMatch(/chapters \(1\/2\)/);
  // The cursor kept its row: Enter on it unfolds the chapters, where chapter 2 now says its draft is waiting.
  app.stdin.write(ENTER); await sleep(40);
  expect(plain(app.lastFrame())).toContain("◆ 2 · draft waiting");
});
