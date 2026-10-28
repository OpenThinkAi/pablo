/**
 * `pablo story "<prompt>"` (AGT-1690, pm project `pablo-story-core`): the core
 * built through the harness, then each requested output drafted, merged and
 * published. Every run is on a temp git copy of the synthetic fixture vault
 * (`PABLO_VAULT`, `PABLO_HOME` and `HOME` all under a temp dir), the harness
 * is pablo's real agent loop on a scripted model (`scripted-agent.ts`) that
 * calls pablo's own in-process tools, and the writer is a fake adapter: no model, no network, no `think`, never
 * `~/writing`.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent } from "@openthink/pablo-core";
import { deleteBranch } from "../src/branch";
import { main, repeatedFlag } from "../src/cli";
import type { HarnessProvider } from "../src/harness/provider";
import { scriptedAgent } from "./scripted-agent";
import { mergeChanges } from "../src/novel/merge";
import { acceptBranchInProject } from "../src/review-finish";
import { radioMachine } from "../src/outputs/radio/casting-side";
import { OUTPUTS, registerOutput } from "../src/outputs/registry";
import { STORY } from "../src/outputs/story";
import type { EnsureOutcome } from "../src/outputs/types";
import type { CastingDeps } from "../src/radio";
import { defaultOutput, runStory, titleFromPrompt, wordsCue } from "../src/story";
import type { StoryDeps } from "../src/story";
import { captureConsoleLog, VERBS } from "../src/verbs";
import type { VerbContext } from "../src/verbs";
import { parseTrackAnswer, trackInferencePrompt } from "../src/tracks/infer";
import { fakeTrackPlanner } from "./track-planner";
import { useLocalConfigHome } from "./local-config";

useLocalConfigHome();

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");

/** Matt's spec example (pablo-casting decision 6). */
const SPEC =
  "research 1900 Italian Riviera fishing villages and write me a story about a family who lives there and discovers an opportunity to move to the United States";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8").trim();
}

/** The fixture vault (style/, voices/) in a temp git repository on `main`. */
function tempVault(): { vault: string; env: Record<string, string>; ctx: VerbContext } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pablo-story-verb-")));
  roots.push(root);
  const vault = join(root, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "config", "commit.gpgsign", "false");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  const env = { PABLO_VAULT: vault, PABLO_HOME: join(root, "pablo-home"), PATH: NO_THINK_PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  return { vault, env, ctx: { cwd: vault, env, stderr: { write: () => {} } } };
}

type Call = readonly [string, Record<string, unknown>];

const BEATS = [
  "| # | Story date | Title (working) | Beat | POV | Status |",
  "|---|---|---|---|---|---|",
  "| 1 | Spring 1900 | The Letter | A letter from a cousin in New York reaches Rosa's kitchen in Camogli. | Rosa | outline |",
  "| 2 | Summer 1900 | The Catch | Paolo's boat comes back light three weeks running; the price of anchovies falls. | Paolo | outline |",
  "| 3 | Autumn 1900 | The Ticket | Rosa sells her mother's coral to buy one passage, not two. | Rosa | outline |",
  "| 4 | Winter 1900 | The Quay | The family on the quay at Genoa, deciding who boards. | Rosa | outline |",
].join("\n");

/** What the fake harness does in each core stage, through pablo's own tools. */
const STAGE_CALLS: Readonly<Record<string, readonly Call[]>> = {
  research: [
    [
      "save_research",
      {
        title: "Ligurian fishing villages, 1900",
        note: "Camogli's fleet fished anchovy and sardine; emigration to New York ran through Genoa.",
        sources: ["https://example.org/liguria-1900"],
      },
    ],
  ],
  premise: [
    ["ask_author", { question: "Does the whole family emigrate in the end?", options: ["They all go", "Only Paolo goes"], why: "The ending is the author's call." }],
    [
      "propose",
      {
        stage: "premise",
        content:
          "# Overview\n\n## Logline\n\nA fishing family in 1900 Camogli is offered one passage to New York and has to decide who takes it.\n\n## Premise\n\nThe sea is failing them.\n\n## Themes\n\n- Leaving.\n\n## Tone\n\nPlain.\n\n## Structure\n\nFour seasons.\n",
      },
    ],
  ],
  bible: [
    ["propose", { stage: "cast", name: "rosa", content: "# Rosa Bertolotto\n\nThe mother; keeps the household accounts.\n" }],
    ["propose", { stage: "places", content: "# Places\n\n- Camogli: the harbour town.\n- Genoa: the emigrant quay.\n" }],
    ["propose", { stage: "timeline", content: "# Timeline\n\n| Year | Real events | In the story |\n|---|---|---|\n| 1900 | emigration through Genoa peaks | the cousin's letter arrives |\n" }],
  ],
  acts: [["propose", { stage: "acts", content: "| Act | Years | What it accomplishes |\n|---|---|---|\n| I | 1900 | The offer comes and the sea fails. |\n| II | 1900 | The choice on the quay. |" }]],
  beats: [["propose", { stage: "beats", content: BEATS }]],
};

const stageOf = (message: string) => /Stage \d of 5, (\w+)\./.exec(message)?.[1] ?? "unknown";

/** pablo's own agent loop on a scripted model: reads the stage off the message, calls that stage's tools, then answers. */
function fakeHarness(): { agent: HarnessProvider; stages: string[]; prompts: string[] } {
  const stages: string[] = [];
  const { provider, messages } = scriptedAgent((message) => {
    const stage = stageOf(message);
    stages.push(stage);
    return STAGE_CALLS[stage] ?? [];
  });
  return { agent: provider, stages, prompts: messages };
}

const PROSE = ["Rosa read the letter twice at the kitchen table.", "The boat came back light again.", "On the quay the wind came off the sea."].join("\n");

function fakeWriter(): Adapter & { drafts: number; extractions: number } {
  const writer = {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text" as const,
    drafts: 0,
    extractions: 0,
    async *complete(): AsyncIterable<CompletionEvent> {
      writer.drafts += 1;
      yield { type: "token", text: PROSE };
      yield { type: "done", stats: { timeToFirstTokenMs: 5, elapsedMs: 10, tokensRead: 100, tokensWritten: 30, tokensPerSecond: 3000 } };
    },
    async extractFactsWithAnchors() {
      writer.extractions += 1;
      return [{ fact: "Rosa reads the letter at the kitchen table", entities: ["Rosa"], storyTime: undefined, certainty: undefined, anchor: "Rosa read the letter twice" }];
    },
    async proposeEdit(): Promise<never> {
      throw new Error("not used");
    },
    async extractFacts(): Promise<never> {
      throw new Error("not used");
    },
  };
  return writer as unknown as Adapter & { drafts: number; extractions: number };
}

function depsFor(agent: HarnessProvider, writer: Adapter, extra: Partial<StoryDeps> = {}): StoryDeps {
  return { agent, writer, planner: fakeTrackPlanner(), now: () => new Date("2026-10-11T12:00:00Z"), ...extra };
}

function receipts(work: string): Record<string, unknown>[] {
  const path = join(work, ".pablo", "receipts.jsonl");
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function changeBranches(vault: string): string[] {
  return git(vault, "for-each-ref", "--format=%(refname:short)", "refs/heads")
    .split("\n")
    .filter((b) => b !== "" && b !== "main");
}

// ---------------------------------------------------------------------------
// The default output and the length cue
// ---------------------------------------------------------------------------

test("the default output is story for a short or unclear prompt, novel when the prompt asks for one", () => {
  expect(defaultOutput(SPEC)).toBe("story");
  expect(defaultOutput("a bedtime story about a lighthouse")).toBe("story");
  expect(defaultOutput("write me a novel about the ice trade")).toBe("novel");
  expect(defaultOutput("a 90,000-word book about a vineyard")).toBe("novel");
  expect(defaultOutput("about 1,500 words on a cannery strike")).toBe("story");
  expect(defaultOutput("a short story, the length of a novel chapter")).toBe("story");
  expect(wordsCue("a 1,500-word story")).toBe(1500);
  expect(wordsCue("80k words")).toBe(80000);
  expect(wordsCue("a story")).toBeUndefined();
  expect(titleFromPrompt("the last ferry. it sinks")).toBe("The last ferry");
});

test("repeatedFlag reads every --output in order, both spellings", () => {
  expect(repeatedFlag(["story", "x", "--output", "novel", "--json", "--output=story"], "output")).toEqual(["novel", "story"]);
  expect(repeatedFlag(["story", "x"], "output")).toEqual([]);
});

// AGT-2143: an MCP tool for an outside agent, never one of the harness's own (`harness: false`).
test("story is one VERBS entry, MCP-only beside the CLI: never the harness's, project optional, output repeatable", () => {
  const story = VERBS.find((v) => v.name === "story");
  expect(story?.mcpTools).toBeUndefined();
  expect(story?.harness).toBe(false);
  expect(story?.args.safeParse({ prompt: "x", output: ["novel", "story"] }).success).toBe(true);
  expect(story?.args.safeParse({}).success).toBe(true);
});

// AGT-2191: the harness's own turns leave receipts and transcripts.
test("AGT-2191: every agent-loop turn keeps a receipt naming the stage intent and its tool calls, and --json points at the stage transcripts", async () => {
  const { ctx } = tempVault();
  const harness = fakeHarness();
  const result = await runStory({ prompt: SPEC }, ctx, depsFor(harness.agent, fakeWriter()));
  const body = result.body as Record<string, any>;
  expect(result.exitCode).toBe(0);

  const loop = receipts(body.path).filter((r) => r["output"] === undefined);
  expect(loop.length).toBeGreaterThanOrEqual(10);
  // research runs under `research`, premise through beats under `plan`; local provider costs nothing.
  expect(new Set(loop.map((r) => r["intent"]))).toEqual(new Set(["research", "plan"]));
  expect(loop[0]).toMatchObject({ intent: "research", provider: "scripted-agent", model: "scripted-agent-model", cost_usd: 0, tool_calls: ["save_research"] });
  for (const r of loop) expect(typeof r["cost_usd"]).toBe("number");
  expect(loop.flatMap((r) => (r["tool_calls"] as string[] | undefined) ?? [])).toEqual(
    expect.arrayContaining(["save_research", "ask_author", "propose"]),
  );

  // One saved transcript per stage, listed in the result and holding the tool calls by name.
  expect(body.transcripts).toHaveLength(5);
  const research = body.transcripts.find((t: string) => t.includes("research-"));
  expect(research.startsWith(join(body.path, ".pablo", "transcripts"))).toBe(true);
  const entries = readFileSync(research, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { kind: string; tool?: string });
  expect(entries[0]?.kind).toBe("session");
  expect(entries.filter((e) => e.kind === "tool_call").map((e) => e.tool)).toEqual(["save_research"]);
  expect(entries.at(-1)?.kind).toBe("result");
});

// ---------------------------------------------------------------------------
// AC1: on demand, a story from one prompt
// ---------------------------------------------------------------------------

test("AC1: the spec example leaves research, a bible, an outline, a drafted and published story, and receipts naming output", async () => {
  const { vault, env, ctx } = tempVault();
  const harness = fakeHarness();
  const writer = fakeWriter();
  const result = await runStory({ prompt: SPEC }, ctx, depsFor(harness.agent, writer));
  const body = result.body as Record<string, any>;
  expect(body.message).toBeUndefined();
  expect(result.exitCode).toBe(0);
  expect(body.ok).toBe(true);
  expect(body.outputs).toEqual(["story"]);

  // Category by output kind: a story lives under stories/.
  const work = join(vault, "stories", body.project);
  expect(body.path).toBe(work);
  expect(harness.stages).toEqual(["research", "premise", "bible", "acts", "beats"]);
  // Every stage message carries the request.
  for (const p of harness.prompts) expect(p).toContain("Italian Riviera");

  // The core, on main.
  const research = readdirSync(join(work, "research")).filter((f) => f.endsWith(".md"));
  expect(research).toEqual(["ligurian-fishing-villages-1900.md"]);
  expect(readFileSync(join(work, "bible", "overview.md"), "utf8")).toContain("## Logline\n\nA fishing family in 1900 Camogli");
  expect(existsSync(join(work, "bible", "characters", "rosa.md"))).toBe(true);
  expect(readFileSync(join(work, "outline", "beats.md"), "utf8")).toContain("| 4 | Winter 1900 | The Quay |");
  expect(body.core.filter((s: { done: boolean }) => !s.done).map((s: { id: string }) => s.id)).toEqual([]);
  expect(body.plan.map((p: { stage: string }) => p.stage)).toEqual(["research", "premise", "bible", "acts", "beats"]);

  // The story output: drafted, merged (with its rituals), published.
  const story = readFileSync(join(work, "outputs", "story", "story.md"), "utf8");
  expect(story).toContain("Rosa read the letter twice at the kitchen table.");
  expect(git(vault, "show", "main:" + `stories/${body.project}/outputs/story/story.md`)).toContain("story: 1");
  expect(readFileSync(join(work, "outline", "beats.md"), "utf8")).toContain("| 1 | Spring 1900 | The Letter |");
  expect(existsSync(join(work, "outputs", "story", "continuity.md"))).toBe(true);
  expect(body.published.story.target).toBe("draft");
  expect(readFileSync(body.published.story.where, "utf8")).toContain("Rosa read the letter twice at the kitchen table.");

  // ask_author answered by a stated assumption, kept.
  expect(body.assumptions).toEqual([
    { stage: "premise", question: "Does the whole family emigrate in the end?", why: "The ending is the author's call.", options: ["They all go", "Only Paolo goes"] },
  ]);

  // The receipt chain: one per model call, each naming its output.
  const chain = receipts(work).filter((r) => r["output"] !== undefined);
  expect(chain.map((r) => r["intent"])).toEqual(["draft", "continuity"]);
  for (const r of chain) expect(r).toMatchObject({ output: "story", unit: 1 });
  expect(writer.drafts).toBe(1);

  // The track's checks ran on the draft (AGT-2115): its hits ride on the draft record, the text untouched.
  expect(Array.isArray(body.drafts.story[0].check)).toBe(true);

  // Every branch was accepted and removed; the work is clean on main.
  expect(changeBranches(vault)).toEqual([]);
  expect(git(vault, "status", "--porcelain", "--", `stories/${body.project}`)).toBe("");
});

test("AGT-2135: --output essay on a fiction story assumes the premise as the essay's thesis and writes every section", async () => {
  const { vault, ctx } = tempVault();
  const result = await runStory({ prompt: SPEC, output: ["essay"] }, ctx, depsFor(fakeHarness().agent, fakeWriter()));
  const body = result.body as Record<string, any>;
  expect(body.message).toBeUndefined();
  expect(result.exitCode).toBe(0);
  const work = join(vault, "stories", body.project);
  expect(readFileSync(join(work, "outputs", "essay", "thesis.md"), "utf8")).toBe("# Thesis\n\nThe sea is failing them.\n");
  expect(body.assumptions).toContainEqual(expect.objectContaining({ stage: "output:essay", options: ["The sea is failing them."] }));
  expect(existsSync(join(work, "outputs", "essay", "outline.md"))).toBe(true);
  expect(body.drafts.essay.length).toBeGreaterThan(1);
  expect(existsSync(body.published.essay.where)).toBe(true);
  expect(changeBranches(vault)).toEqual([]);
});

// ---------------------------------------------------------------------------
// AC2: two outputs from one core
// ---------------------------------------------------------------------------

test("AC2: --output novel --output story builds one core and both outputs", async () => {
  const { vault, env, ctx } = tempVault();
  const harness = fakeHarness();
  const writer = fakeWriter();
  const result = await runStory({ prompt: SPEC, output: ["novel", "story", "novel"] }, ctx, depsFor(harness.agent, writer));
  const body = result.body as Record<string, any>;
  expect(body.message).toBeUndefined();
  expect(result.exitCode).toBe(0);
  expect(body.outputs).toEqual(["novel", "story"]);
  // One core: each stage ran once.
  expect(harness.stages).toEqual(["research", "premise", "bible", "acts", "beats"]);

  // A novel is asked for: the work is filed under novels/.
  const work = join(vault, "novels", body.project);
  expect(readdirSync(join(work, "chapters")).filter((f) => f.endsWith(".md")).sort()).toEqual([
    "01-the-letter.md",
    "02-the-catch.md",
    "03-the-ticket.md",
    "04-the-quay.md",
  ]);
  expect(existsSync(join(work, "outputs", "story", "story.md"))).toBe(true);
  expect(Object.keys(JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")).outputs)).toEqual(["novel", "story"]);
  expect(body.drafts.novel.map((d: { unit: number }) => d.unit)).toEqual([1, 2, 3, 4]);
  expect(body.drafts.story.map((d: { branch: string }) => d.branch)).toEqual(["draft/story"]);
  expect(existsSync(body.published.novel.where)).toBe(true);
  expect(existsSync(body.published.story.where)).toBe(true);
  expect(body.published.novel.where).not.toBe(body.published.story.where);

  const chain = receipts(work).filter((r) => r["output"] !== undefined);
  const drafts = chain.filter((r) => r["intent"] === "draft").map((r) => `${r["output"]}/${r["unit"]}`);
  expect(drafts).toEqual(["novel/1", "novel/2", "novel/3", "novel/4", "story/1"]);
  for (const r of chain) expect(typeof r["output"]).toBe("string");
  expect(changeBranches(vault)).toEqual([]);
});

// ---------------------------------------------------------------------------
// AC3: an output nobody asked for is never ensured; one that cannot run is refused by name, before anything
// ---------------------------------------------------------------------------

/** A fixture type with an `ensure()` that counts its calls (`radio` is a real row since AGT-1686, so this is `podcast`). */
function stubType(outcome: EnsureOutcome): { calls: () => number; dispose: () => void } {
  let calls = 0;
  const dispose = registerOutput({
    ...STORY,
    id: "podcast",
    noun: "episode",
    plural: "episodes",
    artifactDir: "outputs/podcast/episodes",
    ensure: () => {
      calls += 1;
      return outcome;
    },
  });
  return { calls: () => calls, dispose };
}

/**
 * The real radio type's machine (AGT-1686, `outputs/radio/casting-side.ts`), faked: casting sources present, the
 * venv never provisioned, and `uv` on PATH or not. Counts how often the radio type looked at it.
 */
function fakeRadioMachine(uv: boolean): { looks: () => number; restore: () => void } {
  const source = mkdtempSync(join(tmpdir(), "pablo-story-casting-"));
  writeFileSync(join(source, "pyproject.toml"), '[project]\nname = "pablo-casting"\n');
  writeFileSync(join(source, "uv.lock"), "version = 1\n");
  const saved = { deps: radioMachine.deps, env: radioMachine.env };
  let looks = 0;
  const deps: CastingDeps = {
    layout: { source, venv: join(source, ".venv"), install: "checkout" },
    which: () => (uv ? "/fake/bin/uv" : undefined),
    run: () => {
      throw new Error("the radio type must never run anything to ensure itself");
    },
    now: () => new Date("2026-10-11T12:00:00Z"),
  };
  radioMachine.deps = () => {
    looks += 1;
    return deps;
  };
  radioMachine.env = () => ({ PATH: "/nowhere" });
  return {
    looks: () => looks,
    restore: () => {
      radioMachine.deps = saved.deps;
      radioMachine.env = saved.env;
      rmSync(source, { recursive: true, force: true });
    },
  };
}

test("AC3: a run that names no podcast output never calls the podcast type's ensure(), nor looks at radio's casting side", async () => {
  const podcast = stubType({ ok: false, message: "the podcast side is not provisioned" });
  const machine = fakeRadioMachine(false);
  try {
    const { env, ctx } = tempVault();
    const result = await runStory({ prompt: SPEC }, ctx, depsFor(fakeHarness().agent, fakeWriter()));
    expect(result.exitCode).toBe(0);
    expect(podcast.calls()).toBe(0);
    expect(machine.looks()).toBe(0);
  } finally {
    podcast.dispose();
    machine.restore();
  }
});

test("AC3: --output podcast on a machine without it is refused by name before any writing", async () => {
  const podcast = stubType({ ok: false, message: "the podcast side is not provisioned", missing: ["podcast: its side (pablo doctor)"] });
  try {
    const { vault, env, ctx } = tempVault();
    const head = git(vault, "rev-parse", "main");
    const harness = fakeHarness();
    const writer = fakeWriter();
    const result = await runStory({ prompt: SPEC, output: ["story", "podcast"] }, ctx, depsFor(harness.agent, writer));
    expect(result.exitCode).toBe(2);
    const body = result.body as Record<string, any>;
    expect(body.message).toContain("the podcast output cannot run on this machine");
    expect(body.message).toContain("nothing was written");
    expect(body.missing).toEqual(["podcast: its side (pablo doctor)"]);
    expect(podcast.calls()).toBe(1);
    // Nothing started: no harness, no writer, no work, no commit, no branch.
    expect(harness.stages).toEqual([]);
    expect(writer.drafts).toBe(0);
    expect(existsSync(join(vault, "stories"))).toBe(false);
    expect(git(vault, "rev-parse", "main")).toBe(head);
    expect(changeBranches(vault)).toEqual([]);
  } finally {
    podcast.dispose();
  }
});

test("AC3: an output type pablo does not have is refused by name, nothing written", async () => {
  const { vault, env, ctx } = tempVault();
  const harness = fakeHarness();
  const result = await runStory({ prompt: SPEC, output: ["podcast"] }, ctx, depsFor(harness.agent, fakeWriter()));
  expect(result.exitCode).toBe(2);
  expect((result.body as { message: string }).message).toContain("there is no podcast output on this machine");
  expect((result.body as { missing: string[] }).missing).toEqual(["output podcast"]);
  expect(harness.stages).toEqual([]);
  expect(existsSync(join(vault, "stories"))).toBe(false);
  expect(existsSync(join(vault, "novels", "ice-house"))).toBe(true);
});

test("AGT-1686: the real radio type's ensure() refuses --output radio by name when its Python side cannot be provisioned (no uv), having run nothing", async () => {
  const machine = fakeRadioMachine(false);
  try {
    const { vault, env, ctx } = tempVault();
    const harness = fakeHarness();
    const result = await runStory({ prompt: SPEC, output: ["story", "radio"] }, ctx, depsFor(harness.agent, fakeWriter()));
    expect(result.exitCode).toBe(2);
    const body = result.body as Record<string, any>;
    expect(body.message).toContain("the radio output cannot run on this machine");
    expect(body.missing).toEqual(["uv (brew install uv)"]);
    expect(machine.looks()).toBe(1);
    expect(harness.stages).toEqual([]);
    expect(existsSync(join(vault, "stories"))).toBe(false);
  } finally {
    machine.restore();
  }
});

test("AGT-1686: with uv on PATH the radio type's ensure() passes without provisioning: the first casting verb does that", async () => {
  const { ensure } = OUTPUTS.radio;
  const machine = fakeRadioMachine(true);
  try {
    expect(await ensure?.()).toEqual({ ok: true });
  } finally {
    machine.restore();
  }
});

test("AC3 through the CLI: pablo story --output radio --json refuses by name", async () => {
  const { vault } = tempVault();
  const machine = fakeRadioMachine(false);
  const saved = { vault: process.env["PABLO_VAULT"], home: process.env["PABLO_HOME"] };
  process.env["PABLO_VAULT"] = vault;
  process.env["PABLO_HOME"] = join(vault, "..", "pablo-home");
  try {
    const { exitCode, text } = await captureConsoleLog(() => main(["story", SPEC, "--output", "story", "--output", "radio", "--json"], vault));
    expect(exitCode).toBe(2);
    expect(JSON.parse(text)).toMatchObject({ ok: false, code: 2, missing: ["uv (brew install uv)"] });
    expect(existsSync(join(vault, "stories"))).toBe(false);
  } finally {
    machine.restore();
    if (saved.vault === undefined) delete process.env["PABLO_VAULT"];
    else process.env["PABLO_VAULT"] = saved.vault;
    if (saved.home === undefined) delete process.env["PABLO_HOME"];
    else process.env["PABLO_HOME"] = saved.home;
  }
});

// ---------------------------------------------------------------------------
// AC4: --review stops at each stage and resumes
// ---------------------------------------------------------------------------

test("AC4: --review stops on every stage's branch, waits until it is accepted, reruns a dropped one, and resumes to the end", async () => {
  const { vault, env, ctx } = tempVault();
  const harness = fakeHarness();
  const writer = fakeWriter();
  const deps = depsFor(harness.agent, writer);

  let result = await runStory({ prompt: SPEC, review: true }, ctx, deps);
  let body = result.body as Record<string, any>;
  expect(result.exitCode).toBe(0);
  expect(body.waiting.step).toBe("core:research");
  expect(body.waiting.branch).toMatch(/^plan\//);
  const slug = body.project as string;
  const work = join(vault, "stories", slug);
  expect(body.next).toContain(`pablo story --project ${slug}`);
  // Nothing of the stage is on main yet.
  expect(readdirSync(join(work, "research")).filter((f) => f.endsWith(".md"))).toEqual([]);

  // Resuming before the author accepts: still waiting, the harness is not run again.
  result = await runStory({ project: slug }, ctx, deps);
  body = result.body as Record<string, any>;
  expect(body.waiting.step).toBe("core:research");
  expect(harness.stages).toEqual(["research"]);

  // The author drops the research branch: the stage runs again on a new branch.
  const dropped = body.waiting.branch as string;
  expect(deleteBranch(vault, slug, dropped, { force: true, env }).ok).toBe(true);
  result = await runStory({ project: slug }, ctx, deps);
  body = result.body as Record<string, any>;
  expect(body.waiting.step).toBe("core:research");
  expect(body.waiting.branch).not.toBe(dropped);
  expect(harness.stages).toEqual(["research", "research"]);

  // Accept each stage in turn (review mode's finish: merge and remove the branch); each resume stops on the next.
  const steps: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    steps.push(body.waiting.step);
    expect((await mergeChanges(work, body.waiting.branch, { slug, env })).ok).toBe(true);
    result = await runStory({ project: slug }, ctx, deps);
    body = result.body as Record<string, any>;
    expect(result.exitCode).toBe(0);
  }
  expect(steps).toEqual(["core:research", "core:premise", "core:bible", "core:acts", "core:beats"]);
  expect(harness.stages).toEqual(["research", "research", "premise", "bible", "acts", "beats"]);

  // The story's draft waits on its own branch; nothing is published yet.
  expect(body.waiting).toEqual({ step: "draft:story:1", branch: "draft/story" });
  expect(existsSync(join(work, "outputs", "story", "story.md"))).toBe(false);
  expect(existsSync(join(work, ".pablo", "out"))).toBe(false);

  // The author merges the draft (`pablo merge draft/story`); the run publishes and finishes.
  const merged = await acceptBranchInProject(work, "draft/story", env, writer);
  expect(merged.exitCode).toBe(0);
  result = await runStory({ project: slug }, ctx, deps);
  body = result.body as Record<string, any>;
  expect(result.exitCode).toBe(0);
  expect(body.waiting).toBeUndefined();
  expect(body.review).toBe(true);
  expect(existsSync(body.published.story.where)).toBe(true);
  expect(writer.drafts).toBe(1);
  expect(changeBranches(vault)).toEqual([]);
});

test("a resume names what is missing: no run recorded, or a prompt and a project together", async () => {
  const { ctx, env } = tempVault();
  const deps = depsFor(fakeHarness().agent, fakeWriter());
  const none = await runStory({ project: "ice-house" }, ctx, deps);
  expect(none.exitCode).toBe(2);
  expect((none.body as { message: string }).message).toContain("no pablo story run is recorded");
  const both = await runStory({ project: "ice-house", prompt: "x" }, ctx, deps);
  expect(both.exitCode).toBe(2);
  const empty = await runStory({}, ctx, deps);
  expect(empty.exitCode).toBe(2);
  expect((empty.body as { missing: string[] }).missing).toEqual(['"<prompt>"']);
});

// ---------------------------------------------------------------------------
// AGT-2103: --track, and the track inferred from the prompt
// ---------------------------------------------------------------------------

const HISTORICAL_ANSWER = '{"track": "historical-fiction", "why": "the request names 1900 Liguria and the emigration to the United States"}';

function trackedFiles(vault: string, work: string): string[] {
  return git(vault, "ls-files", "--", relative(vault, work)).split("\n").map((p) => relative(relative(vault, work), p));
}

test("AGT-2103: a prompt naming a period is inferred historical-fiction by one planner call; the track and why are in the receipt and pablo.json, with the period core files", async () => {
  const { vault, env, ctx } = tempVault();
  const lines: string[] = [];
  const planner = fakeTrackPlanner(HISTORICAL_ANSWER);
  const result = await runStory({ prompt: SPEC, review: true }, { ...ctx, stderr: { write: (l: string) => void lines.push(l) } }, depsFor(fakeHarness().agent, fakeWriter(), { planner }));
  const body = result.body as Record<string, any>;
  expect(result.exitCode).toBe(0);
  expect(planner.asked).toHaveLength(1);
  expect(planner.asked[0]).toContain(SPEC);
  expect(body.track).toEqual({ track: "historical-fiction", inferred: true, why: "the request names 1900 Liguria and the emigration to the United States" });
  expect(lines[0]).toBe("pablo story: choosing a track from the prompt\n");
  expect(lines[1]).toBe("pablo story: track historical-fiction (inferred: the request names 1900 Liguria and the emigration to the United States)\n");

  const work = join(vault, "stories", body.project as string);
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  expect(marker["track"]).toBe("historical-fiction");
  const tracked = trackedFiles(vault, work);
  for (const file of ["bible/period.md", "facts/period.md", "bible/overview.md", "outline/beats.md", "facts.md", "STYLE.md"]) expect(tracked).toContain(file);
});

test("AGT-2103: a plain fiction prompt is inferred fiction, with no period files", async () => {
  const { vault, env, ctx } = tempVault();
  const planner = fakeTrackPlanner('{"track": "fiction", "why": "an invented lighthouse, no period named"}');
  const result = await runStory({ prompt: "write me a story about a lighthouse keeper's cat", review: true }, ctx, depsFor(fakeHarness().agent, fakeWriter(), { planner }));
  const body = result.body as Record<string, any>;
  expect(result.exitCode).toBe(0);
  expect(planner.asked).toHaveLength(1);
  expect(body.track).toEqual({ track: "fiction", inferred: true, why: "an invented lighthouse, no period named" });
  const work = join(vault, "stories", body.project as string);
  expect(JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")).track).toBe("fiction");
  expect(existsSync(join(work, "bible", "period.md"))).toBe(false);
  expect(existsSync(join(work, "facts", "period.md"))).toBe(false);
});

test("AGT-2103: --track always wins: the planner is never asked", async () => {
  const { vault, env, ctx } = tempVault();
  const planner = fakeTrackPlanner(HISTORICAL_ANSWER);
  const lines: string[] = [];
  const result = await runStory({ prompt: SPEC, review: true, track: "fiction" }, { ...ctx, stderr: { write: (l: string) => void lines.push(l) } }, depsFor(fakeHarness().agent, fakeWriter(), { planner }));
  expect(lines[0]).toBe("pablo story: track fiction (--track)\n");
  const body = result.body as Record<string, any>;
  expect(result.exitCode).toBe(0);
  expect(planner.asked).toEqual([]);
  expect(body.track).toEqual({ track: "fiction", inferred: false, why: "--track" });
  const work = join(vault, "stories", body.project as string);
  expect(JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")).track).toBe("fiction");
  expect(existsSync(join(work, "bible", "period.md"))).toBe(false);

  // And the other way: a plain prompt put on historical-fiction by hand.
  const forced = await runStory({ prompt: "write me a story about a lighthouse keeper's cat", review: true, track: "historical-fiction" }, ctx, depsFor(fakeHarness().agent, fakeWriter(), { planner }));
  const forcedBody = forced.body as Record<string, any>;
  expect(planner.asked).toEqual([]);
  expect(forcedBody.track.track).toBe("historical-fiction");
  expect(existsSync(join(vault, "stories", forcedBody.project as string, "bible", "period.md"))).toBe(true);
});

test("AGT-2103: an unknown track, or a track no requested output allows, is refused before anything is written", async () => {
  const { vault, env, ctx } = tempVault();
  const planner = fakeTrackPlanner();
  const before = git(vault, "rev-parse", "main");

  const unknown = await runStory({ prompt: SPEC, track: "memoir" }, ctx, depsFor(fakeHarness().agent, fakeWriter(), { planner }));
  expect(unknown.exitCode).toBe(2);
  expect((unknown.body as { message: string }).message).toContain('unknown track "memoir"');

  const nonfiction = await runStory({ prompt: SPEC, track: "nonfiction" }, ctx, depsFor(fakeHarness().agent, fakeWriter(), { planner }));
  expect(nonfiction.exitCode).toBe(2);
  expect((nonfiction.body as { message: string }).message).toContain("pablo init --track nonfiction");

  // A requested output the track does not allow (D-7): a test type that only nonfiction allows.
  const off = registerOutput({ ...STORY, id: "nf-only", tracks: ["nonfiction"] });
  try {
    const refused = await runStory({ prompt: SPEC, track: "fiction", output: ["nf-only"] }, ctx, depsFor(fakeHarness().agent, fakeWriter(), { planner }));
    expect(refused.exitCode).toBe(2);
    expect((refused.body as { message: string }).message).toContain("the nf-only output is not allowed on the fiction track");
  } finally {
    off();
  }

  expect(planner.asked).toEqual([]);
  expect(git(vault, "rev-parse", "main")).toBe(before);
  expect(existsSync(join(vault, "stories"))).toBe(false);
});

test("AGT-2103: a planner that cannot answer leaves the run on fiction and says why", async () => {
  const { env, ctx } = tempVault();
  const result = await runStory({ prompt: SPEC, review: true }, ctx, depsFor(fakeHarness().agent, fakeWriter(), { planner: fakeTrackPlanner("I think it is probably historical.") }));
  const body = result.body as Record<string, any>;
  expect(result.exitCode).toBe(0);
  expect(body.track).toEqual({ track: "fiction", inferred: false, why: "the planner's answer could not be read; fiction by default" });
});

test("AGT-2103: parseTrackAnswer reads the JSON asked for and nothing else", () => {
  expect(parseTrackAnswer('```json\n{"track": "historical-fiction", "why": "1906 earthquake"}\n```')).toEqual({ track: "historical-fiction", why: "1906 earthquake" });
  expect(parseTrackAnswer('{"track": "fiction"}')?.track).toBe("fiction");
  expect(parseTrackAnswer('{"track": "nonfiction", "why": "x"}')).toBeUndefined();
  expect(parseTrackAnswer("historical-fiction")).toBeUndefined();
  expect(trackInferencePrompt("the 1906 San Francisco earthquake")).toContain("> the 1906 San Francisco earthquake");
});
