import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditHost, EditHostError } from "../src/edit-host";
import type { CheckHit, EditHost, EditHostDeps } from "../src/edit-host";
import { readEvents } from "../src/review";
import type { PieceRecord } from "../src/review";

/**
 * Every test below works on a real file under a temp directory (never
 * `~/writing`, never a real state dir) so `save`'s atomic temp-then-rename
 * write is exercised against a real filesystem, not an in-memory fake.
 */
const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-edit-host-"));
  cleanupDirs.push(dir);
  return dir;
}

const FRONTMATTER = "---\ntitle: Hello World\nwords: 4\n---\n\n";
const BODY = "Original body text.";

function countWords(body: string): number {
  return body.split(/\s+/).filter((word) => word !== "").length;
}

function fakeCheck(hits: CheckHit[] = []): (body: string) => CheckHit[] {
  return () => hits;
}

function neverGitCommit(): EditHostDeps["gitCommit"] {
  return () => {
    throw new Error("gitCommit should not have been called");
  };
}

function neverRevise(): EditHostDeps["revise"] {
  return () => {
    throw new Error("revise should not have been called");
  };
}

function neverWriteFile(): EditHostDeps["writeFile"] {
  return () => {
    throw new Error("writeFile should not have been called");
  };
}

function piece(overrides: Partial<PieceRecord> = {}): PieceRecord {
  return {
    id: "20260907-hello-world-ab12",
    at: "2026-09-07T10:00:00.000Z",
    kind: "chapter",
    title: "Hello World",
    path: "/tmp/hello-world.md",
    words: 4,
    prompt_hash: "deadbeef",
    ...overrides,
  };
}

interface Fixture {
  readonly dir: string;
  readonly path: string;
  readonly queuePath: string;
}

function fixture(raw: string, filename = "chapter.md"): Fixture {
  const dir = tempDir();
  const path = join(dir, filename);
  writeFileSync(path, raw, "utf8");
  return { dir, path, queuePath: join(dir, "review.jsonl") };
}

function baseDeps(fx: Fixture, overrides: Partial<EditHostDeps> = {}): EditHostDeps {
  return {
    path: fx.path,
    piece: piece({ path: fx.path }),
    queuePath: fx.queuePath,
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, text) => writeFileSync(p, text, "utf8"),
    gitCommit: () => ({ ok: true }),
    revise: neverRevise(),
    check: fakeCheck(),
    countWords,
    now: () => new Date("2026-09-07T12:00:00.000Z"),
    ...overrides,
  };
}

function host(fx: Fixture, overrides: Partial<EditHostDeps> = {}): EditHost {
  return createEditHost(baseDeps(fx, overrides));
}

describe("data()", () => {
  test("strips frontmatter from text, title from frontmatter, check/words from injected fns", () => {
    const fx = fixture(FRONTMATTER + BODY);
    const h = host(fx, { check: fakeCheck([{ path: fx.path, line: 1, rule: "stub", excerpt: "x" }]) });

    const data = h.data();

    expect(data.text).toBe(BODY);
    expect(data.title).toBe("Hello World");
    expect(data.path).toBe(fx.path);
    expect(data.words).toBe(countWords(BODY));
    expect(data.check).toEqual([{ path: fx.path, line: 1, rule: "stub", excerpt: "x" }]);
    expect(data.piece?.id).toBe("20260907-hello-world-ab12");
  });

  test("title falls back to the file's basename without extension when there is no frontmatter title", () => {
    const fx = fixture("Just body text, no frontmatter markers.", "draft.md");
    const h = host(fx, { piece: undefined });

    expect(h.data().title).toBe("draft");
    expect(h.data().text).toBe("Just body text, no frontmatter markers.");
  });
});

describe("save()", () => {
  test("preserves the frontmatter block byte-for-byte and writes the new body", async () => {
    const fx = fixture(FRONTMATTER + BODY);
    const h = host(fx);

    const result = await h.save({ text: "New body text, revised." });

    expect(result.ok).toBe(true);
    expect(readFileSync(fx.path, "utf8")).toBe(FRONTMATTER + "New body text, revised.");
  });

  test("a file with no frontmatter has its whole body replaced", async () => {
    const fx = fixture("Original, no frontmatter at all.");
    const h = host(fx, { piece: undefined });

    await h.save({ text: "Replaced entirely." });

    expect(readFileSync(fx.path, "utf8")).toBe("Replaced entirely.");
  });

  test("calls gitCommit with dirname(path), [path], and an author-edit message naming the basename", async () => {
    const fx = fixture(FRONTMATTER + BODY, "my-chapter.md");
    const calls: Array<{ dir: string; paths: string[]; message: string }> = [];
    const h = host(fx, {
      gitCommit: (dir, paths, message) => {
        calls.push({ dir, paths, message });
        return { ok: true };
      },
    });

    await h.save({ text: "Changed." });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      dir: fx.dir,
      paths: [fx.path],
      message: "author edit: my-chapter.md",
    });
  });

  test("appends an edited event to the queue when piece is set", async () => {
    const fx = fixture(FRONTMATTER + BODY);
    const h = host(fx);

    await h.save({ text: "Changed body." });

    const events = readEvents(fx.queuePath);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "edited",
      id: "20260907-hello-world-ab12",
      at: "2026-09-07T12:00:00.000Z",
      words: countWords("Changed body."),
    });
  });

  test("appends no event when piece is unset", async () => {
    const fx = fixture(FRONTMATTER + BODY);
    const h = host(fx, { piece: undefined });

    await h.save({ text: "Changed body." });

    expect(readEvents(fx.queuePath)).toHaveLength(0);
  });

  test("a text identical to the current body writes nothing and short-circuits with unchanged: true", async () => {
    const fx = fixture(FRONTMATTER + BODY);
    const h = host(fx, {
      writeFile: neverWriteFile(),
      gitCommit: neverGitCommit(),
    });

    const result = await h.save({ text: BODY });

    expect(result.ok).toBe(true);
    expect(result.unchanged).toBe(true);
    expect(readFileSync(fx.path, "utf8")).toBe(FRONTMATTER + BODY);
    expect(readEvents(fx.queuePath)).toHaveLength(0);
  });

  test("a failed commit is returned inside git, never thrown", async () => {
    const fx = fixture(FRONTMATTER + BODY);
    const h = host(fx, {
      gitCommit: () => ({ ok: false, detail: "nothing to commit" }),
    });

    const result = await h.save({ text: "Changed." });

    expect(result.ok).toBe(true);
    expect(result.git).toEqual({ ok: false, detail: "nothing to commit" });
    // The write itself still landed even though the commit failed.
    expect(readFileSync(fx.path, "utf8")).toBe(FRONTMATTER + "Changed.");
  });

  test("a failing write never leaves the chapter file half-written", async () => {
    const fx = fixture(FRONTMATTER + BODY);
    const h = host(fx, {
      writeFile: () => {
        throw new Error("disk full");
      },
      gitCommit: neverGitCommit(),
    });

    await expect(h.save({ text: "Changed." })).rejects.toThrow("disk full");
    // The original file is untouched — the failed write never reached `path`,
    // only a temp path that the (throwing) writeFile never created.
    expect(readFileSync(fx.path, "utf8")).toBe(FRONTMATTER + BODY);
    expect(readEvents(fx.queuePath)).toHaveLength(0);
  });

  test("a rename failure after the temp write still leaves the chapter file untouched and rethrows", async () => {
    const fx = fixture(FRONTMATTER + BODY);
    const h = host(fx, {
      // Writes the temp file successfully, then removes it — simulating the
      // temp file vanishing before the swap-in rename runs, so the real
      // `renameSync(tempPath, path)` itself fails (not the write). This
      // exercises the atomic write's cleanup-and-rethrow branch, distinct
      // from the writeFile-throws case above.
      writeFile: (tempPath, text) => {
        writeFileSync(tempPath, text, "utf8");
        rmSync(tempPath);
      },
      gitCommit: neverGitCommit(),
    });

    await expect(h.save({ text: "Changed." })).rejects.toThrow();
    // `path` is only ever touched by the rename, so a rename that never
    // happens leaves the original file exactly as it was.
    expect(readFileSync(fx.path, "utf8")).toBe(FRONTMATTER + BODY);
    expect(readEvents(fx.queuePath)).toHaveLength(0);
  });
});

describe("revise()", () => {
  test("passes the injected revise() result through unchanged and never touches the file", async () => {
    const fx = fixture(FRONTMATTER + BODY);
    const seen: Array<{ path: string; start: number; end: number; instruction: string }> = [];
    const h = host(fx, {
      writeFile: neverWriteFile(),
      gitCommit: neverGitCommit(),
      revise: async (input) => {
        seen.push(input);
        return { candidate: "A candidate.", receipt: { tokens: 12 } };
      },
    });

    const result = await h.revise({ start: 0, end: 8, instruction: "make it punchier" });

    expect(result).toEqual({ candidate: "A candidate.", receipt: { tokens: 12 } });
    expect(seen).toEqual([{ path: fx.path, start: 0, end: 8, instruction: "make it punchier" }]);
    expect(readFileSync(fx.path, "utf8")).toBe(FRONTMATTER + BODY);
  });

  test("rejects a bad span with EditHostError code bad-span, without calling revise", async () => {
    const fx = fixture(FRONTMATTER + BODY);
    const h = host(fx, { revise: neverRevise() });

    await expect(h.revise({ start: 5, end: 5, instruction: "x" })).rejects.toThrow(EditHostError);
    try {
      await h.revise({ start: -1, end: 5, instruction: "x" });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(EditHostError);
      expect((error as EditHostError).code).toBe("bad-span");
    }

    await expect(h.revise({ start: 0, end: BODY.length + 1, instruction: "x" })).rejects.toMatchObject({
      code: "bad-span",
    });
  });

  test("rejects a blank instruction with EditHostError code no-instruction, without calling revise", async () => {
    const fx = fixture(FRONTMATTER + BODY);
    const h = host(fx, { revise: neverRevise() });

    await expect(h.revise({ start: 0, end: 8, instruction: "   " })).rejects.toMatchObject({
      code: "no-instruction",
    });
  });
});

describe("approve() / reject()", () => {
  test("approve() decides via review.ts's decide(), by: editor, read: true", async () => {
    const fx = fixture(FRONTMATTER + BODY);
    const h = host(fx);
    writeFileSync(
      fx.queuePath,
      `${JSON.stringify({
        type: "queued",
        id: "20260907-hello-world-ab12",
        at: "2026-09-07T09:00:00.000Z",
        kind: "chapter",
        title: "Hello World",
        path: fx.path,
        words: 4,
        prompt_hash: "deadbeef",
      })}\n`,
      "utf8",
    );

    const result = await h.approve();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event).toEqual({
        type: "approved",
        id: "20260907-hello-world-ab12",
        at: "2026-09-07T12:00:00.000Z",
        by: "editor",
        read: true,
      });
    }
  });

  test("reject({reason}) decides rejected with the reason", async () => {
    const fx = fixture(FRONTMATTER + BODY);
    const h = host(fx);
    writeFileSync(
      fx.queuePath,
      `${JSON.stringify({
        type: "queued",
        id: "20260907-hello-world-ab12",
        at: "2026-09-07T09:00:00.000Z",
        kind: "chapter",
        title: "Hello World",
        path: fx.path,
        words: 4,
        prompt_hash: "deadbeef",
      })}\n`,
      "utf8",
    );

    const result = await h.reject({ reason: "too rushed" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event).toMatchObject({ type: "rejected", by: "editor", read: true, reason: "too rushed" });
    }
  });

  test("a second decision is refused", async () => {
    const fx = fixture(FRONTMATTER + BODY);
    const h = host(fx);
    writeFileSync(
      fx.queuePath,
      `${JSON.stringify({
        type: "queued",
        id: "20260907-hello-world-ab12",
        at: "2026-09-07T09:00:00.000Z",
        kind: "chapter",
        title: "Hello World",
        path: fx.path,
        words: 4,
        prompt_hash: "deadbeef",
      })}\n`,
      "utf8",
    );

    const first = await h.approve();
    expect(first.ok).toBe(true);

    const second = await h.reject({});
    expect(second).toEqual({ ok: false, code: "already-decided", detail: expect.any(String) });
  });

  test("approve() and reject() on a non-piece both return not-a-piece", async () => {
    const fx = fixture(FRONTMATTER + BODY);
    const h = host(fx, { piece: undefined });

    const approved = await h.approve();
    const rejected = await h.reject({ reason: "nope" });

    expect(approved).toEqual({ ok: false, code: "not-a-piece", detail: expect.any(String) });
    expect(rejected).toEqual({ ok: false, code: "not-a-piece", detail: expect.any(String) });
  });
});

describe("refresh()", () => {
  test("re-reads the file and returns fresh data after an external change", async () => {
    const fx = fixture(FRONTMATTER + BODY);
    const h = host(fx);

    expect(h.data().text).toBe(BODY);

    // Simulate an external process (e.g. another editor) changing the file
    // directly on disk, bypassing this host entirely.
    writeFileSync(fx.path, FRONTMATTER + "Externally changed body.", "utf8");

    const refreshed = await h.refresh();

    expect(refreshed.text).toBe("Externally changed body.");
    expect(refreshed.words).toBe(countWords("Externally changed body."));
  });
});
