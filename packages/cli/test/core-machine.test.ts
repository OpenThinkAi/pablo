// The story core's stage machine and the two-layer status/resume (AGT-1667,
// pm project `pablo-story-core`). Every test reads the fixture or a temp copy
// of it, never a real vault.

import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { coreNext, coreStages, readCoreState, undecidedPicks } from "../src/core/machine";
import { chapterPreconditions, novelNext, novelUnits, readNovelOutputState, readNovelState } from "../src/novel/machine";
import { buildResume, formatResumeProse } from "../src/resume";
import { readWorkReport, workNext } from "../src/work-state";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const WORK = join(FIXTURE, "novels", "ice-house");
const NO_THINK = { PATH: "/nonexistent-bin-for-core-machine-test" };
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function git(vault: string, ...args: string[]): void {
  execFileSync("git", ["-C", vault, ...args], { stdio: "pipe", env: { ...process.env, ...GIT_ENV } });
}

/** A git-initialised temp copy of the fixture vault. */
function tempVault(): { vault: string; work: string } {
  const vault = mkdtempSync(join(tmpdir(), "pablo-core-machine-"));
  dirs.push(vault);
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

/** Rewrites the work's marker to declare `outputs` (and no `format`). */
function setOutputs(work: string, outputs: Record<string, unknown>): void {
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  delete marker["format"];
  writeFileSync(join(work, "pablo.json"), JSON.stringify({ ...marker, outputs }, null, 2));
}

// --- AC1: the novel state is the core's plus the novel output's ----------------

test("readNovelState is exactly the core state plus the novel output's state", () => {
  expect(readNovelState(WORK)).toEqual({ ...readCoreState(WORK), ...readNovelOutputState(WORK) });
});

test("the core reads premise, research, bible, acts, beats and picks; the novel output reads only chapters", () => {
  const core = readCoreState(WORK);
  expect(core.premise).toBe(true);
  expect(core.research).toEqual([]);
  expect(core.bible.picks).toEqual([{ file: "bible/characters/family-tree.md", name: "Mrs. Frayne" }]);
  expect(core.acts).toHaveLength(2);
  expect(core.beats.map((b) => b.chapter)).toEqual([1, 2, 3, 4]);
  expect(core.outlineFile).toBe("outline/chapters.md");
  expect("chapters" in core).toBe(false);
  expect(readNovelOutputState(WORK)).toEqual({
    chapters: [{ number: 1, file: "chapters/01-the-last-full-cut.md", status: "draft", title: "The Last Full Cut" }],
  });
});

test("the core's stages follow the design table; facts are open while a [pick] is", () => {
  const stages = coreStages(readCoreState(WORK));
  expect(stages.map((s) => [s.id, s.done])).toEqual([
    ["premise", true],
    ["research", false],
    ["bible", true],
    ["acts", true],
    ["beats", true],
    ["facts", false],
  ]);
  expect(stages.find((s) => s.id === "research")?.optional).toBe(true);
  expect(stages.find((s) => s.id === "facts")?.missing).toEqual(["Mrs. Frayne still has a [pick] in bible/characters/family-tree.md"]);
  // Research is optional and facts are checked per unit: neither makes the core short.
  expect(coreNext(readCoreState(WORK))).toBeUndefined();
});

test("undecidedPicks is the core's per-unit facts check chapterPreconditions uses", () => {
  const state = readNovelState(WORK);
  const beat3 = state.beats.find((b) => b.chapter === 3)!;
  expect(undecidedPicks(state, beat3.beat)).toEqual(["Mrs. Frayne still has a [pick] in bible/characters/family-tree.md"]);
  expect(chapterPreconditions(state, 3).missing).toContain("Mrs. Frayne still has a [pick] in bible/characters/family-tree.md");
});

test("research files count toward the research stage, dotfiles do not", () => {
  const { work } = tempVault();
  writeFileSync(join(work, "research", ".gitkeep"), "");
  writeFileSync(join(work, "research", "ice-trade.md"), "# Ice trade\n");
  const core = readCoreState(work);
  expect(core.research).toEqual(["research/ice-trade.md"]);
  expect(coreStages(core).find((s) => s.id === "research")).toMatchObject({ done: true, summary: "1 file" });
});

test("next names the core when the core is short, in stage order", () => {
  const { work } = tempVault();
  writeFileSync(join(work, "outline", "chapters.md"), "# Outline\n");
  expect(workNext(readCoreState(work), {})).toBe("core: save the acts table (pablo save --stage acts)");

  rmSync(join(work, "bible", "characters"), { recursive: true });
  rmSync(join(work, "bible", "places.md"));
  rmSync(join(work, "bible", "timeline.md"));
  expect(workNext(readCoreState(work), {})).toBe("core: write the bible (bible/characters/, bible/places.md, bible/timeline.md)");

  writeFileSync(join(work, "bible", "overview.md"), "# Overview\n");
  expect(workNext(readCoreState(work), {})).toBe("core: write bible/overview.md");
});

test("the novel output's units are its beats and chapter files; next is the lowest undrafted beat", () => {
  const state = readNovelState(WORK);
  const units = novelUnits(state);
  expect(units.map((u) => [u.unit, u.status])).toEqual([
    [1, "draft"],
    [2, "beat"],
    [3, "beat"],
    [4, "beat"],
  ]);
  expect(units[1]).toEqual({ unit: 2, title: "Black Ice", storyDate: "Winter 1931", status: "beat" });
  expect(novelNext(state)).toBe("write chapter 2 (pablo write --chapter 2)");
});

// --- AC2: status --json, migrated and with no outputs ---------------------------

test("status --json on the migrated fixture shows core.stages and outputs.novel.units", () => {
  const { vault } = tempVault();
  const migrated = runCli(["migrate", "outputs", "--project", "ice-house", "--json"], vault);
  expect(migrated.exitCode).toBe(0);

  const r = runCli(["status", "--project", "ice-house", "--json"], vault);
  expect(r.exitCode).toBe(0);
  const body = JSON.parse(r.stdout);
  expect(body.core.stages.map((s: { id: string }) => s.id)).toEqual(["premise", "research", "bible", "acts", "beats", "facts"]);
  expect(body.core.outlineFile).toBe("outline/beats.md");
  expect(Object.keys(body.outputs)).toEqual(["novel"]);
  expect(body.outputs.novel.units).toHaveLength(4);
  expect(body.outputs.novel.units[0]).toMatchObject({ unit: 1, status: "draft", file: "chapters/01-the-last-full-cut.md" });
  expect(body.outputs.novel).toMatchObject({ noun: "chapter", plural: "chapters", dir: "chapters", drafted: 1, total: 4 });
  expect(body.waiting).toEqual([]);
  expect(body.next).toBe("novel: write chapter 2 (pablo write --chapter 2)");
});

test("status on an unmigrated work reports the same two layers through the format shim", () => {
  const { vault } = tempVault();
  const body = JSON.parse(runCli(["status", "--project", "ice-house", "--json"], vault).stdout);
  expect(Object.keys(body.outputs)).toEqual(["novel"]);
  expect(body.core.outlineFile).toBe("outline/chapters.md");
});

test("status --json on a core with no outputs shows the core alone and next: add an output", () => {
  const { vault, work } = tempVault();
  setOutputs(work, {});

  const r = runCli(["status", "--project", "ice-house", "--json"], vault);
  expect(r.exitCode).toBe(0);
  const body = JSON.parse(r.stdout);
  expect(body.core.stages).toHaveLength(6);
  expect(body.outputs).toEqual({});
  expect(body.next).toBe("add an output");

  const prose = runCli(["status", "--project", "ice-house"], vault).stdout;
  expect(prose).toContain("outputs: none");
  expect(prose).not.toContain("novel:");
  expect(prose.trimEnd().split("\n").at(-1)).toBe("next: add an output");
});

test("the core still comes first when it is short, even with an output declared", () => {
  const { work } = tempVault();
  writeFileSync(join(work, "bible", "overview.md"), "# Overview\n");
  const report = readWorkReport(work, { novel: { dir: "chapters", added: "2026-10-10" } });
  expect(report.next).toBe("core: write bible/overview.md");
  expect(report.outputs["novel"]?.next).toBe("write chapter 2 (pablo write --chapter 2)");
});

// --- AC3: resume's prose lists the core first, then each output ------------------

test('resume prose lists the core first, then "novel: 2 of 24 chapters drafted"', async () => {
  const { work } = tempVault();
  const rows = Array.from({ length: 24 }, (_, i) => `| ${i + 1} | ${1929 + Math.floor(i / 6)} | Unit ${i + 1} | Something happens at the pond. | Odile | outline |`);
  const outline = readFileSync(join(work, "outline", "chapters.md"), "utf8");
  const header = "| # | Story date | Title (working) | Beat | POV | Status |\n|---|---|---|---|---|---|\n";
  writeFileSync(join(work, "outline", "chapters.md"), `${outline.split("## Act I")[0]}## Act I\n\n${header}${rows.join("\n")}\n`);
  writeFileSync(join(work, "chapters", "02-unit-2.md"), "---\nchapter: 2\ntitle: Unit 2\nstatus: draft\n---\n\nProse.\n");

  const result = await buildResume(work, "ice-house", { env: NO_THINK });
  expect(result.outputs["novel"]).toMatchObject({ drafted: 2, total: 24 });
  expect(result.next).toBe("novel: write chapter 3 (pablo write --chapter 3)");

  const lines = formatResumeProse(result).split("\n");
  expect(lines[0]).toBe("The Ice House");
  expect(lines.slice(1, 8)).toEqual([
    "core:",
    "  premise: ok",
    "  research: 0 files",
    "  bible: 3 files, 1 [pick] row",
    "  acts: 2",
    "  beats: 24",
    "  facts: 1 open [pick] (checked per unit)",
  ]);
  expect(lines[8]).toBe("novel: 2 of 24 chapters drafted");
  expect(lines.at(-1)).toBe("next: novel: write chapter 3 (pablo write --chapter 3)");
});

test("resume on a core with no outputs says so and asks for one", async () => {
  const { work } = tempVault();
  setOutputs(work, {});
  const result = await buildResume(work, "ice-house", { env: NO_THINK });
  expect(result.format).toBe("core");
  expect(result.outputs).toEqual({});
  expect(result.next).toBe("add an output");
  expect(formatResumeProse(result)).toContain("\noutputs: none\n");
});
