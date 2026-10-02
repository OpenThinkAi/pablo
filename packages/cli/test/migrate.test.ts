import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIGRATE_COMMIT_MESSAGE, migrateLines, splitChapter } from "../src/migrate";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

function git(vault: string, ...args: string[]): string {
  return execFileSync("git", ["-C", vault, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
}

/** A git-initialised temp copy of the fixture vault with everything committed. */
function tempVault(): { vault: string; work: string } {
  const vault = mkdtempSync(join(tmpdir(), "pablo-migrate-test-"));
  cpSync(FIXTURE, vault, { recursive: true });
  git(vault, "init", "-q", "-b", "main");
  git(vault, "add", "-A");
  git(vault, "commit", "-q", "-m", "fixture");
  return { vault, work: join(vault, "novels", "ice-house") };
}

function runCli(args: string[], vault: string) {
  const r = Bun.spawnSync(["bun", "run", CLI, ...args], {
    env: { ...process.env, PABLO_VAULT: vault, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), exitCode: r.exitCode };
}

test("splitChapter leaves frontmatter, headings, scene breaks and blank lines alone and splits prose", () => {
  const input = `---
chapter: 1
title: "Mr. Hale. A test"
---

# One

He stopped. She waited.

* * *

"Go home," she said. "Now."
`;
  expect(splitChapter(input)).toBe(`---
chapter: 1
title: "Mr. Hale. A test"
---

# One

He stopped.
She waited.

* * *

"Go home," she said.
"Now."
`);
});

test("splitChapter is idempotent", () => {
  const once = splitChapter("---\na: 1\n---\n\nOne two. Three four.\nFive six. Mr. Smith left.\n");
  expect(splitChapter(once)).toBe(once);
});

test("migrateLines splits chapters only and commits exactly those files in one commit", () => {
  const { vault, work } = tempVault();
  const before = git(vault, "rev-list", "--count", "HEAD").trim();
  const chapter = join(work, "chapters", "01-the-last-full-cut.md");
  const original = readFileSync(chapter, "utf8");
  const frontmatter = original.slice(0, original.indexOf("\n---\n", 4) + 5);

  const result = migrateLines(vault, work, { dryRun: false });
  expect(result).toMatchObject({ ok: true, committed: true, changed: ["chapters/01-the-last-full-cut.md"] });

  const after = readFileSync(chapter, "utf8");
  expect(after.startsWith(frontmatter)).toBe(true);
  expect(after).not.toBe(original);
  expect(after.split("\n").every((l) => l.length < 300)).toBe(true);
  expect(Number(git(vault, "rev-list", "--count", "HEAD").trim())).toBe(Number(before) + 1);
  expect(git(vault, "log", "-1", "--format=%s").trim()).toBe(MIGRATE_COMMIT_MESSAGE);
  expect(git(vault, "show", "--name-only", "--format=", "HEAD").trim()).toBe("novels/ice-house/chapters/01-the-last-full-cut.md");
  expect(git(vault, "status", "--porcelain").trim()).toBe("");
});

test("a second run changes and commits nothing", () => {
  const { vault, work } = tempVault();
  migrateLines(vault, work, { dryRun: false });
  const head = git(vault, "rev-parse", "HEAD");

  const second = migrateLines(vault, work, { dryRun: false });
  expect(second).toMatchObject({ ok: true, changed: [], committed: false });
  expect(git(vault, "rev-parse", "HEAD")).toBe(head);
});

test("--dry-run lists the files it would change and writes nothing", () => {
  const { vault, work } = tempVault();
  const result = migrateLines(vault, work, { dryRun: true });
  expect(result).toMatchObject({ ok: true, dryRun: true, committed: false, changed: ["chapters/01-the-last-full-cut.md"] });
  expect(git(vault, "status", "--porcelain").trim()).toBe("");
});

test("refuses when a chapter it would change has uncommitted edits", () => {
  const { vault, work } = tempVault();
  const chapter = join(work, "chapters", "01-the-last-full-cut.md");
  writeFileSync(chapter, readFileSync(chapter, "utf8") + "\nAn unsaved edit. Another.\n");
  const result = migrateLines(vault, work, { dryRun: false });
  expect(result).toMatchObject({ ok: false, code: 2 });
});

test("CLI: pablo migrate lines --dry-run then real run, --json", () => {
  const { vault } = tempVault();
  const dry = runCli(["migrate", "lines", "--project", "ice-house", "--dry-run", "--json"], vault);
  expect(dry.exitCode).toBe(0);
  expect(JSON.parse(dry.stdout)).toMatchObject({ ok: true, dryRun: true, changed: ["chapters/01-the-last-full-cut.md"] });

  const real = runCli(["migrate", "lines", "--project", "ice-house", "--json"], vault);
  expect(JSON.parse(real.stdout)).toMatchObject({ ok: true, committed: true });
  const again = runCli(["migrate", "lines", "--project", "ice-house", "--json"], vault);
  expect(JSON.parse(again.stdout)).toMatchObject({ ok: true, changed: [], committed: false });
});

test("CLI: unknown migration and missing --project are refusals", () => {
  const { vault } = tempVault();
  expect(runCli(["migrate", "words", "--project", "ice-house"], vault).exitCode).toBe(2);
  expect(runCli(["migrate", "lines"], vault).exitCode).toBe(2);
});
