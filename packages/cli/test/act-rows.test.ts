/**
 * Act rows are never beats (AGT-2182). The beats file holds the acts table
 * `save --stage acts` writes and the beats table `save --stage beats` writes;
 * an act numbered `1` rather than `I` used to read as beat 1, so `status`
 * counted acts + beats, `plan.md` carried a duplicate row per act, and chapter
 * N's pack was built from act N's row.
 */

import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBeatRow, parseBeatRows, parsePlanRows, readDraftingInputs } from "@openthink/pablo-core";
import { mergePlan, planOutput } from "../src/output-verbs";
import { NOVEL } from "../src/outputs/novel";
import { saveCore } from "../src/save";
import { readWorkStatus } from "../src/work-state";

const FIXTURE = join(import.meta.dir, "fixtures", "conformance");
const TEMPLATE = join(import.meta.dir, "..", "..", "..", "examples", "starter-vault", "templates", "novel", "outline", "chapters.md");

const ACTS = [
  "| Act | Years | What it accomplishes |",
  "|---|---|---|",
  "| 1 | 1911 | Ansel starts writing Walter's watches as kept. |",
  "| 2 | 1911 | The inspector reads the log and finds nothing wrong. |",
  "| 3 | 1911 | A schooner strikes on a night the log says was clear. |",
].join("\n");

const BEATS = [
  "| # | Story date | Title (working) | Beat | POV | Status |",
  "|---|---|---|---|---|---|",
  "| 1 | 1911-01-14 | First false line | Ansel writes the watch as Walter's. | Ansel | planned |",
  "| 2 | 1911-04-02 | The inspector | The inspector signs off. | Ansel | planned |",
  "| 3 | 1911-11-20 | The schooner | A schooner strikes the ledge. | Ansel | planned |",
  "| 4 | 1911-11-21 | The log | Ansel writes what happened. | Ansel | planned |",
].join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
}

/** The conformance vault in a temp git repo, its outline reset to the starter template, then saved through `save --stage acts` and `--stage beats`. */
function savedWork(): { vault: string; work: string; outline: string } {
  const vault = mkdtempSync(join(tmpdir(), "pablo-act-rows-"));
  dirs.push(vault);
  cpSync(FIXTURE, vault, { recursive: true });
  const work = join(vault, "novels", "four-beats");
  const outline = join(work, "outline", "beats.md");
  writeFileSync(outline, readFileSync(TEMPLATE, "utf8"));
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "config", "commit.gpgsign", "false");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  for (const [stage, text] of [["acts", ACTS], ["beats", BEATS]] as const) {
    const input = join(vault, `${stage}.md`);
    writeFileSync(input, `${text}\n`);
    const saved = saveCore({ stage, file: input }, work);
    if (!saved.body.ok) throw new Error(saved.body.message);
    rmSync(input);
  }
  return { vault, work, outline };
}

test("the file save writes for integer-numbered acts and beats parses to the beats alone", () => {
  const { outline } = savedWork();
  const text = readFileSync(outline, "utf8");
  // The acts really are integer rows in the same file: the case the parser used to miscount.
  expect(text).toContain("| 1 | 1911 | Ansel starts writing Walter's watches as kept. |");
  const rows = parseBeatRows(text, "outline/beats.md");
  expect(rows.map((r) => r.chapter)).toEqual([1, 2, 3, 4]);
  expect(rows.map((r) => r.title)).toEqual(["First false line", "The inspector", "The schooner", "The log"]);
  expect(parseBeatRow(text, 1, "outline/beats.md")?.title).toBe("First false line");
  expect(parseBeatRow(text, 1, "outline/beats.md")?.storyDate).toBe("1911-01-14");
});

test("chapter N's pack gets beat N's row, never act N's", () => {
  const { vault, work } = savedWork();
  const inputs = readDraftingInputs({ vaultRoot: vault, workRoot: work, chapter: 2, wordTarget: 1000 });
  expect(inputs.beat.title).toBe("The inspector");
  expect(inputs.beat.beat).toBe("The inspector signs off.");
});

test("status counts the beats alone and the novel's plan has one row per beat", () => {
  const { vault, work } = savedWork();
  const status = readWorkStatus(work);
  const beats = status.core.stages.find((s) => s.id === "beats");
  expect(beats?.summary).toBe("4");
  expect(status.outputs["novel"]?.total).toBe(4);

  const plan = planOutput(vault, work, "novel");
  expect(plan.ok).toBe(true);
  const rows = parsePlanRows(readFileSync(join(work, "outputs", "novel", "plan.md"), "utf8"));
  expect(rows.map((r) => [r.unit, r.title, r.beats])).toEqual([
    [1, "First false line", [1]],
    [2, "The inspector", [2]],
    [3, "The schooner", [3]],
    [4, "The log", [4]],
  ]);
});

test("output plan drops the stale act rows an earlier plan carried, keeping each unit's beat row", () => {
  const { work } = savedWork();
  // The plan the old parser wrote: an act-titled row per act, then a row per beat, the unit numbers repeating.
  const stale = [
    { unit: 1, title: "Ansel starts writing Walter's watches as kept.", beats: [1], status: "beat" },
    { unit: 2, title: "The inspector reads the log and finds nothing wrong.", beats: [2], status: "beat" },
    { unit: 3, title: "A schooner strikes on a night the log says was clear.", beats: [3], status: "beat" },
    { unit: 1, title: "First false line", beats: [1], status: "beat" },
    { unit: 2, title: "The inspector", beats: [2], status: "beat" },
    { unit: 3, title: "The schooner", beats: [3], status: "beat" },
    { unit: 4, title: "The log", beats: [4], status: "beat" },
  ];
  expect(mergePlan(NOVEL, work, stale).map((r) => [r.unit, r.title])).toEqual([
    [1, "First false line"],
    [2, "The inspector"],
    [3, "The schooner"],
    [4, "The log"],
  ]);
});

test("a unit the author retitled keeps its row: only a duplicate that matches no beat is stale", () => {
  const { work } = savedWork();
  const authored = [
    { unit: 1, title: "Midnight", beats: [1], status: "beat" },
    { unit: 2, title: "The inspector", beats: [2], status: "beat" },
    { unit: 3, title: "Snow", beats: [3, 4], status: "beat" },
  ];
  expect(mergePlan(NOVEL, work, authored).map((r) => [r.unit, r.title, r.beats])).toEqual([
    [1, "Midnight", [1]],
    [2, "The inspector", [2]],
    [3, "Snow", [3, 4]],
  ]);
});
