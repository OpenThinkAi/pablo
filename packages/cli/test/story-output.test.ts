/**
 * The `story` output type (AGT-1689, pm project `pablo-story-core`): one unit
 * over all the core's beats (or a chosen act), drafted to
 * `outputs/story/story.md` by `pablo write --output story`, the whole outline
 * as one slice, length from the request. Everything runs on a temp copy of
 * the synthetic fixture vault with a fake writer: no model, never `~/writing`.
 * The conformance run itself is `outputs.test.ts` (it covers every row of
 * `OUTPUTS`, story included).
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent } from "@openthink/pablo-core";
import { addOutput } from "../src/output-verbs";
import { OUTPUTS, outputIds } from "../src/outputs/registry";
import { STORY } from "../src/outputs/story";
import { compileStory } from "../src/outputs/story/publish";
import { runWrite } from "../src/write";
import type { WriteArgs } from "../src/write";
import { useLocalConfigHome } from "./local-config";

useLocalConfigHome();

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const STATE_HOME = mkdtempSync(join(tmpdir(), "pablo-story-state-"));
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

/** The fixture vault in a temp git repository, Mrs. Frayne's [pick] decided so every beat is ready. */
function vault(): { vault: string; work: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), "pablo-story-"));
  dirs.push(dir);
  const root = join(dir, "vault");
  cpSync(FIXTURE_VAULT, root, { recursive: true });
  const work = join(root, "novels", "ice-house");
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  delete marker["format"];
  writeFileSync(join(work, "pablo.json"), `${JSON.stringify({ ...marker, outputs: { novel: { dir: "chapters", added: "2026-09-01" } } }, null, 2)}\n`);
  const tree = join(work, "bible", "characters", "family-tree.md");
  writeFileSync(tree, readFileSync(tree, "utf8").replace("Mrs. Frayne [pick]", "Mrs. Frayne"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "pablo-test@example.com");
  git(root, "config", "user.name", "Pablo Test");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  return { vault: root, work, home: join(dir, "pablo-home") };
}

const STORY_TEXT = ["Odile drove the route alone that winter.", "The ice rang wrong under the horse.", "By March the ledger was closed."].join("\n");

function fakeWriter(prompts: string[] = []): Adapter {
  return {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text",
    async *complete(request: { prompt?: string } | string): AsyncIterable<CompletionEvent> {
      prompts.push(typeof request === "string" ? request : JSON.stringify(request));
      yield { type: "token", text: STORY_TEXT };
      yield { type: "done", stats: { timeToFirstTokenMs: 10, elapsedMs: 20, tokensRead: 100, tokensWritten: 12, tokensPerSecond: 600 } };
    },
    async proposeEdit(): Promise<never> {
      throw new Error("not used");
    },
    async extractFacts(): Promise<never> {
      throw new Error("not used");
    },
  };
}

async function write(v: { vault: string; work: string; home: string }, args: Partial<WriteArgs>, prompts: string[] = []): Promise<{ code: number; body: Record<string, unknown> }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (text: unknown) => void lines.push(String(text));
  try {
    const code = await runWrite(
      { chapter: undefined, words: undefined, scenes: undefined, dryRun: false, json: true, force: false, ...args },
      v.vault,
      v.work,
      {
        adapter: fakeWriter(prompts),
        env: { PATH: NO_THINK_PATH, XDG_STATE_HOME: STATE_HOME, PABLO_HOME: v.home },
        stderr: { write: () => {} },
        now: () => new Date("2026-10-12T12:00:00Z"),
      },
    );
    return { code, body: JSON.parse(lines.join("\n")) as Record<string, unknown> };
  } finally {
    console.log = log;
  }
}

test("story is a row of OUTPUTS: one unit in outputs/story/story.md on draft/story", () => {
  expect(OUTPUTS.story).toBe(STORY);
  expect(outputIds()).toContain("story");
  expect(STORY.artifactDir).toBe("outputs/story");
  expect(STORY.stages).toEqual(["draft", "revise", "publish"]);
  expect(STORY.unitFileName(1, "The Letter")).toBe("story.md");
  expect(STORY.unitOfPath("novels/x/outputs/story/story.md")).toBe(1);
  expect(STORY.unitOfPath("novels/x/chapters/01-a.md")).toBeUndefined();
  expect(STORY.branch(1)).toBe("draft/story");
  expect(STORY.unitOfBranch("draft/story-v2")).toBe(1);
  expect(STORY.unitOfBranch("draft/ch01")).toBeUndefined();
});

test("the default plan is one unit over every beat; an unmet core or a second unit is not ready", () => {
  const v = vault();
  const plan = STORY.plan(v.work);
  expect(plan).toHaveLength(1);
  expect(plan[0]).toMatchObject({ unit: 1, status: "beat" });
  expect(plan[0]?.beats.length).toBeGreaterThan(1);
  expect(STORY.preconditions(v.work, 1)).toEqual({ ready: true, missing: [] });
  expect(STORY.preconditions(v.work, 2).ready).toBe(false);
});

test("an undecided pick a beat names keeps the story unready", () => {
  const v = vault();
  const tree = join(v.work, "bible", "characters", "family-tree.md");
  writeFileSync(tree, readFileSync(tree, "utf8").replace("Mrs. Frayne", "Mrs. Frayne [pick]"));
  const pre = STORY.preconditions(v.work, 1);
  expect(pre.ready).toBe(false);
  expect(pre.missing.join(" ")).toContain("Mrs. Frayne");
});

test("AC1: output add story, then write --output story drafts outputs/story/story.md with a fake writer", async () => {
  const v = vault();
  const added = addOutput(v.vault, v.work, "story", { now: () => new Date(2026, 9, 12) });
  expect(added).toMatchObject({ ok: true, type: "story", committed: true });
  expect(readFileSync(join(v.work, "outputs", "story", "RULES.md"), "utf8")).toBe(STORY.rulesTemplate);

  const prompts: string[] = [];
  const out = await write(v, { output: "story" }, prompts);
  expect(out.body).toMatchObject({ ok: true, branch: "draft/story" });
  expect(out.code).toBe(0);
  // Drafted on draft/story, not main, and only that path was committed.
  const files = git(v.vault, "show", "--name-only", "--format=", "draft/story");
  expect(files).toBe("novels/ice-house/outputs/story/story.md");
  const text = git(v.vault, "show", "draft/story:novels/ice-house/outputs/story/story.md");
  expect(text).toContain("story: 1");
  expect(text).toContain("status: draft");
  // AGT-2287: four beats on different dates: the frontmatter carries the range, first to last.
  expect(text).toMatch(/^story_date: .+\nstory_date_end: .+\nstatus: draft$/m);
  expect(text).toContain("The ice rang wrong under the horse.");
  expect(existsSync(join(v.work, "outputs", "story", "story.md"))).toBe(false);

  // The whole outline went to the writer as one slice, with the story's own rules and the request's length.
  const prompt = prompts.join("\n");
  expect(prompt).toContain("the whole piece");
  expect(prompt).toContain("tells 4 beats");
  // AGT-2287: the beat rows say the dates are scaffolding, not something to print.
  expect(prompt).toContain("Story date (scaffolding, never print it):");
  expect(prompt).toContain("never print a date line");
  expect(prompt).toContain("# Story rules");
  expect(prompt).toContain("about 2400 words");
});

test("length comes from the request: --words overrides the default", async () => {
  const v = vault();
  addOutput(v.vault, v.work, "story", { now: () => new Date(2026, 9, 12) });
  const prompts: string[] = [];
  await write(v, { output: "story", words: "900" }, prompts);
  expect(prompts.join("\n")).toContain("about 900 words");
});

test("a chosen act: the plan row's beats are all the story tells", async () => {
  const v = vault();
  addOutput(v.vault, v.work, "story", { now: () => new Date(2026, 9, 12) });
  const planPath = join(v.work, "outputs", "story", "plan.md");
  writeFileSync(planPath, readFileSync(planPath, "utf8").replace(/^\| 1 \|.*$/m, "| 1 | Act one | 1-2 | beat |"));
  const prompts: string[] = [];
  const out = await write(v, { output: "story" }, prompts);
  expect(out.code).toBe(0);
  const prompt = prompts.join("\n");
  expect(prompt).toContain("tells 2 beats");
  expect(prompt).not.toContain("tells 4 beats");
});

test("--dry-run shows the pack and writes nothing", async () => {
  const v = vault();
  addOutput(v.vault, v.work, "story", { now: () => new Date(2026, 9, 12) });
  const out = await write(v, { output: "story", dryRun: true });
  expect(out.code).toBe(0);
  expect(JSON.stringify(out.body)).toContain("outputRules");
  expect(git(v.vault, "branch", "--list", "draft/*")).toBe("");
});

test("write --unit 2 is refused: the story has one unit", async () => {
  const v = vault();
  addOutput(v.vault, v.work, "story", { now: () => new Date(2026, 9, 12) });
  const out = await write(v, { output: "story", unit: "2" });
  expect(out.code).toBe(2);
});

test("publish compiles the story: title, joined paragraphs, curled quotes, frontmatter dropped", () => {
  const compiled = compileStory("Ice House", '---\nstory: 1\ntitle: x\n---\n\nShe said, "Go."\nHe went.\n\nLater.\n');
  expect(compiled).toBe("# Ice House\n\nShe said, “Go.” He went.\n\nLater.\n");
});
