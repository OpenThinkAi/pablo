import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { listBranches } from "../src/branch";
import { planWrite, startPlanSession } from "../src/plan";

const cleanupDirs: string[] = [];

function sh(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pablo-plan-test-")));
  cleanupDirs.push(dir);
  const repo = join(dir, "vault");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "t@t.example");
  writeFileSync(join(repo, "ch01.md"), "One.\n");
  sh(repo, "add", "--", "ch01.md");
  sh(repo, "commit", "-qm", "base");
  return { repo, env: { PABLO_HOME: join(dir, "home") } };
}

afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

test("no branch exists until the session's first planning write", () => {
  const { repo, env } = setup();
  const s = startPlanSession(repo, "valley", { env, date: "2026-10-01", id: "ab12" });
  expect(s.branch).toBe("plan/2026-10-01-ab12");
  const list = listBranches(repo);
  expect(list.ok && list.branches.plan).toEqual([]);
});

test("two writes in one session land on one plan branch, authored as pablo, main untouched", () => {
  const { repo, env } = setup();
  const s = startPlanSession(repo, "valley", { env, date: "2026-10-01", id: "ab12" });
  const a = planWrite(s, { path: "bible/facts.md", content: "- a fact [invented]\n", message: "record fact" });
  const b = planWrite(s, { path: "research/grapes.md", content: "Grapes, 1919.\n", message: "research note" });
  expect(a.ok && b.ok).toBe(true);

  const list = listBranches(repo);
  expect(list.ok && list.branches.plan).toEqual(["plan/2026-10-01-ab12"]);
  const log = sh(repo, "log", "--format=%an|%ae|%s", "main..plan/2026-10-01-ab12").trim().split("\n");
  expect(log).toEqual(["pablo|pablo@localhost|research note", "pablo|pablo@localhost|record fact"]);

  const wt = s.worktree as string;
  expect(readFileSync(join(wt, "bible/facts.md"), "utf8")).toBe("- a fact [invented]\n");
  expect(readFileSync(join(wt, "research/grapes.md"), "utf8")).toBe("Grapes, 1919.\n");
  expect(existsSync(join(repo, "bible"))).toBe(false);
  expect(sh(repo, "rev-parse", "main")).toBe(sh(repo, "rev-parse", "HEAD"));
});

test("a path outside the vault is refused and creates nothing", () => {
  const { repo, env } = setup();
  const s = startPlanSession(repo, "valley", { env, id: "ab12" });
  const r = planWrite(s, { path: "../escape.md", content: "x", message: "m" });
  expect(r.ok).toBe(false);
  const abs = planWrite(s, { path: "/tmp/escape.md", content: "x", message: "m" });
  expect(abs.ok).toBe(false);
  expect(s.worktree).toBeUndefined();
});
