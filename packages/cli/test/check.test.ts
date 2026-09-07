import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFile, checkWork, isUnprovenanced, loadCheckRules } from "../src/check";

/** Spawns the real bin, same pattern as `cli.test.ts`: exercises argv parsing and exit codes end to end. */
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function runCli(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(["bun", "run", CLI, ...args], {
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

/**
 * The synthetic fixture vault (from AGT-1228): `style/prose.md`'s `## Names`
 * section bans `Blackwood, Thorne, Vance, Seraphina, Elias Vance` (a
 * parenthesized list embedded in a sentence); `anti-tells.md`'s
 * `- Stock names:` bullet bans `Blackwood, Thorne, Vance, Seraphina, Elias
 * (as a default)`. Neither fixture file is touched here — both already carry
 * everything AC2 needs. The chapter samples below are new, synthetic text
 * written for this test, never copied from `~/writing`.
 */
const VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const WORK = fileURLToPath(new URL("./fixtures/vault/novels/ice-house", import.meta.url));

/** A sample chapter file with exactly one hit for every mechanical rule, plus one flagged-line and one stock-name hit. Synthetic text, never copied from the real vault. */
const ONE_OF_EACH_RULE = `---
chapter: 9
title: Sample
model: gemma-4
prompt_hash: abc123
---

She said the letter was final—there was nothing left to argue.
The lease ran 1920-1933, longer than anyone expected.
“That will do,” she said, though the quote marks here are curly.
Little did she know how the season would end.
Blackwood stood at the rail and said nothing.
The scene was rich with the atmosphere of the working harbor.
A plain line with none of the guide's tells.
`;

function tempWork(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-check-test-"));
  const work = join(dir, "ice-house");
  cpSync(WORK, work, { recursive: true });
  return work;
}

test("loadCheckRules reads the fixture's banned stock names (from prose.md's ## Names and anti-tells.md's bullet) and its Flagged: lines", () => {
  const rules = loadCheckRules(VAULT);

  expect(rules.stockNames).toContain("Blackwood");
  expect(rules.stockNames).toContain("Thorne");
  expect(rules.stockNames).toContain("Vance");
  expect(rules.stockNames).toContain("Seraphina");
  expect(rules.stockNames).toContain("Elias Vance");
  expect(rules.stockNames).toContain("Elias");
  // The sentence around the ban list ("Pull names from the time and place: for a
  // 1930s Maine harbor that means Acadian, Irish and Yankee families") must not
  // leak into the ban list just because it also has a colon and commas.
  expect(rules.stockNames.some((name) => name.includes("Yankee") || name.includes("Acadian"))).toBe(false);

  expect(rules.flaggedLines).toContain("The scene was rich with the atmosphere of the working harbor.");
  expect(rules.flaggedLines).toContain("Wilfred had the nerve for the harbor, but Odile had the ledger.");
});

test("checkFile finds exactly one hit for each mechanical rule, one flagged-line hit, and one stock-name hit, at the right line numbers", () => {
  const rules = loadCheckRules(VAULT);
  const hits = checkFile(ONE_OF_EACH_RULE, "chapters/09-sample.md", rules);

  const pairs = hits.map((h) => ({ line: h.line, rule: h.rule }));
  expect(pairs).toEqual([
    { line: 8, rule: "em-dash" },
    { line: 9, rule: "dash-year-range" },
    { line: 10, rule: "curly-quote" },
    { line: 11, rule: "foreshadow" },
    { line: 12, rule: "stock-name" },
    { line: 13, rule: "flagged-line" },
  ]);

  const stockHit = hits.find((h) => h.rule === "stock-name");
  expect(stockHit?.detail).toBe("Blackwood");
  expect(stockHit?.excerpt).toContain("Blackwood");
});

test("checkFile skips the frontmatter block: an em-dash inside frontmatter is not a hit", () => {
  const rules = loadCheckRules(VAULT);
  const text = `---\ntitle: A title—with an em dash right in the frontmatter\nmodel: gemma-4\nprompt_hash: abc\n---\n\nA plain body line.\n`;

  expect(checkFile(text, "chapters/09-sample.md", rules)).toEqual([]);
});

test("checkFile counts one hit per (line, rule) even with repeated occurrences on the same line", () => {
  const rules = loadCheckRules(VAULT);
  const text = "A line with two em—dashes—on it.\n";

  const hits = checkFile(text, "f.md", rules);
  expect(hits.filter((h) => h.rule === "em-dash")).toHaveLength(1);
});

test("checkFile gives each matching stock name its own hit when two appear on one line", () => {
  const rules = loadCheckRules(VAULT);
  const text = "Blackwood and Thorne argued at the rail.\n";

  const hits = checkFile(text, "f.md", rules);
  const names = hits.filter((h) => h.rule === "stock-name").map((h) => h.detail);
  expect(names.sort()).toEqual(["Blackwood", "Thorne"]);
});

test("isUnprovenanced is true for a file with no frontmatter at all", () => {
  expect(isUnprovenanced("Just prose, no frontmatter block.\n")).toBe(true);
});

test("isUnprovenanced is true for frontmatter with model but no prompt_hash", () => {
  expect(isUnprovenanced("---\nmodel: gemma-4\n---\n\nBody.\n")).toBe(true);
});

test("isUnprovenanced is false once both model and prompt_hash are present", () => {
  expect(isUnprovenanced("---\nmodel: gemma-4\nprompt_hash: abc123\n---\n\nBody.\n")).toBe(false);
});

test("checkWork scans every chapters/*.md file and reports the fixture chapter as unprovenanced (no model/prompt_hash) with no mechanical hits", () => {
  const outcome = checkWork(VAULT, WORK);

  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error("unreachable");
  expect(outcome.code).toBe(0);
  expect(outcome.hits).toEqual([]);
  expect(outcome.unprovenanced).toEqual(["chapters/01-the-last-full-cut.md"]);
});

test("checkWork finds the fixture style guide's own flagged line, verbatim, in a synthetic chapter that contains it", () => {
  const work = tempWork();
  writeFileSync(
    join(work, "chapters", "02-echo.md"),
    "---\nchapter: 2\ntitle: Echo\nmodel: gemma-4\nprompt_hash: def456\n---\n\nThe scene was rich with the atmosphere of the working harbor.\n",
    "utf8",
  );

  const outcome = checkWork(VAULT, work);

  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error("unreachable");
  expect(outcome.hits).toContainEqual({
    path: "chapters/02-echo.md",
    line: 8,
    rule: "flagged-line",
    excerpt: "The scene was rich with the atmosphere of the working harbor.",
  });
  expect(outcome.unprovenanced).not.toContain("chapters/02-echo.md");

  rmSync(work, { recursive: true, force: true });
});

test("checkWork with a --file work-relative path scans only that file", () => {
  const outcome = checkWork(VAULT, WORK, "chapters/01-the-last-full-cut.md");

  expect(outcome.ok).toBe(true);
  if (!outcome.ok) throw new Error("unreachable");
  expect(outcome.unprovenanced).toEqual(["chapters/01-the-last-full-cut.md"]);
});

test("checkWork refuses (exit 2) when --file resolves outside the work", () => {
  const outcome = checkWork(VAULT, WORK, "../no-marker/README.md");

  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("unreachable");
  expect(outcome.code).toBe(2);
  expect(outcome.message).toContain("outside the work");
});

test("checkWork refuses (exit 2) when --file is an absolute path outside the work", () => {
  const outcome = checkWork(VAULT, WORK, "/etc/hosts");

  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("unreachable");
  expect(outcome.code).toBe(2);
});

test("check --project ice-house --json exits 0 through the spawned CLI, with the {ok, hits, unprovenanced} shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "pablo-check-cli-test-"));
  const vault = join(dir, "vault");
  cpSync(VAULT, vault, { recursive: true });

  const { stdout, exitCode } = runCli(["check", "--project", "ice-house", "--json"], { PABLO_VAULT: vault });

  expect(exitCode).toBe(0);
  const body = JSON.parse(stdout);
  expect(body.ok).toBe(true);
  expect(Array.isArray(body.hits)).toBe(true);
  expect(body.unprovenanced).toEqual(["chapters/01-the-last-full-cut.md"]);

  rmSync(dir, { recursive: true, force: true });
});

test("check --project ice-house --file outside the work exits 2 through the spawned CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "pablo-check-cli-test-"));
  const vault = join(dir, "vault");
  cpSync(VAULT, vault, { recursive: true });

  const { stdout, exitCode } = runCli(
    ["check", "--project", "ice-house", "--file", "/etc/hosts", "--json"],
    { PABLO_VAULT: vault },
  );

  expect(exitCode).toBe(2);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: false, code: 2 });
  expect(body.message).toContain("outside the work");

  rmSync(dir, { recursive: true, force: true });
});
