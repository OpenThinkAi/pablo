/**
 * The narrated output, text side (AGT-2137, pm project `pablo-platform`,
 * D-7): `output add narrated --from <output>`, units mirroring the source's,
 * `write --output narrated --unit N` making a `lines` script from the source
 * unit's prose with no model (`--voices characters` adding speaker lines),
 * and the check that flags a reading whose words differ from its source.
 * The conformance run is `outputs.test.ts`'s. Everything runs on a temp copy
 * of the synthetic fixture vault; no model is ever called.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter } from "@openthink/pablo-core";
import { checkWork } from "../src/check";
import { readMarker } from "../src/marker";
import { addOutput, listOutputs, removeOutput } from "../src/output-verbs";
import { OUTPUTS } from "../src/outputs/registry";
import { characterNames, narrateProse, narrationDrift } from "../src/outputs/narrated/narrate";
import { stripFrontmatter } from "../src/publish";
import { runWrite } from "../src/write";
import type { WriteArgs } from "../src/write";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const STATE_HOME = mkdtempSync(join(tmpdir(), "pablo-narrated-state-"));
const CHAPTER_ONE = "chapters/01-the-last-full-cut.md";

afterAll(() => rmSync(STATE_HOME, { recursive: true, force: true }));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8").trim();
}

/** The fixture vault in a temp git repository, the work's marker on `outputs` (the novel, chapter 1 written). */
function vault(outputs: Record<string, unknown> = { novel: { dir: "chapters", added: "2026-09-01" } }): { vault: string; work: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), "pablo-narrated-"));
  dirs.push(dir);
  const root = join(dir, "vault");
  cpSync(FIXTURE_VAULT, root, { recursive: true });
  const work = join(root, "novels", "ice-house");
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  delete marker["format"];
  writeFileSync(join(work, "pablo.json"), `${JSON.stringify({ ...marker, outputs }, null, 2)}\n`);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "pablo-test@example.com");
  git(root, "config", "user.name", "Pablo Test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  return { vault: root, work, home: join(dir, "pablo-home") };
}

/** A work with the novel and the narrated output reading it. */
function narratedWork(): { vault: string; work: string; home: string } {
  const made = vault();
  const added = addOutput(made.vault, made.work, "narrated", { from: "novel", now: () => new Date(2026, 9, 26) });
  if (!added.ok) throw new Error(added.message);
  return made;
}

/** A writer that fails the test if `write` ever calls it: a reading is made with no model. */
const noModel: Adapter = {
  id: "local",
  model: "never",
  preferredOutput: "text",
  complete(): never {
    throw new Error("the model was called for a narrated unit");
  },
  async proposeEdit(): Promise<never> {
    throw new Error("not used");
  },
  async extractFacts(): Promise<never> {
    throw new Error("not used");
  },
};

async function write(v: { vault: string; work: string; home: string }, args: Partial<WriteArgs>): Promise<{ code: number; body: Record<string, unknown> }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (text: unknown) => void lines.push(String(text));
  try {
    const code = await runWrite(
      { chapter: undefined, words: undefined, scenes: undefined, dryRun: false, json: true, force: false, ...args },
      v.vault,
      v.work,
      { adapter: noModel, env: { PATH: NO_THINK_PATH, XDG_STATE_HOME: STATE_HOME, PABLO_HOME: v.home }, stderr: { write: () => {} }, now: () => new Date("2026-10-26T12:00:00Z") },
    );
    return { code, body: JSON.parse(lines.join("\n")) as Record<string, unknown> };
  } finally {
    console.log = log;
  }
}

// --- the script, pure --------------------------------------------------------

const PROSE = ["The ice rang under the horse.", "It was cold.", "", 'Wilfred came up the ramp. "Four thousand ton," he said. "We fill her."', "", '"Who said that?" Nobody answered.'].join("\n");

test("narrator voices: a CAST: line, one NARRATOR: line per paragraph, the source's words unchanged", () => {
  const script = narrateProse(PROSE, "narrator");
  expect(script.split("\n")).toEqual([
    'CAST: NARRATOR="the narrator, reading the prose"',
    "",
    "NARRATOR: The ice rang under the horse. It was cold.",
    "",
    'NARRATOR: Wilfred came up the ramp. "Four thousand ton," he said. "We fill her."',
    "",
    'NARRATOR: "Who said that?" Nobody answered.',
  ]);
  expect(narrationDrift(PROSE, script)).toBeUndefined();
});

test("character voices: attributed quotes become the speaker's lines, unattributed ones stay the narrator's, no word changes", () => {
  const script = narrateProse(PROSE, "characters", new Set(["Wilfred"]));
  expect(script.split("\n")).toEqual([
    'CAST: NARRATOR="the narrator, reading the prose", WILFRED="Wilfred, speaking their dialogue"',
    "",
    "NARRATOR: The ice rang under the horse. It was cold.",
    "",
    "NARRATOR: Wilfred came up the ramp.",
    "WILFRED: Four thousand ton,",
    "NARRATOR: he said.",
    "WILFRED: We fill her.",
    "",
    'NARRATOR: "Who said that?" Nobody answered.',
  ]);
  expect(narrationDrift(PROSE, script)).toBeUndefined();
});

test("characterNames reads names from the bible, not words that only start a sentence", () => {
  const names = characterNames(["- **Odile Nadeau** (born 1912). Runs the scale house.\n  She keeps the book; Wilfred cuts.\n"]);
  expect(names.has("Odile")).toBe(true);
  expect(names.has("Nadeau")).toBe(true);
  expect(names.has("Wilfred")).toBe(true);
  expect(names.has("Runs")).toBe(false);
  expect(names.has("She")).toBe(false);
});

test("narrationDrift names the first changed word's line, and words the reading lost", () => {
  const script = narrateProse(PROSE, "narrator");
  const changed = narrationDrift(PROSE, script.replace("It was cold.", "It was freezing."));
  expect(changed).toMatchObject({ line: 3, detail: '"freezing." where the source has "cold."' });
  const short = narrationDrift(PROSE, script.replace('NARRATOR: "Who said that?" Nobody answered.', ""));
  expect(short?.detail).toContain('5 words of the source missing, from "Who');
  expect(narrationDrift(PROSE, `${script}\nNARRATOR: More.`)?.detail).toBe('"More." is not in the source');
});

// --- output add narrated --from ----------------------------------------------

test("output add narrated needs --from naming a prose output the work has; --from is the narrated output's alone", () => {
  const v = vault({ novel: { dir: "chapters", added: "2026-09-01" }, radio: { added: "2026-10-01" } });
  const none = addOutput(v.vault, v.work, "narrated");
  expect(none).toMatchObject({ ok: false, missing: ["--from: novel"] });
  if (!none.ok) expect(none.message).toContain("name it with --from");
  const script = addOutput(v.vault, v.work, "narrated", { from: "radio" });
  expect(script.ok).toBe(false);
  if (!script.ok) expect(script.message).toContain("--from radio is not a prose output");
  const undeclared = addOutput(v.vault, v.work, "narrated", { from: "story" });
  expect(undeclared.ok).toBe(false);
  if (!undeclared.ok) expect(undeclared.message).toContain("pablo output add story");
  const novelFrom = addOutput(v.vault, v.work, "story", { from: "novel" });
  expect(novelFrom.ok).toBe(false);
  if (!novelFrom.ok) expect(novelFrom.message).toContain("--from is for a derived output");
  expect(existsSync(join(v.work, "outputs", "narrated"))).toBe(false);
  expect(git(v.vault, "status", "--porcelain")).toBe("");
});

test("output add narrated --from novel records the source, mirrors the novel's units and commits", () => {
  const v = narratedWork();
  const marker = readMarker(v.work);
  expect(marker.ok && marker.marker.outputs["narrated"]).toEqual({ added: "2026-10-26", from: "novel" });
  const plan = readFileSync(join(v.work, "outputs", "narrated", "plan.md"), "utf8");
  for (const row of OUTPUTS.novel.plan(v.work)) expect(plan).toContain(`| ${row.unit} | ${row.title} |`);
  expect(git(v.vault, "status", "--porcelain")).toBe("");
  const listed = listOutputs(v.work);
  expect(listed.ok && listed.outputs.find((o) => o.type === "narrated")).toMatchObject({ noun: "reading", drafted: 0, total: OUTPUTS.novel.plan(v.work).length });
  // The novel cannot be removed while the narration reads it.
  const removed = removeOutput(v.vault, v.work, "novel");
  expect(removed.ok).toBe(false);
  if (!removed.ok) expect(removed.message).toContain("the narrated output reads the novel output");
});

// --- write --output narrated -------------------------------------------------

test("write --output narrated --unit 1 makes the reading from chapter 1 with no model, word for word, on its own branch", async () => {
  const v = narratedWork();
  const { code, body } = await write(v, { output: "narrated", unit: "1" });
  expect(code).toBe(0);
  expect(body).toMatchObject({ ok: true, path: "outputs/narrated/readings/01-the-last-full-cut.md", branch: "draft/narrated-01", from: CHAPTER_ONE, receipt: { output: "narrated", unit: 1, model: "pablo-derived" } });
  const file = join(body["worktree"] as string, "novels", "ice-house", "outputs", "narrated", "readings", "01-the-last-full-cut.md");
  const text = readFileSync(file, "utf8");
  expect(text).toContain("model: pablo-derived");
  expect(text).toContain('CAST: NARRATOR="the narrator, reading the prose"');
  expect(text).not.toContain("WILFRED:");
  const source = stripFrontmatter(readFileSync(join(v.work, CHAPTER_ONE), "utf8"));
  expect(narrationDrift(source, text)).toBeUndefined();
  // Nothing landed on main.
  expect(existsSync(join(v.work, "outputs", "narrated", "readings"))).toBe(false);
});

test("write --voices characters gives quoted dialogue to the characters the paragraph names", async () => {
  const v = narratedWork();
  const { code, body } = await write(v, { output: "narrated", unit: "1", voices: "characters" });
  expect(code).toBe(0);
  const text = readFileSync(join(body["worktree"] as string, "novels", "ice-house", body["path"] as string), "utf8");
  expect(text).toContain("WILFRED: Four thousand ton,");
  expect(text).toContain("ODILE: You'll fill her.");
  expect(text).toMatch(/^CAST: NARRATOR=.*, WILFRED=.*, ODILE=/m);
  expect(narrationDrift(stripFrontmatter(readFileSync(join(v.work, CHAPTER_ONE), "utf8")), text)).toBeUndefined();
});

test("write refuses a reading whose source unit is not written, and --voices on an output the writer drafts", async () => {
  const v = narratedWork();
  const unwritten = await write(v, { output: "narrated", unit: "3" });
  expect(unwritten.code).toBe(2);
  expect(unwritten.body["missing"]).toEqual(["chapter 3 of the novel output is not written yet (pablo write --output novel --unit 3)"]);
  const voices = await write(v, { output: "novel", unit: "2", voices: "characters" });
  expect(voices.code).toBe(2);
  expect(voices.body["message"]).toContain("--voices is for the narrated output");
  const bad = await write(v, { output: "narrated", unit: "1", voices: "everyone" });
  expect(bad.code).toBe(2);
  expect(bad.body["message"]).toContain("--voices must be narrator or characters");
});

// --- the check ---------------------------------------------------------------

test("check flags a reading whose words differ from its source unit's prose", async () => {
  const v = narratedWork();
  const { body } = await write(v, { output: "narrated", unit: "1" });
  const made = readFileSync(join(body["worktree"] as string, "novels", "ice-house", body["path"] as string), "utf8");
  const path = join(v.work, body["path"] as string);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, made);
  const clean = checkWork(v.vault, v.work, undefined, "narrated");
  expect(clean.ok && clean.hits.filter((h) => h.rule === "narration-drift")).toEqual([]);

  writeFileSync(path, made.replace("The pond rang under the horse", "The pond sang under the horse"));
  const drifted = checkWork(v.vault, v.work, undefined, "narrated");
  expect(drifted.ok).toBe(true);
  if (drifted.ok) {
    const hit = drifted.hits.find((h) => h.rule === "narration-drift");
    expect(hit).toMatchObject({ path: "outputs/narrated/readings/01-the-last-full-cut.md", detail: '"sang" where the source has "rang"' });
  }
});
