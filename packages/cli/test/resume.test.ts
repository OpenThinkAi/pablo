import { expect, test } from "bun:test";
import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildResume, formatResumeProse } from "../src/resume";

/** The synthetic fixture novel (same one `machine.test.ts` reads): 4 beats, 1 written chapter. */
const WORK = fileURLToPath(new URL("./fixtures/vault/novels/ice-house", import.meta.url));

/** A PATH that resolves no binaries at all — `think` included — so tests never shell out for real. */
const NO_THINK_PATH = "/nonexistent-bin-for-resume-test";

function tempWork(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-resume-test-"));
  const work = join(dir, "ice-house");
  cpSync(WORK, work, { recursive: true });
  return work;
}

/** Writes an executable shell script named `think` into a fresh temp dir and returns that dir (for PATH). */
function fakeThinkPath(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-fake-think-"));
  const bin = join(dir, "think");
  writeFileSync(bin, script, "utf8");
  chmodSync(bin, 0o755);
  return dir;
}

function runGit(dir: string, args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  }
}

test("buildResume on the fixture novel has the right shape and next is 'write chapter 2'", async () => {
  const result = await buildResume(WORK, "ice-house", { env: { PATH: NO_THINK_PATH } });

  expect(result.format).toBe("novel");
  expect(result.title).toBe("The Ice House");
  expect(result.stages.beats).toHaveLength(4);
  expect(result.stages.chapters).toHaveLength(1);
  expect(result.next).toBe("write chapter 2 (pablo write --chapter 2)");

  expect(result.last.note).toEqual({
    file: "notes/1929-01-09-first-session.md",
    date: "1929-01-09",
    summary: "1929-01-09 session notes",
  });

  expect(result.open).toContainEqual({
    source: "bible/characters/family-tree.md",
    text: "Mrs. Frayne ([pick] in bible/characters/family-tree.md)",
  });
  expect(result.open).toContainEqual({
    source: "bible/characters/family-tree.md",
    text: "Whether Celine appears on the page in Act I or only in the ledgers.",
  });

  // "### Open questions for Act I" in outline/chapters.md is a level-3 heading, not
  // "## Open questions...", so its bullet must NOT be picked up.
  expect(result.open.some((item) => item.text.includes("schooner is named"))).toBe(false);

  expect(result.notices).toEqual(["think not on PATH"]);
  expect(result.brief).toBeUndefined();
});

test("formatResumeProse is under 30 lines and its final line starts with 'next:'", async () => {
  const result = await buildResume(WORK, "ice-house", { env: { PATH: NO_THINK_PATH } });
  const prose = formatResumeProse(result);
  const lines = prose.split("\n");

  expect(lines.length).toBeLessThan(30);
  expect(lines[lines.length - 1]).toMatch(/^next: /);
  expect(lines[lines.length - 1]).toBe("next: write chapter 2 (pablo write --chapter 2)");
});

test("a think that sleeps past a short injected timeout produces a 'timed out' notice", async () => {
  const thinkDir = fakeThinkPath("#!/bin/sh\nsleep 5\n");

  const result = await buildResume(WORK, "ice-house", { env: { PATH: thinkDir }, timeoutMs: 150 });

  expect(result.brief).toBeUndefined();
  expect(result.notices).toBeDefined();
  expect(result.notices?.[0]).toContain("timed out");

  rmSync(thinkDir, { recursive: true, force: true });
});

test("a think that exits 3 produces an 'exited 3' notice", async () => {
  const thinkDir = fakeThinkPath("#!/bin/sh\nexit 3\n");

  const result = await buildResume(WORK, "ice-house", { env: { PATH: thinkDir }, timeoutMs: 2000 });

  expect(result.brief).toBeUndefined();
  expect(result.notices).toEqual(["think brief exited 3"]);

  rmSync(thinkDir, { recursive: true, force: true });
});

test("a think that succeeds lands its trimmed stdout as brief", async () => {
  const thinkDir = fakeThinkPath('#!/bin/sh\nprintf "  the recalled context  \\n"\n');

  const result = await buildResume(WORK, "ice-house", { env: { PATH: thinkDir }, timeoutMs: 2000 });

  expect(result.brief).toBe("the recalled context");
  expect(result.notices).toBeUndefined();

  rmSync(thinkDir, { recursive: true, force: true });
});

test("PATH with no think produces a 'think not on PATH' notice", async () => {
  const result = await buildResume(WORK, "ice-house", { env: { PATH: NO_THINK_PATH } });

  expect(result.notices).toEqual(["think not on PATH"]);
});

test("a temp copy of the fixture with a git commit has last.commit present", async () => {
  const work = tempWork();
  runGit(work, ["init", "-q"]);
  runGit(work, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "add", "-A"]);
  runGit(work, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "seed fixture"]);

  const result = await buildResume(work, "ice-house", { env: { PATH: NO_THINK_PATH } });

  expect(result.last.commit).toBeDefined();
  expect(result.last.commit?.subject).toBe("seed fixture");
  expect(result.last.commit?.sha).toMatch(/^[0-9a-f]+$/);
  expect(result.last.commit?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  rmSync(work, { recursive: true, force: true });
});

test("a temp copy of the fixture with no git repo has last.commit absent", async () => {
  const work = tempWork();

  const result = await buildResume(work, "ice-house", { env: { PATH: NO_THINK_PATH } });

  expect(result.last.commit).toBeUndefined();

  rmSync(work, { recursive: true, force: true });
});
