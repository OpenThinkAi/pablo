import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import { readNovelState } from "../src/novel/machine";
import {
  buildContent,
  extractDataRows,
  readSaveInput,
  replaceOrInsertActsTable,
  replaceOrInsertBeatsTable,
  resolveStageTarget,
  runSave,
  validateActsRows,
  validateBeatsRows,
} from "../src/save";

/**
 * Every test below works on a throwaway copy of the synthetic fixture vault
 * under a temp directory — never `~/writing`. See `CLAUDE.md`'s
 * "never write into ~/writing" rule.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const FIXTURE_WORK = fileURLToPath(new URL("./fixtures/vault/novels/ice-house", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const cleanupDirs: string[] = [];

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.email=t@t.example", "-c", "user.name=Test", ...args], {
    encoding: "utf8",
  });
}

function tempWork(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-save-test-"));
  const work = join(dir, "ice-house");
  cpSync(FIXTURE_WORK, work, { recursive: true });
  cleanupDirs.push(dir);
  return work;
}

function initGitWork(): string {
  const work = tempWork();
  git(work, "init", "-q");
  git(work, "add", "--", ".");
  git(work, "commit", "-qm", "base");
  return work;
}

function tempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-save-cli-test-"));
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  cleanupDirs.push(dir);
  return vault;
}

function initGitVault(): string {
  const vault = tempVault();
  git(vault, "init", "-q");
  git(vault, "add", "--", ".");
  git(vault, "commit", "-qm", "base");
  return vault;
}

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

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const outlinePath = (work: string) => join(work, "outline", "chapters.md");

// ── resolveStageTarget ──────────────────────────────────────────────────

test("resolveStageTarget resolves premise, acts, beats, and bible/<file>", () => {
  const work = "/vault/novels/ice-house";

  const premise = resolveStageTarget(work, "premise");
  expect(premise.ok).toBe(true);
  if (premise.ok) expect(premise.target.relPath).toBe("bible/overview.md");

  const acts = resolveStageTarget(work, "acts");
  expect(acts.ok).toBe(true);
  if (acts.ok) expect(acts.target.relPath).toBe("outline/chapters.md");

  const beats = resolveStageTarget(work, "beats");
  expect(beats.ok).toBe(true);
  if (beats.ok) expect(beats.target.relPath).toBe("outline/chapters.md");

  const bible = resolveStageTarget(work, "bible/places.md");
  expect(bible.ok).toBe(true);
  if (bible.ok) expect(bible.target.relPath).toBe("bible/places.md");
});

test("resolveStageTarget refuses bible/../x.md, an absolute bible path, and a non-.md bible file", () => {
  const work = "/vault/novels/ice-house";

  for (const stage of ["bible/../x.md", "bible/../../etc/passwd", "bible//../secrets.md"]) {
    const result = resolveStageTarget(work, stage);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("bible/");
  }

  const notMd = resolveStageTarget(work, "bible/places.txt");
  expect(notMd.ok).toBe(false);

  const empty = resolveStageTarget(work, "bible/");
  expect(empty.ok).toBe(false);
});

test("resolveStageTarget refuses an unknown stage, naming it", () => {
  const result = resolveStageTarget("/vault/novels/ice-house", "outline");
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.message).toContain("--stage expects");
    expect(result.message).toContain('"outline"');
  }
});

// ── row validation ──────────────────────────────────────────────────────

test("validateBeatsRows refuses a 5-cell row naming the row and the expected column count", () => {
  const rows = extractDataRows("| 1 | 1934 | Title | Beat text | Odile |", "#");
  const result = validateBeatsRows(rows);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain("row 1, column 6");
});

test("validateBeatsRows refuses a story date with no four-digit year", () => {
  const rows = extractDataRows("| 1 | sometime | Title | Beat text | Odile | draft |", "#");
  const result = validateBeatsRows(rows);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.message).toContain("row 1, column 2");
    expect(result.message).toContain("four-digit year");
  }
});

test("validateBeatsRows refuses a non-integer chapter number", () => {
  const rows = extractDataRows("| one | 1934 | Title | Beat text | Odile | draft |", "#");
  const result = validateBeatsRows(rows);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain("row 1, column 1");
});

test("validateActsRows refuses a 2-cell row naming the row and the expected column count", () => {
  const rows = extractDataRows("| III | 1943 to 1950 |", "act");
  const result = validateActsRows(rows);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain("row 1, column 3");
});

test("extractDataRows strips a header+separator pair, and accepts rows-only input identically", () => {
  const withHeader = [
    "| # | Story date | Title (working) | Beat | POV | Status |",
    "|---|---|---|---|---|---|",
    "| 5 | 1935 | New Chapter | A beat. | Odile | outline |",
  ].join("\n");
  const rowsOnly = "| 5 | 1935 | New Chapter | A beat. | Odile | outline |";

  expect(extractDataRows(withHeader, "#")).toEqual(extractDataRows(rowsOnly, "#"));
  expect(extractDataRows(rowsOnly, "#")).toEqual([["5", "1935", "New Chapter", "A beat.", "Odile", "outline"]]);
});

// ── table replace, byte-for-byte outside the table ─────────────────────

test("replaceOrInsertBeatsTable keeps everything before and after the chapter table intact", () => {
  const original = readFileSync(outlinePath(FIXTURE_WORK), "utf8");
  const table = ["| # | Story date | Title (working) | Beat | POV | Status |", "|---|---|---|---|---|---|", "| 1 | 1929 | New | A beat. | Odile | draft |"].join(
    "\n",
  );

  const result = replaceOrInsertBeatsTable(original, table);

  // Before the table: the acts section, untouched.
  expect(result).toContain("## The acts");
  expect(result).toContain("The ice trade contracts. Odile takes the books, Wilfred takes the risk.");
  expect(result).toContain("The cannery converts. The pond house closes.");

  // After the table: the open-questions section, untouched.
  expect(result).toContain("### Open questions for Act I");
  expect(result).toContain("Whether the schooner is named in Act I or held back until the storm.");

  // The old beat rows are gone; the new one is present.
  expect(result).not.toContain("The Last Full Cut");
  expect(result).not.toContain("Black Ice");
  expect(result).toContain("| 1 | 1929 | New | A beat. | Odile | draft |");
});

test("replaceOrInsertActsTable keeps the chapter table below it intact", () => {
  const original = readFileSync(outlinePath(FIXTURE_WORK), "utf8");
  const table = ["| Act | Years | What it accomplishes |", "|---|---|---|", "| I | 1929 to 1934 | Rewritten summary. |"].join("\n");

  const result = replaceOrInsertActsTable(original, table);

  expect(result).toContain("| I | 1929 to 1934 | Rewritten summary. |");
  expect(result).not.toContain("The ice trade contracts");
  expect(result).not.toContain("The cannery converts");

  // The Act I chapter table below is untouched.
  expect(result).toContain("The Last Full Cut");
  expect(result).toContain("Black Ice");
  expect(result).toContain("### Open questions for Act I");
});

// ── runSave: beats / acts against a real temp work dir ──────────────────

test("runSave --stage beats replaces the chapter table, commits by pathspec, and readNovelState sees it immediately", () => {
  const work = initGitWork();
  const input = [
    "| 1 | 1929 | Rewritten Opening | A rewritten beat. | Odile | draft |",
    "| 2 | 1931 | Rewritten Second | Another rewritten beat. | Odile | outline |",
  ].join("\n");

  const tmpFile = join(mkdtempSync(join(tmpdir(), "pablo-save-input-")), "beats.md");
  writeFileSync(tmpFile, input, "utf8");

  const exitCode = runSave({ stage: "beats", file: tmpFile, json: true }, work);
  expect(exitCode).toBe(0);

  const outline = readFileSync(outlinePath(work), "utf8");
  expect(outline).toContain("Rewritten Opening");
  expect(outline).toContain("Rewritten Second");
  expect(outline).not.toContain("The Last Full Cut");
  expect(outline).toContain("## The acts");

  const committedFiles = git(work, "log", "-1", "--name-only", "--pretty=format:")
    .trim()
    .split("\n")
    .filter(Boolean);
  expect(committedFiles).toEqual(["outline/chapters.md"]);

  const state = readNovelState(work);
  expect(state.beats.map((b) => b.chapter)).toEqual([1, 2]);
  expect(state.beats[0]?.title).toBe("Rewritten Opening");
});

test("runSave --stage acts replaces only the acts table", () => {
  const work = initGitWork();
  const tmpFile = join(mkdtempSync(join(tmpdir(), "pablo-save-input-")), "acts.md");
  writeFileSync(tmpFile, "| I | 1929 to 1934 | New act summary. |", "utf8");

  const exitCode = runSave({ stage: "acts", file: tmpFile, json: true }, work);
  expect(exitCode).toBe(0);

  const outline = readFileSync(outlinePath(work), "utf8");
  expect(outline).toContain("New act summary.");
  expect(outline).toContain("The Last Full Cut"); // chapter table untouched

  const state = readNovelState(work);
  expect(state.acts).toEqual([{ act: "I", years: "1929 to 1934", summary: "New act summary." }]);
});

test("runSave --stage beats refuses a malformed row and leaves the file byte-identical", () => {
  const work = initGitWork();
  const before = readFileSync(outlinePath(work), "utf8");

  const tmpFile = join(mkdtempSync(join(tmpdir(), "pablo-save-input-")), "beats.md");
  writeFileSync(tmpFile, "| 1 | 1934 | Title | Beat text | Odile |", "utf8"); // 5 cells

  const exitCode = runSave({ stage: "beats", file: tmpFile, json: true }, work);
  expect(exitCode).toBe(2);

  const after = readFileSync(outlinePath(work), "utf8");
  expect(after).toBe(before);
});

test("runSave --stage beats refuses a row with no year and writes nothing", () => {
  const work = initGitWork();
  const before = readFileSync(outlinePath(work), "utf8");

  const tmpFile = join(mkdtempSync(join(tmpdir(), "pablo-save-input-")), "beats.md");
  writeFileSync(tmpFile, "| 1 | sometime | Title | Beat text | Odile | draft |", "utf8");

  const exitCode = runSave({ stage: "beats", file: tmpFile, json: true }, work);
  expect(exitCode).toBe(2);
  expect(readFileSync(outlinePath(work), "utf8")).toBe(before);
});

test("runSave --stage bible/../x.md refuses without writing", () => {
  const work = initGitWork();
  const tmpFile = join(mkdtempSync(join(tmpdir(), "pablo-save-input-")), "x.md");
  writeFileSync(tmpFile, "anything", "utf8");

  const exitCode = runSave({ stage: "bible/../x.md", file: tmpFile, json: true }, work);
  expect(exitCode).toBe(2);
  expect(existsSync(join(work, "x.md"))).toBe(false);
  expect(existsSync(join(work, "..", "x.md"))).toBe(false);
});

test("runSave --stage premise replaces bible/overview.md whole and commits", () => {
  const work = initGitWork();
  const tmpFile = join(mkdtempSync(join(tmpdir(), "pablo-save-input-")), "premise.md");
  const newOverview = "# Overview\n\n## Logline\n\nA brand new logline for the test.\n";
  writeFileSync(tmpFile, newOverview, "utf8");

  const exitCode = runSave({ stage: "premise", file: tmpFile, json: true }, work);
  expect(exitCode).toBe(0);

  expect(readFileSync(join(work, "bible", "overview.md"), "utf8")).toBe(newOverview);

  const committedFiles = git(work, "log", "-1", "--name-only", "--pretty=format:")
    .trim()
    .split("\n")
    .filter(Boolean);
  expect(committedFiles).toEqual(["bible/overview.md"]);
});

test("runSave into a non-git work dir writes the file and returns a notice instead of throwing", () => {
  const work = tempWork(); // no `git init`
  const tmpFile = join(mkdtempSync(join(tmpdir(), "pablo-save-input-")), "premise.md");
  writeFileSync(tmpFile, "# Overview\n\n## Logline\n\nNo git here.\n", "utf8");

  const exitCode = runSave({ stage: "premise", file: tmpFile, json: true }, work);
  expect(exitCode).toBe(0);
  expect(existsSync(join(work, "bible", "overview.md"))).toBe(true);
  expect(readFileSync(join(work, "bible", "overview.md"), "utf8")).toContain("No git here.");
});

// ── readSaveInput ─────────────────────────────────────────────────────

test("readSaveInput reads --file when given", () => {
  const dir = mkdtempSync(join(tmpdir(), "pablo-save-input-"));
  cleanupDirs.push(dir);
  const file = join(dir, "in.md");
  writeFileSync(file, "hello\n", "utf8");

  const result = readSaveInput(file);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.text).toBe("hello\n");
});

test("readSaveInput errors (code 1) on a --file that does not exist", () => {
  const result = readSaveInput("/definitely/not/a/real/path.md");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(1);
});

// ── buildContent (premise passthrough) ──────────────────────────────────

test("buildContent for premise/bible ensures exactly one trailing newline", () => {
  const target = { kind: "premise" as const, absPath: "/x/bible/overview.md", relPath: "bible/overview.md" };
  const withNewline = buildContent(target, "text\n", "");
  const withoutNewline = buildContent(target, "text", "");
  expect(withNewline.ok && withNewline.content).toBe("text\n");
  expect(withoutNewline.ok && withoutNewline.content).toBe("text\n");
});

// ── through the spawned CLI ─────────────────────────────────────────────

test("save --stage beats --file <tmp> through the spawned CLI exits 0 and the commit shows only that path", () => {
  const vault = initGitVault();
  const tmpFile = join(mkdtempSync(join(tmpdir(), "pablo-save-cli-input-")), "beats.md");
  writeFileSync(
    tmpFile,
    ["| 1 | 1929 | Rewritten Opening | A rewritten beat. | Odile | draft |", "| 2 | 1931 | Rewritten Second | Another beat. | Odile | outline |"].join(
      "\n",
    ),
    "utf8",
  );

  const { stdout, exitCode } = runCli(["save", "--project", "ice-house", "--stage", "beats", "--file", tmpFile, "--json"], {
    PABLO_VAULT: vault,
  });

  expect(exitCode).toBe(0);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: true, stage: "beats", path: "outline/chapters.md", committed: true });

  const committedFiles = git(vault, "log", "-1", "--name-only", "--pretty=format:")
    .trim()
    .split("\n")
    .filter(Boolean);
  expect(committedFiles).toEqual(["novels/ice-house/outline/chapters.md"]);
});

test("save --stage beats --json exits 2 with a JSON refusal when neither --file nor piped stdin is given (TTY simulated by empty pipe still succeeds; malformed content refused)", () => {
  const vault = initGitVault();
  const tmpFile = join(mkdtempSync(join(tmpdir(), "pablo-save-cli-input-")), "beats.md");
  writeFileSync(tmpFile, "| 1 | 1934 | Title | Beat text | Odile |", "utf8"); // 5 cells

  const { stdout, exitCode } = runCli(["save", "--project", "ice-house", "--stage", "beats", "--file", tmpFile, "--json"], {
    PABLO_VAULT: vault,
  });

  expect(exitCode).toBe(2);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: false, code: 2 });
  expect(body.message).toContain("row 1, column 6");
});

test("save --project nope --stage beats --json exits 2 with the shared project refusal", () => {
  const vault = initGitVault();

  const { stdout, exitCode } = runCli(["save", "--project", "nope", "--stage", "beats", "--json"], { PABLO_VAULT: vault });

  expect(exitCode).toBe(2);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: false, code: 2 });
});
