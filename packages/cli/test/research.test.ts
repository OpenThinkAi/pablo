import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { startPlanSession } from "../src/plan";
import { isSource, saveResearch } from "../src/research";

const cleanupDirs: string[] = [];

function sh(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pablo-research-test-")));
  cleanupDirs.push(dir);
  const repo = join(dir, "vault");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "t@t.example");
  writeFileSync(join(repo, "ch01.md"), "One.\n");
  sh(repo, "add", "--", "ch01.md");
  sh(repo, "commit", "-qm", "base");
  const session = startPlanSession(repo, "valley", { env: { PABLO_HOME: join(dir, "home") }, date: "2026-10-01", id: "ab12" });
  return { repo, session };
}

afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

test("writes research/<slug>.md with sources and retrieval date on the plan branch", () => {
  const { repo, session } = setup();
  const r = saveResearch(
    session,
    { title: "Grape Prices, 1919", note: "A ton fetched about forty dollars.", sources: ["https://example.test/grapes", "Almanac 1920, p. 12"] },
    { retrieved: "2026-10-01" },
  );
  expect(r.ok && r.path).toBe("research/grape-prices-1919.md");

  const body = readFileSync(join(session.worktree as string, "research/grape-prices-1919.md"), "utf8");
  expect(body).toContain("# Grape Prices, 1919");
  expect(body).toContain("Retrieved: 2026-10-01");
  expect(body).toContain("A ton fetched about forty dollars.");
  expect(body).toContain("- https://example.test/grapes");
  expect(body).toContain("- Almanac 1920, p. 12");

  expect(sh(repo, "log", "--format=%an|%s", "main..plan/2026-10-01-ab12").trim()).toBe("pablo|research: Grape Prices, 1919");
  expect(existsSync(join(repo, "research"))).toBe(false);
});

test("a project dir prefixes the path; a repeated title gets a suffixed file, not an overwrite", () => {
  const { session } = setup();
  const a = saveResearch(session, { title: "Rail", note: "One.", sources: ["https://example.test/s1"] }, { dir: "novels/valley" });
  const b = saveResearch(session, { title: "Rail", note: "Two.", sources: ["https://example.test/s2"] }, { dir: "novels/valley" });
  expect(a.ok && a.path).toBe("novels/valley/research/rail.md");
  expect(b.ok && b.path).toBe("novels/valley/research/rail-2.md");
  expect(readFileSync(join(session.worktree as string, "novels/valley/research/rail.md"), "utf8")).toContain("One.");
});

test("refuses a note with no sources, no title or no body, creating no branch", () => {
  const { repo, session } = setup();
  expect(saveResearch(session, { title: "X", note: "n", sources: [] }).ok).toBe(false);
  expect(saveResearch(session, { title: "  ", note: "n", sources: ["https://example.test/s"] }).ok).toBe(false);
  expect(saveResearch(session, { title: "X", note: " ", sources: ["https://example.test/s"] }).ok).toBe(false);
  expect(sh(repo, "branch", "--list", "plan/*").trim()).toBe("");
});

test("AGT-2185: refuses a Sources list with entries that are not sources, naming them and what is accepted", () => {
  const { repo, session } = setup();
  const r = saveResearch(session, {
    title: "Ligurian fishing",
    note: "Anchovy and sardine.",
    sources: ["https://example.test/liguria", "General knowledge of Ligurian fishing practice, c. 1900"],
  });
  expect(r.ok).toBe(false);
  const notice = r.ok ? "" : r.notice;
  expect(notice).toContain('this is not a source: "General knowledge of Ligurian fishing practice, c. 1900"');
  expect(notice).toContain("http(s) URL");
  expect(notice).toContain("citation naming the work and its year");
  expect(notice).not.toContain("https://example.test/liguria");
  for (const bad of ["from memory", "Wikipedia", "common knowledge", "1920", "Brown, Fishing Villages of Liguria"]) {
    expect(saveResearch(session, { title: "X", note: "n", sources: [bad] }).ok).toBe(false);
  }
  expect(sh(repo, "branch", "--list", "plan/*").trim()).toBe("");
});

test("AGT-2185: URLs, DOIs, ISBNs and citations naming the work and its year are sources", () => {
  for (const ok of [
    "https://example.test/a (retrieved 2026-10-27)",
    "Hobsbawm, The Age of Empire, 1987",
    "Almanac 1920, p. 12",
    "doi:10.1000/182",
    "ISBN 978-0-14-044913-6",
  ]) {
    expect(isSource(ok)).toBe(true);
  }
  for (const bad of ["", "General knowledge of 1900 Liguria", "Life in the 1920s", "none", "training data"]) expect(isSource(bad)).toBe(false);
});

test("a dir that escapes the repo is refused, and a multi-line title stays one commit subject", () => {
  const { repo, session } = setup();
  expect(saveResearch(session, { title: "X", note: "n", sources: ["https://example.test/s"] }, { dir: "../../etc" }).ok).toBe(false);
  expect(saveResearch(session, { title: "X", note: "n", sources: ["https://example.test/s"] }, { dir: "/etc" }).ok).toBe(false);
  expect(sh(repo, "branch", "--list", "plan/*").trim()).toBe("");
  const r = saveResearch(session, { title: "Two\nLines", note: "n", sources: ["https://example.test/s"] });
  expect(r.ok).toBe(true);
  expect(sh(repo, "log", "-1", "--format=%B", "plan/2026-10-01-ab12").trim()).toBe("research: Two Lines");
});

test("harness: planTools carries save_research, writing under the work's research/", async () => {
  const { planTools } = await import("../src/harness/plan-tools");
  const { repo, session } = setup();
  const tool = planTools(session, join(repo, "novels", "valley")).find((t) => t.name === "save_research")!;
  expect(tool).toBeDefined();
  const out = await tool.run({ title: "Wells", note: "Hand-dug.", sources: ["https://example.test/w"] }, {} as never);
  expect(out.body).toEqual({ ok: true, path: "novels/valley/research/wells.md", branch: "plan/2026-10-01-ab12" });
  const bad = await tool.run({ title: "Wells", note: "x", sources: [] }, {} as never);
  expect(bad.exitCode).toBe(2);
});
