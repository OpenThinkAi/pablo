import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import { startPlanSession } from "../src/plan";
import { PROPOSE_STAGES, propose } from "../src/propose";
import { buildContent, resolveStageTarget } from "../src/save";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const cleanupDirs: string[] = [];

function sh(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pablo-propose-test-")));
  cleanupDirs.push(dir);
  const repo = join(dir, "vault");
  cpSync(FIXTURE_VAULT, repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "t@t.example");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "base");
  const session = startPlanSession(repo, "ice-house", { env: { PABLO_HOME: join(dir, "home") }, date: "2026-10-01", id: "ab12" });
  return { repo, work: join(repo, "novels/ice-house"), session };
}

afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

const ACTS = "| I | 1919-1920 | Cora arrives |\n| II | 1921 | The thaw |\n";
const BEATS = "| 1 | 1919-01-05 | Arrival | Cora meets the ice cutter | Cora | outline |\n";

test("an unknown stage is refused with the valid list, and nothing is created", () => {
  const { repo, work, session } = setup();
  const r = propose(session, work, { stage: "epilogue", content: "x" });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.notice).toContain('unknown stage "epilogue"');
    for (const s of PROPOSE_STAGES) expect(r.notice).toContain(s);
  }
  expect(session.worktree).toBeUndefined();
  expect(sh(repo, "branch", "--list", "plan/*").trim()).toBe("");
});

test("acts and beats write the same file content pablo save would, on the plan branch only", () => {
  const { repo, work, session } = setup();
  const before = readFileSync(join(work, "outline/chapters.md"), "utf8");
  const a = propose(session, work, { stage: "acts", content: ACTS });
  const b = propose(session, work, { stage: "beats", content: BEATS });
  expect(a.ok && b.ok).toBe(true);
  if (!a.ok) return;
  expect(a.path).toBe("novels/ice-house/outline/chapters.md");
  expect(a.branch).toBe("plan/2026-10-01-ab12");

  // Expected shape: save's own pure builders applied in sequence.
  const t = resolveStageTarget(work, "acts");
  const u = resolveStageTarget(work, "beats");
  if (!t.ok || !u.ok) throw new Error("targets");
  const afterActs = buildContent(t.target, ACTS, before);
  if (!afterActs.ok) throw new Error("acts");
  const afterBeats = buildContent(u.target, BEATS, afterActs.content);
  if (!afterBeats.ok) throw new Error("beats");
  expect(readFileSync(join(session.worktree as string, a.path), "utf8")).toBe(afterBeats.content);

  expect(readFileSync(join(work, "outline/chapters.md"), "utf8")).toBe(before);
  expect(sh(repo, "log", "--format=%an|%s", "main..plan/2026-10-01-ab12").trim().split("\n")).toEqual([
    "pablo|propose beats",
    "pablo|propose acts",
  ]);
});

test("premise and places replace their whole file; cast writes a named character file", () => {
  const { work, session } = setup();
  const p = propose(session, work, { stage: "premise", content: "A logline." });
  const pl = propose(session, work, { stage: "places", content: "# Places\n- the ice house\n" });
  const c = propose(session, work, { stage: "cast", name: "cora-vance", content: "# Cora\n" });
  expect(p.ok && pl.ok && c.ok).toBe(true);
  const wt = session.worktree as string;
  expect(readFileSync(join(wt, "novels/ice-house/bible/overview.md"), "utf8")).toBe("A logline.\n");
  expect(readFileSync(join(wt, "novels/ice-house/bible/places.md"), "utf8")).toBe("# Places\n- the ice house\n");
  expect(readFileSync(join(wt, "novels/ice-house/bible/characters/cora-vance.md"), "utf8")).toBe("# Cora\n");
});

test("cast without a usable name is refused", () => {
  const { work, session } = setup();
  for (const name of [undefined, "", "../x", "Cora Vance"]) {
    const r = propose(session, work, { stage: "cast", name, content: "x" });
    expect(r.ok).toBe(false);
  }
  expect(session.worktree).toBeUndefined();
});

test("a malformed table is refused naming the row, and nothing is written", () => {
  const { work, session } = setup();
  const r = propose(session, work, { stage: "acts", content: "| I | only two |\n" });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.notice).toMatch(/pablo: propose: row 1, column 3/);
  expect(session.worktree).toBeUndefined();
});
