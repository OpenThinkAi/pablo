/**
 * The `essay` output (AGT-2134, pm project `pablo-platform`, D-7, D-8): on every
 * track; on nonfiction its units are the core outline's sections, all in
 * `outputs/essay/essay.md`; its pack carries the thesis, the section's claims
 * with their sources and the voice; publish draft|final writes markdown with a
 * sources list; it passes the conformance run. No test reaches a model.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent } from "@openthink/pablo-core";
import { checkWork } from "../src/check";
import { initTrack } from "../src/init";
import { readMarker } from "../src/marker";
import { mergeDraft } from "../src/novel/merge";
import { runConformance } from "../src/outputs/conformance";
import { ESSAY } from "../src/outputs/essay";
import { buildEssayPack, essayDefaultPlan, essayPreconditions } from "../src/outputs/essay/pack";
import { compileEssay, noteSource, publishEssay } from "../src/outputs/essay/publish";
import { claimRefs, cleanSectionBody, parseEssayFile, putSection, sectionBody, withoutCitations } from "../src/outputs/essay/sections";
import { NARRATED } from "../src/outputs/narrated";
import { OUTPUTS, outputsOnTrack, resolveOutput } from "../src/outputs/registry";
import { addOutput } from "../src/output-verbs";
import { TRACKS, trackIds } from "../src/tracks/registry";
import { runWrite } from "../src/write";
import type { WriteArgs } from "../src/write";
import { useLocalConfigHome } from "./local-config";

useLocalConfigHome();

const CONFORMANCE = fileURLToPath(new URL("./fixtures/conformance", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const STATE_HOME = mkdtempSync(join(tmpdir(), "pablo-essay-state-"));
const NOW = () => new Date("2026-10-26T12:00:00Z");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => rmSync(STATE_HOME, { recursive: true, force: true }));

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8").trim();
}

const THESIS = "# Thesis\n\nThe printing press changed who could argue in public.\n";
const CLAIMS = "# Claims\n\n| # | Claim | Sources |\n|---|---|---|\n| 1 | Gutenberg's press was working in Mainz by 1455 | gutenberg |\n| 2 | Pamphlets spread Luther's theses within weeks | luther-pamphlets |\n| 3 | Literacy rose in print towns | literacy |\n";
const OUTLINE = "# Outline\n\n| # | Section | What it covers |\n|---|---|---|\n| 1 | The press arrives | Mainz and the first books (#1) |\n| 2 | The pamphlet war | Luther and speed (#2, #3) |\n| 3 | Who reads now | What changed |\n";
const NOTE = (id: string, title: string): string => `# ${title}\n\nRetrieved: 2026-10-20\n\nThe raw note about ${id}, never sent to the writer.\n\n## Sources\n\n- https://example.org/${id}\n`;

/** A git vault (the conformance fixture's `style/`) holding a nonfiction work with a full core and, optionally, the essay output. */
function nonfiction(opts: { essay?: boolean } = {}): { vault: string; work: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "pablo-essay-"));
  dirs.push(root);
  const vault = join(root, "vault");
  cpSync(CONFORMANCE, vault, { recursive: true });
  rmSync(join(vault, "novels"), { recursive: true, force: true });
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "config", "commit.gpgsign", "false");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  const made = initTrack(vault, "the-press", "The Press", "nonfiction", { now: NOW, author: "Test Author" });
  if (!made.ok) throw new Error(made.message);
  const work = made.path;
  writeFileSync(join(work, "core", "thesis.md"), THESIS);
  writeFileSync(join(work, "core", "claims.md"), CLAIMS);
  writeFileSync(join(work, "core", "outline.md"), OUTLINE);
  writeFileSync(join(work, "research", "gutenberg.md"), NOTE("gutenberg", "Gutenberg in Mainz"));
  writeFileSync(join(work, "research", "luther-pamphlets.md"), NOTE("luther-pamphlets", "Luther's pamphlets"));
  writeFileSync(join(work, "research", "literacy.md"), NOTE("literacy", "Literacy in print towns"));
  writeFileSync(
    join(work, "research", "checklist.md"),
    "| # | Category | Item | Status | Sources | Waived |\n| --- | --- | --- | --- | --- | --- |\n| 1 | claim | The press | waived | | common knowledge |\n",
  );
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "the core");
  if (opts.essay === true) {
    const added = addOutput(vault, work, "essay", { now: NOW });
    if (!added.ok) throw new Error(`output add failed: ${JSON.stringify(added)}`);
  }
  return { vault, work, home: join(root, "pablo-home") };
}

function markerOf(work: string) {
  const marker = readMarker(work);
  if (!marker.ok) throw new Error(marker.message);
  return marker.marker;
}

/** A writer that answers one paragraph with a citation, plus a stray heading it should not keep. */
function fakeEssayWriter(text = "## A heading the writer added\n\nMainz had a working press by 1455 [#1]. It changed what a town could read."): Adapter {
  return {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text",
    async *complete(): AsyncIterable<CompletionEvent> {
      yield { type: "token", text };
      yield { type: "done", stats: { timeToFirstTokenMs: 10, elapsedMs: 20, tokensRead: 100, tokensWritten: 30, tokensPerSecond: 600 } };
    },
    async proposeEdit(): Promise<never> {
      throw new Error("not used");
    },
    async extractFacts(): Promise<never> {
      throw new Error("not used");
    },
  };
}

async function write(vault: string, work: string, home: string, unit: string, extra: Partial<WriteArgs> = {}, adapter = fakeEssayWriter()): Promise<{ code: number; body: Record<string, unknown> }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (text: unknown) => void lines.push(String(text));
  let code: number;
  try {
    code = await runWrite(
      { chapter: undefined, output: "essay", unit, words: undefined, scenes: undefined, dryRun: false, json: true, force: false, ...extra } as WriteArgs,
      vault,
      work,
      { adapter, env: { PATH: NO_THINK_PATH, XDG_STATE_HOME: STATE_HOME, PABLO_HOME: home }, stderr: { write: () => {} }, now: NOW },
    );
  } finally {
    console.log = log;
  }
  return { code, body: JSON.parse(lines.join("\n") || "{}") as Record<string, unknown> };
}

// AC1 ------------------------------------------------------------------------

test("AC1: essay is registered on every track, and every track lists it", () => {
  expect(OUTPUTS.essay).toBe(ESSAY);
  expect([...ESSAY.tracks]).toEqual(trackIds());
  for (const track of trackIds()) {
    expect(TRACKS[track].outputs as readonly string[]).toContain("essay");
    expect(outputsOnTrack(track)).toContain("essay");
  }
  expect(ESSAY.artifactDir).toBe("outputs/essay");
  expect(ESSAY.unitFileName(2, "The pamphlet war")).toBe("essay.md");
  expect(ESSAY.unitOfPath("essays/the-press/outputs/essay/essay.md")).toBe(1);
  expect(ESSAY.unitOfPath("outputs/story/story.md")).toBeUndefined();
  expect(ESSAY.branch(2)).toBe("draft/essay-02");
  expect(ESSAY.unitOfBranch("draft/essay-02-v3")).toBe(2);
  expect(ESSAY.unitOfBranch("draft/story")).toBeUndefined();
});

test("AC1: on nonfiction the units are the outline's sections; output add scaffolds the plan from them", () => {
  const { work } = nonfiction({ essay: true });
  expect(markerOf(work).outputs["essay"]).toBeDefined();
  expect(essayDefaultPlan(work).map((r) => [r.unit, r.title, r.beats])).toEqual([
    [1, "The press arrives", [1]],
    [2, "The pamphlet war", [2]],
    [3, "Who reads now", [3]],
  ]);
  const plan = readFileSync(join(work, "outputs", "essay", "plan.md"), "utf8");
  expect(plan).toContain("core/outline.md");
  expect(plan).toContain("| 2 | The pamphlet war | 2 | beat |");
  expect(existsSync(join(work, "outputs", "essay", "RULES.md"))).toBe(true);
  expect(essayPreconditions(work, 2)).toEqual({ ready: true, missing: [] });
  expect(essayPreconditions(work, 9).missing[0]).toContain("no section 9 in core/outline.md");
});

test("AC1: sections live in one file, in outline order; putting one keeps the others", () => {
  const outline = [
    { number: 1, title: "One", covers: "" },
    { number: 2, title: "Two", covers: "" },
    { number: 3, title: "Three", covers: "" },
  ];
  let text = putSection(outline, undefined, 3, "Third.", "---\nmodel: a\n---");
  text = putSection(outline, text, 1, "# Stray\n\nFirst.\n## inner", "---\nmodel: b\n---");
  text = putSection(outline, text, 2, "Second.", "---\nmodel: c\n---");
  expect(text).toBe("---\nmodel: c\n---\n\n## One\n\nFirst.\n### inner\n\n## Two\n\nSecond.\n\n## Three\n\nThird.\n");
  const replaced = putSection(outline, text, 2, "Second, again.", "---\nmodel: d\n---");
  expect(parseEssayFile(replaced).sections.map((s) => s.body)).toEqual(["First.\n### inner", "Second, again.", "Third."]);
  expect(sectionBody(outline, replaced, 2)).toBe("Second, again.");
  expect(sectionBody([...outline.slice(0, 1), { number: 2, title: "  two ", covers: "" }], replaced, 2)).toBe("Second, again.");
  expect(sectionBody(outline, "## One\n", 1)).toBeUndefined();
  expect(cleanSectionBody("## Title\n\nBody.")).toBe("Body.");
});

test("AC1: write --output essay --unit N puts section N into essay.md on draft/essay-NN; a written section refuses without --force", async () => {
  const { vault, work, home } = nonfiction({ essay: true });
  const first = await write(vault, work, home, "1");
  expect(first.code).toBe(0);
  expect(first.body).toMatchObject({ ok: true, branch: "draft/essay-01", path: "outputs/essay/essay.md" });
  const merged = await mergeDraft(work, "draft/essay-01", { slug: "the-press", env: { PATH: NO_THINK_PATH }, now: NOW });
  expect(merged.ok).toBe(true);
  if (merged.ok) expect(merged.rituals.filter((r) => r.status === "failed")).toEqual([]);

  const second = await write(vault, work, home, "2", {}, fakeEssayWriter("Luther's theses were in print within weeks [#2]."));
  expect(second.code).toBe(0);
  const onBranch = git(vault, "show", "draft/essay-02:essays/the-press/outputs/essay/essay.md");
  const file = parseEssayFile(onBranch);
  expect(file.sections.map((s) => s.title)).toEqual(["The press arrives", "The pamphlet war"]);
  expect(file.sections[0]!.body).toBe("Mainz had a working press by 1455 [#1].\nIt changed what a town could read.");
  expect(onBranch).not.toContain("A heading the writer added");
  expect(onBranch).toMatch(/^---\nsection: 2\n/);
  expect(onBranch).toContain("prompt_hash: ");

  const again = await write(vault, work, home, "1");
  expect(again.code).toBe(2);
  expect(String(again.body["message"])).toContain("section 1 already has text in outputs/essay/essay.md");
});

test("a nonfiction work with no output is refused naming `pablo output add essay`, never a beat", async () => {
  const { vault, work, home } = nonfiction();
  const lines: string[] = [];
  const log = console.log;
  console.log = (text: unknown) => void lines.push(String(text));
  let code: number;
  try {
    code = await runWrite({ chapter: undefined, output: undefined, unit: "1", dryRun: false, json: true, force: false } as WriteArgs, vault, work, {
      adapter: fakeEssayWriter(),
      env: { PATH: NO_THINK_PATH, XDG_STATE_HOME: STATE_HOME, PABLO_HOME: home },
      stderr: { write: () => {} },
    });
  } finally {
    console.log = log;
  }
  expect(code).toBe(2);
  const body = JSON.parse(lines.join("\n")) as { message: string; missing: string[] };
  expect(body.message).toContain("pablo output add essay");
  expect(body.message).not.toContain("beat");
  expect(body.missing).toContain("output essay (pablo output add essay)");
  expect(resolveOutput({}, undefined, "check", "fiction")).toMatchObject({ ok: true });
  expect(resolveOutput({}, "novel", "publish", "nonfiction")).toMatchObject({ ok: false, code: 2 });
});

// AC2 ------------------------------------------------------------------------

test("AC2: a section's pack carries the thesis, its claims with their sources as citations, the voice, the previous section; never a raw note", () => {
  const { vault, work } = nonfiction({ essay: true });
  writeFileSync(join(work, "outputs", "essay", "essay.md"), putSection(essayDefaultPlan(work).map((r) => ({ number: r.unit, title: r.title, covers: "" })), undefined, 1, "Mainz had a press by 1455 [#1].", "---\nmodel: x\nprompt_hash: y\n---"));
  const packed = buildEssayPack(vault, work, 2, { marker: markerOf(work), output: "essay" });
  if (!packed.ok) throw new Error(packed.message);
  const prompt = packed.pack.prompt;
  expect(prompt).toContain('section 2, "The pamphlet war" of an essay, working title "The Press"');
  expect(prompt).toContain("The printing press changed who could argue in public.");
  expect(prompt).toContain("- [#2] Pamphlets spread Luther's theses within weeks (sources: [@luther-pamphlets])");
  expect(prompt).toContain("- [#3] Literacy rose in print towns (sources: [@literacy])");
  expect(prompt).not.toContain("[#1] Gutenberg");
  expect(prompt).toContain("2. The pamphlet war: Luther and speed (#2, #3)  <- this section");
  expect(prompt).toContain("# The end of the previous section");
  expect(prompt).toContain("Mainz had a press by 1455 [#1].");
  expect(prompt).toContain("# Essay rules");
  // The voice: the vault's style/ and the essay's own rules, layered.
  expect(packed.pack.slices.find((s) => s.name === "style")?.text.trim()).not.toBe("");
  expect(packed.pack.slices.find((s) => s.name === "outputRules")?.source).toContain("outputs/essay/RULES.md");
  expect(prompt).not.toContain("never sent to the writer");
  expect(prompt).not.toContain("example.org");
  for (const slice of packed.pack.slices) expect(slice.source ?? "").not.toContain("research/");
  expect(prompt).not.toContain("scenes");
  // A section naming no claim gets every claim.
  expect(claimRefs("What changed")).toEqual([]);
  const third = buildEssayPack(vault, work, 3, { marker: markerOf(work), output: "essay" });
  if (!third.ok) throw new Error(third.message);
  expect(third.pack.prompt).toContain("[#1] Gutenberg");
});

test("AC2: a section naming a claim the table lacks is not ready", () => {
  const { work } = nonfiction({ essay: true });
  writeFileSync(join(work, "core", "outline.md"), OUTLINE.replace("(#1)", "(#7)"));
  expect(essayPreconditions(work, 1)).toEqual({ ready: false, missing: ["section 1 names claim #7, which core/claims.md does not have"] });
});

test("AC2: on a fiction track the essay is one section about the story, drawing on the story core", () => {
  const vault = mkdtempSync(join(tmpdir(), "pablo-essay-fiction-"));
  dirs.push(vault);
  cpSync(CONFORMANCE, vault, { recursive: true });
  const work = join(vault, "novels", "four-beats");
  writeFileSync(join(work, "facts.md"), "# Facts\n\n- The lamp is red. established-by: novel/ch01\n");
  expect(essayDefaultPlan(work).map((r) => [r.unit, r.title])).toEqual([[1, "The essay"]]);
  const packed = buildEssayPack(vault, work, 1, { marker: markerOf(work), output: "essay" });
  if (!packed.ok) throw new Error(packed.message);
  expect(packed.pack.prompt).toContain("# The story this essay is about");
  expect(packed.pack.prompt).toContain("The lamp is red.");
  expect(packed.pack.prompt).toContain("an essay about the story");
});

// AC3 ------------------------------------------------------------------------

test("AC3: publish draft|final compile markdown with numbered references and a sources list", () => {
  const { work } = nonfiction({ essay: true });
  const outline = essayDefaultPlan(work).map((r) => ({ number: r.unit, title: r.title, covers: "" }));
  let text = putSection(outline, undefined, 1, 'Mainz had a press by 1455 [#1].\nIt "worked".', "---\nmodel: x\nprompt_hash: y\n---");
  text = putSection(outline, text, 2, "Luther spread fast [@luther-pamphlets; #3].\nAgain Mainz [@gutenberg].", "---\nmodel: x\nprompt_hash: y\n---");
  writeFileSync(join(work, "outputs", "essay", "essay.md"), text);

  const draft = publishEssay(work, "the-press", "The Press", "draft");
  if (!draft.ok) throw new Error(draft.message);
  expect(draft.where).toEndWith(".pablo/out/the-press-essay-draft.md");
  const out = readFileSync(draft.where, "utf8");
  expect(out).toContain("# The Press\n\n*Draft, ");
  expect(out).toContain("## The press arrives\n\nMainz had a press by 1455 [1]. It “worked”.");
  expect(out).toContain("Luther spread fast [2, 3]. Again Mainz [1].");
  expect(out).toContain(
    "## Sources\n\n1. Gutenberg in Mainz. https://example.org/gutenberg (retrieved 2026-10-20)\n2. Luther's pamphlets. https://example.org/luther-pamphlets (retrieved 2026-10-20)\n3. Literacy in print towns. https://example.org/literacy (retrieved 2026-10-20)\n",
  );

  const final = publishEssay(work, "the-press", "The Press", "final");
  if (!final.ok) throw new Error(final.message);
  const clean = readFileSync(final.where, "utf8");
  expect(clean).not.toContain("*Draft");
  expect(clean).toContain("## Sources");

  writeFileSync(join(work, "outputs", "essay", "essay.md"), putSection(outline, text, 3, "Nobody knows [@ghost].", "---\nmodel: x\nprompt_hash: y\n---"));
  const dangling = publishEssay(work, "the-press", "The Press", "final");
  expect(dangling.ok).toBe(false);
  if (!dangling.ok) expect(dangling.message).toContain("@ghost");
  const flagged = publishEssay(work, "the-press", "The Press", "draft");
  if (!flagged.ok) throw new Error(flagged.message);
  expect(readFileSync(flagged.where, "utf8")).toContain("Unresolved citations: @ghost.");
  expect(publishEssay(work, "the-press", "The Press", "review")).toMatchObject({ ok: false, code: 2 });
});

test("AC3: an essay that cites nothing still ends with its sources list", () => {
  const compiled = compileEssay("T", "## One\n\nPlain.\n", new Map(), new Map(), "final");
  expect(compiled.text).toBe("# T\n\n## One\n\nPlain.\n\n## Sources\n\nNo sources cited.\n");
  expect(noteSource("x", "no title")).toEqual({ id: "x", title: "x", links: [] });
});

// AC4 ------------------------------------------------------------------------

test("AC4: the essay passes the conformance run on a nonfiction work, every section kept in the one file", async () => {
  const { vault, work } = nonfiction({ essay: true });
  const report = await runConformance(ESSAY, {
    vaultRoot: vault,
    workDir: work,
    marker: markerOf(work),
    writer: (_prompt, unit) => `Section ${unit} argues [#1].`,
    env: { PATH: NO_THINK_PATH },
    now: NOW,
  });
  expect(report.units).toEqual([1, 2, 3]);
  const file = parseEssayFile(readFileSync(join(work, "outputs", "essay", "essay.md"), "utf8"));
  expect(file.sections.map((s) => s.body)).toEqual(["Section 1 argues [#1].", "Section 2 argues [#1].", "Section 3 argues [#1]."]);
  expect(readFileSync(report.published, "utf8")).toContain("1. Gutenberg in Mainz.");
});

// narrated --from essay ------------------------------------------------------

test("narrated reads an essay section aloud without its citations", () => {
  const { work } = nonfiction({ essay: true });
  const outline = essayDefaultPlan(work).map((r) => ({ number: r.unit, title: r.title, covers: "" }));
  writeFileSync(join(work, "outputs", "essay", "essay.md"), putSection(outline, putSection(outline, undefined, 1, "One [#1].", "---\nstatus: draft\nmodel: x\nprompt_hash: y\n---"), 2, "Two came fast [#2; @literacy].", "---\nstatus: draft\nmodel: x\nprompt_hash: y\n---"));
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as { outputs: Record<string, unknown> };
  marker.outputs["narrated"] = { added: "2026-10-26", from: "essay" };
  writeFileSync(join(work, "pablo.json"), JSON.stringify(marker));
  expect(ESSAY.unitText?.(work, 2)).toBe("Two came fast.");
  expect(withoutCitations("A [#1], b [@x; #2].")).toBe("A, b.");
  const reading = NARRATED.derive?.(work, 2, { voices: "narrator" });
  if (reading === undefined || !reading.ok) throw new Error("no reading");
  expect(reading.text).toContain("Two came fast.");
  expect(reading.text).not.toContain("[#");
  expect(reading.text).not.toContain("One");
  expect(NARRATED.preconditions(work, 3).ready).toBe(false);
});

test("check scans the essay file only, never its RULES.md or plan.md, and flags an uncited claim", () => {
  const { vault, work } = nonfiction({ essay: true });
  const outline = essayDefaultPlan(work).map((r) => ({ number: r.unit, title: r.title, covers: "" }));
  writeFileSync(join(work, "outputs", "essay", "essay.md"), putSection(outline, undefined, 1, "Gutenberg's press was working in Mainz by 1455.", "---\nmodel: x\nprompt_hash: y\n---"));
  const checked = checkWork(vault, work);
  if (!checked.ok) throw new Error(checked.message);
  expect([...new Set(checked.hits.map((h) => h.path))]).toEqual(["outputs/essay/essay.md"]);
  expect(checked.hits.map((h) => h.rule)).toContain("claim-uncited");
  expect(checked.unprovenanced).toEqual([]);
});
