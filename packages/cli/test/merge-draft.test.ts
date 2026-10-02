import { afterEach, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent } from "@openthink/pablo-core";
import { commitAs, createBranch } from "../src/branch";
import { draftChapter, mergeDraft, mergeDraftInProject } from "../src/novel/merge";
import { runWrite } from "../src/write";

/**
 * AGT-1536: `write` commits a chapter on `draft/chNN` and runs none of the
 * after-write steps; `mergeDraft` merges the branch and runs them. Fake
 * adapter, temp git vault, a think-free (or fake-think) PATH, temp PABLO_HOME
 * and XDG_STATE_HOME throughout.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8").trim();
}

function setup(path = NO_THINK_PATH): { vault: string; project: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "pablo-merge-draft-"));
  dirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  return {
    vault,
    project: join(vault, "novels", "ice-house"),
    env: { PATH: path, XDG_STATE_HOME: join(dir, "state"), PABLO_HOME: join(dir, "home") },
  };
}

const adapter: Adapter = {
  id: "local",
  model: "test-writer-model",
  preferredOutput: "text",
  async *complete(): AsyncIterable<CompletionEvent> {
    yield { type: "token", text: "The storm came up from the coast. She let him in." };
    yield { type: "done", stats: { timeToFirstTokenMs: 1, elapsedMs: 2, tokensRead: 3, tokensWritten: 4, tokensPerSecond: 5 } };
  },
  async proposeEdit(): Promise<never> {
    throw new Error("not implemented");
  },
  async extractFacts(): Promise<never> {
    throw new Error("not implemented");
  },
};

async function write(vault: string, project: string, env: Record<string, string>): Promise<void> {
  const log = console.log;
  console.log = () => {};
  try {
    const code = await runWrite(
      { chapter: "2", words: undefined, scenes: undefined, dryRun: false, json: true, force: false },
      vault,
      project,
      { adapter, env, stderr: { write: () => {} } },
    );
    expect(code).toBe(0);
  } finally {
    console.log = log;
  }
}

function outlineRow(project: string): string {
  return readFileSync(join(project, "outline", "chapters.md"), "utf8")
    .split("\n")
    .find((l) => /^\|\s*2\s*\|/.test(l)) as string;
}

test("draftChapter reads the chapter off draft/chNN and its variants only", () => {
  expect(draftChapter("draft/ch05")).toBe(5);
  expect(draftChapter("draft/ch12-v3")).toBe(12);
  expect(draftChapter("revise/abc")).toBeUndefined();
  expect(draftChapter("draft/notes")).toBeUndefined();
});

test("write runs no after-write step; merging the draft runs them all on main (AGT-1536 AC1, AC2)", async () => {
  const think = mkdtempSync(join(tmpdir(), "pablo-merge-think-"));
  dirs.push(think);
  const marker = join(think, "called");
  writeFileSync(join(think, "think"), `#!/bin/sh\necho "$@" >> ${marker}\n`);
  chmodSync(join(think, "think"), 0o755);
  const { vault, project, env } = setup(`${think}:${NO_THINK_PATH}`);
  const outlineBefore = outlineRow(project);

  await write(vault, project, env);

  // Nothing but the draft branch moved: main, its tree, the outline, notes, README, think.
  expect(git(vault, "log", "--format=%s", "main")).toBe("base");
  expect(git(vault, "log", "--format=%s", "main..draft/ch02")).toBe("ice-house: draft chapter 2");
  expect(outlineRow(project)).toBe(outlineBefore);
  expect(git(vault, "ls-files", "novels/ice-house/notes").split("\n").filter((f) => f.includes("chapter-02"))).toEqual([]);
  expect(existsSync(join(project, "notes", "2026-09-06-chapter-02.md"))).toBe(false);
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(join(project, "chapters", "02-black-ice.md"))).toBe(false);

  const merged = await mergeDraft(project, "draft/ch02", { slug: "ice-house", env, now: () => new Date("2026-09-06T12:00:00.000Z"), extractor: adapter });
  expect(merged.ok).toBe(true);
  if (!merged.ok) return;
  expect(merged.rituals.map((r) => [r.name, r.status])).toEqual([
    ["outline", "ran"],
    ["note", "ran"],
    ["readme", "ran"],
    ["continuity", "skipped"], // the fake has no extractFactsWithAnchors
    ["git", "ran"],
    ["think", "ran"],
  ]);

  expect(existsSync(join(project, "chapters", "02-black-ice.md"))).toBe(true);
  expect(outlineRow(project)).toContain("draft");
  expect(existsSync(join(project, "notes", "2026-09-06-chapter-02.md"))).toBe(true);
  expect(readFileSync(join(project, "README.md"), "utf8")).toContain("chapter 2 drafted");
  expect(readFileSync(marker, "utf8")).toContain("sync");
  // The draft branch and its worktree are gone once merged.
  expect(git(vault, "branch", "--list", "draft/*")).toBe("");
  expect(git(vault, "branch", "--show-current")).toBe("main");
});

test("a conflicting merge runs no after-write step and leaves main as it was", async () => {
  const { vault, project, env } = setup();
  await write(vault, project, env);
  // The same chapter file lands on main with different content before the draft merges.
  writeFileSync(join(project, "chapters", "02-black-ice.md"), "different\n");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "main edit");
  const head = git(vault, "rev-parse", "HEAD");

  const merged = await mergeDraft(project, "draft/ch02", { slug: "ice-house", env });
  expect(merged.ok).toBe(false);
  expect(git(vault, "rev-parse", "HEAD")).toBe(head);
  expect(git(vault, "status", "--porcelain", "-uno")).toBe("");
  expect(outlineRow(project)).not.toContain("draft");
  expect(git(vault, "branch", "--list", "draft/ch02")).toContain("draft/ch02");
});

test("mergeDraft refuses a branch that is not a draft", async () => {
  const { vault, project, env } = setup();
  const made = createBranch(vault, "ice-house", "revise/abc", env);
  expect(made.ok).toBe(true);
  if (made.ok) commitAs(made.path as string, { message: "x", author: { name: "a", email: "a@b" } });
  const merged = await mergeDraft(project, "revise/abc", { slug: "ice-house", env });
  expect(merged.ok).toBe(false);
});

test("pablo merge: a non-draft branch is refused (exit 2) by the CLI verb; the verb entry merges with an injected extractor", async () => {
  const { vault, project, env } = setup();
  await write(vault, project, env);
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const refused = Bun.spawnSync(["bun", "run", cli, "merge", "--project", "ice-house", "main", "--json"], {
    env: { ...process.env, ...env, PABLO_VAULT: vault },
  });
  expect(refused.exitCode).toBe(2);
  expect(JSON.parse(refused.stdout.toString())).toMatchObject({ ok: false, code: 2 });

  // The CLI's success path routes a real extraction adapter; the verb's entry takes a fake instead.
  const outcome = await mergeDraftInProject(project, "draft/ch02", env, adapter);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.body).toMatchObject({ ok: true, branch: "draft/ch02", chapter: 2 });
  expect(existsSync(join(project, "chapters", "02-black-ice.md"))).toBe(true);
});
