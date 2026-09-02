import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  BRIEF_TIMEOUT_MS,
  briefCommand,
  detectWork,
  directoryExists,
  findVaultRoot,
  resolveThink,
  runBrief,
  workUnder,
  type SpawnResult,
  type Spawner,
} from "../src/brief";

/**
 * Detection is tested over synthetic paths with an injected probe — no vault on
 * disk, and never Matt's real one — plus one pass over the repo's own fixture
 * vault so the rule is checked against a real tree as well.
 *
 * The runner is tested twice over: once with a fake spawner (the outcomes), and
 * once against a fake `think` script on a `PATH` this file controls (that the
 * spawn, the timeout, and the kill are real).
 */

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop() ?? "", { recursive: true, force: true });
});

const VAULT = "/home/writer/writing";

/** A probe over a fixed set of directories: pure, and no disk. */
function probe(...vaults: string[]): (path: string) => boolean {
  const styles = new Set(vaults.map((vault) => join(vault, "style")));
  return (path: string) => styles.has(path);
}

test("the vault root is the nearest ancestor holding style/ (AC1)", () => {
  const isDirectory = probe(VAULT);
  expect(findVaultRoot(`${VAULT}/novels/valleys-shadow/chapters/01.md`, isDirectory)).toBe(VAULT);
  expect(findVaultRoot(`${VAULT}/style/prose.md`, isDirectory)).toBe(VAULT);
  expect(findVaultRoot("/tmp/scratch/chapter.md", isDirectory)).toBeUndefined();
});

test("a vault nested inside another resolves to the nearer one", () => {
  const inner = `${VAULT}/novels/valleys-shadow/spinoff`;
  const isDirectory = probe(VAULT, inner);
  expect(findVaultRoot(`${inner}/novels/one-night/chapters/01.md`, isDirectory)).toBe(inner);
});

test("the slug is the directory directly under <vault>/<kind>/ (AC1)", () => {
  const isDirectory = probe(VAULT);
  expect(detectWork(`${VAULT}/novels/valleys-shadow/chapters/01.md`, isDirectory)).toEqual({
    vaultRoot: VAULT,
    kind: "novels",
    slug: "valleys-shadow",
  });

  // Depth past the slug does not matter: every file in the work briefs the work.
  expect(detectWork(`${VAULT}/novels/valleys-shadow/bible/characters/family-tree.md`, isDirectory)?.slug).toBe(
    "valleys-shadow",
  );
  expect(detectWork(`${VAULT}/stories/the-ferry/draft.md`, isDirectory)).toEqual({
    vaultRoot: VAULT,
    kind: "stories",
    slug: "the-ferry",
  });
});

test("a file that names no work briefs nothing", () => {
  const isDirectory = probe(VAULT);

  // In the vault, but not in a work: the root, the kind directory, and style/.
  expect(detectWork(`${VAULT}/README.md`, isDirectory)).toBeUndefined();
  expect(detectWork(`${VAULT}/novels/README.md`, isDirectory)).toBeUndefined();
  expect(detectWork(`${VAULT}/style/prose.md`, isDirectory)).toBeUndefined();
  expect(detectWork(`${VAULT}/.pablo/receipts/01.md`, isDirectory)).toBeUndefined();

  // Not in a vault at all — the common case for a scratch file.
  expect(detectWork("/tmp/scratch/chapter.md", isDirectory)).toBeUndefined();
});

test("workUnder refuses a path outside the root it was given", () => {
  expect(workUnder(VAULT, "/home/writer/other/novels/x/chapters/01.md")).toBeUndefined();
  expect(workUnder(VAULT, VAULT)).toBeUndefined();
});

test("the rule holds against a real vault tree (the repo's fixture)", () => {
  const chapter = resolve(
    dirname(import.meta.path),
    "../../core/test/fixtures/vault/novels/ice-house/chapters/01-the-last-full-cut.md",
  );
  const work = detectWork(chapter, directoryExists);

  expect(work?.slug).toBe("ice-house");
  expect(work?.kind).toBe("novels");
  expect(work?.vaultRoot.endsWith(join("test", "fixtures", "vault"))).toBe(true);
});

test("the command is the one the design doc's ritual table names", () => {
  expect(briefCommand("/usr/local/bin/think", "valleys-shadow")).toEqual([
    "/usr/local/bin/think",
    "brief",
    "--cortex",
    "writing",
    "--context",
    "valleys-shadow",
  ]);
});

function fakeSpawn(result: Partial<SpawnResult>, seen?: string[][]): Spawner {
  return async (command) => {
    seen?.push([...command]);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...result };
  };
}

const FOUND = (): string => "/fake/bin/think";

test("a brief that runs returns its stdout, trimmed", async () => {
  const seen: string[][] = [];
  const outcome = await runBrief("valleys-shadow", {
    resolve: FOUND,
    spawn: fakeSpawn({ stdout: "── repo lessons ──\nthe cellar is cold\n\n" }, seen),
  });

  expect(outcome.status).toBe("ready");
  expect(outcome.text).toBe("── repo lessons ──\nthe cellar is cold");
  expect(seen[0]).toEqual(["/fake/bin/think", "brief", "--cortex", "writing", "--context", "valleys-shadow"]);
});

test("stderr is never part of the brief: think writes advisory notes there", async () => {
  const outcome = await runBrief("ice-house", {
    resolve: FOUND,
    spawn: fakeSpawn({ stdout: "the brief", stderr: "note: --cortex now selects the HOME cortex" }),
  });

  expect(outcome.text).toBe("the brief");
});

test("think missing from PATH is a notice, not an error (AC3)", async () => {
  const outcome = await runBrief("ice-house", { resolve: () => undefined });

  expect(outcome.status).toBe("unavailable");
  expect(outcome.text).toBeUndefined();
  expect(outcome.notice).toContain("PATH");
});

test("a non-zero exit is a notice that quotes the first line of stderr (AC3)", async () => {
  const outcome = await runBrief("ice-house", {
    resolve: FOUND,
    spawn: fakeSpawn({ exitCode: 3, stderr: "error: no such cortex\nstack trace\n" }),
  });

  expect(outcome.status).toBe("unavailable");
  expect(outcome.notice).toContain("exit 3");
  expect(outcome.notice).toContain("no such cortex");
  expect(outcome.notice).not.toContain("stack trace");
});

test("a timeout and an empty brief are both notices (AC3)", async () => {
  const timedOut = await runBrief("ice-house", {
    resolve: FOUND,
    timeoutMs: 20_000,
    spawn: fakeSpawn({ timedOut: true }),
  });
  expect(timedOut.status).toBe("unavailable");
  expect(timedOut.notice).toContain("20s");

  const empty = await runBrief("ice-house", { resolve: FOUND, spawn: fakeSpawn({ stdout: "  \n" }) });
  expect(empty.status).toBe("unavailable");
  expect(empty.notice).toContain("ice-house");
});

test("a spawner that throws is still only a notice (AC3)", async () => {
  const outcome = await runBrief("ice-house", {
    resolve: FOUND,
    spawn: () => Promise.reject(new Error("EAGAIN")),
  });

  expect(outcome.status).toBe("unavailable");
  expect(outcome.notice).toContain("EAGAIN");
});

test("the default timeout is generous enough for a cold daemon, and bounded", () => {
  expect(BRIEF_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  expect(BRIEF_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
});

/** A directory holding an executable `think`, for a PATH this test controls. */
function fakeThink(script: string): string {
  const directory = mkdtempSync(join(tmpdir(), "pablo-path-"));
  directories.push(directory);
  const path = join(directory, "think");
  writeFileSync(path, script, "utf8");
  chmodSync(path, 0o755);
  return directory;
}

test("`think` is resolved from PATH at run time, never from a hardcoded path", async () => {
  // `$5` is the slug only if the argv is exactly `brief --cortex writing
  // --context <slug>`, so this asserts the command shape as well as the spawn.
  const bin = fakeThink('#!/bin/sh\necho "── repo lessons [$5] ──"\n');

  expect(resolveThink(bin)).toBe(join(bin, "think"));

  const outcome = await runBrief("ice-house", { path: bin });
  expect(outcome.status).toBe("ready");
  expect(outcome.text).toBe("── repo lessons [ice-house] ──");
});

test("an empty PATH means no brief and an open view (AC3)", async () => {
  const empty = mkdtempSync(join(tmpdir(), "pablo-empty-"));
  directories.push(empty);

  expect(resolveThink(empty)).toBeUndefined();
  const outcome = await runBrief("ice-house", { path: empty });
  expect(outcome.status).toBe("unavailable");
  expect(outcome.notice).toContain("PATH");
});

test("a real failing `think` is reported, not thrown (AC3)", async () => {
  const bin = fakeThink('#!/bin/sh\necho "boom" >&2\nexit 4\n');
  const outcome = await runBrief("ice-house", { path: bin });

  expect(outcome.status).toBe("unavailable");
  expect(outcome.notice).toContain("exit 4");
  expect(outcome.notice).toContain("boom");
});

test("a hung `think` is killed at the timeout and leaves nothing running (AC3)", async () => {
  // `exec` so the shell becomes the sleep: killing the child kills the sleep
  // too, rather than orphaning it.
  const bin = fakeThink("#!/bin/sh\nexec sleep 30\n");
  const started = Date.now();
  const outcome = await runBrief("ice-house", { path: bin, timeoutMs: 150 });

  expect(outcome.status).toBe("unavailable");
  expect(outcome.notice).toContain("timed out");
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("aborting the session kills a brief that is still running", async () => {
  const bin = fakeThink("#!/bin/sh\nexec sleep 30\n");
  const controller = new AbortController();
  const running = runBrief("ice-house", { path: bin, timeoutMs: 30_000, signal: controller.signal });

  await Bun.sleep(20);
  controller.abort();
  const outcome = await running;

  // Killed, not timed out: the notice is about the failure, and the promise
  // resolves rather than hanging the teardown.
  expect(outcome.status).toBe("unavailable");
  expect(outcome.text).toBeUndefined();
});
