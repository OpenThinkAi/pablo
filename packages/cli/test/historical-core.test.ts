// The historical-fiction core (AGT-2100, pm project `pablo-platform`, D-5,
// D-6): a period brief, required sourced research and period facts before the
// bible, and `write` refused while the track's gate is shut. Fiction keeps
// research optional. Every test reads a temp copy of the fixture vault, never
// a real vault, and no test calls a model (`write` runs `--dry-run` or is
// refused before the pack).

import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_STAGE_IDS, HISTORICAL_CORE_STAGE_IDS, coreNext, coreStages, readCoreState, trackGate } from "../src/core/machine";
import { buildResume } from "../src/resume";
import { TRACKS } from "../src/tracks/registry";
import { readWorkStatus } from "../src/work-state";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK = { PATH: "/nonexistent-bin-for-historical-core-test" };

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** A temp copy of the fixture vault; the work's marker gets `track` when one is given. */
function tempWork(track?: string): { vault: string; work: string } {
  const vault = mkdtempSync(join(tmpdir(), "pablo-historical-core-"));
  dirs.push(vault);
  cpSync(FIXTURE, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  if (track !== undefined) {
    const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
    writeFileSync(join(work, "pablo.json"), JSON.stringify({ ...marker, track }, null, 2));
  }
  return { vault, work };
}

function runCli(args: string[], vault: string) {
  const r = Bun.spawnSync(["bun", "run", CLI, ...args], { env: { ...process.env, PABLO_VAULT: vault } });
  return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), exitCode: r.exitCode };
}

const PERIOD_BRIEF = "# Period\n\nThe Hudson ice trade, winter 1888-89: the Great Blizzard, the Knickerbocker ice houses.\n";
const SOURCED_NOTE = "# Ice harvest\n\nRetrieved: 2026-10-26\n\nHarvest began once the ice reached a foot.\n\n## Sources\n\n- https://example.org/ice-harvest\n";
const PERIOD_FACTS = "# Period facts\n\n| Fact | Source | Story date |\n|---|---|---|\n| Ice was cut once it reached a foot thick | research/ice-harvest.md | 1888 |\n";

function addPeriodBrief(work: string): void {
  writeFileSync(join(work, "bible", "period.md"), PERIOD_BRIEF);
}
function addSourcedNote(work: string): void {
  writeFileSync(join(work, "research", "ice-harvest.md"), SOURCED_NOTE);
}
function addPeriodFacts(work: string): void {
  mkdirSync(join(work, "facts"), { recursive: true });
  writeFileSync(join(work, "facts", "period.md"), PERIOD_FACTS);
}

// --- AC1: the historical core's stages, in order --------------------------------

test("a historical-fiction work's core stages are premise, period, research, period facts, bible, acts, beats, facts", () => {
  const { work } = tempWork("historical-fiction");
  const ids = coreStages(readCoreState(work, "historical-fiction")).map((s) => s.id);
  expect(ids).toEqual(["premise", "period", "research", "period-facts", "bible", "acts", "beats", "facts"]);
  expect(ids).toEqual([...HISTORICAL_CORE_STAGE_IDS]);
  expect([...TRACKS["historical-fiction"].coreStages] as string[]).toEqual(ids);
});

test("the period stage needs bible/period.md with text; a heading alone is not a brief", () => {
  const { work } = tempWork("historical-fiction");
  const stage = () => coreStages(readCoreState(work, "historical-fiction")).find((s) => s.id === "period");
  expect(stage()).toMatchObject({ done: false, gate: true, missing: ["bible/period.md has no period brief yet"] });
  writeFileSync(join(work, "bible", "period.md"), "# Period\n");
  expect(stage()?.done).toBe(false);
  writeFileSync(join(work, "bible", "period.md"), "---\ntitle: Period\n---\n# Period\n");
  expect(stage()?.done).toBe(false);
  addPeriodBrief(work);
  expect(stage()).toMatchObject({ done: true, summary: "ok", missing: [] });
});

test("historical research is required and counts only notes with a ## Sources entry", () => {
  const { work } = tempWork("historical-fiction");
  const stage = () => coreStages(readCoreState(work, "historical-fiction")).find((s) => s.id === "research");
  expect(stage()).toMatchObject({ done: false, gate: true, summary: "0 sourced notes", missing: ["research has no sourced notes yet"] });
  expect(stage()?.optional).toBeUndefined();

  writeFileSync(join(work, "research", "unsourced.md"), "# Unsourced\n\nA hunch.\n\n## Sources\n\n");
  expect(stage()?.done).toBe(false);

  addSourcedNote(work);
  expect(readCoreState(work, "historical-fiction").sourcedResearch).toEqual(["research/ice-harvest.md"]);
  expect(stage()).toMatchObject({ done: true, summary: "1 sourced note", missing: [] });
});

test("the period-facts stage counts fact rows in facts/period.md, not its table header", () => {
  const { work } = tempWork("historical-fiction");
  const stage = () => coreStages(readCoreState(work, "historical-fiction")).find((s) => s.id === "period-facts");
  expect(stage()).toMatchObject({ done: false, gate: true, missing: ["facts/period.md has no sourced period facts yet"] });
  mkdirSync(join(work, "facts"), { recursive: true });
  writeFileSync(join(work, "facts", "period.md"), "# Period facts\n\n| Fact | Source | Story date |\n|---|---|---|\n");
  expect(stage()?.done).toBe(false);
  addPeriodFacts(work);
  expect(stage()).toMatchObject({ done: true, summary: "1 fact" });
});

// --- AC3: coreNext walks the historical stages; resume returns it as next ------

test("coreNext names each historical stage in turn, then hands on to the fiction stages", () => {
  const { work } = tempWork("historical-fiction");
  const next = () => coreNext(readCoreState(work, "historical-fiction"));
  expect(next()).toBe("write the period brief (bible/period.md)");
  addPeriodBrief(work);
  expect(next()).toBe("save sourced research notes (pablo research save)");
  addSourcedNote(work);
  expect(next()).toBe("distill the research into sourced period facts (facts/period.md)");
  addPeriodFacts(work);
  // The fixture already has its bible, acts and beats.
  expect(next()).toBeUndefined();
});

test("resume and status read the track from pablo.json and report the historical next stage", async () => {
  const { work } = tempWork("historical-fiction");
  addPeriodBrief(work);

  const resumed = await buildResume(work, "ice-house", { env: NO_THINK, timeoutMs: 2000 });
  expect(resumed.track).toBe("historical-fiction");
  expect(resumed.next).toBe("core: save sourced research notes (pablo research save)");
  expect(resumed.core.stages.map((s) => s.id)).toEqual([...HISTORICAL_CORE_STAGE_IDS]);

  const status = readWorkStatus(work);
  expect(status.next).toBe("core: save sourced research notes (pablo research save)");
  expect(status.core.stages.find((s) => s.id === "period")?.done).toBe(true);
});

// --- AC2: write refuses on a historical work, naming the track and the stage ---

test("write on a historical-fiction work with no sourced research refuses naming the track", () => {
  const { vault, work } = tempWork("historical-fiction");
  addPeriodBrief(work);

  const r = runCli(["write", "--project", "ice-house", "--chapter", "2", "--dry-run", "--json"], vault);
  expect(r.exitCode).toBe(2);
  const body = JSON.parse(r.stdout) as { ok: boolean; message: string; missing: string[] };
  expect(body.ok).toBe(false);
  expect(body.message).toBe("pablo: historical-fiction: research has no sourced notes yet");
  expect(body.missing).toEqual(["research has no sourced notes yet"]);
});

test("write's prose refusal names the period brief first, then the period facts", () => {
  const { vault, work } = tempWork("historical-fiction");
  let r = runCli(["write", "--project", "ice-house", "--chapter", "2", "--dry-run"], vault);
  expect(r.exitCode).toBe(2);
  expect(r.stderr).toContain("historical-fiction: bible/period.md has no period brief yet");

  addPeriodBrief(work);
  addSourcedNote(work);
  r = runCli(["write", "--project", "ice-house", "--chapter", "2", "--dry-run"], vault);
  expect(r.exitCode).toBe(2);
  expect(r.stderr).toContain("historical-fiction: facts/period.md has no sourced period facts yet");
});

test("write on a historical-fiction work goes ahead once the period, research and period facts are in", () => {
  const { vault, work } = tempWork("historical-fiction");
  addPeriodBrief(work);
  addSourcedNote(work);
  addPeriodFacts(work);
  expect(trackGate(readCoreState(work, "historical-fiction"))).toBeUndefined();
  const r = runCli(["write", "--project", "ice-house", "--chapter", "2", "--dry-run", "--json"], vault);
  expect(r.exitCode).toBe(0);
});

// --- AC4: fiction still treats research as optional -----------------------------

test("a fiction work keeps today's stages with research optional and no gate", () => {
  const { work } = tempWork();
  const core = readCoreState(work);
  expect(core.track).toBe("fiction");
  const stages = coreStages(core);
  expect(stages.map((s) => s.id)).toEqual([...CORE_STAGE_IDS]);
  expect(stages.find((s) => s.id === "research")).toMatchObject({ done: false, optional: true, missing: ["research/ has no files"] });
  expect(stages.some((s) => s.gate === true)).toBe(false);
  expect(trackGate(core)).toBeUndefined();
  expect(coreNext(core)).toBeUndefined();
});

test("write on a fiction work with no research and no period brief still drafts (dry run)", () => {
  const { vault } = tempWork("fiction");
  const r = runCli(["write", "--project", "ice-house", "--chapter", "2", "--dry-run", "--json"], vault);
  expect(r.exitCode).toBe(0);
});
