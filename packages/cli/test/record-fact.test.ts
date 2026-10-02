import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import { parseFactLine } from "@openthink/pablo-core";
import { startPlanSession } from "../src/plan";
import { recordFact } from "../src/record-fact";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const cleanupDirs: string[] = [];

function sh(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pablo-fact-test-")));
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

test("a researched fact with a source is appended to continuity on the plan branch, tagged", () => {
  const { repo, work, session } = setup();
  const before = readFileSync(join(work, "continuity.md"), "utf8");
  const r = recordFact(session, work, { fact: "Ice sold at $4 a ton in 1929.", where: "continuity", kind: "researched", source: "Smith, Ice Trade, p. 12", heading: "Dates" });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.path).toBe("novels/ice-house/continuity.md");
  expect(r.branch).toBe("plan/2026-10-01-ab12");
  const text = readFileSync(join(session.worktree as string, r.path), "utf8");
  expect(text).toContain("- Ice sold at $4 a ton in 1929. [researched: Smith, Ice Trade, p. 12]\n");
  expect(parseFactLine(r.line)?.provenance).toEqual({ kind: "researched", source: "Smith, Ice Trade, p. 12" });
  // Filed under its section, not at the end.
  expect(text.indexOf("Ice sold")).toBeLessThan(text.indexOf("## Objects and places"));
  expect(readFileSync(join(work, "continuity.md"), "utf8")).toBe(before);
  expect(sh(repo, "log", "--format=%an|%s", "main..plan/2026-10-01-ab12").trim()).toStartWith("pablo|record fact:");
});

test("a researched fact without a source is refused with a message, and nothing is created", () => {
  const { repo, work, session } = setup();
  for (const source of [undefined, "", "   "]) {
    const r = recordFact(session, work, { fact: "Grapes cost 9 cents.", where: "continuity", kind: "researched", ...(source === undefined ? {} : { source }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.notice).toContain("researched fact needs a source");
  }
  expect(session.worktree).toBeUndefined();
  expect(sh(repo, "branch", "--list", "plan/*").trim()).toBe("");
});

test("invented and author facts need no source and append to a bible file", () => {
  const { work, session } = setup();
  const a = recordFact(session, work, { fact: "The scale house smells of kerosene.", where: "places", kind: "invented", chapter: "ch01" });
  const b = recordFact(session, work, { fact: "Odile never leaves the island.", where: "bible/places.md", kind: "author" });
  expect(a.ok && b.ok).toBe(true);
  if (!a.ok) return;
  expect(a.line).toBe("- The scale house smells of kerosene. [ch01] [invented]");
  const text = readFileSync(join(session.worktree as string, a.path), "utf8");
  expect(text.endsWith("[ch01] [invented]\n- Odile never leaves the island. [author]\n")).toBe(true);
});

test("unknown kind, empty fact, and targets outside bible/continuity are refused", () => {
  const { work, session } = setup();
  const base = { fact: "x", where: "continuity", kind: "invented" };
  expect(recordFact(session, work, { ...base, kind: "guess" })).toMatchObject({ ok: false });
  expect(recordFact(session, work, { ...base, fact: "  " })).toMatchObject({ ok: false });
  expect(recordFact(session, work, { ...base, where: "research/grapes.md" })).toMatchObject({ ok: false });
  expect(recordFact(session, work, { ...base, where: "bible/../chapters/01-the-last-full-cut" })).toMatchObject({ ok: false });
  expect(recordFact(session, work, { ...base, where: "bible/nope" })).toMatchObject({ ok: false });
  expect(session.worktree).toBeUndefined();
});
