import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ritual, RitualOptions } from "../src/novel/rituals";
import { runRituals } from "../src/novel/rituals";
import { readEvents } from "../src/review";
import type { QueuedEvent } from "../src/review";

/**
 * `runRituals` (AGT-1231) exercised directly against a throwaway copy of the
 * `ice-house` fixture novel — never `~/writing`. `write-send.test.ts` covers
 * the integration (`runWrite` calling this after the file is written); these
 * tests cover the five rituals' own edge cases without paying for a fake
 * model stream each time.
 */
const FIXTURE_PROJECT = fileURLToPath(new URL("./fixtures/vault/novels/ice-house", import.meta.url));

/** Same pattern as `cli.test.ts`'s `NO_THINK_PATH`: real `bun`/`git` resolve, `think` never does. */
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");

/**
 * AGT-1262: `runRituals` now appends a `queued` event to
 * `stateReviewPath(env)` unconditionally — a test whose `env` carries no
 * `XDG_STATE_HOME` would append to the author's real
 * `~/.local/state/pablo/review.jsonl`. Every temp dir this creates is
 * removed by the module-level `afterEach` cleanup below, the same discipline
 * `write-send.test.ts`/`prose-send.test.ts` use for their own temp dirs.
 */
const stateHomeDirs: string[] = [];
function tempStateHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-rituals-state-"));
  stateHomeDirs.push(dir);
  return dir;
}

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-rituals-test-"));
  const project = join(dir, "ice-house");
  cpSync(FIXTURE_PROJECT, project, { recursive: true });
  return project;
}

function runGit(dir: string, args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  }
}

/** Git-initialises `dir` and commits the fixture's starting state, so the rituals' own commit has a base to diff against. */
function gitInitBase(dir: string): void {
  runGit(dir, ["init", "-q"]);
  runGit(dir, ["config", "user.email", "pablo-test@example.com"]);
  runGit(dir, ["config", "user.name", "Pablo Test"]);
  runGit(dir, ["add", "."]);
  runGit(dir, ["commit", "-q", "-m", "base"]);
}

/** The current commit's changed paths, sorted, via `git log -1 --name-only`. */
function lastCommitPaths(dir: string): string[] {
  const result = Bun.spawnSync(["git", "-C", dir, "log", "-1", "--name-only", "--pretty=format:"], { stdout: "pipe" });
  return result.stdout
    .toString("utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .sort();
}

/** Stands in for what `write.ts` already wrote before calling `runRituals`. */
function writeChapterFile(project: string, chapter: number, slug: string): string {
  const name = `${String(chapter).padStart(2, "0")}-${slug}.md`;
  const abs = join(project, "chapters", name);
  writeFileSync(abs, `---\nchapter: ${chapter}\n---\n\nDraft text for chapter ${chapter}.\n`, "utf8");
  return abs;
}

/** Writes an executable shell script named `think` into a fresh temp dir and returns that dir (for PATH). */
function fakeThinkPath(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-rituals-fake-think-"));
  const bin = join(dir, "think");
  writeFileSync(bin, script, "utf8");
  chmodSync(bin, 0o755);
  return dir;
}

/** Row `chapter`'s status cell (outline/chapters.md's last cell), byte-trimmed. */
function outlineStatus(project: string, chapter: number): string | undefined {
  const text = readFileSync(join(project, "outline", "chapters.md"), "utf8");
  const line = text.split("\n").find((l) => new RegExp(`^\\|\\s*${chapter}\\s*\\|`).test(l));
  if (line === undefined) return undefined;
  const cells = line.split("|");
  return cells[cells.length - 2]?.trim();
}

function setOutlineStatus(project: string, chapter: number, status: string): void {
  const path = join(project, "outline", "chapters.md");
  const lines = readFileSync(path, "utf8").split("\n");
  const idx = lines.findIndex((l) => new RegExp(`^\\|\\s*${chapter}\\s*\\|`).test(l));
  const cells = (lines[idx] ?? "").split("|");
  cells[cells.length - 2] = ` ${status} `;
  lines[idx] = cells.join("|");
  writeFileSync(path, lines.join("\n"), "utf8");
}

function byName(rituals: readonly Ritual[]): Record<string, Ritual> {
  return Object.fromEntries(rituals.map((r) => [r.name, r]));
}

afterEach(() => {
  while (stateHomeDirs.length > 0) {
    const dir = stateHomeDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** `<stateHome>/pablo/review.jsonl`'s `queued` events, in order. */
function queuedEvents(stateHome: string): QueuedEvent[] {
  return readEvents(join(stateHome, "pablo", "review.jsonl")).filter(
    (event): event is QueuedEvent => event.type === "queued",
  );
}

function baseOpts(overrides: Partial<RitualOptions> = {}): RitualOptions {
  return {
    slug: "ice-house",
    words: 42,
    model: "test-writer-model",
    receiptLine: "read 1200 tokens in 0.4s, wrote 42 in 1.4s",
    now: () => new Date("2026-09-06T12:00:00.000Z"),
    env: { PATH: NO_THINK_PATH, XDG_STATE_HOME: tempStateHome() },
    thinkTimeoutMs: 2000,
    queue: { id: "20260906-ice-house-abcd", title: "Black Ice", vault: "/tmp/pablo-rituals-fixture-vault", promptHash: "deadbeef" },
    ...overrides,
  };
}

test("runRituals ticks the outline, notes, updates the README, commits exactly the touched paths, and skips think off PATH", async () => {
  const project = tempProject();
  gitInitBase(project);
  const chapterPath = writeChapterFile(project, 2, "black-ice");

  const opts = baseOpts();
  const rituals = await runRituals(project, 2, chapterPath, opts);
  expect(rituals).toHaveLength(7);

  const ritualsByName = byName(rituals);
  expect(ritualsByName["outline"]?.status).toBe("ran");
  expect(ritualsByName["note"]?.status).toBe("ran");
  expect(ritualsByName["readme"]?.status).toBe("ran");
  expect(ritualsByName["continuity"]?.status).toBe("skipped");
  expect(ritualsByName["continuity"]?.detail).toBe("no extraction adapter");
  expect(ritualsByName["git"]?.status).toBe("ran");
  expect(ritualsByName["queue"]?.status).toBe("ran");
  expect(ritualsByName["think"]?.status).toBe("skipped");
  expect(ritualsByName["think"]?.detail).toBe("think not on PATH");

  // AGT-1262: the queued event landed in the state dir's review.jsonl, text-free.
  const queued = queuedEvents(opts.env?.["XDG_STATE_HOME"] as string);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({
    kind: "chapter",
    id: opts.queue.id,
    title: opts.queue.title,
    path: chapterPath,
    vault: opts.queue.vault,
    project: "ice-house",
    words: 42,
    prompt_hash: opts.queue.promptHash,
  });

  // Outline: row 2 ticked, row 3 (and every other row) byte-for-byte untouched.
  expect(outlineStatus(project, 2)).toBe("draft");
  expect(outlineStatus(project, 3)).toBe("outline");
  expect(outlineStatus(project, 4)).toBe("outline");

  // Note: created with the heading and the receipt/words/model line.
  const notePath = join(project, "notes", "2026-09-06-chapter-02.md");
  expect(existsSync(notePath)).toBe(true);
  const noteText = readFileSync(notePath, "utf8");
  expect(noteText).toContain("# 2026-09-06 — chapter 2 drafted");
  expect(noteText).toContain("read 1200 tokens in 0.4s, wrote 42 in 1.4s");
  expect(noteText).toContain("words: 42, model: test-writer-model");

  // README: "Where things stand" created (the fixture has no such section yet) with the bullet.
  const readme = readFileSync(join(project, "README.md"), "utf8");
  expect(readme).toContain("## Where things stand");
  expect(readme).toContain("- 2026-09-06: chapter 2 drafted (42 words, test-writer-model).");

  // Git: exactly the touched paths.
  expect(lastCommitPaths(project)).toEqual(
    ["chapters/02-black-ice.md", "notes/2026-09-06-chapter-02.md", "outline/chapters.md", "README.md"].sort(),
  );

  rmSync(project, { recursive: true, force: true });
});

test("an unwritable state directory: the queue ritual fails, and nothing else is undone (AGT-1262 AC5)", async () => {
  const project = tempProject();
  gitInitBase(project);
  const chapterPath = writeChapterFile(project, 2, "black-ice");

  // Make `<stateHome>/pablo` itself unwritable so `appendEvent`'s `mkdirSync`
  // (of `review.jsonl`'s own, not-yet-existing parent) fails with EACCES.
  const stateHome = tempStateHome();
  const pabloDir = join(stateHome, "pablo");
  mkdirSync(pabloDir, { recursive: true });
  chmodSync(pabloDir, 0o500);

  try {
    const rituals = await runRituals(project, 2, chapterPath, baseOpts({ env: { PATH: NO_THINK_PATH, XDG_STATE_HOME: stateHome } }));
    const ritualsByName = byName(rituals);

    expect(ritualsByName["queue"]?.status).toBe("failed");
    expect(ritualsByName["outline"]?.status).toBe("ran");
    expect(ritualsByName["git"]?.status).toBe("ran");
    expect(existsSync(chapterPath)).toBe(true);
  } finally {
    chmodSync(pabloDir, 0o700);
  }

  rmSync(project, { recursive: true, force: true });
});

test("a non-git temp copy: the git ritual fails but nothing else is undone, and the chapter file survives", async () => {
  const project = tempProject();
  const chapterPath = writeChapterFile(project, 2, "black-ice");

  const rituals = await runRituals(project, 2, chapterPath, baseOpts());
  const ritualsByName = byName(rituals);

  expect(ritualsByName["outline"]?.status).toBe("ran");
  expect(ritualsByName["note"]?.status).toBe("ran");
  expect(ritualsByName["readme"]?.status).toBe("ran");
  expect(ritualsByName["git"]?.status).toBe("failed");
  expect(ritualsByName["git"]?.detail).toContain("not a git repository");
  expect(ritualsByName["think"]?.status).toBe("skipped");

  expect(existsSync(chapterPath)).toBe(true);
  expect(outlineStatus(project, 2)).toBe("draft");

  rmSync(project, { recursive: true, force: true });
});

test("an outline row already marked draft is skipped, idempotently", async () => {
  const project = tempProject();
  gitInitBase(project);
  const chapterPath = writeChapterFile(project, 2, "black-ice");
  setOutlineStatus(project, 2, "draft");
  runGit(project, ["add", "."]);
  runGit(project, ["commit", "-q", "-m", "pre-drafted"]);

  const rituals = await runRituals(project, 2, chapterPath, baseOpts());
  const outline = rituals.find((r) => r.name === "outline");

  expect(outline?.status).toBe("skipped");
  expect(outline?.detail).toContain("already marked draft");
  expect(outlineStatus(project, 2)).toBe("draft");

  rmSync(project, { recursive: true, force: true });
});

test("a fake think script that exits 0 is 'ran'", async () => {
  const project = tempProject();
  gitInitBase(project);
  const chapterPath = writeChapterFile(project, 2, "black-ice");
  const thinkDir = fakeThinkPath("#!/bin/sh\nexit 0\n");

  const rituals = await runRituals(project, 2, chapterPath, baseOpts({ env: { PATH: thinkDir, XDG_STATE_HOME: tempStateHome() } }));
  const think = rituals.find((r) => r.name === "think");

  expect(think?.status).toBe("ran");
  expect(think?.detail).toContain("ice-house: drafted chapter 2 (42 words)");

  rmSync(thinkDir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

test("a fake think script that exits 3 is 'failed' with 'exited 3'", async () => {
  const project = tempProject();
  gitInitBase(project);
  const chapterPath = writeChapterFile(project, 2, "black-ice");
  const thinkDir = fakeThinkPath("#!/bin/sh\nexit 3\n");

  const rituals = await runRituals(project, 2, chapterPath, baseOpts({ env: { PATH: thinkDir, XDG_STATE_HOME: tempStateHome() } }));
  const think = rituals.find((r) => r.name === "think");

  expect(think?.status).toBe("failed");
  expect(think?.detail).toBe("exited 3");

  rmSync(thinkDir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

test("a fake think script that sleeps past a short injected timeout is 'failed' with 'timed out'", async () => {
  const project = tempProject();
  gitInitBase(project);
  const chapterPath = writeChapterFile(project, 2, "black-ice");
  const thinkDir = fakeThinkPath("#!/bin/sh\nsleep 5\n");

  const rituals = await runRituals(project, 2, chapterPath, baseOpts({ env: { PATH: thinkDir, XDG_STATE_HOME: tempStateHome() }, thinkTimeoutMs: 150 }));
  const think = rituals.find((r) => r.name === "think");

  expect(think?.status).toBe("failed");
  expect(think?.detail).toContain("timed out");

  rmSync(thinkDir, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

test("calling runRituals twice on the same day appends to the note file instead of duplicating it", async () => {
  const project = tempProject();
  gitInitBase(project);
  const chapterPath = writeChapterFile(project, 2, "black-ice");

  await runRituals(project, 2, chapterPath, baseOpts());
  await runRituals(project, 2, chapterPath, baseOpts({ receiptLine: "read 1300 tokens in 0.5s, wrote 50 in 1.5s", words: 50 }));

  const noteFiles = readdirSync(join(project, "notes")).filter((f) => f.startsWith("2026-09-06-chapter-02"));
  expect(noteFiles).toHaveLength(1);

  const text = readFileSync(join(project, "notes", "2026-09-06-chapter-02.md"), "utf8");
  expect((text.match(/^# /gm) ?? []).length).toBe(1);
  expect(text).toContain("read 1200 tokens in 0.4s, wrote 42 in 1.4s");
  expect(text).toContain("read 1300 tokens in 0.5s, wrote 50 in 1.5s");

  rmSync(project, { recursive: true, force: true });
});
