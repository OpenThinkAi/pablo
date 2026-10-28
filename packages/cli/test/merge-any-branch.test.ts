import { afterEach, expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commitAs, createBranch, worktreePath } from "../src/branch";
import { acceptBranchInProject, rejectBranchInProject } from "../src/review-finish";
import { VERBS } from "../src/verbs";
import type { VerbContext } from "../src/verbs";
import { useLocalConfigHome } from "./local-config";

useLocalConfigHome();

/**
 * AGT-2181: `pablo merge` (and the MCP `merge` tool) accepts any change branch, not only drafts, and `--reject`
 * deletes one. Temp git vault from the fixture, temp PABLO_HOME, a think-free PATH; no model is ever called (a plan/
 * branch touches no unit, and the revise/ case needs no extractor).
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const SLUG = "ice-house";
const AUTHOR = { name: "a", email: "a@b" };

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8").trim();
}

function setup(): { vault: string; project: string; home: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "pablo-merge-any-"));
  dirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  const home = join(dir, "home");
  return { vault, project: join(vault, "novels", SLUG), home, env: { PATH: NO_THINK_PATH, XDG_STATE_HOME: join(dir, "state"), PABLO_HOME: home } };
}

/** A `branch` with one commit writing `file` (relative to the project) to `text`; returns the worktree. */
function branchWith(vault: string, env: Record<string, string>, branch: string, file: string, text: string, append = false): string {
  const made = createBranch(vault, SLUG, branch, env);
  if (!made.ok) throw new Error(made.notice);
  const wt = made.path as string;
  const path = join(wt, "novels", SLUG, file);
  if (append) appendFileSync(path, text);
  else writeFileSync(path, text);
  const committed = commitAs(wt, { message: `x ${branch}`, author: AUTHOR, paths: [`novels/${SLUG}/${file}`] });
  if (!committed.ok) throw new Error(committed.notice);
  return wt;
}

const branchListed = (vault: string, branch: string): boolean => git(vault, "branch", "--list", branch) !== "";

test("merge accepts a plan/ branch: merged onto main, branch deleted, its worktree directories gone from the cache", async () => {
  const { vault, project, home, env } = setup();
  const wt = branchWith(vault, env, "plan/research", "research/harvest.md", "# Harvest\n\nCut at a foot of ice.\n");
  expect(existsSync(wt)).toBe(true);

  const outcome = await acceptBranchInProject(project, "plan/research", env);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.body).toMatchObject({ ok: true, branch: "plan/research", kind: "plan", merged: true, chapters: [] });
  expect(outcome.body["chapter"]).toBeUndefined();
  expect(readFileSync(join(project, "research", "harvest.md"), "utf8")).toContain("a foot of ice");
  expect(git(vault, "log", "-1", "--format=%s")).toBe("merge plan/research");
  expect(branchListed(vault, "plan/research")).toBe(false);
  expect(existsSync(wt)).toBe(false);
  // The kind and slug directories the worktree sat in are pruned too: nothing piles up under PABLO_HOME.
  expect(existsSync(join(home, "worktrees", SLUG))).toBe(false);
});

test("merge accepts a revise/ branch and reports the units it changes; an edit/ branch the same way", async () => {
  const { vault, project, env } = setup();
  const wt = branchWith(vault, env, "revise/abc", "chapters/01-the-last-full-cut.md", "\nA new last line.\n", true);
  const outcome = await acceptBranchInProject(project, "revise/abc", env);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.body).toMatchObject({ ok: true, kind: "revise", merged: true, chapters: [1] });
  expect(readFileSync(join(project, "chapters", "01-the-last-full-cut.md"), "utf8")).toContain("A new last line.");
  expect(existsSync(wt)).toBe(false);

  const ewt = branchWith(vault, env, "edit/ch01", "notes/edit.md", "an edit\n");
  const edited = await acceptBranchInProject(project, "edit/ch01", env);
  expect(edited.body).toMatchObject({ ok: true, kind: "edit", merged: true });
  expect(existsSync(ewt)).toBe(false);
  expect(branchListed(vault, "edit/ch01")).toBe(false);
});

test("merge --reject deletes the branch and its worktree (even with stray files in it); main is untouched", () => {
  const { vault, project, home, env } = setup();
  const before = git(vault, "rev-parse", "main");
  const wt = branchWith(vault, env, "plan/waive-3", "research/waive.md", "waived\n");
  writeFileSync(join(wt, "stray.json"), "{}"); // an untracked cache file left in the worktree
  const outcome = rejectBranchInProject(project, "plan/waive-3", env);
  expect(outcome.exitCode).toBe(0);
  expect(outcome.body).toEqual({ ok: true, branch: "plan/waive-3", kind: "plan", rejected: true });
  expect(git(vault, "rev-parse", "main")).toBe(before);
  expect(existsSync(join(project, "research", "waive.md"))).toBe(false);
  expect(branchListed(vault, "plan/waive-3")).toBe(false);
  expect(existsSync(wt)).toBe(false);
  expect(existsSync(join(home, "worktrees", SLUG))).toBe(false);
});

test("refusals name the kind: not a change branch, a missing branch of a kind, a draft branch of no unit", async () => {
  const { project, env } = setup();
  const notChange = await acceptBranchInProject(project, "main", env);
  expect(notChange.exitCode).toBe(2);
  expect(String(notChange.body["message"])).toContain('"main" is not a change branch (draft/, revise/, edit/, reader/, plan/)');

  const missing = await acceptBranchInProject(project, "plan/nope", env);
  expect(missing.exitCode).toBe(2);
  expect(String(missing.body["message"])).toContain('no plan branch "plan/nope"');

  const rejectMissing = rejectBranchInProject(project, "revise/nope", env);
  expect(rejectMissing.exitCode).toBe(2);
  expect(String(rejectMissing.body["message"])).toContain('merge --reject: no revise branch "revise/nope"');

  const noUnit = await acceptBranchInProject(project, "draft/xyz", env);
  expect(noUnit.exitCode).toBe(2);
  expect(String(noUnit.body["message"])).toContain('"draft/xyz" is a draft branch');
});

test("the merge verb (the MCP tool) accepts a plan/ branch, and with reject deletes one", async () => {
  const { vault, project, env } = setup();
  const verb = VERBS.find((v) => v.name === "merge")!;
  const ctx: VerbContext = { cwd: vault, env, stderr: { write: () => {} } };
  branchWith(vault, env, "plan/a", "research/a.md", "a\n");
  branchWith(vault, env, "plan/b", "research/b.md", "b\n");

  const accepted = await verb.run(verb.args.parse({ project: SLUG, branch: "plan/a" }) as never, ctx);
  expect(accepted.exitCode).toBe(0);
  expect(accepted.body).toMatchObject({ ok: true, kind: "plan", merged: true });
  expect(existsSync(join(project, "research", "a.md"))).toBe(true);

  const rejected = await verb.run(verb.args.parse({ project: SLUG, branch: "plan/b", reject: true }) as never, ctx);
  expect(rejected.exitCode).toBe(0);
  expect(rejected.body).toMatchObject({ ok: true, rejected: true });
  expect(branchListed(vault, "plan/b")).toBe(false);
  expect(existsSync(worktreePath(SLUG, "plan/b", env))).toBe(false);
});

test("pablo merge on the CLI: accepts a plan/ branch, and --reject deletes one", () => {
  const { vault, env } = setup();
  branchWith(vault, env, "plan/a", "research/a.md", "a\n");
  branchWith(vault, env, "plan/b", "research/b.md", "b\n");
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const run = (...args: string[]) => Bun.spawnSync(["bun", "run", cli, "merge", "--project", SLUG, ...args], { env: { ...process.env, ...env, PABLO_VAULT: vault } });

  const accepted = run("plan/a", "--json");
  expect(accepted.exitCode).toBe(0);
  expect(JSON.parse(accepted.stdout.toString())).toMatchObject({ ok: true, branch: "plan/a", kind: "plan", merged: true });

  const rejected = run("--reject", "plan/b");
  expect(rejected.exitCode).toBe(0);
  expect(rejected.stdout.toString()).toContain("rejected plan/b");
  expect(branchListed(vault, "plan/b")).toBe(false);
});
