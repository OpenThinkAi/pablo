/**
 * The story-output gaps AGT-1689/1690 left (AGT-1705): the novel's ledger,
 * the story's review/final publish targets, its after-revision ritual, a
 * single-row story plan, titles from the premise, and a progress line per
 * stage. Every run is on a temp git copy of the synthetic fixture vault with a
 * fake harness and a fake writer: no model, no network, no `think`, never
 * `~/writing`.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defaultConfig } from "@openthink/pablo-core";
import type { Adapter, CompletionEvent } from "@openthink/pablo-core";
import { harnessAuth } from "../src/harness/auth";
import type { HarnessQuery } from "../src/harness/session";
import { mergeChanges } from "../src/novel/merge";
import { addOutput, mergePlan, planOutput } from "../src/output-verbs";
import { STORY } from "../src/outputs/story";
import { compileStoryReview } from "../src/outputs/story/publish";
import { runStory, titleFromPremise, titleFromPrompt } from "../src/story";
import type { StoryDeps } from "../src/story";
import { publishOutput } from "../src/verbs";
import type { VerbContext, VerbResult } from "../src/verbs";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");

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

function tempVault(): { vault: string; env: Record<string, string>; ctx: VerbContext; lines: string[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pablo-story-gaps-")));
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
  return { vault, env, ctx: { cwd: vault, env, stderr: { write: (text: string) => void lines.push(text) } }, lines };
}

const success = (result: string) =>
  ({ type: "result", subtype: "success", is_error: false, result, num_turns: 2, duration_ms: 10, total_cost_usd: 0 }) as unknown as SDKMessage;

type Call = readonly [string, Record<string, unknown>];

const BEATS = [
  "| # | Story date | Title (working) | Beat | POV | Status |",
  "|---|---|---|---|---|---|",
  "| 1 | Spring 1900 | The Letter | A letter from a cousin in New York reaches Rosa's kitchen in Camogli. | Rosa | outline |",
  "| 2 | Summer 1900 | The Catch | Paolo's boat comes back light three weeks running. | Paolo | outline |",
  "| 3 | Autumn 1900 | The Ticket | Rosa sells her mother's coral to buy one passage, not two. | Rosa | outline |",
  "| 4 | Winter 1900 | The Quay | The family on the quay at Genoa, deciding who boards. | Rosa | outline |",
].join("\n");

const LOGLINE = "A fishing family in 1900 Camogli is offered one passage to New York and has to decide who takes it.";

function overview(title: string | undefined): string {
  return `# Overview\n\n${title === undefined ? "" : `## Title\n\n${title}\n\n`}## Logline\n\n${LOGLINE}\n\n## Premise\n\nThe sea is failing them.\n\n## Themes\n\n- Leaving.\n\n## Tone\n\nPlain.\n\n## Structure\n\nFour seasons.\n`;
}

function stageCalls(title: string | undefined): Readonly<Record<string, readonly Call[]>> {
  return {
    research: [["save_research", { title: "Ligurian fishing villages, 1900", note: "Camogli's fleet fished anchovy and sardine.", sources: ["https://example.org/liguria-1900"] }]],
    premise: [["propose", { stage: "premise", content: overview(title) }]],
    bible: [
      ["propose", { stage: "cast", name: "rosa", content: "# Rosa Bertolotto\n\nThe mother; keeps the household accounts.\n" }],
      ["propose", { stage: "places", content: "# Places\n\n- Camogli: the harbour town.\n- Genoa: the emigrant quay.\n" }],
      ["propose", { stage: "timeline", content: "# Timeline\n\n| Year | Real events | In the story |\n|---|---|---|\n| 1900 | emigration through Genoa peaks | the cousin's letter arrives |\n" }],
    ],
    acts: [["propose", { stage: "acts", content: "| Act | Years | What it accomplishes |\n|---|---|---|\n| I | 1900 | The offer comes and the sea fails. |\n| II | 1900 | The choice on the quay. |" }]],
    beats: [["propose", { stage: "beats", content: BEATS }]],
  };
}

function fakeHarness(title: string | null = "The Last Passage"): { query: HarnessQuery; prompts: string[] } {
  const calls = stageCalls(title ?? undefined);
  const prompts: string[] = [];
  const query: HarnessQuery = async function* (params) {
    const stage = /Stage \d of 5, (\w+)\./.exec(params.prompt)?.[1] ?? "unknown";
    prompts.push(params.prompt);
    const instance = (params.options.mcpServers?.["pablo"] as { instance: McpServer }).instance;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await instance.connect(serverSide);
    const client = new Client({ name: "fake-sdk", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      for (const [name, args] of calls[stage] ?? []) {
        const called = await client.callTool({ name, arguments: args });
        const body = JSON.parse((called.content as { text: string }[])[0]!.text) as { ok: boolean; message?: string };
        if (body.ok !== true) throw new Error(`${name} refused: ${body.message}`);
      }
    } finally {
      await client.close();
    }
    yield success(`${stage} done`);
  };
  return { query, prompts };
}

const PROSE = ["Rosa read the letter twice at the kitchen table.", "The boat came back light again.", "On the quay the wind came off the sea."].join("\n");

function fakeWriter(): Adapter {
  const writer = {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text" as const,
    async *complete(): AsyncIterable<CompletionEvent> {
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
  return writer as unknown as Adapter;
}

function depsFor(env: Record<string, string>, query: HarnessQuery, extra: Partial<StoryDeps> = {}): StoryDeps {
  return { query, writer: fakeWriter(), auth: harnessAuth(defaultConfig(), env, { env: {} }), now: () => new Date("2026-10-11T12:00:00Z"), ...extra };
}

function receipts(work: string): Record<string, unknown>[] {
  return readFileSync(join(work, ".pablo", "receipts.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** A finished story run: the work directory and the vault around it. */
async function finishedRun(output: string[] | undefined, title: string | null = "The Last Passage", args: { title?: string } = {}) {
  const v = tempVault();
  const result = await runStory({ prompt: SPEC, ...(output ? { output } : {}), ...args }, v.ctx, depsFor(v.env, fakeHarness(title).query));
  const body = result.body as Record<string, any>;
  expect(body.message).toBeUndefined();
  expect(result.exitCode).toBe(0);
  return { ...v, body, work: body.path as string };
}

// ---------------------------------------------------------------------------
// AC1: the novel's ledger
// ---------------------------------------------------------------------------

test("AC1: a story run with --output novel creates the novel ledger and files a continuity receipt per chapter", async () => {
  const { work } = await finishedRun(["novel"]);
  const ledger = join(work, "outputs", "novel", "continuity.md");
  expect(existsSync(ledger)).toBe(true);
  expect(readFileSync(ledger, "utf8")).toContain("Rosa reads the letter at the kitchen table");
  const continuity = receipts(work).filter((r) => r["intent"] === "continuity");
  expect(continuity.map((r) => `${r["output"]}/${r["unit"]}`)).toEqual(["novel/1", "novel/2", "novel/3", "novel/4"]);
  // The ledger is committed with the first chapter's rituals, not left dirty.
  expect(git(dirname(dirname(work)), "status", "--porcelain", "--", work)).toBe("");
});

test("AC1: output add novel creates the ledger, and keeps one the work already has at either name", async () => {
  const fresh = await finishedRun(["story"]);
  const marker = JSON.parse(readFileSync(join(fresh.work, "pablo.json"), "utf8")) as Record<string, unknown>;
  expect(Object.keys(marker["outputs"] as object)).toEqual(["story"]);
  const added = addOutput(fresh.vault, fresh.work, "novel", { now: () => new Date(2026, 9, 12) });
  expect(added.ok).toBe(true);
  if (added.ok) expect(added.paths).toContain("outputs/novel/continuity.md");
  expect(readFileSync(join(fresh.work, "outputs", "novel", "continuity.md"), "utf8")).toContain("## Names and ages");

  // A work whose ledger is the unmigrated root continuity.md keeps it: no second ledger appears.
  const legacy = await finishedRun(["story"]);
  writeFileSync(join(legacy.work, "continuity.md"), "# Continuity\n\n## Names and ages\n\n- kept\n");
  git(legacy.vault, "add", ".");
  git(legacy.vault, "commit", "-q", "-m", "legacy ledger");
  expect(addOutput(legacy.vault, legacy.work, "novel", { now: () => new Date(2026, 9, 12) }).ok).toBe(true);
  expect(existsSync(join(legacy.work, "outputs", "novel", "continuity.md"))).toBe(false);
  expect(readFileSync(join(legacy.work, "continuity.md"), "utf8")).toContain("- kept");
}, 30_000);

// ---------------------------------------------------------------------------
// AC2: review and final publish targets
// ---------------------------------------------------------------------------

test("AC2: publish --output story builds draft, review and final, and still refuses an unknown target", async () => {
  const { work } = await finishedRun(["story"]);
  const draft = publishOutput(work, "draft", "story");
  const review = publishOutput(work, "review", "story");
  const final = publishOutput(work, "final", "story");
  for (const r of [draft, review, final]) expect(r.exitCode).toBe(0);
  const fields = (r: VerbResult) => r.body as Record<string, unknown>;
  const where = (r: VerbResult) => fields(r)["where"] as string;
  expect(new Set([where(draft), where(review), where(final)]).size).toBe(3);
  expect(where(review)).toMatch(/-story-review\.md$/);
  expect(where(final)).toMatch(/-story-final\.md$/);

  const reviewText = readFileSync(where(review), "utf8");
  const finalText = readFileSync(where(final), "utf8");
  expect(reviewText).toContain("*Review copy, ");
  expect(reviewText).toContain("Rosa read the letter twice at the kitchen table.");
  expect(finalText).not.toContain("Review copy");
  expect(finalText).toBe(readFileSync(where(draft), "utf8"));
  expect(fields(review)["target"]).toBe("review");
  expect(fields(final)["target"]).toBe("final");

  const unknown = publishOutput(work, "epub", "story");
  expect(unknown.exitCode).toBe(2);
});

test("AC2: the review copy is the compiled story under a word-counted line", () => {
  const text = compileStoryReview("Ice House", '---\nstory: 1\n---\n\nShe said, "Go."\nHe went.\n');
  expect(text).toBe("# Ice House\n\n*Review copy, 5 words.*\n\nShe said, “Go.” He went.\n");
});

// ---------------------------------------------------------------------------
// AC3: the revision ritual
// ---------------------------------------------------------------------------

test("AC3: a revision merged into the story writes a dated note with the author's comments, commits it, and syncs", async () => {
  const { vault, env, work, body } = await finishedRun(["story"]);
  const slug = body.project as string;
  git(vault, "checkout", "-q", "-b", "revise/story");
  const storyFile = join(work, "outputs", "story", "story.md");
  writeFileSync(storyFile, `${readFileSync(storyFile, "utf8")}\nThe sea gave nothing back.\n`);
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "revise the story");
  git(vault, "checkout", "-q", "main");

  const merged = await mergeChanges(work, "revise/story", {
    slug,
    env,
    now: () => new Date("2026-10-12T12:00:00Z"),
    authorNotes: [{ path: `stories/${slug}/outputs/story/story.md`, line: 3, text: "On the quay", body: "Cut the wind." }],
  });
  expect(merged.ok).toBe(true);
  if (!merged.ok) return;
  expect(merged.chapters).toEqual([1]);
  expect(merged.rituals.map((r) => `${r.name}:${r.status}`)).toEqual(["note:ran", "git:ran", "think:skipped"]);

  const note = readFileSync(join(work, "notes", "2026-10-12-story.md"), "utf8");
  expect(note).toContain("# 2026-10-12 — story revised");
  expect(note).toContain("Revised on revise/story.");
  expect(note).toContain("Cut the wind.");
  // The note is committed on its own; the work is clean.
  expect(git(vault, "log", "-1", "--format=%s")).toBe(`${slug}: notes on the story (revise/story)`);
  expect(git(vault, "status", "--porcelain", "--", work)).toBe("");
});

test("AC3: a second revision the same day appends to the note", async () => {
  const { work, body } = await finishedRun(["story"]);
  const opts = { slug: body.project as string, branch: "revise/story", now: () => new Date("2026-10-12T12:00:00Z"), env: { PATH: NO_THINK_PATH } };
  await STORY.rituals.afterRevision(work, 1, opts);
  const second = await STORY.rituals.afterRevision(work, 1, { ...opts, branch: "edit/story" });
  expect(second[0]?.detail).toContain("appended to notes/2026-10-12-story.md");
  const note = readFileSync(join(work, "notes", "2026-10-12-story.md"), "utf8");
  expect(note).toContain("Revised on revise/story.");
  expect(note).toContain("Revised on edit/story.");
});

// ---------------------------------------------------------------------------
// AC4: the story's plan keeps one row
// ---------------------------------------------------------------------------

test("AC4: regenerating the story plan after a new beat keeps a single unit row covering it", async () => {
  const { vault, work } = await finishedRun(["story"]);
  const beats = join(work, "outline", "beats.md");
  writeFileSync(
    beats,
    `${readFileSync(beats, "utf8").trimEnd()}\n| 5 | Spring 1901 | The Crossing | The ship leaves Genoa with Rosa aboard. | Rosa | outline |\n`,
  );
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "a fifth beat");

  const planned = planOutput(vault, work, "story");
  expect(planned.ok).toBe(true);
  if (!planned.ok) return;
  expect(planned.rows.map((r) => ({ unit: r.unit, beats: r.beats }))).toEqual([{ unit: 1, beats: [1, 2, 3, 4, 5] }]);
  const text = readFileSync(join(work, "outputs", "story", "plan.md"), "utf8");
  expect(text.match(/^\| \d+ \|/gm)).toEqual(["| 1 |"]);

  // The story still drafts: unit 1 tells all five beats, and the plan does not name a second unit.
  expect(STORY.preconditions(work, 1).ready).toBe(true);
});

test("AC4: a plan that already grew a unit-2 row is folded back into the first", async () => {
  const { work } = await finishedRun(["story"]);
  // The work tells four beats; an old plan appended a second unit for the last two.
  const rows = mergePlan(
    STORY,
    work,
    [
      { unit: 1, title: "The story", beats: [1, 2], status: "draft" },
      { unit: 2, title: "The story", beats: [3, 4], status: "beat" },
    ],
  );
  expect(rows).toEqual([{ unit: 1, title: "The story", beats: [1, 2, 3, 4], status: "draft" }]);
});

test("AC4: a chosen act (a row that does not start at the first beat) is kept as written", async () => {
  const { vault, work } = await finishedRun(["story"]);
  const planFile = join(work, "outputs", "story", "plan.md");
  writeFileSync(planFile, readFileSync(planFile, "utf8").replace(/\| 1, 2, 3, 4 \|/, "| 3, 4 |"));
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "tell act two only");
  const planned = planOutput(vault, work, "story");
  expect(planned.ok).toBe(true);
  if (planned.ok) expect(planned.rows.map((r) => ({ unit: r.unit, beats: r.beats }))).toEqual([{ unit: 1, beats: [3, 4] }]);
});

// ---------------------------------------------------------------------------
// AC5: titles from the premise
// ---------------------------------------------------------------------------

test("AC5: the premise's ## Title names the work: pablo.json, the README and QWEN.md headings follow, the slug stays", async () => {
  const { vault, work, body } = await finishedRun(["story"], "The Last Passage");
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as { title: string };
  expect(marker.title).toBe("The Last Passage");
  expect(body.title).toBe("The Last Passage");
  expect(readFileSync(join(work, "README.md"), "utf8").split("\n")[0]).toBe("# The Last Passage");
  expect(readFileSync(join(work, "QWEN.md"), "utf8").split("\n")[0]).toBe("# The Last Passage: the work's rules");
  expect(body.project).toMatch(/^a-family-who-lives/);
  expect(git(vault, "status", "--porcelain", "--", work)).toBe("");
  // The published copy carries the premise's title, not the request.
  expect(readFileSync(body.published.story.where, "utf8").split("\n")[0]).toBe("# The Last Passage");
});

test("AC5: with no ## Title the title is the logline's subject, never the request's verb", async () => {
  const { body, work } = await finishedRun(["story"], null);
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as { title: string };
  expect(marker.title).toBe("A fishing family in 1900 Camogli");
  expect(body.title).toBe(marker.title);
  expect(marker.title.toLowerCase()).not.toContain("research");
});

test("AC5: an explicit --title is never replaced by the premise's", async () => {
  const { work } = await finishedRun(["story"], "The Last Passage", { title: "Camogli" });
  expect((JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as { title: string }).title).toBe("Camogli");
});

test("AC5: titleFromPremise and the request-derived working title", () => {
  expect(titleFromPremise(overview("“The Last Passage.”"))).toBe("The Last Passage");
  expect(titleFromPremise(overview(undefined))).toBe("A fishing family in 1900 Camogli");
  expect(titleFromPremise("# Overview\n")).toBeUndefined();
  expect(titleFromPremise("# Overview\n\n## Logline\n\nOne.\n")).toBeUndefined();
  // The request's verb phrase is not a title: the subject after "write me a story about" is.
  expect(titleFromPrompt(SPEC)).toBe("A family who lives there and discovers an");
  expect(titleFromPrompt(SPEC).toLowerCase()).not.toMatch(/^research|write/);
  expect(titleFromPrompt("the last ferry. it sinks")).toBe("The last ferry");
});

// ---------------------------------------------------------------------------
// AC6: a progress line per stage
// ---------------------------------------------------------------------------

test("AC6: a run prints one stderr line per stage, in order, and nothing else", async () => {
  const { lines } = await finishedRun(["story"]);
  expect(lines.every((l) => l.startsWith("pablo story: ") && l.endsWith("\n") && l.indexOf("\n") === l.length - 1)).toBe(true);
  expect(lines.map((l) => l.trim())).toEqual([
    "pablo story: research (core stage 1 of 5)",
    "pablo story: premise (core stage 2 of 5)",
    "pablo story: bible (core stage 3 of 5)",
    "pablo story: acts (core stage 4 of 5)",
    "pablo story: beats (core stage 5 of 5)",
    "pablo story: story: adding the output",
    "pablo story: story: drafting story 1 of 1",
    "pablo story: story: publishing (draft)",
  ]);
});

test("AC6: a novel run prints a line per chapter", async () => {
  const { lines } = await finishedRun(["novel"]);
  const drafting = lines.filter((l) => l.includes("drafting chapter"));
  expect(drafting.map((l) => l.trim())).toEqual([1, 2, 3, 4].map((n) => `pablo story: novel: drafting chapter ${n} of 4`));
});
