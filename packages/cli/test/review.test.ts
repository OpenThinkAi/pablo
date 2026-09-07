import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  appendEvent,
  decide,
  mintPieceId,
  pending,
  readEvents,
  record,
  reviewStateFor,
  waitForDecision,
} from "../src/review";
import type { DecisionEvent, EditedEvent, QueuedEvent, ReviewEvent } from "../src/review";

let dir: string | undefined;

function tempPath(...segments: string[]): string {
  if (dir === undefined) throw new Error("useTempDir() must run first");
  return join(dir, ...segments);
}

function queuePath(): string {
  return tempPath("review.jsonl");
}

function queuedEvent(overrides: Partial<QueuedEvent> = {}): QueuedEvent {
  return {
    type: "queued",
    id: "20260907-hello-abcd",
    at: "2026-09-07T10:00:00.000Z",
    kind: "chapter",
    title: "Hello",
    path: "/tmp/hello.md",
    words: 500,
    prompt_hash: "deadbeef",
    ...overrides,
  };
}

function decisionEvent(overrides: Partial<DecisionEvent> = {}): DecisionEvent {
  return {
    type: "approved",
    id: "20260907-hello-abcd",
    at: "2026-09-07T11:00:00.000Z",
    by: "cli",
    read: true,
    ...overrides,
  };
}

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function useTempDir(): void {
  dir = mkdtempSync(join(tmpdir(), "pablo-review-"));
}

// mintPieceId is pure (no filesystem access), so these don't need useTempDir().
describe("mintPieceId", () => {
  test("shape is <YYYYMMDD>-<slug>-<4 lowercase hex>", () => {
    const id = mintPieceId(new Date("2026-09-07T12:34:56.000Z"), "My Chapter", () => "ab12");
    expect(id).toBe("20260907-my-chapter-ab12");
  });

  test("slug is lowercased, non-alphanumerics collapsed to single hyphens, trimmed", () => {
    const id = mintPieceId(new Date("2026-01-02T00:00:00.000Z"), "  Weird!! Slug__Name??  ", () => "0000");
    expect(id).toBe("20260102-weird-slug-name-0000");
  });

  test("slug is cut to 24 chars", () => {
    const longSlug = "a".repeat(40);
    const id = mintPieceId(new Date("2026-01-02T00:00:00.000Z"), longSlug, () => "ffff");
    expect(id).toBe(`20260102-${"a".repeat(24)}-ffff`);
  });

  test("random defaults to 4 hex chars from node:crypto", () => {
    const id = mintPieceId(new Date("2026-01-02T00:00:00.000Z"), "slug");
    const suffix = id.slice(id.length - 4);
    expect(suffix).toMatch(/^[0-9a-f]{4}$/);
  });
});

describe("appendEvent / readEvents", () => {
  test("round trip: appended events read back in order", () => {
    useTempDir();
    const path = tempPath("nested", "review.jsonl");
    const q = queuedEvent();
    const d: DecisionEvent = { type: "approved", id: q.id, at: "2026-09-07T11:00:00.000Z", by: "cli", read: true };

    appendEvent(path, q);
    appendEvent(path, d);

    const events = readEvents(path);
    expect(events).toEqual([q, d]);
  });

  test("creates parent directory and file when missing", () => {
    useTempDir();
    const path = tempPath("does", "not", "exist", "review.jsonl");
    appendEvent(path, queuedEvent());
    expect(readEvents(path)).toHaveLength(1);
  });

  test("missing file reads as no events", () => {
    useTempDir();
    expect(readEvents(tempPath("nope.jsonl"))).toEqual([]);
  });

  test("malformed line is skipped, not thrown", () => {
    useTempDir();
    const path = queuePath();
    const q = queuedEvent();
    writeFileSync(path, `${JSON.stringify(q)}\nnot json at all\n{"type":"queued"\n`, "utf8");
    expect(() => readEvents(path)).not.toThrow();
    expect(readEvents(path)).toEqual([q]);
  });
});

describe("pending / record", () => {
  test("pending returns queued pieces newest first, excluding decided ones", () => {
    useTempDir();
    const path = queuePath();
    const older = queuedEvent({ id: "a", at: "2026-09-01T00:00:00.000Z", title: "Older" });
    const newer = queuedEvent({ id: "b", at: "2026-09-05T00:00:00.000Z", title: "Newer" });
    const decided = queuedEvent({ id: "c", at: "2026-09-06T00:00:00.000Z", title: "Decided" });
    const decision: DecisionEvent = { type: "approved", id: "c", at: "2026-09-06T01:00:00.000Z", by: "cli", read: true };

    for (const event of [older, newer, decided, decision]) appendEvent(path, event);

    const events = readEvents(path);
    const result = pending(events);

    expect(result.map((p) => p.title)).toEqual(["Newer", "Older"]);
    expect(result.every((p) => !("type" in p))).toBe(true);
  });

  test("record returns a piece's history: piece, decision, edits", () => {
    useTempDir();
    const events: ReviewEvent[] = [
      queuedEvent({ id: "x" }),
      { type: "edited", id: "x", at: "2026-09-07T10:30:00.000Z", words: 520 } satisfies EditedEvent,
      { type: "rejected", id: "x", at: "2026-09-07T11:00:00.000Z", by: "editor", read: true, reason: "no" },
    ];

    const found = record(events, "x");
    expect(found).toBeDefined();
    expect(found?.piece.title).toBe("Hello");
    expect(found?.decision).toEqual({
      type: "rejected",
      id: "x",
      at: "2026-09-07T11:00:00.000Z",
      by: "editor",
      read: true,
      reason: "no",
    });
    expect(found?.edits).toHaveLength(1);
  });

  test("record returns undefined for an id never queued", () => {
    useTempDir();
    expect(record([], "nope")).toBeUndefined();
  });
});

describe("decide", () => {
  test("unknown id is refused", () => {
    useTempDir();
    const path = queuePath();
    const result = decide(path, { id: "nope", kind: "approved", by: "cli", read: true });
    expect(result).toEqual({ ok: false, code: "unknown-piece", detail: expect.any(String) });
    expect(readEvents(path)).toEqual([]);
  });

  test("decides a fresh piece and appends the decision", () => {
    useTempDir();
    const path = queuePath();
    appendEvent(path, queuedEvent({ id: "fresh" }));

    const now = new Date("2026-09-07T12:00:00.000Z");
    const result = decide(path, { id: "fresh", kind: "approved", by: "tray", read: false, now });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event).toEqual({
        type: "approved",
        id: "fresh",
        at: "2026-09-07T12:00:00.000Z",
        by: "tray",
        read: false,
      });
    }

    const events = readEvents(path);
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual(result.ok ? result.event : undefined);
  });

  test("already-decided piece is refused and the file is untouched", () => {
    useTempDir();
    const path = queuePath();
    appendEvent(path, queuedEvent({ id: "done" }));
    const first = decide(path, { id: "done", kind: "rejected", by: "cli", read: true, reason: "bad" });
    expect(first.ok).toBe(true);

    const before = readEvents(path);
    const second = decide(path, { id: "done", kind: "approved", by: "editor", read: true });

    expect(second).toEqual({ ok: false, code: "already-decided", detail: expect.any(String) });
    expect(readEvents(path)).toEqual(before);
  });
});

describe("waitForDecision", () => {
  test("returns unknown-piece immediately when the id was never queued", async () => {
    useTempDir();
    const path = queuePath();
    const result = await waitForDecision(path, "nope", { timeoutMs: 1000, sleep: async () => {} });
    expect(result).toEqual({ status: "unknown-piece" });
  });

  test("resolves when a decision is appended between polls", async () => {
    useTempDir();
    const path = queuePath();
    appendEvent(path, queuedEvent({ id: "pending-one" }));

    // waitForDecision reads at the *top* of each loop iteration, before
    // sleeping. So poll 1 reads (no decision) -> sleeps; while asleep for
    // poll 2, we write the decision here -> the loop wakes, reads again at
    // the top of the next iteration, and now sees it.
    let polls = 0;
    const sleep = async (): Promise<void> => {
      polls += 1;
      if (polls === 2) {
        decide(path, { id: "pending-one", kind: "approved", by: "cli", read: true });
      }
    };

    const result = await waitForDecision(path, "pending-one", { timeoutMs: 60_000, pollMs: 1, sleep });

    expect(result.status).toBe("approved");
    expect(result.event?.id).toBe("pending-one");
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  test("times out without a real wait", async () => {
    useTempDir();
    const path = queuePath();
    appendEvent(path, queuedEvent({ id: "never-decided" }));

    const result = await waitForDecision(path, "never-decided", {
      timeoutMs: 0,
      sleep: async () => {
        throw new Error("sleep should not be called when the deadline has already passed");
      },
    });

    expect(result).toEqual({ status: "timeout" });
  });
});

describe("reviewStateFor (pure — no filesystem)", () => {
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
