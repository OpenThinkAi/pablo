/**
 * AGT-2318: `output add radio` (and so `story --output radio`) plans one episode
 * over all beats when the request or premise asks for a single episode or a
 * length, says which it chose, and scaffolds rules whose announcer / narrator /
 * music conventions the premise can switch off (a premise that says nothing keeps
 * them). Everything runs on a temp copy of the synthetic fixture vault; no model.
 */

import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMarker } from "../src/marker";
import { addOutput } from "../src/output-verbs";
import { buildRadioPack } from "../src/outputs/radio/pack";
import { radioDefaultPlan, radioPlanChoice } from "../src/outputs/radio/plan";
import { RADIO_RULES_TEMPLATE, radioRules } from "../src/outputs/radio/rules";
import { episodeCue, groupBeats, radioStyleOf, styleOf } from "../src/outputs/radio/style";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
}

/** A novel-only work (a core at beats) in a temp git vault; `asked` and `tone` rewrite the README quote and the premise's tone. */
function work(opts: { asked?: string; tone?: string } = {}): { vault: string; work: string } {
  const dir = mkdtempSync(join(tmpdir(), "pablo-radio-single-"));
  dirs.push(dir);
  const root = join(dir, "vault");
  cpSync(FIXTURE_VAULT, root, { recursive: true });
  const w = join(root, "novels", "ice-house");
  const marker = JSON.parse(readFileSync(join(w, "pablo.json"), "utf8")) as Record<string, unknown>;
  delete marker["format"];
  writeFileSync(join(w, "pablo.json"), `${JSON.stringify({ ...marker, outputs: { novel: { dir: "chapters", added: "2026-09-01" } } }, null, 2)}\n`);
  if (opts.asked !== undefined) {
    const readme = readFileSync(join(w, "README.md"), "utf8");
    writeFileSync(join(w, "README.md"), `${readme}\nAsked for on 2026-11-02:\n\n> ${opts.asked}\n`);
  }
  if (opts.tone !== undefined) {
    const overview = readFileSync(join(w, "bible", "overview.md"), "utf8");
    writeFileSync(join(w, "bible", "overview.md"), overview.replace(/## Tone\n\n[^\n]*\n/, `## Tone\n\n${opts.tone}\n`));
  }
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "pablo-test@example.com");
  git(root, "config", "user.name", "Pablo Test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  return { vault: root, work: w };
}

const NOW = { now: () => new Date("2026-11-14T12:00:00Z") };

test("episodeCue reads a single episode, a count and a total length, and ignores 'one episode per beat'", () => {
  expect(episodeCue("a single ~10-minute episode")).toMatchObject({ episodes: 1 });
  expect(episodeCue("One episode about a flood")?.episodes).toBe(1);
  expect(episodeCue("a three-episode drama")?.episodes).toBe(3);
  expect(episodeCue("a 36 minute radio play")?.episodes).toBe(3);
  expect(episodeCue("a 30 minute radio drama")?.episodes).toBe(3);
  expect(episodeCue("a 10-minute play")?.episodes).toBe(1);
  expect(episodeCue("one episode per beat")).toBeUndefined();
  // Format words may sit between the quantifier and "episode"; story prose may not.
  expect(episodeCue("a single radio episode")).toMatchObject({ episodes: 1 });
  expect(episodeCue("one 10-minute episode")).toMatchObject({ episodes: 1 });
  expect(episodeCue("a standalone audio-drama episode")).toMatchObject({ episodes: 1 });
  expect(episodeCue("A single radio drama episode, about 10 minutes, set during the theft")).toMatchObject({ episodes: 1 });
  expect(episodeCue("He has had one bad episode in his life, years ago.")).toBeUndefined();
  expect(episodeCue("after one episode of fainting at the desk")).toBeUndefined();
  expect(episodeCue("she survived two episodes of fever that winter")).toBeUndefined();
  expect(episodeCue("a ghost story in a harbor town")).toBeUndefined();
});

test("episodeCue: a length in story prose is not a format cue, and a singular episode's length is that episode's", () => {
  expect(episodeCue("She wakes an hour before the tide turns. He has 10 minutes to get out.")).toBeUndefined();
  expect(episodeCue("A 30-minute episode")).toMatchObject({ episodes: 1, minutes: 30 });
  expect(episodeCue("a 25 min episode")).toMatchObject({ episodes: 1, minutes: 25 });
  expect(episodeCue("a 36 minute radio play")).toMatchObject({ episodes: 3 });
  expect(episodeCue("a radio drama of about 24 minutes")?.episodes).toBe(2);
  expect(styleOf("the inn had no host").announcer).toBe(true);
});

test("a premise that holds only story prose keeps one episode per beat and the default rules", () => {
  const w = work({ tone: "She wakes an hour before the tide turns; he has 10 minutes to get out. The inn had no host." });
  expect(radioPlanChoice(w.work).reason).toMatch(/one episode per beat/);
  expect(radioStyleOf(w.work)).toEqual({ announcer: true, narrator: true, music: true });
});

test("a single 30-minute episode: one unit, and the rules' length line follows it", () => {
  const w = work({ asked: "A 30-minute episode about the pond", tone: "No narrator." });
  expect(radioDefaultPlan(w.work)).toHaveLength(1);
  addOutput(w.vault, w.work, "radio", NOW);
  const rules = readFileSync(join(w.work, "outputs", "radio", "RULES.md"), "utf8");
  expect(rules).toContain("Length: what fits a 30-minute broadcast, about 4,500 spoken words.");
  expect(rules).toContain("This work's premise switches off: narrator");  // The writer's brief asks for the same length as the rules, not the twelve-minute default.
  const m = readMarker(w.work);
  if (!m.ok) throw new Error(m.message);
  const built = buildRadioPack(w.vault, w.work, 1, { marker: m.marker });
  if (!built.ok) throw new Error(built.message);
  const brief = built.pack.slices.map((sl) => sl.text).join("\n");
  expect(brief).toContain("about 4500 words");
  expect(brief).not.toContain("about 1800 words");
});

test("the Style note names the request when the request switched the convention off", () => {
  const w = work({ asked: "A radio play with no narrator" });
  addOutput(w.vault, w.work, "radio", NOW);
  expect(readFileSync(join(w.work, "outputs", "radio", "RULES.md"), "utf8")).toContain("This work's request switches off: narrator");
});

test("output add reports `planned` only when it wrote the plan", () => {
  const w = work({ asked: "A single episode" });
  expect(addOutput(w.vault, w.work, "radio", NOW)).toMatchObject({ planned: expect.any(String) });
  expect(addOutput(w.vault, w.work, "radio", NOW)).not.toHaveProperty("planned");
});

test("groupBeats deals beats into contiguous, even groups and never more groups than beats", () => {
  expect(groupBeats([1, 2, 3, 4, 5], 2)).toEqual([[1, 2, 3], [4, 5]]);
  expect(groupBeats([1, 2, 3], 1)).toEqual([[1, 2, 3]]);
  expect(groupBeats([1, 2], 9)).toEqual([[1], [2]]);
});

test("styleOf: only an explicit 'no X' switches a convention off", () => {
  expect(styleOf("Dry, close, working.")).toEqual({ announcer: true, narrator: true, music: true });
  expect(styleOf("Dialogue only, no narrator explaining the case.").narrator).toBe(false);
  expect(styleOf("There is no announcer and no music.")).toMatchObject({ announcer: false, music: false, narrator: true });
  expect(styleOf("A narrator-free play").narrator).toBe(false);
});

test("AC1: a prompt asking for a single episode plans one unit over every beat, and says so", () => {
  const w = work({ asked: "A single ~10-minute episode, Empty Frames Upstairs" });
  const plan = radioDefaultPlan(w.work);
  expect(plan).toHaveLength(1);
  expect(plan[0]?.unit).toBe(1);
  expect((plan[0]?.beats.length ?? 0) > 1).toBe(true);
  expect(radioPlanChoice(w.work).reason).toMatch(/1 episode over \d+ beats: the request asks for a single episode/);
  const added = addOutput(w.vault, w.work, "radio", NOW);
  expect(added).toMatchObject({ ok: true, planned: expect.stringContaining("1 episode over") });
  expect(readFileSync(join(w.work, "outputs", "radio", "plan.md"), "utf8")).toMatch(/Planned: 1 episode over \d+ beats/);
});

test("AC1: the premise can ask for the single episode, and a total length implies the episode count", () => {
  const fromPremise = work({ tone: "One episode, about ten minutes. Dry and close." });
  expect(radioDefaultPlan(fromPremise.work)).toHaveLength(1);
  expect(radioPlanChoice(fromPremise.work).reason).toContain("the premise asks for a single episode");
  const long = work({ asked: "A 24-minute radio drama" });
  const plan = radioDefaultPlan(long.work);
  expect(plan.map((r) => r.unit)).toEqual([1, 2]);
  expect(plan.flatMap((r) => r.beats)).toEqual(radioDefaultPlan(work().work).flatMap((r) => r.beats));
});

test("AC1: with no cue the plan is one episode per beat, as before, and says that", () => {
  const w = work({ asked: "A ghost story in a harbor town" });
  const plan = radioDefaultPlan(w.work);
  expect(plan.length).toBeGreaterThan(1);
  for (const row of plan) expect(row.beats).toEqual([row.unit]);
  expect(radioPlanChoice(w.work).reason).toMatch(/one episode per beat/);
});

test("AC2: a premise whose tone says no narrator gets rules without NARRATOR, and says why", () => {
  const w = work({ tone: "Dry and close. No narrator explaining the case." });
  expect(radioStyleOf(w.work)).toEqual({ announcer: true, narrator: false, music: true, source: "premise" });
  addOutput(w.vault, w.work, "radio", NOW);
  const rules = readFileSync(join(w.work, "outputs", "radio", "RULES.md"), "utf8");
  expect(rules).not.toContain("NARRATOR:");
  expect(rules).toContain("## Style");
  expect(rules).toContain("premise switches off: narrator");
  expect(rules).toContain("ANNOUNCER:");
  expect(rules).toContain("[MUSIC:");
  expect(rules).toContain("Describe every role, the announcer included.");
});

test("AC2: a premise that says nothing keeps the template's narrator, announcer and music verbatim", () => {
  const w = work();
  expect(radioStyleOf(w.work)).toEqual({ announcer: true, narrator: true, music: true });
  addOutput(w.vault, w.work, "radio", NOW);
  expect(readFileSync(join(w.work, "outputs", "radio", "RULES.md"), "utf8")).toBe(RADIO_RULES_TEMPLATE);
});

test("AC2: every convention can be off at once and the rules still hold together", () => {
  const rules = radioRules({ announcer: false, narrator: false, music: false });
  for (const gone of ["ANNOUNCER:", "NARRATOR:", "[MUSIC:", "Theme music", "narrator line"]) expect(rules).not.toContain(gone);
  expect(rules).toContain("premise switches off: announcer, narrator, music");
  expect(rules).toContain("[SFX:");
  expect(rules).toContain("Describe every role.");
});
