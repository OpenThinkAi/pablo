import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { commitAs, createBranch, deleteBranch, listBranches, mergeBranch, worktreePath } from "../src/branch";

const cleanupDirs: string[] = [];

function sh(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

/** A temp repo on `main` with one commit, plus a temp PABLO_HOME. Never a real vault. */
function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pablo-branch-test-")));
  cleanupDirs.push(dir);
  const repo = join(dir, "vault");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "t@t.example");
  writeFileSync(join(repo, "ch01.md"), "One.\nTwo.\n");
  sh(repo, "add", "--", "ch01.md");
  sh(repo, "commit", "-qm", "base");
  const env = { PABLO_HOME: join(dir, "home") };
  return { repo, env };
}

afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

test("createBranch makes a worktree under PABLO_HOME/worktrees/<slug>/<branch>", () => {
  const { repo, env } = setup();
  const res = createBranch(repo, "valley", "draft/ch03", env);
  expect(res).toEqual({ ok: true, path: join(env.PABLO_HOME, "worktrees", "valley", "draft", "ch03") });
  expect(worktreePath("valley", "draft/ch03", env)).toBe((res as { path: string }).path);
  expect(existsSync(join((res as { path: string }).path, "ch01.md"))).toBe(true);
  expect(sh(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
});

test("createBranch refuses unknown kinds, bad slugs, and duplicates with a notice", () => {
  const { repo, env } = setup();
  expect(createBranch(repo, "valley", "feature/x", env).ok).toBe(false);
  expect(createBranch(repo, "Bad Slug", "draft/ch01", env).ok).toBe(false);
  expect(createBranch(repo, "valley", "draft/../x", env).ok).toBe(false);
  expect(createBranch(repo, "valley", "draft/ch01", env).ok).toBe(true);
  const dup = createBranch(repo, "valley", "draft/ch01", env);
  expect(dup.ok).toBe(false);
  expect(!dup.ok && dup.notice).toContain("pablo:");
});

test("commitAs records the named author and the receipt hash", () => {
  const { repo, env } = setup();
  const wt = (createBranch(repo, "valley", "draft/ch03", env) as { path: string }).path;
  writeFileSync(join(wt, "ch03.md"), "Three.\n");
  const res = commitAs(wt, {
    message: "draft ch03",
    author: { name: "gemma-4", email: "gemma@pablo.local" },
    receipt: "abc123",
  });
  expect(res.ok).toBe(true);
  expect(sh(wt, "log", "-1", "--format=%an <%ae>")).toBe("gemma-4 <gemma@pablo.local>\n");
  expect(sh(wt, "log", "-1", "--format=%B")).toContain("Receipt: abc123");
});

test("commitAs with nothing to commit returns a notice", () => {
  const { repo, env } = setup();
  const wt = (createBranch(repo, "valley", "edit/a1", env) as { path: string }).path;
  const res = commitAs(wt, { message: "noop", author: { name: "Matt", email: "m@m.example" } });
  expect(res.ok).toBe(false);
});

test("listBranches groups by kind and omits main", () => {
  const { repo, env } = setup();
  for (const b of ["draft/ch02", "draft/ch01", "revise/x1", "edit/y2", "reader/ann-2026-10-01", "plan/2026-10-01-ab12"]) {
    createBranch(repo, "valley", b, env);
  }
  sh(repo, "branch", "scratch");
  const res = listBranches(repo);
  expect(res).toEqual({
    ok: true,
    branches: {
      draft: ["draft/ch01", "draft/ch02"],
      revise: ["revise/x1"],
      edit: ["edit/y2"],
      reader: ["reader/ann-2026-10-01"],
      plan: ["plan/2026-10-01-ab12"],
    },
  });
});

test("mergeBranch merges into main; deleteBranch removes branch and worktree", () => {
  const { repo, env } = setup();
  const wt = (createBranch(repo, "valley", "draft/ch03", env) as { path: string }).path;
  writeFileSync(join(wt, "ch03.md"), "Three.\n");
  commitAs(wt, { message: "draft ch03", author: { name: "gemma-4", email: "g@pablo.local" } });

  const merged = mergeBranch(repo, "draft/ch03", env);
  expect(merged.ok).toBe(true);
  expect(readFileSync(join(repo, "ch03.md"), "utf8")).toBe("Three.\n");

  expect(deleteBranch(repo, "valley", "draft/ch03", { env }).ok).toBe(true);
  expect(existsSync(wt)).toBe(false);
  expect(sh(repo, "branch", "--list", "draft/ch03").trim()).toBe("");
});

test("deleteBranch refuses an unmerged branch unless forced", () => {
  const { repo, env } = setup();
  const wt = (createBranch(repo, "valley", "draft/ch04", env) as { path: string }).path;
  writeFileSync(join(wt, "ch04.md"), "Four.\n");
  commitAs(wt, { message: "draft ch04", author: { name: "gemma-4", email: "g@pablo.local" } });

  const refused = deleteBranch(repo, "valley", "draft/ch04", { env });
  expect(refused.ok).toBe(false);
  expect(sh(repo, "branch", "--list", "draft/ch04").trim()).not.toBe("");

  expect(deleteBranch(repo, "valley", "draft/ch04", { force: true, env }).ok).toBe(true);
  expect(existsSync(wt)).toBe(false);
});

test("a merge conflict is a returned notice and leaves main clean", () => {
  const { repo, env } = setup();
  const wt = (createBranch(repo, "valley", "edit/c1", env) as { path: string }).path;
  writeFileSync(join(wt, "ch01.md"), "One.\nBranch two.\n");
  commitAs(wt, { message: "edit", author: { name: "Matt", email: "m@m.example" } });
  writeFileSync(join(repo, "ch01.md"), "One.\nMain two.\n");
  sh(repo, "commit", "-qam", "main edit");

  const res = mergeBranch(repo, "edit/c1", env);
  expect(res.ok).toBe(false);
  expect(!res.ok && res.notice).toContain("pablo: git merge failed");
  expect(sh(repo, "status", "--porcelain").trim()).toBe("");
});

test("git failures are notices, never exceptions", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pablo-branch-test-")));
  cleanupDirs.push(dir);
  const env = { PABLO_HOME: join(dir, "home") };
  expect(createBranch(dir, "valley", "draft/ch01", env).ok).toBe(false);
  expect(listBranches(dir).ok).toBe(false);
  expect(mergeBranch(dir, "draft/ch01", env).ok).toBe(false);
  expect(deleteBranch(dir, "valley", "draft/ch01", { env }).ok).toBe(false);
  expect(commitAs(dir, { message: "x", author: { name: "a", email: "a@a.example" } }).ok).toBe(false);
});
