/**
 * `pablo story --project <slug> --from <stage>` (AGT-2289, D-22): adopting a hand-built work. The fixture work is
 * written file by file into a temp git copy of the synthetic vault (no `.pablo/story.json`); the harness is pablo's
 * real loop on a scripted model, the writer a fake. No model, no network, never `~/writing`.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent } from "@openthink/pablo-core";
import { writeMarker } from "../src/marker";
import { addOutput } from "../src/output-verbs";
import { runStory } from "../src/story";
import { withoutBeats } from "../src/story-adopt";
import type { StoryDeps } from "../src/story";
import type { VerbContext } from "../src/verbs";
import { scriptedAgent } from "./scripted-agent";
import { useLocalConfigHome } from "./local-config";

useLocalConfigHome();

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");

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

const OVERVIEW = "# Overview\n\n## Title\n\nOne Passage\n\n## Logline\n\nA fishing family in 1900 Camogli is offered one passage to New York.\n\n## Premise\n\nThe sea is failing them.\n";
const OLD_ROSA = "# Rosa Bertolotto\n\nThe OLD cast: keeps the accounts.\n";
const ACTS = "## The acts\n\n| Act | Years | What it accomplishes |\n|---|---|---|\n| I | 1900 | The offer and the choice. |\n";
const BEATS = [
  "## Beats",
  "",
  "| # | Story date | Title (working) | Beat | POV | Status |",
  "|---|---|---|---|---|---|",
  "| 1 | Spring 1900 | The Letter | A letter reaches Rosa's kitchen. | Rosa | outline |",
  "| 2 | Winter 1900 | The Quay | The family on the quay at Genoa. | Rosa | outline |",
].join("\n");
const NEW_BEATS = BEATS.replace("The Letter", "The Offer");

/** A hand-built work: no story.json, a drafted `story` output, committed. */
function handBuilt(opts: { historical?: boolean; period?: boolean } = {}): { vault: string; work: string; ctx: VerbContext; lines: string[] } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pablo-story-adopt-")));
  roots.push(root);
  const vault = join(root, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "config", "commit.gpgsign", "false");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  const work = join(vault, "stories", "one-passage");
  const files: Record<string, string> = {
    "README.md": "# One Passage\n\nAsked for on 2026-10-01:\n\n> a short story about a fishing family in 1900 Camogli\n",
    "bible/overview.md": OVERVIEW,
    "bible/characters/rosa.md": OLD_ROSA,
    "bible/places.md": "# Places\n\n- Camogli: the OLD harbour.\n",
    "bible/timeline.md": "# Timeline\n\n| Year | Real events | In the story |\n|---|---|---|\n| 1900 | emigration | the letter |\n",
    "outline/beats.md": `# Outline\n\n${ACTS}\n${BEATS}\n`,
    "research/camogli.md": "# Camogli\n\nAnchovy fleet.\n\n## Sources\n\n- Smith, Liguria, 1998\n",
  };
  if (opts.historical) {
    files["research/checklist.md"] = "# Research checklist\n\n- [x] (places) The quay at Genoa <!-- ... -->\n";
  }
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    writeFileSync(join(work, rel), text, "utf8");
  }
  writeMarker(work, { title: "One Passage", slug: "one-passage", author: "author", voice: ["../../style"], neverSend: ["research/"], publish: {}, outputs: {}, ...(opts.historical ? { track: "historical-fiction" as const } : {}) });
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "hand-built work");
  if (!opts.historical) {
    const added = addOutput(vault, work, "story", { now: () => new Date("2026-10-01T12:00:00Z") });
    if (!added.ok) throw new Error(JSON.stringify(added));
    writeFileSync(join(work, "outputs", "story", "story.md"), "---\nstatus: draft\n---\nThe old draft.\n", "utf8");
    git(vault, "add", ".");
    git(vault, "commit", "-q", "-m", "drafted");
  }
  const env = { PABLO_VAULT: vault, PABLO_HOME: join(root, "pablo-home"), PATH: NO_THINK_PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  const lines: string[] = [];
  return { vault, work, ctx: { cwd: vault, env, stderr: { write: (l: string) => void lines.push(l) } }, lines };
}

const stageOf = (message: string) => /Stage \d+ of \d+, ([\w-]+)\./.exec(message)?.[1] ?? "unknown";

function harness(): { agent: StoryDeps["agent"]; stages: string[] } {
  const stages: string[] = [];
  const { provider } = scriptedAgent((message) => {
    const stage = stageOf(message);
    stages.push(stage);
    switch (stage) {
      case "premise":
        return [["propose", { stage: "premise", content: OVERVIEW.replace("The sea is failing them.", "A NEW premise.") }]];
      case "bible":
        return [
          ["propose", { stage: "cast", name: "rosa", content: "# Rosa Bertolotto\n\nThe NEW cast.\n" }],
          ["propose", { stage: "places", content: "# Places\n\n- Genoa: the quay.\n" }],
          ["propose", { stage: "timeline", content: "# Timeline\n\n| Year | Real events | In the story |\n|---|---|---|\n| 1900 | emigration | the offer |\n" }],
        ];
      case "acts":
        return [["propose", { stage: "acts", content: "| Act | Years | What it accomplishes |\n|---|---|---|\n| I | 1900 | The NEW acts. |" }]];
      case "beats":
        return [["propose", { stage: "beats", content: NEW_BEATS.split("\n").slice(2).join("\n") }]];
      default:
        return [];
    }
  });
  return { agent: provider, stages };
}

function fakeWriter(): Adapter & { drafts: number } {
  const writer = {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text" as const,
    drafts: 0,
    async *complete(): AsyncIterable<CompletionEvent> {
      writer.drafts += 1;
      yield { type: "token", text: "Rosa read the letter twice.\nThe boat came back light." };
      yield { type: "done", stats: { timeToFirstTokenMs: 5, elapsedMs: 10, tokensRead: 100, tokensWritten: 30, tokensPerSecond: 3000 } };
    },
    async extractFactsWithAnchors() {
      return [{ fact: "Rosa reads the letter", entities: ["Rosa"], storyTime: undefined, certainty: undefined, anchor: "Rosa read the letter twice" }];
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

const NOW = () => new Date("2026-10-31T12:00:00Z");

function allFiles(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(dir, e.name), base) : [join(dir, e.name).slice(base.length + 1)]));
}

test("AGT-2289: a work with no run record is refused and --from is named; --from alone needs --project; an unknown stage lists the stages", async () => {
  const { work, ctx } = handBuilt();
  const noRecord = await runStory({ project: "one-passage" }, ctx, {});
  expect(noRecord.exitCode).toBe(2);
  expect((noRecord.body as any).message).toContain("--from");
  const noProject = await runStory({ from: "bible" }, ctx, {});
  expect(noProject.exitCode).toBe(2);
  expect((noProject.body as any).message).toContain("--project");
  const unknown = await runStory({ project: "one-passage", from: "chapters" }, ctx, { now: NOW });
  expect(unknown.exitCode).toBe(2);
  expect((unknown.body as any).message).toContain("research, premise, bible, acts, beats");
  expect(existsSync(join(work, "_archived"))).toBe(false);
});

test("AGT-2289: --from bible keeps research and premise, archives the bible onward and the output, and reruns from there", async () => {
  const { vault, work, ctx, lines } = handBuilt();
  const h = harness();
  const writer = fakeWriter();
  const result = await runStory({ project: "one-passage", from: "bible" }, ctx, { agent: h.agent, writer, now: NOW });
  const body = result.body as Record<string, any>;
  expect(body.message).toBeUndefined();
  expect(result.exitCode).toBe(0);

  // Only the stages from bible on ran; research and the premise are untouched.
  expect(h.stages).toEqual(["bible", "acts", "beats"]);
  expect(readFileSync(join(work, "bible", "overview.md"), "utf8")).toBe(OVERVIEW);
  expect(existsSync(join(work, "research", "camogli.md"))).toBe(true);
  expect(body.adopted).toMatchObject({ from: "bible", outputs: ["story"] });
  expect(body.title).toBe("One Passage");

  // New material is live; the old is archived, never deleted.
  expect(readFileSync(join(work, "bible", "characters", "rosa.md"), "utf8")).toContain("NEW cast");
  const archive = join(work, "_archived", "bible-2026-10-31");
  expect(readFileSync(join(archive, "bible", "characters", "rosa.md"), "utf8")).toBe(OLD_ROSA);
  expect(readFileSync(join(archive, "outline", "beats.md"), "utf8")).toContain("The Letter");
  expect(readFileSync(join(work, "outline", "beats.md"), "utf8")).not.toContain("The Letter");
  expect(readFileSync(join(work, "outline", "beats.md"), "utf8")).toContain("The Offer");
  const removed = readdirSync(join(work, "outputs", "_removed"));
  expect(removed).toHaveLength(1);
  expect(readFileSync(join(work, "outputs", "_removed", removed[0]!, "story.md"), "utf8")).toContain("The old draft.");

  // The output was added again and drafted anew.
  expect(writer.drafts).toBe(1);
  expect(readFileSync(join(work, "outputs", "story", "story.md"), "utf8")).not.toContain("The old draft.");
  expect(lines.some((l) => l.includes("adopting one-passage from bible"))).toBe(true);
  expect(git(vault, "status", "--porcelain", "--", "stories")).toBe("");
  expect(existsSync(join(work, ".pablo", "story.json"))).toBe(true);
}, 120_000);

test("AGT-2289: --from beats keeps the acts table, archives the whole outline as it was", async () => {
  const { work, ctx } = handBuilt();
  const h = harness();
  const result = await runStory({ project: "one-passage", from: "beats", output: ["story"] }, ctx, { agent: h.agent, writer: fakeWriter(), now: NOW });
  expect(result.exitCode).toBe(0);
  expect(h.stages).toEqual(["beats"]);
  const outline = readFileSync(join(work, "outline", "beats.md"), "utf8");
  expect(outline).toContain("The offer and the choice.");
  expect(outline).toContain("The Offer");
  expect(readFileSync(join(work, "_archived", "beats-2026-10-31", "outline", "beats.md"), "utf8")).toContain("The Letter");
  // The bible stayed where it was.
  expect(readFileSync(join(work, "bible", "characters", "rosa.md"), "utf8")).toBe(OLD_ROSA);
});

test("AGT-2289: stages before --from must be complete: the refusal names what is missing and nothing moves", async () => {
  const { vault, work, ctx } = handBuilt();
  writeFileSync(join(work, "outline", "beats.md"), `# Outline\n\n${BEATS}\n`, "utf8");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "drop acts");
  const result = await runStory({ project: "one-passage", from: "beats" }, ctx, { agent: harness().agent, writer: fakeWriter(), now: NOW });
  expect(result.exitCode).toBe(2);
  const body = result.body as Record<string, any>;
  expect(body.message).toContain("acts");
  expect(body.missing.join(" ")).toContain("acts");
  expect(existsSync(join(work, "_archived"))).toBe(false);
  expect(existsSync(join(work, "outputs", "_removed"))).toBe(false);
  expect(allFiles(work)).toContain("bible/characters/rosa.md");
});

test("AGT-2289: an uncommitted edit in an output refuses before anything moves", async () => {
  const { work, ctx } = handBuilt();
  writeFileSync(join(work, "outputs", "story", "story.md"), "unsaved edit\n", "utf8");
  const result = await runStory({ project: "one-passage", from: "bible" }, ctx, { agent: harness().agent, writer: fakeWriter(), now: NOW });
  expect(result.exitCode).toBe(2);
  expect((result.body as any).message).toContain("uncommitted changes");
  expect(existsSync(join(work, "_archived"))).toBe(false);
  expect(readFileSync(join(work, "bible", "characters", "rosa.md"), "utf8")).toBe(OLD_ROSA);
  expect(readFileSync(join(work, "outline", "beats.md"), "utf8")).toContain("The Letter");
});

test("AGT-2289: withoutBeats clears only the beats table, wherever it sits", () => {
  const acts = "| Act | Years | What |\n|---|---|---|\n| I | 1900 | x |";
  const beats = "| # | Story date | Title |\n|---|---|---|\n| 1 | 1900 | A |";
  expect(withoutBeats(`${beats}\n\n${acts}\n`)).toBe(`| # | Story date | Title |\n|---|---|---|\n\n${acts}\n`);
  expect(withoutBeats(`${acts}\n\n${beats}\n`)).toBe(`${acts}\n\n| # | Story date | Title |\n|---|---|---|\n`);
  expect(withoutBeats(`${acts}\n`)).toBe(`${acts}\n`);
});

test("AGT-2289: on historical-fiction the research gate must be open before a later stage; uncommitted changes are refused", async () => {
  const { vault, work, ctx } = handBuilt({ historical: true });
  // No period brief, no period facts, an unsourced checklist item: every earlier stage is short.
  const gate = await runStory({ project: "one-passage", from: "bible" }, ctx, { agent: harness().agent, now: NOW });
  expect(gate.exitCode).toBe(2);
  const missing = (gate.body as any).missing.join("\n");
  expect(missing).toContain("period");
  expect(missing).toContain("period-facts");
  expect(existsSync(join(work, "_archived"))).toBe(false);

  // From the first stage nothing is required, but a dirty file in the way is refused.
  writeFileSync(join(work, "bible", "overview.md"), `${OVERVIEW}\nunsaved edit\n`, "utf8");
  const dirty = await runStory({ project: "one-passage", from: "premise" }, ctx, { agent: harness().agent, now: NOW });
  expect(dirty.exitCode).toBe(2);
  expect((dirty.body as any).message).toContain("uncommitted changes");
  expect(git(vault, "log", "--oneline").split("\n")).toHaveLength(2);
});
