// `pablo migrate outputs` (AGT-1666) and the shims that keep both an unmigrated
// and a migrated work readable. Every migration runs on a git-initialised temp
// copy of the fixture vault, never on the fixture itself.

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readDraftingInputs } from "@openthink/pablo-core";
import { readTool, searchTool } from "../src/harness-tools";
import { readMarker } from "../src/marker";
import { MIGRATE_OUTPUTS_COMMIT_MESSAGE, migrateOutputs, novelRules, type OutputsChange } from "../src/migrate-outputs";
import { chapterPreconditions, readNovelState } from "../src/novel/machine";
import { buildResume } from "../src/resume";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NOW = () => new Date(2026, 9, 10, 12);

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function git(vault: string, ...args: string[]): string {
  return execFileSync("git", ["-C", vault, ...args], { encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
}

function tempVault(): { vault: string; work: string } {
  const vault = mkdtempSync(join(tmpdir(), "pablo-migrate-outputs-"));
  cpSync(FIXTURE, vault, { recursive: true });
  git(vault, "init", "-q", "-b", "main");
  git(vault, "add", "-A");
  git(vault, "commit", "-q", "-m", "fixture");
  return { vault, work: join(vault, "novels", "ice-house") };
}

function runCli(args: string[], vault: string) {
  const r = Bun.spawnSync(["bun", "run", CLI, ...args], { env: { ...process.env, ...GIT_ENV, PABLO_VAULT: vault } });
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), exitCode: r.exitCode };
}

/** sha256 of every file under `dirs` of `work`, keyed by work-relative path. */
function hashes(work: string, dirs: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(relative(work, full), createHash("sha256").update(readFileSync(full)).digest("hex"));
    }
  };
  for (const d of dirs) walk(join(work, d));
  return out;
}

const EXPECTED_CHANGES: OutputsChange[] = [
  { op: "rewrite", path: "pablo.json" },
  { op: "create", path: "outputs/novel/plan.md" },
  { op: "create", path: "outputs/novel/RULES.md" },
  { op: "move", from: "continuity.md", path: "outputs/novel/continuity.md" },
  { op: "move", from: "outline/chapters.md", path: "outline/beats.md" },
  { op: "create", path: "facts.md" },
];

const EXPECTED_PATHS = [
  "continuity.md",
  "facts.md",
  "outline/beats.md",
  "outline/chapters.md",
  "outputs/novel/RULES.md",
  "outputs/novel/continuity.md",
  "outputs/novel/plan.md",
  "pablo.json",
];

// --- AC1 --------------------------------------------------------------------

test("--dry-run lists exactly the paths the design names and writes nothing", () => {
  const { vault, work } = tempVault();
  const result = migrateOutputs(vault, work, { dryRun: true, now: NOW });

  expect(result).toEqual({ ok: true, dryRun: true, changes: EXPECTED_CHANGES, paths: EXPECTED_PATHS, committed: false });
  expect(git(vault, "status", "--porcelain").trim()).toBe("");
  rmSync(vault, { recursive: true, force: true });
});

test("the real run commits exactly those paths in one commit; chapters, bible, outline, research, notes are byte-identical", () => {
  const { vault, work } = tempVault();
  const core = ["chapters", "bible", "research", "notes"];
  const before = hashes(work, [...core, "outline"]);
  const qwenBefore = readFileSync(join(work, "QWEN.md"), "utf8");
  const ledgerBefore = readFileSync(join(work, "continuity.md"), "utf8");
  const commits = Number(git(vault, "rev-list", "--count", "HEAD").trim());

  const result = migrateOutputs(vault, work, { dryRun: false, now: NOW });
  expect(result).toMatchObject({ ok: true, dryRun: false, committed: true, changes: EXPECTED_CHANGES, paths: EXPECTED_PATHS });

  // One commit, holding exactly the migration, with both moves recorded as renames.
  expect(Number(git(vault, "rev-list", "--count", "HEAD").trim())).toBe(commits + 1);
  expect(git(vault, "log", "-1", "--format=%s").trim()).toBe(MIGRATE_OUTPUTS_COMMIT_MESSAGE);
  const status = git(vault, "show", "-M", "--name-status", "--format=", "HEAD").trim().split("\n").sort();
  expect(status).toEqual(
    [
      "A\tnovels/ice-house/facts.md",
      "A\tnovels/ice-house/outputs/novel/RULES.md",
      "A\tnovels/ice-house/outputs/novel/plan.md",
      "M\tnovels/ice-house/pablo.json",
      "R100\tnovels/ice-house/continuity.md\tnovels/ice-house/outputs/novel/continuity.md",
      "R100\tnovels/ice-house/outline/chapters.md\tnovels/ice-house/outline/beats.md",
    ].sort(),
  );
  expect(git(vault, "status", "--porcelain").trim()).toBe("");

  // The core is untouched; the outline's only change is the file's name.
  const after = hashes(work, [...core, "outline"]);
  const renamed = new Map([...before].map(([k, v]) => [k === "outline/chapters.md" ? "outline/beats.md" : k, v]));
  expect(after).toEqual(renamed);
  expect(readFileSync(join(work, "QWEN.md"), "utf8")).toBe(qwenBefore);
  expect(readFileSync(join(work, "outputs/novel/continuity.md"), "utf8")).toBe(ledgerBefore);

  // The marker: `format` gone, `outputs.novel` in its place, every other key as written.
  const raw = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8"));
  expect(Object.keys(raw)).toEqual(["outputs", "title", "slug", "author", "voice", "neverSend", "publish"]);
  expect(raw.outputs).toEqual({ novel: { dir: "chapters", added: "2026-10-10" } });
  const marker = readMarker(work);
  expect(marker.ok && marker.deprecated).toBe(undefined);

  // plan.md: one unit per beat; chapter 1 exists (draft), the rest are beats.
  const plan = readFileSync(join(work, "outputs/novel/plan.md"), "utf8");
  expect(plan).toContain("| unit | title | beats | status |");
  expect(plan).toContain("| 1 | The Last Full Cut | 1 | draft |");
  expect(plan).toContain("| 2 | Black Ice | 2 | beat |");
  expect(plan).toContain("| 4 | The Hoist | 4 | beat |");

  // RULES.md: the novel-only section, not the core's ground rules or period facts.
  const rules = readFileSync(join(work, "outputs/novel/RULES.md"), "utf8");
  expect(rules).toContain("## Point of view and voice\n\n- Close third person, one point-of-view character per scene.");
  expect(rules).not.toContain("## Ground rules");
  expect(rules).not.toContain("## Setting and period facts");

  expect(readFileSync(join(work, "facts.md"), "utf8")).toStartWith("# Facts\n");
  rmSync(vault, { recursive: true, force: true });
});

test("a second run changes and commits nothing", () => {
  const { vault, work } = tempVault();
  migrateOutputs(vault, work, { dryRun: false, now: NOW });
  const head = git(vault, "rev-parse", "HEAD");

  expect(migrateOutputs(vault, work, { dryRun: false, now: NOW })).toEqual({
    ok: true,
    dryRun: false,
    changes: [],
    paths: [],
    committed: false,
  });
  expect(git(vault, "rev-parse", "HEAD")).toBe(head);
  rmSync(vault, { recursive: true, force: true });
});

test("the added date is the first chapter's generated date when it has one", () => {
  const { vault, work } = tempVault();
  const chapter = join(work, "chapters", "01-the-last-full-cut.md");
  writeFileSync(chapter, readFileSync(chapter, "utf8").replace("status: draft\n", "status: draft\ngenerated: 2026-09-01T10:00:00.000Z\n"));
  git(vault, "commit", "-q", "-am", "generated");

  migrateOutputs(vault, work, { dryRun: false, now: NOW });
  expect(JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")).outputs.novel.added).toBe("2026-09-01");
  rmSync(vault, { recursive: true, force: true });
});

test("refuses when a path it would move has uncommitted edits, and changes nothing", () => {
  const { vault, work } = tempVault();
  writeFileSync(join(work, "continuity.md"), `${readFileSync(join(work, "continuity.md"), "utf8")}- An unsaved fact.\n`);

  const result = migrateOutputs(vault, work, { dryRun: false, now: NOW });
  expect(result).toMatchObject({ ok: false, code: 2 });
  if (!result.ok) expect(result.message).toContain("continuity.md");
  expect(existsSync(join(work, "outputs"))).toBe(false);
  expect(existsSync(join(work, "outline/chapters.md"))).toBe(true);
  rmSync(vault, { recursive: true, force: true });
});

test("refuses when both the old and the new beats file exist", () => {
  const { vault, work } = tempVault();
  writeFileSync(join(work, "outline/beats.md"), "# Beats\n");
  const result = migrateOutputs(vault, work, { dryRun: true, now: NOW });
  expect(result).toMatchObject({ ok: false, code: 2 });
  if (!result.ok) expect(result.message).toContain("outline/beats.md");
  rmSync(vault, { recursive: true, force: true });
});

test("a work init already gave outputs gets only the file moves and facts.md", () => {
  const { vault, work } = tempVault();
  writeFileSync(
    join(work, "pablo.json"),
    `${JSON.stringify({ title: "The Ice House", slug: "ice-house", outputs: { novel: { dir: "chapters", added: "2026-01-01" } } }, null, 2)}\n`,
  );
  git(vault, "commit", "-q", "-am", "new marker");
  const result = migrateOutputs(vault, work, { dryRun: true, now: NOW });
  expect(result.ok && result.changes.map((c) => c.path)).toEqual([
    "outputs/novel/plan.md",
    "outputs/novel/RULES.md",
    "outputs/novel/continuity.md",
    "outline/beats.md",
    "facts.md",
  ]);
  rmSync(vault, { recursive: true, force: true });
});

test("novelRules lifts point of view, chapter length and scene sections, and says so when there are none", () => {
  const qwen = "# W\n\n## Ground rules\n\n1. x\n\n## Chapter length\n\n3,000 words.\n\n## Scene conventions\n\nBreaks are * * *.\n\n## The files\n\nmap\n";
  const rules = novelRules(qwen);
  expect(rules).toContain("## Chapter length\n\n3,000 words.\n\n## Scene conventions\n\nBreaks are * * *.\n");
  expect(rules).not.toContain("Ground rules");
  expect(rules).not.toContain("The files");
  expect(novelRules("# W\n\n## Ground rules\n")).toContain("No novel-only section");
});

// --- AC2: the shim's notice ---------------------------------------------------

test("CLI: an unmigrated work still runs, with a stderr notice naming pablo migrate outputs; a migrated one has none", () => {
  const { vault } = tempVault();
  const before = runCli(["status", "--project", "ice-house", "--json"], vault);
  expect(before.exitCode).toBe(0);
  expect(before.stderr).toContain("pablo migrate outputs");
  expect(before.stderr.match(/deprecated "format"/g)).toHaveLength(1);

  const dry = runCli(["migrate", "outputs", "--project", "ice-house", "--dry-run", "--json"], vault);
  expect(dry.exitCode).toBe(0);
  expect(JSON.parse(dry.stdout)).toMatchObject({ ok: true, dryRun: true, changes: EXPECTED_CHANGES });
  expect(git(vault, "status", "--porcelain").trim()).toBe("");

  const real = runCli(["migrate", "outputs", "--project", "ice-house", "--json"], vault);
  expect(real.exitCode).toBe(0);
  expect(JSON.parse(real.stdout)).toMatchObject({ ok: true, committed: true, paths: EXPECTED_PATHS });

  const after = runCli(["status", "--project", "ice-house", "--json"], vault);
  expect(after.exitCode).toBe(0);
  expect(after.stderr).not.toContain("deprecated");
  expect(JSON.parse(after.stdout).core.beats).toHaveLength(4);
  rmSync(vault, { recursive: true, force: true });
});

test("CLI: a marker with both format and outputs, or an unknown output type, refuses with exit 2 naming the key", () => {
  const { vault, work } = tempVault();
  const base = { title: "The Ice House", slug: "ice-house" };
  writeFileSync(join(work, "pablo.json"), JSON.stringify({ ...base, format: "novel", outputs: { novel: { added: "2026-10-10" } } }));
  const both = runCli(["status", "--project", "ice-house", "--json"], vault);
  expect(both.exitCode).toBe(2);
  expect(both.stdout).toContain('\\"format\\"');
  expect(both.stdout).toContain('\\"outputs\\"');

  writeFileSync(join(work, "pablo.json"), JSON.stringify({ ...base, outputs: { podcast: { added: "2026-10-10" } } }));
  const unknown = runCli(["status", "--project", "ice-house", "--json"], vault);
  expect(unknown.exitCode).toBe(2);
  expect(unknown.stdout).toContain("outputs.podcast");
  rmSync(vault, { recursive: true, force: true });
});

test("CLI: unknown migration names the three it knows", () => {
  const { vault } = tempVault();
  const r = runCli(["migrate", "words", "--project", "ice-house", "--json"], vault);
  expect(r.exitCode).toBe(2);
  expect(r.stdout).toContain("lines, outputs, track or style");
  rmSync(vault, { recursive: true, force: true });
});

// --- AC4: every reader resolves the beats (and the ledger) on both shapes ------

test("after migration status, preconditions, resume, the pack and the harness read tool resolve outline/beats.md and the novel's ledger", async () => {
  const { vault, work } = tempVault();
  const unmigrated = readNovelState(work);
  expect(unmigrated.outlineFile).toBe("outline/chapters.md");

  migrateOutputs(vault, work, { dryRun: false, now: NOW });

  const state = readNovelState(work);
  expect(state.outlineFile).toBe("outline/beats.md");
  expect(state.beats).toHaveLength(4);
  expect(state.acts).toHaveLength(2);
  expect(state.beats.map((b) => ({ ...b, source: "" }))).toEqual(unmigrated.beats.map((b) => ({ ...b, source: "" })));
  expect(chapterPreconditions(state, 2)).toEqual({ ready: true, missing: [] });
  expect(chapterPreconditions(state, 9).missing).toEqual(["no beat for chapter 9 in outline/beats.md"]);

  writeFileSync(join(work, "outline/beats.md"), `${readFileSync(join(work, "outline/beats.md"), "utf8")}\n## Open questions\n\n- Does the schooner have a name?\n`);
  const resume = await buildResume(work, "ice-house", { env: { PATH: "/nonexistent" }, timeoutMs: 50 });
  expect(resume.format).toBe("novel");
  expect(resume.open).toContainEqual({ source: "outline/beats.md", text: "Does the schooner have a name?" });

  const pack = readDraftingInputs({ vaultRoot: vault, workRoot: work, chapter: 2, wordTarget: 3000 });
  expect(pack.beat.title).toBe("Black Ice");
  expect(pack.beat.source).toContain("outline/beats.md");
  expect(pack.continuity?.path).toContain("outputs/novel/continuity.md");
  expect(pack.continuity?.text).toContain("Dorcas");

  for (const asked of ["outline/chapters.md", "outline/beats.md"]) {
    const read = readTool(work, asked);
    expect(read.ok && "text" in read && read.text).toContain("Black Ice");
  }
  for (const asked of ["continuity.md", "outputs/novel/continuity.md"]) {
    const read = readTool(work, asked);
    expect(read.ok && read.kind).toBe("continuity");
  }
  // search walks the moved ledger (a file, not a directory, among its areas) and the renamed beats file.
  const search = searchTool(work, "Dorcas");
  expect(search.ok && search.matches.map((m) => m.file)).toContain("outputs/novel/continuity.md");
  const beatsHit = searchTool(work, "Black Ice");
  expect(beatsHit.ok && beatsHit.matches.map((m) => m.file)).toContain("outline/beats.md");

  const dry = runCli(["write", "--project", "ice-house", "--chapter", "2", "--dry-run", "--json"], vault);
  expect(dry.exitCode).toBe(0);
  expect(dry.stdout).toContain("outline/beats.md");
  rmSync(vault, { recursive: true, force: true });
});

test("save --stage beats writes outline/beats.md on a migrated work", () => {
  const { vault, work } = tempVault();
  migrateOutputs(vault, work, { dryRun: false, now: NOW });
  const beats = "| # | Story date | Title | Beat | POV | Status |\n|---|---|---|---|---|---|\n| 1 | January 1929 | The Last Full Cut | A cut. | Odile | draft |\n";
  const tmp = join(vault, "beats-input.md");
  writeFileSync(tmp, beats);
  const r = runCli(["save", "--project", "ice-house", "--stage", "beats", "--file", tmp, "--json"], vault);
  expect(r.exitCode).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, path: "outline/beats.md" });
  expect(existsSync(join(work, "outline/chapters.md"))).toBe(false);
  rmSync(vault, { recursive: true, force: true });
});
