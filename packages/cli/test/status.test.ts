/**
 * AGT-1263: `pablo status` reports `review: pending|approved|rejected|none`
 * per chapter, computed by matching the chapter file's absolute path against
 * `queued` events in the review queue (`stateReviewPath()`, AGT-1255/1261)
 * and taking the latest decision for that piece.
 *
 * `reviewStateFor` (AC3) lives in `../src/novel/machine.ts`, not
 * `../src/review.ts` — `review.ts` is a finished, shared dependency other
 * in-flight tickets build on, so this ticket adds the new pure function
 * beside `readNovelState`/`chapterPreconditions` instead of editing it. Its
 * behaviour matches the ticket's spec exactly; only the file changed.
 *
 * These tests never touch a real vault or a real `XDG_STATE_HOME` — every
 * disk-touching test copies the fixture vault into a temp dir and seeds a
 * temp state dir with its own `review.jsonl`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readNovelState, reviewStateFor } from "../src/novel/machine";
import { stateReviewPath } from "../src/paths";
import type { DecisionEvent, QueuedEvent, ReviewEvent } from "../src/review";

const WORK = fileURLToPath(new URL("./fixtures/vault/novels/ice-house", import.meta.url));

function tempWork(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-status-test-work-"));
  const work = join(dir, "ice-house");
  cpSync(WORK, work, { recursive: true });
  return work;
}

function queuedEvent(overrides: Partial<QueuedEvent> = {}): QueuedEvent {
  return {
    type: "queued",
    id: "20260907-chapter-one-aaaa",
    at: "2026-09-07T10:00:00.000Z",
    kind: "chapter",
    title: "The Last Full Cut",
    path: "/tmp/does-not-matter.md",
    words: 900,
    prompt_hash: "deadbeef",
    ...overrides,
  };
}

function decisionEvent(overrides: Partial<DecisionEvent> = {}): DecisionEvent {
  return {
    type: "approved",
    id: "20260907-chapter-one-aaaa",
    at: "2026-09-07T11:00:00.000Z",
    by: "cli",
    read: true,
    ...overrides,
  };
}

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tempStateHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-status-test-state-"));
  dirs.push(dir);
  return dir;
}

function seedQueue(stateHome: string, events: readonly ReviewEvent[]): void {
  const path = join(stateHome, "pablo", "review.jsonl");
  mkdirSync(join(stateHome, "pablo"), { recursive: true });
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

describe("reviewStateFor (AC3, pure — no filesystem)", () => {
  test("none: no queued event matches the path at all", () => {
    const events: ReviewEvent[] = [queuedEvent({ path: "/vault/chapters/02-other.md" })];
    expect(reviewStateFor(events, "/vault/chapters/01-mine.md")).toBe("none");
  });

  test("pending: queued, no decision yet", () => {
    const events: ReviewEvent[] = [queuedEvent({ path: "/vault/chapters/01-mine.md" })];
    expect(reviewStateFor(events, "/vault/chapters/01-mine.md")).toBe("pending");
  });

  test("approved: queued then approved", () => {
    const events: ReviewEvent[] = [
      queuedEvent({ path: "/vault/chapters/01-mine.md" }),
      decisionEvent({ type: "approved" }),
    ];
    expect(reviewStateFor(events, "/vault/chapters/01-mine.md")).toBe("approved");
  });

  test("rejected: queued then rejected", () => {
    const events: ReviewEvent[] = [
      queuedEvent({ path: "/vault/chapters/01-mine.md" }),
      decisionEvent({ type: "rejected", reason: "voice drifted" }),
    ];
    expect(reviewStateFor(events, "/vault/chapters/01-mine.md")).toBe("rejected");
  });

  test("two queued events for the same path: the latest (by `at`) wins, ignoring the older one's decision", () => {
    const events: ReviewEvent[] = [
      // Older run: queued, then rejected.
      queuedEvent({ id: "old", at: "2026-09-01T00:00:00.000Z", path: "/vault/chapters/01-mine.md" }),
      decisionEvent({ id: "old", type: "rejected", at: "2026-09-01T01:00:00.000Z" }),
      // Rewritten and queued again, later, with no decision yet.
      queuedEvent({ id: "new", at: "2026-09-07T00:00:00.000Z", path: "/vault/chapters/01-mine.md" }),
    ];
    expect(reviewStateFor(events, "/vault/chapters/01-mine.md")).toBe("pending");
  });

  test("two queued events for the same path: the latest's own decision is what's reported", () => {
    const events: ReviewEvent[] = [
      queuedEvent({ id: "old", at: "2026-09-01T00:00:00.000Z", path: "/vault/chapters/01-mine.md" }),
      decisionEvent({ id: "old", type: "rejected", at: "2026-09-01T01:00:00.000Z" }),
      queuedEvent({ id: "new", at: "2026-09-07T00:00:00.000Z", path: "/vault/chapters/01-mine.md" }),
      decisionEvent({ id: "new", type: "approved", at: "2026-09-07T02:00:00.000Z" }),
    ];
    expect(reviewStateFor(events, "/vault/chapters/01-mine.md")).toBe("approved");
  });

  test("paths are compared resolve()d: a relative chapterPath still matches an absolute queued path for the same file", () => {
    const absolute = resolve("vault/chapters/01-mine.md");
    const events: ReviewEvent[] = [queuedEvent({ path: absolute })];
    expect(reviewStateFor(events, "vault/chapters/01-mine.md")).toBe("pending");
  });

  test("a decision event for a different id never matches a queued event's id", () => {
    const events: ReviewEvent[] = [
      queuedEvent({ id: "mine", path: "/vault/chapters/01-mine.md" }),
      decisionEvent({ id: "someone-else", type: "approved" }),
    ];
    expect(reviewStateFor(events, "/vault/chapters/01-mine.md")).toBe("pending");
  });
});

describe("readNovelState wires `review` onto each chapter (AC1, AC4 — fixture vault + seeded temp XDG_STATE_HOME)", () => {
  test("a chapter with no queue entry at all reads review: \"none\"", () => {
    const stateHome = tempStateHome();
    const state = readNovelState(WORK, { XDG_STATE_HOME: stateHome });

    expect(state.chapters).toEqual([
      { number: 1, file: "chapters/01-the-last-full-cut.md", status: "draft", title: "The Last Full Cut", review: "none" },
    ]);
  });

  test("a chapter queued with no decision reads review: \"pending\"", () => {
    const stateHome = tempStateHome();
    const chapterPath = join(WORK, "chapters", "01-the-last-full-cut.md");
    seedQueue(stateHome, [queuedEvent({ path: chapterPath })]);

    const state = readNovelState(WORK, { XDG_STATE_HOME: stateHome });
    expect(state.chapters[0]?.review).toBe("pending");
  });

  test("a chapter queued and approved reads review: \"approved\"", () => {
    const stateHome = tempStateHome();
    const chapterPath = join(WORK, "chapters", "01-the-last-full-cut.md");
    seedQueue(stateHome, [queuedEvent({ path: chapterPath }), decisionEvent({ type: "approved" })]);

    const state = readNovelState(WORK, { XDG_STATE_HOME: stateHome });
    expect(state.chapters[0]?.review).toBe("approved");
  });

  test("a chapter queued and rejected reads review: \"rejected\"", () => {
    const stateHome = tempStateHome();
    const chapterPath = join(WORK, "chapters", "01-the-last-full-cut.md");
    seedQueue(stateHome, [queuedEvent({ path: chapterPath }), decisionEvent({ type: "rejected" })]);

    const state = readNovelState(WORK, { XDG_STATE_HOME: stateHome });
    expect(state.chapters[0]?.review).toBe("rejected");
  });

  test("a queue entry for a different chapter's path doesn't affect this one: still \"none\"", () => {
    const stateHome = tempStateHome();
    seedQueue(stateHome, [queuedEvent({ path: "/some/other/vault/chapters/02-x.md" })]);

    const state = readNovelState(WORK, { XDG_STATE_HOME: stateHome });
    expect(state.chapters[0]?.review).toBe("none");
  });

  test("a missing queue file degrades to \"none\" without throwing", () => {
    const stateHome = tempStateHome(); // never seeded — pablo/review.jsonl doesn't exist

    expect(() => readNovelState(WORK, { XDG_STATE_HOME: stateHome })).not.toThrow();
    const state = readNovelState(WORK, { XDG_STATE_HOME: stateHome });
    expect(state.chapters[0]?.review).toBe("none");
  });

  test("a malformed queue file (bad JSON lines) degrades to \"none\" without throwing", () => {
    const stateHome = tempStateHome();
    const path = stateReviewPath({ XDG_STATE_HOME: stateHome });
    mkdirSync(join(stateHome, "pablo"), { recursive: true });
    writeFileSync(path, "not json\n{\"type\": \"queued\"\n\n", "utf8");

    expect(() => readNovelState(WORK, { XDG_STATE_HOME: stateHome })).not.toThrow();
    const state = readNovelState(WORK, { XDG_STATE_HOME: stateHome });
    expect(state.chapters[0]?.review).toBe("none");
  });

  test("stateReviewPath sits beside receipts.jsonl under <XDG_STATE_HOME>/pablo/", () => {
    const stateHome = tempStateHome();
    expect(stateReviewPath({ XDG_STATE_HOME: stateHome })).toBe(join(stateHome, "pablo", "review.jsonl"));
  });

  test("readNovelState never writes to the queue file itself — it's read-only from here", () => {
    const stateHome = tempStateHome();
    readNovelState(WORK, { XDG_STATE_HOME: stateHome });
    expect(() => readFileSync(stateReviewPath({ XDG_STATE_HOME: stateHome }), "utf8")).toThrow();
  });

  test("a rewritten chapter (rejected, then requeued and still pending) reads the latest state, not the old decision", () => {
    const work = tempWork();
    const stateHome = tempStateHome();
    const chapterPath = join(work, "chapters", "01-the-last-full-cut.md");
    seedQueue(stateHome, [
      queuedEvent({ id: "old", at: "2026-09-01T00:00:00.000Z", path: chapterPath }),
      decisionEvent({ id: "old", type: "rejected", at: "2026-09-01T01:00:00.000Z" }),
      queuedEvent({ id: "new", at: "2026-09-07T00:00:00.000Z", path: chapterPath }),
    ]);

    const state = readNovelState(work, { XDG_STATE_HOME: stateHome });
    expect(state.chapters[0]?.review).toBe("pending");

    rmSync(work, { recursive: true, force: true });
  });
});
