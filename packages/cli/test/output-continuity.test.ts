/**
 * Per-output continuity, `facts.md` promotion and `pablo check --across` (AGT-1671, pm project `pablo-story-core`,
 * S7), over the real `radio` output (AGT-1686). Everything runs on a temp copy of the synthetic fixture vault;
 * the critic is a fake `Ask` and the extractor a fake adapter: no model, never `~/writing`.
 *
 * AC1: a novel ledger saying "bay" and a radio ledger saying "grey" are reported by `--across` with both sources;
 *      promoting the novel's fact puts a comment on the radio unit's line, shown by review mode.
 * AC2: the radio unit's pack never carries a line of `outputs/novel/continuity.md`.
 * AC3: the story-time gate still refuses a mention dated after the unit's year.
 */

import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent, ExtractedFact } from "@openthink/pablo-core";
import { establishedByOf, parseFactLine } from "@openthink/pablo-core";
import { loadReview } from "../../tui/src/review";
import { checkAcross, lineFor, loadFindings, promoteFinding, readLedgers } from "../src/across";
import { branchDiff, fileAt } from "../src/branch";
import { checkWork } from "../src/check";
import { continuityReference, critiqueModel, reviewCommentsOf } from "../src/critique";
import { runContinuity } from "../src/novel/continuity";
import { OUTPUTS } from "../src/outputs/registry";
import type { OutputDefinition } from "../src/outputs/types";
import { startPlanSession } from "../src/plan";
import { recordFact } from "../src/record-fact";
import { VERBS } from "../src/verbs";
import type { VerbContext } from "../src/verbs";
import { runWrite } from "../src/write";
import type { WriteArgs } from "../src/write";
import { readMarker } from "../src/marker";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");

/** pablo-casting's radio output (AGT-1686), the real registry row: its own directory, branches, units and ledger. */
const RADIO: OutputDefinition = OUTPUTS.radio;

const dirs: string[] = [];
afterEach(() => {
  critiqueModel.ask = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8").trim();
}

const NOVEL_BAY = "- Dorcas is a bay mare. [ch02]";
const RADIO_LEDGER = `# Continuity

## Names and ages

## Dates

## Objects and places

- Dorcas is a grey mare. [ep02]
- The pond house has two doors. [ep02]

## Who knows what
`;

const EPISODE_TWO = `---
episode: 2
title: Black Ice
story_date: Winter 1931
model: test
prompt_hash: abc
---

NARRATOR: The ice rang wrong under the horse.
WILFRED: Bring Dorcas round, the grey one never minds the cold.
ODILE: I will not weigh what comes off that ice.
`;

/**
 * The fixture vault in a temp git repository with a novel and a radio output. `migrated` moves the novel's ledger
 * to `outputs/novel/continuity.md` (the migrated layout); otherwise it stays at the work root. The novel's ledger
 * says the horse is a bay, the radio's that she is grey; radio episode 2 is drafted.
 */
function twoOutputWork(migrated = true): { vault: string; work: string; home: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pablo-output-continuity-")));
  dirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  delete marker["format"];
  writeFileSync(join(work, "pablo.json"), `${JSON.stringify({ ...marker, outputs: { novel: { dir: "chapters", added: "2026-09-01" }, radio: { added: "2026-10-12" } } }, null, 2)}\n`);
  const ledger = readFileSync(join(work, "continuity.md"), "utf8").replace("## Objects and places\n", `## Objects and places\n\n${NOVEL_BAY}`);
  if (migrated) {
    rmSync(join(work, "continuity.md"));
    mkdirSync(join(work, "outputs", "novel"), { recursive: true });
    writeFileSync(join(work, "outputs", "novel", "continuity.md"), ledger);
  } else {
    writeFileSync(join(work, "continuity.md"), ledger);
  }
  mkdirSync(join(work, "outputs", "radio", "episodes"), { recursive: true });
  writeFileSync(join(work, "outputs", "radio", "continuity.md"), RADIO_LEDGER);
  writeFileSync(join(work, "outputs", "radio", "episodes", "02-black-ice.md"), EPISODE_TWO);
  // Chapter 3's beat names Mrs. Frayne, an undecided [pick] in the fixture: decide it so later units are ready.
  const tree = join(work, "bible", "characters", "family-tree.md");
  writeFileSync(tree, readFileSync(tree, "utf8").replace("Mrs. Frayne [pick]", "Mrs. Frayne"));
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "config", "commit.gpgsign", "false");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  return { vault, work, home: join(dir, "pablo-home") };
}

function env(home: string): Record<string, string> {
  return { PATH: NO_THINK_PATH, PABLO_HOME: home, HOME: dirname(home) };
}

function verb(name: string) {
  const found = VERBS.find((v) => v.name === name);
  if (found === undefined) throw new Error(`no verb ${name}`);
  return found;
}

function ctx(vault: string, home: string): VerbContext {
  return { cwd: vault, env: { ...env(home), PABLO_VAULT: vault }, stderr: { write: () => {} } };
}

/** The label the critic's numbered ledgers gave the fact `text` starts with. */
function labelOf(prompt: string, text: string): string {
  const m = new RegExp(`^(c\\d+)\\s+${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m").exec(prompt);
  if (m === null) throw new Error(`no label for "${text}" in the prompt`);
  return m[1] as string;
}

/**
 * The fake critic: the candidate pass reports the colour (bay vs grey) and a spurious "name" contradiction; the
 * refute pass upholds the colour and withdraws the name, citing a ledger line it was shown.
 */
const prompts: string[] = [];
async function fakeCritic(prompt: string): Promise<string> {
  prompts.push(prompt);
  if (prompt.startsWith("A critic says two facts")) {
    if (prompt.includes("name differs")) return JSON.stringify({ verdict: "withdraw", reason: "both call her Dorcas", lines: ["c1"] });
    return JSON.stringify({ verdict: "uphold", reason: "a bay and a grey cannot be the same mare", lines: [] });
  }
  const bay = labelOf(prompt, "Dorcas is a bay mare");
  const grey = labelOf(prompt, "Dorcas is a grey mare");
  const called = labelOf(prompt, "The horse is called Dorcas");
  return JSON.stringify([
    { claim: "The novel's Dorcas is a bay; the radio show's is grey.", lines: [bay, grey] },
    { claim: "The horse's name differs.", lines: [called, grey] },
    { claim: "Two novel facts cannot be a cross-output finding.", lines: [bay, called] },
  ]);
}

// --- AC1: check --across, promote, the comment in review mode ---------------------------------------------------

test("AC1: --across reports bay vs grey with both sources; promoting the novel's fact comments the radio unit's line in review mode", async () => {
  const { vault, work, home } = twoOutputWork();
  prompts.length = 0;
  critiqueModel.ask = fakeCritic;

  const checked = await verb("check").run({ project: "ice-house", across: true, "dry-run": false } as never, ctx(vault, home));
  expect(checked.exitCode).toBe(0);
  const body = checked.body as { ok: true; findings: { id: string; claim: string; sources: { output: string; ledger: string; line: number; fact: string; establishedBy?: string }[]; actions: { keep: string; command: string }[] }[]; raised: number; withdrawn: number };
  // The refute step ran: two cross-output candidates raised (the same-output pair is dropped), one withdrawn with a cited line.
  expect(body.raised).toBe(2);
  expect(body.withdrawn).toBe(1);
  expect(body.findings).toHaveLength(1);
  const finding = body.findings[0]!;
  expect(finding.id).toMatch(/^x[0-9a-f]{8}$/);
  expect(finding.sources).toEqual([
    expect.objectContaining({ output: "novel", ledger: "outputs/novel/continuity.md", fact: "Dorcas is a bay mare.", establishedBy: "novel/ch02" }),
    expect.objectContaining({ output: "radio", ledger: "outputs/radio/continuity.md", fact: "Dorcas is a grey mare.", establishedBy: "radio/ep02" }),
  ]);
  const novelLedger = readFileSync(join(work, "outputs", "novel", "continuity.md"), "utf8").split("\n");
  expect(novelLedger[finding.sources[0]!.line - 1]).toBe(NOVEL_BAY);
  expect(finding.actions.map((a) => a.keep)).toEqual(["novel", "radio"]);
  expect(finding.actions[0]!.command).toBe(`pablo promote --project ice-house --finding ${finding.id} --keep novel`);
  // Only the ledgers reach the critic: never research/ or notes/.
  for (const p of prompts) expect(p).not.toContain("first-session");

  const promoted = await verb("promote").run({ project: "ice-house", finding: finding.id, keep: "novel" }, ctx(vault, home));
  expect(promoted.exitCode).toBe(0);
  const result = promoted.body as { ok: true; branch: string; path: string; line: string; comments: { path: string; line?: number; body: string }[] };
  expect(result.branch).toMatch(/^plan\//);
  expect(result.path).toBe("novels/ice-house/facts.md");
  expect(result.line).toBe("- Dorcas is a bay mare. [established-by: novel/ch02] [author]");
  const facts = fileAt(vault, result.branch, "novels/ice-house/facts.md") ?? "";
  expect(facts).toStartWith("# Facts\n");
  expect(facts).toContain(result.line);
  expect(establishedByOf(parseFactLine(result.line)!)).toBe("novel/ch02");
  // Nothing on main changed: promotion is a branch for the author to review.
  expect(existsSync(join(work, "facts.md"))).toBe(false);

  const episodePath = "novels/ice-house/outputs/radio/episodes/02-black-ice.md";
  const greyLine = EPISODE_TWO.split("\n").findIndex((l) => l.includes("the grey one")) + 1;
  expect(result.comments).toEqual([expect.objectContaining({ path: episodePath, line: greyLine })]);

  // Review mode: the branch's comments, laid out by the screen's own loader, show a note on the radio unit's line.
  const comments = reviewCommentsOf(work, result.branch);
  expect(comments).toEqual(expect.arrayContaining([expect.objectContaining({ path: episodePath, line: greyLine })]));
  const review = loadReview(branchDiff(vault, result.branch), comments, (path) => fileAt(vault, result.branch, path));
  const notes = [...review.notes.values()];
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatchObject({ path: episodePath, line: greyLine });
  expect(notes[0]!.quoted.join("\n")).toContain("the grey one");
  expect(notes[0]!.comment.body).toContain('Contradicts facts.md: "Dorcas is a bay mare."');
  expect(review.rows.some((r) => r.id === `file:${episodePath}`)).toBe(true);

  // A second promotion of the same fact is refused by name, not written twice.
  const again = promoteFinding({ projectPath: work, finding: finding.id, keep: "novel", session: { repo: vault, slug: "ice-house", env: env(home), branch: result.branch, worktree: join(home, "worktrees", "ice-house", result.branch) } });
  expect(again.ok).toBe(false);
});

test("check --across on a work with one ledger of facts compares nothing and says so", async () => {
  const { vault, work, home } = twoOutputWork();
  writeFileSync(join(work, "outputs", "radio", "continuity.md"), "# Continuity\n");
  critiqueModel.ask = async () => {
    throw new Error("the critic must not be asked");
  };
  const result = await checkAcross({ projectPath: work, ask: critiqueModel.ask });
  expect(result).toMatchObject({ ok: true, findings: [], raised: 0 });
  if (result.ok) expect(result.note).toContain("only novel");
  expect(loadFindings(work)).toEqual([]);
  void vault;
  void home;
});

test("promote refuses an unknown finding and a side the finding does not have", async () => {
  const { work } = twoOutputWork();
  await checkAcross({ projectPath: work, ask: fakeCritic });
  const id = loadFindings(work)[0]!.id;
  expect(promoteFinding({ projectPath: work, finding: "x00000000", keep: "novel" })).toMatchObject({ ok: false, code: 2 });
  expect(promoteFinding({ projectPath: work, finding: id, keep: "story" })).toMatchObject({ ok: false, code: 2 });
});

test("readLedgers reads each output's own ledger with unit tags; an unmigrated novel's is continuity.md at the root", () => {
  const { work } = twoOutputWork(false);
  const ledgers = readLedgers(work);
  expect(ledgers.map((l) => [l.output, l.path])).toEqual([
    ["novel", "continuity.md"],
    ["radio", "outputs/radio/continuity.md"],
  ]);
  const novel = ledgers[0]!.facts;
  // A wrapped bullet is one fact; a `[ch01 §2]` tag still gives the unit.
  expect(novel).toEqual(expect.arrayContaining([expect.objectContaining({ fact: "The tally book is a green ledger with a broken spine, kept on the scale house windowsill.", tag: "ch01", unit: 1 })]));
  expect(ledgers[1]!.facts.map((f) => f.tag)).toEqual(["ep02", "ep02"]);
});

test("lineFor finds the prose line sharing the most words with the fact, skipping frontmatter", () => {
  expect(lineFor(EPISODE_TWO, "Dorcas is a grey mare.")).toBe(10);
  expect(lineFor(EPISODE_TWO, "Nothing here matches xyzzy.")).toBeUndefined();
});

// --- record_fact --promote --------------------------------------------------------------------------------------

test("record_fact --promote writes facts.md with established-by; a malformed or unknown source is refused, nothing written", () => {
  const { vault, work, home } = twoOutputWork();
  const session = startPlanSession(vault, "ice-house", { env: env(home), date: "2026-10-12", id: "aa11" });
  const bad = recordFact(session, work, { fact: "Dorcas is a bay mare", where: "", kind: "author", promote: true, establishedBy: "novel" });
  expect(bad.ok).toBe(false);
  const unknown = recordFact(session, work, { fact: "Dorcas is a bay mare", where: "", kind: "author", promote: true, establishedBy: "podcast/ep01" });
  expect(unknown.ok).toBe(false);
  expect(session.worktree).toBeUndefined();
  const ok = recordFact(session, work, { fact: "Dorcas is a bay mare", where: "continuity", kind: "author", promote: true, establishedBy: "novel/ch02" });
  expect(ok).toMatchObject({ ok: true, path: "novels/ice-house/facts.md", line: "- Dorcas is a bay mare [established-by: novel/ch02] [author]" });
  // `where` is ignored on a promotion: the novel's ledger is untouched on the branch.
  expect(fileAt(vault, session.branch, "novels/ice-house/outputs/novel/continuity.md")).toBe(readFileSync(join(work, "outputs", "novel", "continuity.md"), "utf8"));
  const noWhere = recordFact(session, work, { fact: "Something", where: "", kind: "author" });
  expect(noWhere.ok).toBe(false);
});

// --- AC2: the radio unit's pack never carries the novel's ledger --------------------------------------------------

function novelBullets(work: string, rel: string): string[] {
  return readFileSync(join(work, rel), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).replace(/\s*\[[^\]]*\]\s*$/, "").trim());
}

async function dryRun(vault: string, work: string, home: string, args: Partial<WriteArgs>): Promise<{ code: number; body: Record<string, unknown> }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (text: unknown) => void lines.push(String(text));
  try {
    const code = await runWrite({ chapter: undefined, words: undefined, scenes: undefined, dryRun: true, json: true, force: false, ...args }, vault, work, { env: env(home), stderr: { write: () => {} } });
    return { code, body: JSON.parse(lines.join("\n")) as Record<string, unknown> };
  } finally {
    console.log = log;
  }
}

for (const migrated of [true, false]) {
  test(`AC2: the radio unit's --dry-run pack never contains a line of the novel's ledger (${migrated ? "migrated" : "unmigrated"} work)`, async () => {
    const { vault, work, home } = twoOutputWork(migrated);
    writeFileSync(join(work, "facts.md"), "# Facts\n\n- The pond house has two doors. [established-by: novel/ch01] [author]\n");
    // Both outputs have rules (AGT-1670): the radio unit gets its own, beside its own ledger, never the novel's.
    writeFileSync(join(work, "outputs", "radio", "RULES.md"), "# Radio rules\n\nEvery scene is heard, not seen.\n");
    mkdirSync(join(work, "outputs", "novel"), { recursive: true });
    writeFileSync(join(work, "outputs", "novel", "RULES.md"), "# Novel rules\n\nChapters run close third.\n");
    const novelLedger = migrated ? "outputs/novel/continuity.md" : "continuity.md";

    const dry = await dryRun(vault, work, home, { output: "radio", unit: "1" });
    expect(dry.code).toBe(0);
    const slices = dry.body["slices"] as { name: string; source?: string }[];
    expect(slices.some((s) => (s.source ?? "").split(", ").includes(`novels/ice-house/${novelLedger}`))).toBe(false);
    expect(slices.find((s) => s.name === "continuity")?.source).toBe("novels/ice-house/outputs/radio/continuity.md");
    expect(slices.find((s) => s.name === "facts")?.source).toBe("novels/ice-house/facts.md");
    expect(slices.find((s) => s.name === "outputRules")?.source).toBe("novels/ice-house/outputs/radio/RULES.md");
    expect(slices.some((s) => (s.source ?? "").includes("outputs/novel/"))).toBe(false);

    // The prompt itself: no fact of the novel's ledger, the radio's own facts and facts.md present.
    const marker = readMarker(work);
    if (!marker.ok) throw new Error(marker.message);
    const packed = RADIO.pack(vault, work, 1, { marker: marker.marker, output: "radio" });
    if (!packed.ok) throw new Error(packed.message);
    for (const fact of novelBullets(work, novelLedger)) expect(packed.pack.prompt).not.toContain(fact);
    expect(packed.pack.prompt).toContain("Dorcas is a grey mare.");
    expect(packed.pack.prompt).toContain("The pond house has two doors. [established-by: novel/ch01]");

    // And the novel's own pack is unchanged in kind: its ledger, not the radio's.
    const novel = await dryRun(vault, work, home, { output: "novel", unit: "2" });
    const novelSlices = novel.body["slices"] as { name: string; source?: string }[];
    expect(novelSlices.find((s) => s.name === "continuity")?.source).toBe(`novels/ice-house/${novelLedger}`);
    expect(novelSlices.some((s) => (s.source ?? "").includes("outputs/radio/"))).toBe(false);
  });
}

test("the story output's pack carries its own ledger and facts.md, never the novel's", () => {
  const { vault, work } = twoOutputWork();
  writeFileSync(join(work, "facts.md"), "# Facts\n\n- Promoted thing. [established-by: novel/ch01] [author]\n");
  mkdirSync(join(work, "outputs", "story"), { recursive: true });
  writeFileSync(join(work, "outputs", "story", "continuity.md"), "# Continuity\n\n- The story's own fact. [st01]\n");
  const marker = readMarker(work);
  if (!marker.ok) throw new Error(marker.message);
  const packed = OUTPUTS.story.pack(vault, work, 1, { marker: marker.marker });
  if (!packed.ok) throw new Error(packed.message);
  expect(packed.pack.slices.find((s) => s.name === "continuity")?.source).toBe("novels/ice-house/outputs/story/continuity.md");
  expect(packed.pack.prompt).toContain("Promoted thing.");
  expect(packed.pack.prompt).not.toContain("Dorcas is a bay mare.");
});

test("the critic's reference for a radio branch is facts.md plus the radio ledger, never the novel's", () => {
  const { work } = twoOutputWork();
  writeFileSync(join(work, "facts.md"), "# Facts\n\n- Promoted thing. [established-by: novel/ch01] [author]\n");
  const ref = continuityReference(work, "radio");
  expect(ref).toContain("Promoted thing.");
  expect(ref).toContain("Dorcas is a grey mare.");
  expect(ref).not.toContain("Dorcas is a bay mare.");
});

// --- continuity extraction writes the output's own ledger ---------------------------------------------------------

function extractor(facts: readonly ExtractedFact[]): Adapter {
  return {
    id: "local",
    model: "fake-extractor",
    preferredOutput: "text",
    async *complete(): AsyncIterable<CompletionEvent> {
      yield { type: "done", stats: { timeToFirstTokenMs: 1, elapsedMs: 1, tokensRead: 1, tokensWritten: 0, tokensPerSecond: 0 } };
    },
    async proposeEdit(): Promise<never> {
      throw new Error("not used");
    },
    async extractFacts(): Promise<never> {
      throw new Error("not used");
    },
    extractFactsWithAnchors: async () => facts,
  };
}

test("continuity extraction for a radio episode files its facts in outputs/radio/continuity.md tagged [epNN]; the novel's ledger is untouched", async () => {
  const { work } = twoOutputWork();
  rmSync(join(work, "outputs", "radio", "continuity.md"));
  const novelBefore = readFileSync(join(work, "outputs", "novel", "continuity.md"), "utf8");
  const ritual = await runContinuity(work, 2, "The ice rang wrong under the horse.\n", {
    adapter: extractor([{ fact: "The ice rang wrong under the horse.", entities: [], storyTime: undefined, certainty: undefined, anchor: "The ice rang wrong under the horse." }]),
    output: "radio",
    unitNoun: "episode",
  });
  expect(ritual.status).toBe("ran");
  const radio = readFileSync(join(work, "outputs", "radio", "continuity.md"), "utf8");
  expect(radio).toStartWith("# Continuity\n");
  expect(radio).toContain("- The ice rang wrong under the horse. [ep02]");
  expect(readFileSync(join(work, "outputs", "novel", "continuity.md"), "utf8")).toBe(novelBefore);
  expect(readdirSync(join(work, "outputs", "radio"))).toContain("continuity.md");
});

// --- AC3: the story-time gate -----------------------------------------------------------------------------------

test("AC3: check --output radio refuses a mention dated after the unit's year (story-time), and a name the core does not know", () => {
  const { vault, work } = twoOutputWork();
  const path = join(work, "outputs", "radio", "episodes", "02-black-ice.md");
  writeFileSync(path, `${EPISODE_TWO}NARRATOR: Nobody yet spoke of the September hurricane.\nWILFRED: In 1945 we sell the lot.\nODILE: Ask Halvorsen about the hoist.\n`);
  const outcome = checkWork(vault, work, undefined, "radio");
  if (!outcome.ok) throw new Error(outcome.message);
  const core = outcome.core ?? [];
  const rel = "outputs/radio/episodes/02-black-ice.md";
  expect(core).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: rel, line: 12, rule: "story-time", detail: expect.stringContaining("1938: the September hurricane") }),
      expect.objectContaining({ path: rel, line: 13, rule: "story-time", detail: expect.stringContaining("1945 is after") }),
      expect.objectContaining({ path: rel, line: 14, rule: "unknown-name", detail: "Halvorsen" }),
    ]),
  );
  // Names the core knows (the bible, the radio ledger) are not flagged; the episode's own 1931 lines are clean.
  expect(core.filter((h) => h.rule === "unknown-name").map((h) => h.detail)).toEqual(["Halvorsen"]);
  expect(core.filter((h) => h.line < 12)).toEqual([]);

  // The same lines in an episode dated 1946 pass the gate.
  writeFileSync(path, readFileSync(path, "utf8").replace("story_date: Winter 1931", "story_date: Spring 1946"));
  const later = checkWork(vault, work, undefined, "radio");
  if (!later.ok) throw new Error(later.message);
  expect((later.core ?? []).filter((h) => h.rule === "story-time")).toEqual([]);

  // No output named: no core check (the plain scan is unchanged).
  const plain = checkWork(vault, work, "outputs/radio/episodes/02-black-ice.md");
  if (!plain.ok) throw new Error(plain.message);
  expect(plain.core).toBeUndefined();
});

test("AC3: the radio unit's pack still gates the timeline by its story date", () => {
  const { vault, work } = twoOutputWork();
  const marker = readMarker(work);
  if (!marker.ok) throw new Error(marker.message);
  const packed = RADIO.pack(vault, work, 2, { marker: marker.marker, output: "radio" });
  if (!packed.ok) throw new Error(packed.message);
  const timeline = packed.pack.slices.find((s) => s.name === "timeline");
  expect(timeline?.text).toContain("1938: the September hurricane");
  expect(packed.pack.prompt).toMatch(/do NOT exist at this chapter's date[\s\S]*1938: the September hurricane/);
});

test("AGT-2190: a name only an unconfirmed ledger bullet carries stays an unknown-name hit until the author confirms it", () => {
  const { vault, work } = twoOutputWork();
  const path = join(work, "outputs", "radio", "episodes", "02-black-ice.md");
  writeFileSync(path, `${EPISODE_TWO}ODILE: Ask Halvorsen about the hoist.\n`);
  const ledger = join(work, "outputs", "radio", "continuity.md");
  const original = readFileSync(ledger, "utf8");
  const unknown = (): string[] => {
    const outcome = checkWork(vault, work, undefined, "radio");
    if (!outcome.ok) throw new Error(outcome.message);
    return (outcome.core ?? []).filter((h) => h.rule === "unknown-name").map((h) => h.detail ?? "");
  };

  writeFileSync(ledger, `${original}\n- Halvorsen runs the hoist. [ep02, unconfirmed]\n`);
  expect(unknown()).toEqual(["Halvorsen"]);

  writeFileSync(ledger, `${original}\n- Halvorsen runs the hoist. [ep02]\n`);
  expect(unknown()).toEqual([]);
});

// --- AGT-2197: write and check agree on unknown names, with fewer false positives ---------------------------------

test("AGT-2197: check without --output runs the same core check as with it; headings, title, period facts, quoted signs are not names", () => {
  const { vault, work } = twoOutputWork();
  const path = join(work, "outputs", "radio", "episodes", "02-black-ice.md");
  mkdirSync(join(work, "facts"), { recursive: true });
  writeFileSync(join(work, "facts", "period.md"), "# Period facts\n\n- The Bantley Building opened in 1925.\n");
  writeFileSync(
    path,
    `${EPISODE_TWO}## The Ice House\nODILE: Meet me at the Bantley Building.\nWILFRED: The sign said "Please wait" at the Ice House.\nODILE: Ask Halvorsen about the hoist.\n`,
  );
  const named = checkWork(vault, work, undefined, "radio");
  if (!named.ok) throw new Error(named.message);
  expect((named.core ?? []).filter((h) => h.rule === "unknown-name").map((h) => h.detail)).toEqual(["Halvorsen"]);

  // The work has two outputs here, so a bare check is refused; a one-output work gets the core check without --output.
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as { outputs: Record<string, unknown> };
  delete marker.outputs["novel"];
  writeFileSync(join(work, "pablo.json"), `${JSON.stringify(marker, null, 2)}\n`);
  const bare = checkWork(vault, work);
  if (!bare.ok) throw new Error(bare.message);
  expect((bare.core ?? []).map((h) => `${h.rule}:${h.detail}`)).toEqual((named.core ?? []).map((h) => `${h.rule}:${h.detail}`));
});

// --- AGT-2226: a slug-only character file clears its name; research names are known on historical fiction ----------

function unknownNames(vault: string, work: string): string[] {
  const outcome = checkWork(vault, work, undefined, "radio");
  if (!outcome.ok) throw new Error(outcome.message);
  return (outcome.core ?? []).filter((h) => h.rule === "unknown-name").map((h) => h.detail ?? "");
}

test("AGT-2226: a slug-only character file (clara-vane.md, no display name in the text) clears Clara and Vane", () => {
  const { vault, work } = twoOutputWork();
  writeFileSync(join(work, "outputs", "radio", "episodes", "02-black-ice.md"), `${EPISODE_TWO}ODILE: Ask Clara Vane about the hoist.\n`);
  expect(unknownNames(vault, work)).toEqual(["Clara", "Vane"]);
  writeFileSync(join(work, "bible", "characters", "clara-vane.md"), "- **clara-vane**: the telegraph clerk, quick and wary.\n");
  expect(unknownNames(vault, work)).toEqual([]);
});

test("AGT-2226: on historical fiction a name only a research note carries is known; on fiction it is not", () => {
  const { vault, work } = twoOutputWork();
  writeFileSync(join(work, "outputs", "radio", "episodes", "02-black-ice.md"), `${EPISODE_TWO}ODILE: Tap it out on the Bunnell Triumph.\n`);
  mkdirSync(join(work, "research"), { recursive: true });
  writeFileSync(join(work, "research", "telegraph.md"), "# Telegraph\n\nThe Bunnell Triumph key was standard in 1931 depots.\n");
  expect(unknownNames(vault, work)).toEqual(["Bunnell", "Triumph"]);
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(work, "pablo.json"), `${JSON.stringify({ ...marker, track: "historical-fiction" }, null, 2)}\n`);
  expect(unknownNames(vault, work)).toEqual([]);
});

// --- AGT-2285: forms of address, plural titles, demonyms and party names are not names ------------------------------

test("AGT-2285: a kinship term of address (Mother, Father, Nonna, Papà) is never an unknown-name hit, but a real name beside it still is", () => {
  const { vault, work } = twoOutputWork();
  writeFileSync(
    join(work, "outputs", "radio", "episodes", "02-black-ice.md"),
    `${EPISODE_TWO}ODILE: He is a Savoyard, Mother.\nODILE: Yes, Father, and Nonna agrees. Papà knows, and Grandmother too.\nODILE: Tell Uncle Halvorsen.\n`,
  );
  expect(unknownNames(vault, work)).toEqual(["Savoyard", "Halvorsen"]);
});

test("AGT-2285: a title in the period facts clears its plural; without the title the plural is still flagged", () => {
  const { vault, work } = twoOutputWork();
  writeFileSync(join(work, "outputs", "radio", "episodes", "02-black-ice.md"), `${EPISODE_TWO}ODILE: The Doges ruled the lagoon.\n`);
  expect(unknownNames(vault, work)).toEqual(["Doges"]);
  mkdirSync(join(work, "facts"), { recursive: true });
  writeFileSync(join(work, "facts", "period.md"), "- The Doge was elected for life.\n");
  expect(unknownNames(vault, work)).toEqual([]);
});

test("AGT-2285: a demonym or party name clears when its place or polity is known; a near-miss name does not", () => {
  const { vault, work } = twoOutputWork();
  writeFileSync(
    join(work, "outputs", "radio", "episodes", "02-black-ice.md"),
    `${EPISODE_TWO}ODILE: The Russians, the Sardinians and the Republicans all came, and Russell stayed.\n`,
  );
  expect(unknownNames(vault, work)).toEqual(["Russians", "Sardinians", "Republicans", "Russell"]);
  mkdirSync(join(work, "facts"), { recursive: true });
  writeFileSync(join(work, "facts", "period.md"), "- Russia and Sardinia were at war; the Republic fell.\n");
  expect(unknownNames(vault, work)).toEqual(["Russell"]);
});
