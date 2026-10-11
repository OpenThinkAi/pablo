/**
 * Per-output rules and plans in the pack (AGT-1670, pm project
 * `pablo-story-core`, S6): the output's `RULES.md` is its own slice layered
 * after the work's rules and before the unit's slices, a plan row maps a unit
 * onto one or several beats instead of "beat N", and `pablo output plan`
 * regenerates the plan keeping the rows whose units exist.
 *
 * Everything runs on a temp copy of the synthetic fixture vault (never
 * `~/writing`), the dry run through the real bin, no model.
 */

import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlanRows } from "@openthink/pablo-core";
import { mergePlan, planOutput } from "../src/output-verbs";
import { NOVEL } from "../src/outputs/novel";
import { readMarker } from "../src/marker";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
}

const PLAN_HEAD = "| unit | title | beats | status |\n|---|---|---|---|\n";

/** The fixture vault in a temp git repo, migrated to `outputs` (novel), Mrs. Frayne decided so beat 3 has no open pick. */
function vaultWith(files: Record<string, string> = {}): { vault: string; work: string } {
  const dir = mkdtempSync(join(tmpdir(), "pablo-output-pack-"));
  dirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  delete marker["format"];
  writeFileSync(join(work, "pablo.json"), `${JSON.stringify({ ...marker, outputs: { novel: { dir: "chapters", added: "2026-09-01" } } }, null, 2)}\n`);
  const tree = join(work, "bible", "characters", "family-tree.md");
  writeFileSync(tree, readFileSync(tree, "utf8").replace("Mrs. Frayne [pick]", "Mrs. Frayne"));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(work, rel);
    Bun.spawnSync(["mkdir", "-p", join(abs, "..")]);
    writeFileSync(abs, text);
  }
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "config", "commit.gpgsign", "false");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  return { vault, work };
}

function dryRun(vault: string, unit: number): { slices: { name: string; heading: string; source?: string; tokens: number }[]; prompt: string } {
  const run = Bun.spawnSync(["bun", "run", CLI, "write", "--project", "ice-house", "--unit", String(unit), "--dry-run", "--json"], {
    env: { ...process.env, PABLO_VAULT: vault },
  });
  expect(run.exitCode).toBe(0);
  const body = JSON.parse(run.stdout.toString()) as { slices: { name: string; heading: string; source?: string; tokens: number }[] };
  const text = Bun.spawnSync(["bun", "run", CLI, "write", "--project", "ice-house", "--unit", String(unit), "--dry-run"], {
    env: { ...process.env, PABLO_VAULT: vault },
  });
  return { slices: body.slices, prompt: text.stdout.toString() };
}

function packFor(vault: string, work: string, unit: number): string {
  const marker = readMarker(work);
  if (!marker.ok) throw new Error(marker.message);
  const out = NOVEL.pack(vault, work, unit, { marker: marker.marker });
  if (!out.ok) throw new Error(out.message);
  return out.pack.prompt;
}

const CH1 = `---
chapter: 1
title: The Last Full Cut
status: draft
---

The crew cut a full pond.
`;

test("AC1: a unit mapped to beats 2-3 gets both beat rows in its pack and nothing from beat 4", () => {
  const { vault, work } = vaultWith({
    "outputs/novel/plan.md": `${PLAN_HEAD}| 1 | The Last Full Cut | 1 | draft |\n| 2 | Ice and the Route | 2-3 | beat |\n| 3 | The Hoist | 4 | beat |\n`,
  });
  const prompt = packFor(vault, work, 2);
  expect(prompt).toContain("A thin January."); // beat 2
  expect(prompt).toContain("The domestic route down to nine stops."); // beat 3
  expect(prompt).not.toContain("The rope parts."); // beat 4
  expect(prompt).not.toContain("The crew cuts a full pond"); // beat 1
  expect(prompt).toContain("tells 2 beats, in order");
  expect(prompt).toContain("drafting chapter 2 of");
});

test("AC1: a unit whose plan row maps it onto a later beat tells that beat, not beat N", () => {
  const { vault, work } = vaultWith({
    "outputs/novel/plan.md": `${PLAN_HEAD}| 1 | The Hoist | 4 | beat |\n`,
  });
  const prompt = packFor(vault, work, 1);
  expect(prompt).toContain("The rope parts.");
  expect(prompt).not.toContain("The crew cuts a full pond");
  expect(prompt).toContain("drafting chapter 1 of");
});

test("with no plan row for the unit, it is one beat: beat N (the default plan)", () => {
  const { vault, work } = vaultWith();
  const prompt = packFor(vault, work, 2);
  expect(prompt).toContain("A thin January.");
  expect(prompt).not.toContain("tells 2 beats");
  expect(prompt).not.toContain("The domestic route down to nine stops.");
});

test("AC1: the unit's preconditions check every beat its row names", () => {
  const { work } = vaultWith({
    "outputs/novel/plan.md": `${PLAN_HEAD}| 1 | Gone | 1, 9 | beat |\n`,
  });
  expect(NOVEL.preconditions(work, 1)).toEqual({ ready: false, missing: ["no beat for chapter 9 in outline/chapters.md"] });
});

test("AC2: RULES.md is its own slice in --dry-run, with its token count, after the work's rules and before the craft rules", () => {
  const { vault } = vaultWith({
    "outputs/novel/RULES.md": "# Novel rules\n\nChapters open in the scale house or on the ice, never in a bedroom.\n",
  });
  const { slices, prompt } = dryRun(vault, 2);
  const names = slices.map((s) => s.name);
  expect(names.indexOf("outputRules")).toBeGreaterThan(names.indexOf("workRules"));
  expect(names.indexOf("outputRules")).toBeLessThan(names.indexOf("craft"));
  expect(names.indexOf("outputRules")).toBeLessThan(names.indexOf("period"));
  const rules = slices.find((s) => s.name === "outputRules");
  expect(rules?.tokens).toBeGreaterThan(0);
  expect(rules?.source).toBe("novels/ice-house/outputs/novel/RULES.md");
  expect(prompt).toContain("outputRules");
  expect(prompt).toContain("never in a bedroom");
});

test("AC2: a work with no RULES.md has no outputRules slice (the pack is unchanged)", () => {
  const { vault } = vaultWith();
  expect(dryRun(vault, 2).slices.map((s) => s.name)).not.toContain("outputRules");
});

test("AC2: the dry run lists the beats slice by name (chapter) for a multi-beat unit", () => {
  const { vault } = vaultWith({
    "outputs/novel/plan.md": `${PLAN_HEAD}| 1 | The Last Full Cut | 1 | draft |\n| 2 | Ice and the Route | 2-3 | beat |\n`,
  });
  const { slices } = dryRun(vault, 2);
  expect(slices.map((s) => s.name)).toContain("chapter");
});

test("AC3: regenerating the plan after adding a beat appends a row and leaves drafted rows untouched", () => {
  const edited = `${PLAN_HEAD}| 1 | My Own Title | 1 | draft |\n| 2 | Ice and the Route | 2-3 | beat |\n| 3 | The Hoist | 4 | beat |\n`;
  const { vault, work } = vaultWith({
    "outputs/novel/plan.md": edited,
    "chapters/01-the-last-full-cut.md": CH1,
  });
  // Add beat 5 to the outline.
  const outline = join(work, "outline", "chapters.md");
  const text = readFileSync(outline, "utf8");
  writeFileSync(
    outline,
    text.replace("\n### Open questions", "\n| 5 | 1935 | The Cannery | The order comes. | Odile | outline |\n\n### Open questions"),
  );
  git(vault, "commit", "-q", "-am", "add beat 5");

  const before = parsePlanRows(edited);
  const planned = planOutput(vault, work, "novel");
  expect(planned).toMatchObject({ ok: true, changed: true, committed: true });
  const after = parsePlanRows(readFileSync(join(work, "outputs", "novel", "plan.md"), "utf8"));
  expect(after).toHaveLength(4);
  // Drafted unit 1 and the hand-mapped rows keep their title and beats.
  expect(after.slice(0, 3).map((r) => [r.unit, r.title, r.beats])).toEqual(before.map((r) => [r.unit, r.title, r.beats]));
  expect(after[0]?.status).toBe("draft");
  // The new beat is appended as the next free unit.
  expect(after[3]).toMatchObject({ unit: 4, title: "The Cannery", beats: [5], status: "beat" });
  // A second run changes nothing.
  expect(planOutput(vault, work, "novel")).toMatchObject({ ok: true, changed: false, committed: false });
});

test("AC3: mergePlan drops an undrafted row whose beat is gone, keeps a drafted one, and covers every beat once", () => {
  const { work } = vaultWith({ "chapters/01-the-last-full-cut.md": CH1 });
  const rows = mergePlan(NOVEL, work, [
    { unit: 1, title: "Drafted", beats: [1, 9], status: "draft" },
    { unit: 2, title: "Stale", beats: [2, 9], status: "beat" },
    { unit: 3, title: "Two and three", beats: [2, 3], status: "beat" },
  ]);
  expect(rows.map((r) => [r.unit, r.beats])).toEqual([
    [1, [1, 9]],
    [3, [2, 3]],
    [4, [4]],
  ]);
});

test("AC3: output plan with no existing plan writes the default, one unit per beat", () => {
  const { vault, work } = vaultWith();
  expect(existsSync(join(work, "outputs", "novel", "plan.md"))).toBe(false);
  expect(planOutput(vault, work, "novel")).toMatchObject({ ok: true, changed: true, committed: true });
  const rows = parsePlanRows(readFileSync(join(work, "outputs", "novel", "plan.md"), "utf8"));
  expect(rows.map((r) => [r.unit, r.beats])).toEqual([[1, [1]], [2, [2]], [3, [3]], [4, [4]]]);
});
