/**
 * The radio output's rules template (AGT-1694, pm project `pablo-casting`).
 *
 * The real `radio` registry entry (AGT-1686) carries it as its `rulesTemplate`:
 * the template is what `pablo output add radio` scaffolds and what `write
 * --dry-run` shows as the rules slice. The check half (`pablo check --output radio`) is the
 * Python side's report rendered by `radioCheckLines`; its parser is tested in
 * `packages/casting/tests/test_radio_rules.py`. Scripts here are invented;
 * everything runs on a temp copy of the synthetic fixture vault, no model.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addOutput } from "../src/output-verbs";
import { RADIO_EMOTIONS, RADIO_NONVERBALS, RADIO_RULES_TEMPLATE } from "../src/outputs/radio/rules";
import { OUTPUTS } from "../src/outputs/registry";
import { radioCheckLines } from "../src/radio";
import { runWrite } from "../src/write";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const DIRECTIONS_PY = fileURLToPath(new URL("../../casting/src/pablo_casting/directions.py", import.meta.url));
const STATE_HOME = mkdtempSync(join(tmpdir(), "pablo-radio-rules-state-"));

afterAll(() => {
  rmSync(STATE_HOME, { recursive: true, force: true });
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
}

/** The fixture vault in a temp git repo, a novel-only work (so `output add radio` has a core at beats). */
function vault(): { vault: string; work: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), "pablo-radio-rules-"));
  dirs.push(dir);
  const root = join(dir, "vault");
  cpSync(FIXTURE_VAULT, root, { recursive: true });
  const work = join(root, "novels", "ice-house");
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  delete marker["format"];
  writeFileSync(join(work, "pablo.json"), `${JSON.stringify({ ...marker, outputs: { novel: { dir: "chapters", added: "2026-09-01" } } }, null, 2)}\n`);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "pablo-test@example.com");
  git(root, "config", "user.name", "Pablo Test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  return { vault: root, work, home: join(dir, "pablo-home") };
}

test("the template's vocabulary is the Python side's closed emotion list, word for word", () => {
  const source = readFileSync(DIRECTIONS_PY, "utf8");
  const block = /EMOTIONS: tuple\[str, \.\.\.\] = \(([^)]*)\)/.exec(source);
  expect(block).not.toBeNull();
  const emotions = [...(block?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  expect([...RADIO_EMOTIONS] as string[]).toEqual(emotions as string[]);
  const nonverbals = /NONVERBALS: frozenset\[str\] = frozenset\(\s*\{([^}]*)\}/.exec(source);
  const known = [...(nonverbals?.[1] ?? "").matchAll(/"([a-z ]+)"/g)].map((m) => m[1]);
  for (const word of RADIO_NONVERBALS) expect(known).toContain(word);
});

test("the template carries the script shape, the cues, the length, the direction grammar and the described CAST line", () => {
  const text = RADIO_RULES_TEMPLATE;
  for (const cue of ["[MUSIC:", "[SFX:", "[BED:", "[BED: off]", "ANNOUNCER:", "NARRATOR:"]) expect(text).toContain(cue);
  expect(text).toContain("1,800 spoken words");
  expect(text).toContain("8 to 16 sound cues");
  for (const emotion of RADIO_EMOTIONS) expect(text).toContain(emotion);
  expect(text).toContain("(<emotion>[, <intensity>][, <pace>])");
  expect(text).toMatch(/at most one direction/);
  expect(text).toMatch(/Direction is sparing/);
  expect(text).toMatch(/CAST: MAE=f "fifties, dry, unhurried"/);
  expect(text).toMatch(/Describe every role/);
  expect(text).toContain("character\nsheet in the core");
});

test("AGT-1686: the radio registry row's rules template is this template", () => {
  expect(OUTPUTS.radio.rulesTemplate).toBe(RADIO_RULES_TEMPLATE);
});

test("the template names no work: no manuscript, no chapters directory", () => {
  expect(RADIO_RULES_TEMPLATE).not.toMatch(/chapters\//);
  expect(RADIO_RULES_TEMPLATE).not.toMatch(/QWEN\.md/);
});

test("AC3: output add radio scaffolds outputs/radio/RULES.md from the template", () => {
  const { vault: root, work } = vault();
  const result = addOutput(root, work, "radio", { now: () => new Date("2026-10-12T12:00:00Z") });
  expect(result).toMatchObject({ ok: true, action: "add", type: "radio" });
  const rules = join(work, "outputs", "radio", "RULES.md");
  expect(existsSync(rules)).toBe(true);
  expect(readFileSync(rules, "utf8")).toBe(RADIO_RULES_TEMPLATE);
});

test("AC3: write --dry-run on a radio episode shows the template as the rules slice, after the work's rules and before craft", async () => {
  const { vault: root, work, home } = vault();
  expect(addOutput(root, work, "radio", { now: () => new Date("2026-10-12T12:00:00Z") })).toMatchObject({ ok: true });
  const lines: string[] = [];
  const log = console.log;
  console.log = (text: unknown) => void lines.push(String(text));
  let code: number;
  try {
    code = await runWrite(
      { chapter: undefined, output: "radio", unit: "1", words: undefined, scenes: undefined, dryRun: true, json: true, force: false },
      root,
      work,
      { env: { XDG_STATE_HOME: STATE_HOME, PABLO_HOME: home }, stderr: { write: () => {} } },
    );
  } finally {
    console.log = log;
  }
  expect(code).toBe(0);
  const body = JSON.parse(lines.join("\n")) as { slices: { name: string; source?: string; tokens: number }[] };
  const names = body.slices.map((s) => s.name);
  expect(names.indexOf("outputRules")).toBeGreaterThan(names.indexOf("workRules"));
  expect(names.indexOf("outputRules")).toBeLessThan(names.indexOf("craft"));
  const rules = body.slices.find((s) => s.name === "outputRules");
  expect(rules?.source).toBe("novels/ice-house/outputs/radio/RULES.md");
  expect(rules?.tokens).toBeGreaterThan(0);
});

test("AC2: check's radio lines list each offending line: two bad directions, a second direction, a synonym, an undescribed role", () => {
  const file = "outputs/radio/episodes/01-invented.md";
  const lines = radioCheckLines({
    unknownDirections: [
      { file, line: 5, text: "(approaching)", speaker: "MAE", kind: "direction", unknown: ["approaching"] },
      { file, line: 6, text: "(smiling)", speaker: "TOBY", kind: "direction", unknown: ["smiling"] },
    ],
    offVocabulary: [{ file, line: 8, text: "(dryly)", speaker: "TOBY", mapped: { dryly: "dry" }, ignored: [] }],
    multipleDirections: [{ file, line: 7, speaker: "MAE", directions: ["(dry)", "(urgent)"] }],
    undescribedRoles: [{ file, episode: 1, role: "TOBY" }],
    unboundRoles: [{ file, episode: 1, role: "MAE" }],
  });
  expect(lines).toEqual([
    `${file}:5 unknown direction (approaching) (MAE: approaching)`,
    `${file}:6 unknown direction (smiling) (TOBY: smiling)`,
    `${file}:8 direction outside the vocabulary (dryly) (TOBY: dryly -> dry)`,
    `${file}:7 more than one direction (dry) (urgent) (MAE)`,
    `${file} undescribed role: TOBY (add a description on the CAST: line)`,
    `${file} unbound role: MAE`,
  ]);
});

test("a body from a Python side that predates these checks still renders", () => {
  expect(radioCheckLines({ unknownDirections: [], unboundRoles: [] })).toEqual([]);
});
