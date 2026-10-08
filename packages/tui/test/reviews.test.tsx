import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { bookRail, type BookStage } from "../src/book";
import { roundDoc, roundRows, reviewsIn, REVIEWS_GROUP } from "../src/reviews";
import type { BookSnapshot, PullResult, RoundsResult } from "../src/screen";
import { statusFields } from "../src/status";
import type { Round } from "../src/state";

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
const READING: Round = { id: "ben-2026-10-05", reader: "ben", chapters: [1], status: "reading" };
const IN: Round = { id: "atara-2026-10-04", reader: "atara", chapters: [3], status: "submitted" };
const DIFF = "diff --git a/chapters/03-a.md b/chapters/03-a.md\n--- a/chapters/03-a.md\n+++ b/chapters/03-a.md\n@@ -1 +1 @@\n-The well was dry.\n+The well had been dry since June.\n";

/** A puller the test steers: it records each round asked for and resolves when `finish` is called. */
function controlledPuller() {
  const calls: string[] = [];
  let finish!: (r: PullResult) => void;
  const puller = (round: string) => { calls.push(round); return new Promise<PullResult>((resolve) => { finish = resolve; }); };
  return { puller, calls, finish: (r: PullResult) => finish(r) };
}

const mount = (props: Partial<Parameters<typeof App>[0]> = {}) =>
  render(<App title="Ice House" format="novel" book={bookRail(STAGES)} diffOf={() => ({ ok: true, text: DIFF })} size={{ cols: 110, rows: 32 }} {...props} />);

test("roundRows: a Reviews group with a row per round, the ones in marked and counted", () => {
  expect(roundRows([])).toEqual({ rows: [], labels: {} });
  const { rows, labels } = roundRows([READING, IN]);
  expect(rows.map((r) => r.id)).toEqual([REVIEWS_GROUP, "round:ben-2026-10-05", "round:atara-2026-10-04"]);
  expect(rows[0]).toMatchObject({ group: true, depth: 0 });
  expect(labels[REVIEWS_GROUP]).toBe("reviews (2) · 1 in");
  expect(labels["round:ben-2026-10-05"]).toBe("ben · ch 1 · reading");
  expect(labels["round:atara-2026-10-04"]).toBe("● atara · ch 3 · review in");
  expect(reviewsIn([READING, IN])).toBe(1);
});

test("roundDoc says where a round stands and what Enter does", () => {
  expect(roundDoc(IN).text).toContain("atara's review of chapter 3 is in.");
  expect(roundDoc(IN).text).toContain("Press Enter to pull it");
  expect(roundDoc(READING).text).toContain("Chapter 1 is with ben.");
});

test("the status area counts the reviews that are in, and leaves the field out at zero", () => {
  const base = { format: "novel", drafted: 1, total: 2, branch: "main", comments: {} };
  expect(statusFields({ ...base, reviews: 1 }).find((f) => f.key === "reviews")?.value).toBe("● 1 in");
  expect(statusFields({ ...base, reviews: 0 }).some((f) => f.key === "reviews")).toBe(false);
});

test("polled rounds show as a Reviews group, a row's state is in the main pane, and the header counts the one in", async () => {
  const app = mount({ rounds: async (): Promise<RoundsResult> => ({ ok: true, rounds: [READING, IN] }) });
  await sleep(60);
  let frame = plain(app.lastFrame());
  expect(frame).toContain("reviews (2) · 1 in");
  expect(frame).toContain("ben · ch 1 · reading");
  expect(frame).toContain("● atara · ch 3 · review");
  expect(frame).toContain("reviews ● 1 in");
  // premise, chapters (folded), reviews, ben, atara
  for (let i = 0; i < 4; i++) { app.stdin.write(DOWN); await sleep(20); }
  frame = plain(app.lastFrame());
  expect(frame).toContain("review · atara · ch 3");
  expect(frame).toContain("atara's review of chapter 3 is in.");
});

test("Enter on a review that is in pulls it, then opens the review on its reader/ branch", async () => {
  const p = controlledPuller();
  const app = mount({ rounds: async () => ({ ok: true, rounds: [IN] }), puller: p.puller });
  await sleep(60);
  for (let i = 0; i < 3; i++) { app.stdin.write(DOWN); await sleep(20); }
  app.stdin.write(ENTER); await sleep(40);
  expect(p.calls).toEqual(["atara-2026-10-04"]);
  expect(plain(app.lastFrame())).toContain("Pulling atara-2026-10-04");
  app.stdin.write(ENTER); await sleep(40);
  expect(p.calls).toHaveLength(1); // one pull at a time
  p.finish({ ok: true, branch: "reader/atara-2026-10-04", lines: ["2 suggestions, 1 comment"] }); await sleep(60);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("review reader/atara-2026-10-04");
  expect(frame).toContain("Pulled atara-2026-10-04 into reader/atara-2026-10-04");
  expect(frame).toContain("2 suggestions, 1 comment");
  expect(frame).toContain("CHANGES");
  expect(frame).not.toContain("reviews ● 1 in"); // the pulled round has left the group
});

test("Enter on a round still with its reader says so and pulls nothing", async () => {
  const p = controlledPuller();
  const app = mount({ rounds: async () => ({ ok: true, rounds: [READING] }), puller: p.puller });
  await sleep(60);
  for (let i = 0; i < 3; i++) { app.stdin.write(DOWN); await sleep(20); }
  app.stdin.write(ENTER); await sleep(40);
  expect(p.calls).toEqual([]);
  expect(plain(app.lastFrame())).toContain("ben has not sent their review yet.");
});

test("a pull that fails says why and stays in the book", async () => {
  const p = controlledPuller();
  const app = mount({ rounds: async () => ({ ok: true, rounds: [IN] }), puller: p.puller });
  await sleep(60);
  for (let i = 0; i < 3; i++) { app.stdin.write(DOWN); await sleep(20); }
  app.stdin.write(ENTER); await sleep(40);
  p.finish({ ok: false, message: "pablo: notes pull: atara-2026-10-04: GitHub did not answer" }); await sleep(60);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("Not pulled");
  expect(frame).toContain("GitHub did not answer");
  expect(frame).toContain("book ·");
});

test("a poll that fails says so in the footer, and the next one that works clears it", async () => {
  let fail = true;
  const rounds = async (): Promise<RoundsResult> => (fail ? { ok: false, message: "gh: not logged in" } : { ok: true, rounds: [IN] });
  const app = mount({ rounds, roundsMs: 80 });
  await sleep(40);
  expect(plain(app.lastFrame())).toContain("reviews: gh: not logged in");
  fail = false;
  await sleep(150);
  const frame = plain(app.lastFrame());
  expect(frame).not.toContain("gh: not logged in");
  expect(frame).toContain("● atara · ch 3 · review");
});

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
