/**
 * `pablo story` on a historical-fiction work (AGT-2184, D-5, D-9, D-10, D-22): the run goes through the track's core,
 * premise -> period brief -> research checklist (planned by pablo, sourced or waived by the harness) -> period facts
 * (distilled by pablo) -> bible -> acts -> beats, and reaches a drafted unit. Every run is on a temp git copy of the
 * synthetic fixture vault; the harness is pablo's real agent loop on a scripted model, and the research agent and the
 * writer are fakes. No model, no network, never `~/writing`.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent, CompletionRequest } from "@openthink/pablo-core";
import { mergeChanges } from "../src/novel/merge";
import { acceptBranchInProject } from "../src/review-finish";
import { runStory, stageMessage } from "../src/story";
import type { StoryDeps } from "../src/story";
import type { VerbContext } from "../src/verbs";
import { scriptedAgent } from "./scripted-agent";
import type { ScriptedCall } from "./scripted-agent";
import { fakeTrackPlanner } from "./track-planner";
import { useLocalConfigHome } from "./local-config";

useLocalConfigHome();

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const PROMPT = "write me a short story about a fishing family in 1900 Camogli offered one passage to New York";

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

function tempVault(): { vault: string; ctx: VerbContext; lines: string[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pablo-story-historical-")));
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
  const lines: string[] = [];
  return { vault, ctx: { cwd: vault, env, stderr: { write: (l: string) => void lines.push(l) } }, lines };
}

const PERIOD_BRIEF =
  "# Period\n\n## When and where\n\nCamogli and Genoa, 1900.\n\n## The events\n\nThe great emigration from Liguria to New York.\n\n## What the story must be true to\n\nThe anchovy fleet, steerage passage from Genoa, the coral trade.\n";

const BEATS = [
  "| # | Story date | Title (working) | Beat | POV | Status |",
  "|---|---|---|---|---|---|",
  "| 1 | Spring 1900 | The Letter | A letter from a cousin in New York reaches Rosa's kitchen in Camogli. | Rosa | outline |",
  "| 2 | Winter 1900 | The Quay | The family on the quay at Genoa, deciding who boards. | Rosa | outline |",
].join("\n");

/** The open checklist item numbers the research stage's message lists (`- #3 (people) ...`). */
function openItems(message: string): number[] {
  return [...message.matchAll(/^- #(\d+)/gm)].map((m) => Number(m[1]));
}

/** What the scripted harness does in each historical stage, through pablo's own tools. */
function callsFor(stage: string, message: string): readonly ScriptedCall[] {
  switch (stage) {
    case "premise":
      return [
        [
          "propose",
          {
            stage: "premise",
            content:
              "# Overview\n\n## Title\n\nOne Passage\n\n## Logline\n\nA fishing family in 1900 Camogli is offered one passage to New York.\n\n## Premise\n\nThe sea is failing them.\n\n## Themes\n\n- Leaving.\n\n## Tone\n\nPlain.\n\n## Structure\n\nTwo seasons.\n",
          },
        ],
      ];
    case "period":
      return [["propose", { stage: "period", content: PERIOD_BRIEF }]];
    case "research": {
      const [first, ...rest] = openItems(message);
      return [
        [
          "save_research",
          { title: "Ligurian emigration, 1900", note: "Emigrants to New York sailed from Genoa in steerage.", sources: ["https://example.org/liguria-1900"], items: first === undefined ? [] : [first] },
        ],
        // Several waives in one session: each builds on the last, on the one plan branch.
        ...rest.map((n): ScriptedCall => ["waive_research_item", { item: n, reason: "Not needed for a two-scene story." }]),
      ];
    }
    case "bible":
      return [
        ["propose", { stage: "cast", name: "rosa", content: "# Rosa Bertolotto\n\nThe mother; keeps the household accounts.\n" }],
        ["propose", { stage: "places", content: "# Places\n\n- Camogli: the harbour town.\n- Genoa: the emigrant quay.\n" }],
        ["propose", { stage: "timeline", content: "# Timeline\n\n| Year | Real events | In the story |\n|---|---|---|\n| 1900 | emigration through Genoa | the letter arrives |\n" }],
      ];
    case "acts":
      return [["propose", { stage: "acts", content: "| Act | Years | What it accomplishes |\n|---|---|---|\n| I | 1900 | The offer and the choice. |" }]];
    case "beats":
      return [["propose", { stage: "beats", content: BEATS }]];
    default:
      return [];
  }
}

const stageOf = (message: string) => /Stage \d+ of \d+, ([\w-]+)\./.exec(message)?.[1] ?? "unknown";

function fakeHarness() {
  const stages: string[] = [];
  const { provider } = scriptedAgent((message) => {
    const stage = stageOf(message);
    stages.push(stage);
    return callsFor(stage, message);
  });
  return { agent: provider, stages };
}

/** The research agent: a checklist for `research plan`'s prompt, period facts sourced by the first note for `distill`'s. */
function fakeResearcher(): Adapter & { asked: string[] } {
  const asked: string[] = [];
  const researcher = {
    id: "fake-researcher",
    model: "fake-researcher-model",
    preferredOutput: "text" as const,
    asked,
    async *complete(request: CompletionRequest): AsyncIterable<CompletionEvent> {
      asked.push(request.prompt);
      let answer: string;
      if (request.prompt.includes("planning the research")) {
        answer = JSON.stringify({ items: [{ category: "places", item: "The emigrant quay at Genoa in 1900" }, { category: "technology", item: "Anchovy boats and nets of the Camogli fleet" }] });
      } else {
        const note = /## Note (\S+)/.exec(request.prompt)?.[1] ?? "missing";
        answer = JSON.stringify({ facts: [{ fact: "Emigrants to New York sailed from Genoa in steerage.", source: note, date: "1900", names: [] }] });
      }
      yield { type: "token", text: answer };
      yield { type: "done", stats: { timeToFirstTokenMs: 1, elapsedMs: 1, tokensRead: 10, tokensWritten: 10, tokensPerSecond: 10 } };
    },
    async proposeEdit(): Promise<never> {
      throw new Error("not used");
    },
    async extractFacts(): Promise<never> {
      throw new Error("not used");
    },
  };
  return researcher as unknown as Adapter & { asked: string[] };
}

const PROSE = ["Rosa read the letter twice at the kitchen table.", "On the quay at Genoa the wind came off the sea."].join("\n");

function fakeWriter(): Adapter & { drafts: number } {
  const writer = {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text" as const,
    drafts: 0,
    async *complete(): AsyncIterable<CompletionEvent> {
      writer.drafts += 1;
      yield { type: "token", text: PROSE };
      yield { type: "done", stats: { timeToFirstTokenMs: 5, elapsedMs: 10, tokensRead: 100, tokensWritten: 30, tokensPerSecond: 3000 } };
    },
    async extractFactsWithAnchors() {
      return [{ fact: "Rosa reads the letter at the kitchen table", entities: ["Rosa"], storyTime: undefined, certainty: undefined, anchor: "Rosa read the letter twice" }];
    },
    async proposeEdit(): Promise<never> {
      throw new Error("not used");
    },
    async extractFacts(): Promise<never> {
      throw new Error("not used");
    },
  };
  return writer as unknown as Adapter & { drafts: number };
}

function depsFor(extra: Partial<StoryDeps> = {}): StoryDeps & { researcher: Adapter & { asked: string[] }; writer: Adapter & { drafts: number } } {
  return {
    agent: fakeHarness().agent,
    writer: fakeWriter(),
    researcher: fakeResearcher(),
    planner: fakeTrackPlanner('{"track": "historical-fiction", "why": "the request names 1900 Camogli"}'),
    now: () => new Date("2026-10-27T12:00:00Z"),
    ...extra,
  } as StoryDeps & { researcher: Adapter & { asked: string[] }; writer: Adapter & { drafts: number } };
}

test("AGT-2184: an unattended historical run goes premise -> period -> research (checklist) -> period facts -> bible -> acts -> beats, and drafts", async () => {
  const { vault, ctx, lines } = tempVault();
  const harness = fakeHarness();
  const deps = depsFor({ agent: harness.agent });
  const result = await runStory({ prompt: PROMPT }, ctx, deps);
  const body = result.body as Record<string, any>;
  expect(body.message).toBeUndefined();
  expect(result.exitCode).toBe(0);
  expect(body.track.track).toBe("historical-fiction");

  // The harness ran the stages that are its own; pablo planned and distilled in between.
  expect(harness.stages).toEqual(["premise", "period", "research", "bible", "acts", "beats"]);
  expect(lines.filter((l) => l.includes("core stage")).map((l) => l.trim())).toEqual([
    "pablo story: premise (core stage 1 of 8)",
    "pablo story: period (core stage 2 of 8)",
    "pablo story: research-plan (core stage 3 of 8)",
    "pablo story: research (core stage 4 of 8)",
    "pablo story: period-facts (core stage 5 of 8)",
    "pablo story: bible (core stage 6 of 8)",
    "pablo story: acts (core stage 7 of 8)",
    "pablo story: beats (core stage 8 of 8)",
  ]);
  // The checklist was planned from the brief, then the notes distilled (later checks may ask the research agent too).
  expect(deps.researcher.asked[0]).toContain("The great emigration from Liguria");
  expect(deps.researcher.asked[1]).toContain("## Note ligurian-emigration-1900");

  // Every step's branch was accepted as it landed: one plan entry each, all merged, none left over.
  expect(body.plan.map((p: { stage: string }) => p.stage)).toEqual(["premise", "period", "research-plan", "research", "period-facts", "bible", "acts", "beats"]);
  for (const p of body.plan) expect(typeof p.merged).toBe("string");

  const work = body.path as string;
  expect(readFileSync(join(work, "bible", "period.md"), "utf8")).toContain("The great emigration");
  const checklist = readFileSync(join(work, "research", "checklist.md"), "utf8");
  expect(checklist).toContain("ligurian-emigration-1900");
  expect(checklist).toContain("Not needed for a two-scene story.");
  expect(readFileSync(join(work, "facts", "period.md"), "utf8")).toContain("Emigrants to New York sailed from Genoa in steerage.");
  for (const stage of body.core) if (stage.id !== "facts") expect({ id: stage.id, done: stage.done }).toEqual({ id: stage.id, done: true });

  // And it reached the draft: the story drafted, merged and published.
  expect(deps.writer.drafts).toBe(1);
  expect(body.drafts.story).toHaveLength(1);
  expect(typeof body.drafts.story[0].merged).toBe("string");
  expect(body.published.story).toBeDefined();
  expect(git(vault, "for-each-ref", "--format=%(refname:short)", "refs/heads/plan")).toBe("");
}, 300_000);

test("AGT-2184: --review stops on each historical step's branch, pablo's own included, and resumes past each", async () => {
  const { ctx } = tempVault();
  const deps = depsFor();
  const waits: string[] = [];
  let result = await runStory({ prompt: PROMPT, review: true }, ctx, deps);
  let body = result.body as Record<string, any>;
  const work = body.path as string;
  const slug = body.project as string;
  for (let i = 0; i < 8; i += 1) {
    expect(result.exitCode).toBe(0);
    waits.push(body.waiting.step);
    expect((await mergeChanges(work, body.waiting.branch, { slug, env: ctx.env })).ok).toBe(true);
    result = await runStory({ project: slug }, ctx, deps);
    body = result.body as Record<string, any>;
  }
  expect(waits).toEqual(["core:premise", "core:period", "core:research-plan", "core:research", "core:period-facts", "core:bible", "core:acts", "core:beats"]);
  expect(body.waiting).toEqual({ step: "draft:story:1", branch: "draft/story" });
  expect((await acceptBranchInProject(work, "draft/story", ctx.env, deps.writer)).exitCode).toBe(0);
  result = await runStory({ project: slug }, ctx, deps);
  body = result.body as Record<string, any>;
  expect(result.exitCode).toBe(0);
  expect(body.published.story).toBeDefined();
}, 300_000);

test("AGT-2184: the research stage's message lists the open checklist items; a fiction run's messages are unchanged", () => {
  const historical = { prompt: PROMPT, outputs: ["story"], review: false, track: { track: "historical-fiction" as const, inferred: true, why: "x" } };
  expect(stageMessage("period", historical, "T", "t")).toContain('Stage 2 of 6, period. Write the period brief with propose (stage "period")');
  expect(stageMessage("research", historical, "T", "t")).toContain("Stage 3 of 6, research. pablo planned the research checklist");
  const fiction = { prompt: PROMPT, outputs: ["story"], review: false };
  expect(stageMessage("research", fiction, "T", "t")).toContain("Stage 1 of 5, research. Find what this story needs to be true to");
  expect(stageMessage("premise", fiction, "T", "t")).toContain("Stage 2 of 5, premise. Read the research notes");
});
