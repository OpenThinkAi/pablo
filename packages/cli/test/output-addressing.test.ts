/**
 * Addressing an output (AGT-1669, pm project `pablo-story-core`, S5): the
 * default-output rule on `write`/`status`/`check`/`publish`/`share`,
 * `--output`/`--unit` with `--chapter` as the novel's sugar, receipts naming
 * `output` and `unit`, `draft_unit` reaching the same code as `write`, and
 * `pablo output list|add|remove|plan`.
 *
 * `radio` is the real registry row (AGT-1686); `blog` (a later type) is not a
 * row of `OUTPUTS` yet, so these tests register a fixture type built from the
 * novel's machinery (`registerOutput`) and remove it after. Everything runs on a temp copy of
 * the synthetic fixture vault with a fake writer: no model, never `~/writing`.
 */

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent } from "@openthink/pablo-core";
import { receiptsPath } from "@openthink/pablo-core";
import { addOutput, listOutputs, planOutput, removeOutput } from "../src/output-verbs";
import { NOVEL } from "../src/outputs/novel";
import { registerOutput, resolveOutput } from "../src/outputs/registry";
import type { OutputDefinition } from "../src/outputs/types";
import { parseForUnit, VERBS } from "../src/verbs";
import type { VerbContext } from "../src/verbs";
import { runWrite } from "../src/write";
import type { WriteArgs } from "../src/write";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const STATE_HOME = mkdtempSync(join(tmpdir(), "pablo-output-addressing-state-"));

/** A fixture type on the novel's machinery with radio's directory and branches: only the base `BLOG` is built from (the real `radio` is a row of `OUTPUTS`, AGT-1686). */
const RADIO_LIKE: OutputDefinition = {
  ...NOVEL,
  id: "radio",
  noun: "episode",
  plural: "episodes",
  artifactDir: "outputs/radio/episodes",
  rulesTemplate: "# Radio rules\n",
  branch: (n) => `draft/radio-ep${String(n).padStart(2, "0")}`,
  unitOfBranch: (b) => {
    const m = /^draft\/radio-ep(\d+)(?:-v\d+)?$/.exec(b);
    return m ? Number(m[1]) : undefined;
  },
  unitOfPath: (p) => {
    const m = /(?:^|\/)outputs\/radio\/episodes\/(\d+)-[^/]*\.md$/.exec(p);
    return m ? Number(m[1]) : undefined;
  },
  // An episode needs the one before it, on top of the novel's per-beat gates.
  preconditions: (workDir, unit) => {
    const base = NOVEL.preconditions(workDir, unit);
    const dir = join(workDir, "outputs", "radio", "episodes");
    const prev = existsSync(dir) && readdirSync(dir).some((f) => Number(f.split("-")[0]) === unit - 1);
    const missing = unit > 1 && !prev ? [`episode ${unit - 1} does not exist`] : [];
    return { ready: base.ready && missing.length === 0, missing: [...base.missing, ...missing] };
  },
  // Its own units: the episodes on disk, one per core beat.
  report: (workDir, core) => {
    const dir = join(workDir, "outputs", "radio", "episodes");
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^\d{2,}-.*\.md$/.test(f)) : [];
    const units = core.beats.map((b) => {
      const file = files.find((f) => Number(f.split("-")[0]) === b.chapter);
      return { unit: b.chapter, title: b.title, status: file ? "draft" : "beat", ...(file ? { file: `outputs/radio/episodes/${file}` } : {}) };
    });
    return { noun: "episode", plural: "episodes", dir: "outputs/radio/episodes", units, drafted: files.length, total: units.length };
  },
};

/** Stands in for a later type's blog type: one directory under outputs/, its own rules. */
const BLOG: OutputDefinition = { ...RADIO_LIKE, id: "blog", noun: "blog", plural: "posts", artifactDir: "outputs/blog", rulesTemplate: "# Blog rules\n\nOne piece, all the beats.\n" };

const unregister: (() => void)[] = [];
beforeAll(() => {
  unregister.push(registerOutput(BLOG));
});
afterAll(() => {
  for (const off of unregister.splice(0)) off();
  rmSync(STATE_HOME, { recursive: true, force: true });
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8").trim();
}

const CHAPTER_TWO = `---
chapter: 2
title: Black Ice
pov: Odile
story_date: Winter 1931
status: draft
model: test
prompt_hash: abc
---

The ice rang wrong under the horse.
`;

/** The fixture vault in a temp git repository; `outputs` replaces the work's marker `format` (chapter 2 exists so chapter 3 is ready). */
function vaultWith(outputs: Record<string, unknown> | undefined): { vault: string; work: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), "pablo-output-addressing-"));
  dirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  if (outputs !== undefined) {
    const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
    delete marker["format"];
    writeFileSync(join(work, "pablo.json"), `${JSON.stringify({ ...marker, outputs }, null, 2)}\n`);
  }
  writeFileSync(join(work, "chapters", "02-black-ice.md"), CHAPTER_TWO);
  // Chapter 3's beat names Mrs. Frayne, an undecided [pick] in the fixture: decide it so chapter 3 is ready.
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

const TWO = { novel: { dir: "chapters", added: "2026-09-01" }, radio: { added: "2026-10-12" } };

function fakeWriter(): Adapter {
  return {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text",
    async *complete(): AsyncIterable<CompletionEvent> {
      yield { type: "token", text: "The route was down to nine stops. Odile drove it herself." };
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

function env(home: string): Record<string, string> {
  return { PATH: NO_THINK_PATH, XDG_STATE_HOME: STATE_HOME, PABLO_HOME: home };
}

/** `runWrite` with its printed JSON body captured. */
async function write(vault: string, work: string, home: string, args: Partial<WriteArgs>): Promise<{ code: number; body: Record<string, unknown> }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (text: unknown) => void lines.push(String(text));
  try {
    const code = await runWrite(
      { chapter: undefined, words: undefined, scenes: undefined, dryRun: false, json: true, force: false, ...args },
      vault,
      work,
      { adapter: fakeWriter(), env: env(home), stderr: { write: () => {} }, now: () => new Date("2026-10-12T12:00:00Z") },
    );
    return { code, body: JSON.parse(lines.join("\n")) as Record<string, unknown> };
  } finally {
    console.log = log;
  }
}

function verb(name: string) {
  const found = VERBS.find((v) => v.name === name);
  if (found === undefined) throw new Error(`no verb ${name}`);
  return found;
}

function ctx(vault: string, home: string): VerbContext {
  return { cwd: vault, env: { ...env(home), PABLO_VAULT: vault }, stderr: { write: () => {} }, writer: fakeWriter() };
}

// --- the default-output rule ------------------------------------------------

test("resolveOutput: one output is implied, several refuse naming them, an unknown or undeclared type is refused by name", () => {
  expect(resolveOutput({ novel: { added: "2026-09-01" } }, undefined, "write")).toMatchObject({ ok: true, output: { id: "novel" } });
  expect(resolveOutput({}, undefined, "write")).toMatchObject({ ok: true, output: { id: "novel" } });
  expect(resolveOutput(TWO, undefined, "write")).toMatchObject({ ok: false, code: 2, missing: ["--output: novel | radio"] });
  expect(resolveOutput(TWO, "radio", "write")).toMatchObject({ ok: true, output: { id: "radio" } });
  const unknown = resolveOutput(TWO, "podcast", "write");
  expect(unknown.ok).toBe(false);
  if (!unknown.ok) expect(unknown.message).toContain('unknown output type "podcast"');
  const undeclared = resolveOutput({ novel: { added: "2026-09-01" } }, "radio", "write");
  expect(undeclared.ok).toBe(false);
  if (!undeclared.ok) expect(undeclared.message).toContain("pablo output add radio");
});

test("parseForUnit reads <output> N, the novel's chapter spellings and a bare N", () => {
  expect(parseForUnit("radio 3")).toEqual({ output: "radio", unit: 3 });
  expect(parseForUnit("novel-4")).toEqual({ output: "novel", unit: 4 });
  expect(parseForUnit("chapter 2")).toEqual({ output: "novel", unit: 2 });
  expect(parseForUnit("ch 2")).toEqual({ output: "novel", unit: 2 });
  expect(parseForUnit("5")).toEqual({ output: undefined, unit: 5 });
  expect(parseForUnit("bogus")).toBeUndefined();
});

// --- AC1: write on a two-output work ----------------------------------------

test("AC1: write --unit 3 on a two-output work refuses naming the outputs; nothing is drafted", async () => {
  const { vault, work, home } = vaultWith(TWO);
  const out = await write(vault, work, home, { unit: "3" });
  expect(out.code).toBe(2);
  expect(out.body).toMatchObject({ ok: false, code: 2, missing: ["--output: novel | radio"] });
  expect(git(vault, "branch", "--list", "draft/*")).toBe("");
});

test("AC1: write --output novel --unit 3 drafts chapter 3 on draft/ch03, and the receipt names output and unit", async () => {
  const { vault, work, home } = vaultWith(TWO);
  const out = await write(vault, work, home, { output: "novel", unit: "3" });
  expect(out.code).toBe(0);
  expect(out.body).toMatchObject({ ok: true, branch: "draft/ch03", path: "chapters/03-the-route.md" });
  expect(out.body["receipt"]).toMatchObject({ output: "novel", unit: 3 });
  expect(git(vault, "log", "-1", "--format=%s", "draft/ch03")).toBe("ice-house: draft chapter 3");
  expect(git(vault, "show", "draft/ch03:novels/ice-house/chapters/03-the-route.md")).toContain("chapter: 3");

  // AC3: the receipts.jsonl line carries them too.
  const lines = readFileSync(receiptsPath(work), "utf8").trim().split("\n");
  expect(JSON.parse(lines[lines.length - 1] as string)).toMatchObject({ intent: "draft", output: "novel", unit: 3 });
});

test("AC1: --chapter 3 is the same draft on the same branch", async () => {
  const { vault, work, home } = vaultWith(TWO);
  const out = await write(vault, work, home, { chapter: "3" });
  expect(out.code).toBe(0);
  expect(out.body).toMatchObject({ ok: true, branch: "draft/ch03", path: "chapters/03-the-route.md", receipt: { output: "novel", unit: 3 } });
});

test("--chapter never addresses another output, and --chapter and --unit must agree", async () => {
  const { vault, work, home } = vaultWith(TWO);
  const radio = await write(vault, work, home, { chapter: "3", output: "radio" });
  expect(radio.code).toBe(2);
  expect(String(radio.body["message"])).toContain("--chapter is the novel's spelling");
  const both = await write(vault, work, home, { chapter: "3", unit: "4" });
  expect(both.code).toBe(2);
  expect(String(both.body["message"])).toContain("--chapter and --unit");
});

test("write --output radio drafts into the radio output's directory on its own branch", async () => {
  const { vault, work, home } = vaultWith(TWO);
  mkdirSync(join(work, "outputs", "radio", "episodes"), { recursive: true });
  writeFileSync(join(work, "outputs", "radio", "episodes", "01-the-last-full-cut.md"), CHAPTER_TWO.replace("chapter: 2", "episode: 1"));
  writeFileSync(join(work, "outputs", "radio", "episodes", "02-black-ice.md"), CHAPTER_TWO.replace("chapter: 2", "episode: 2"));
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "episodes");
  const out = await write(vault, work, home, { output: "radio", unit: "3" });
  expect(out.body).toMatchObject({ ok: true, branch: "draft/radio-ep03", path: "outputs/radio/episodes/03-the-route.md", receipt: { output: "radio", unit: 3 } });
  expect(git(vault, "show", "draft/radio-ep03:novels/ice-house/outputs/radio/episodes/03-the-route.md")).toContain("episode: 3");
});

test("a one-output work needs no --output: write --unit 3 drafts the novel's chapter 3", async () => {
  const { vault, work, home } = vaultWith(undefined);
  const out = await write(vault, work, home, { unit: "3" });
  expect(out.body).toMatchObject({ ok: true, branch: "draft/ch03" });
});

// --- AC3: the write verb, MCP and draft_unit --------------------------------

test("AC3: the write verb's schema (and so its MCP tool) takes output and unit; draft_unit takes output, n and direction", () => {
  expect(Object.keys(verb("write").args.shape)).toEqual(expect.arrayContaining(["output", "unit", "chapter"]));
  const draftUnit = verb("draft_unit").args;
  expect(Object.keys(draftUnit.shape)).toEqual(expect.arrayContaining(["project", "output", "n", "direction"]));
  expect(draftUnit.safeParse({ project: "ice-house", n: 3 }).success).toBe(false);
  expect(draftUnit.safeParse({ project: "ice-house", output: "novel", n: 3 }).success).toBe(true);
  expect(VERBS.some((v) => v.name === "draft_chapter")).toBe(true);
});

test("AC3: draft_unit reaches the same code as write: same refusal, same branch, receipt naming output and unit, no prose", async () => {
  const { vault, home } = vaultWith(TWO);
  const refusedWrite = await verb("write").run({ project: "ice-house", unit: 3 }, ctx(vault, home));
  expect(refusedWrite.body).toMatchObject({ ok: false, missing: ["--output: novel | radio"] });

  const unknown = await verb("draft_unit").run({ project: "ice-house", output: "podcast", n: 3 }, ctx(vault, home));
  expect(unknown.exitCode).toBe(2);
  expect(String((unknown.body as { message: string }).message)).toContain('unknown output type "podcast"');

  const drafted = await verb("draft_unit").run({ project: "ice-house", output: "novel", n: 3, direction: "stay on Odile" }, ctx(vault, home));
  expect(drafted.exitCode).toBe(0);
  expect(drafted.body).toMatchObject({ ok: true, branch: "draft/ch03", path: "chapters/03-the-route.md", receipt: { output: "novel", unit: 3 } });
  expect(JSON.stringify(drafted.body)).not.toContain("nine stops");
  expect(git(vault, "show", "draft/ch03:novels/ice-house/chapters/03-the-route.md")).toContain("direction: stay on Odile");
});

// --- status, check, publish, share ------------------------------------------

test("status --for <type> N addresses one output; a bare N on a two-output work refuses naming them", async () => {
  const { vault, home } = vaultWith(TWO);
  const novel = await verb("status").run({ project: "ice-house", for: "novel 3" }, ctx(vault, home));
  expect(novel).toMatchObject({ exitCode: 0, body: { ready: true, missing: [] } });
  const radio = await verb("status").run({ project: "ice-house", for: "radio 3" }, ctx(vault, home));
  expect(radio.exitCode).toBe(2);
  expect((radio.body as { missing: string[] }).missing.length).toBeGreaterThan(0);
  const bare = await verb("status").run({ project: "ice-house", for: "3" }, ctx(vault, home));
  expect(bare).toMatchObject({ exitCode: 2, body: { ok: false, missing: ["--output: novel | radio"] } });
  const chapter = await verb("status").run({ project: "ice-house", for: "chapter 3" }, ctx(vault, home));
  expect(chapter).toMatchObject({ exitCode: 0, body: { ready: true } });
});

test("check --output scans that output's units; with several outputs and none named it refuses", async () => {
  const { vault, home } = vaultWith(TWO);
  const refused = await verb("check").run({ project: "ice-house" }, ctx(vault, home));
  expect(refused).toMatchObject({ exitCode: 2, body: { ok: false, missing: ["--output: novel | radio"] } });
  const novel = await verb("check").run({ project: "ice-house", output: "novel" }, ctx(vault, home));
  expect(novel.exitCode).toBe(0);
  const file = await verb("check").run({ project: "ice-house", file: "chapters/02-black-ice.md" }, ctx(vault, home));
  expect(file.exitCode).toBe(0);
});

test("publish --output publishes that output; with several and none named it refuses", async () => {
  const { vault, home } = vaultWith(TWO);
  const refused = await verb("publish").run({ project: "ice-house", target: "draft" }, ctx(vault, home));
  expect(refused).toMatchObject({ exitCode: 2, body: { ok: false, missing: ["--output: novel | radio"] } });
  const novel = await verb("publish").run({ project: "ice-house", target: "draft", output: "novel" }, ctx(vault, home));
  expect(novel).toMatchObject({ exitCode: 0, body: { ok: true, output: "novel", target: "draft", chapters: 2 } });
});

// --- AC2: pablo output add|remove|list|plan ----------------------------------

test("AC2: output add blog scaffolds outputs/blog/ with plan.md and RULES.md, updates the marker and commits", () => {
  const { vault, work } = vaultWith({ novel: { dir: "chapters", added: "2026-09-01" } });
  const before = git(vault, "rev-parse", "HEAD");
  const added = addOutput(vault, work, "blog", { now: () => new Date(2026, 9, 12) });
  expect(added).toMatchObject({ ok: true, action: "add", type: "blog", committed: true, paths: ["outputs/blog/RULES.md", "outputs/blog/plan.md", "pablo.json"] });
  expect(readFileSync(join(work, "outputs", "blog", "RULES.md"), "utf8")).toBe(BLOG.rulesTemplate);
  const plan = readFileSync(join(work, "outputs", "blog", "plan.md"), "utf8");
  expect(plan).toContain("# Plan: blog");
  expect(plan).toContain("| 3 | The Route | 3 | beat |");
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as { title: string; outputs: Record<string, unknown> };
  expect(marker.outputs).toEqual({ novel: { dir: "chapters", added: "2026-09-01" }, blog: { added: "2026-10-12" } });
  expect(marker.title).toBe("The Ice House");
  expect(git(vault, "rev-parse", "HEAD~1")).toBe(before);
  expect(git(vault, "log", "-1", "--format=%s")).toBe("ice-house: add the blog output");
  expect(git(vault, "status", "--porcelain")).toBe("");

  const again = addOutput(vault, work, "blog");
  expect(again).toMatchObject({ ok: false, code: 2 });
});

test("AC2: output remove blog archives outputs/blog/ under outputs/_removed/ and updates the marker", () => {
  const { vault, work } = vaultWith({ novel: { dir: "chapters", added: "2026-09-01" } });
  const now = () => new Date(2026, 9, 12);
  addOutput(vault, work, "blog", { now });
  const removed = removeOutput(vault, work, "blog", { now });
  expect(removed).toMatchObject({ ok: true, action: "remove", type: "blog", committed: true, archived: "outputs/_removed/blog-2026-10-12" });
  expect(existsSync(join(work, "outputs", "blog"))).toBe(false);
  expect(readFileSync(join(work, "outputs", "_removed", "blog-2026-10-12", "RULES.md"), "utf8")).toBe(BLOG.rulesTemplate);
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as { outputs: Record<string, unknown> };
  expect(Object.keys(marker.outputs)).toEqual(["novel"]);
  expect(git(vault, "log", "-1", "--format=%s")).toBe("ice-house: remove the blog output");
  expect(git(vault, "status", "--porcelain")).toBe("");

  // Removing it again is refused; a second add and remove on the same day archives beside the first.
  expect(removeOutput(vault, work, "blog", { now })).toMatchObject({ ok: false, code: 2 });
  addOutput(vault, work, "blog", { now });
  expect(removeOutput(vault, work, "blog", { now })).toMatchObject({ ok: true, archived: "outputs/_removed/blog-2026-10-12-2" });
});

test("AC2: add and remove refuse an unknown type by name, changing nothing", () => {
  const { vault, work } = vaultWith({ novel: { dir: "chapters", added: "2026-09-01" } });
  const head = git(vault, "rev-parse", "HEAD");
  for (const result of [addOutput(vault, work, "podcast"), removeOutput(vault, work, "podcast")]) {
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(2);
      expect(result.message).toContain('unknown output type "podcast"');
      expect(result.message).toContain("novel");
    }
  }
  expect(git(vault, "rev-parse", "HEAD")).toBe(head);
  expect(git(vault, "status", "--porcelain")).toBe("");
});

test("output add refuses while the story core is not at beats, naming what is short", () => {
  const { vault, work } = vaultWith({ novel: { dir: "chapters", added: "2026-09-01" } });
  const outline = join(work, "outline", "chapters.md");
  writeFileSync(outline, readFileSync(outline, "utf8").split("\n").filter((l) => !/^\| \d+ \|/.test(l)).join("\n"));
  git(vault, "commit", "-q", "-am", "no beats");
  const refused = addOutput(vault, work, "blog");
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.message).toContain("not at beats");
    expect(refused.missing?.some((m) => m.startsWith("core beats:"))).toBe(true);
  }
  expect(existsSync(join(work, "outputs", "blog"))).toBe(false);
});

test("output add refuses a type the work's track does not allow, naming the allowed types (AGT-2105)", () => {
  const { vault, work } = vaultWith({ novel: { dir: "chapters", added: "2026-09-01" } });
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(work, "pablo.json"), `${JSON.stringify({ ...marker, track: "nonfiction" }, null, 2)}\n`);
  git(vault, "commit", "-q", "-am", "nonfiction");
  const refused = addOutput(vault, work, "radio");
  expect(refused.ok).toBe(false);
  if (!refused.ok) {
    expect(refused.message).toContain("not allowed on the nonfiction track");
    expect(refused.message).toContain("allowed: none");
  }
  expect(existsSync(join(work, "outputs", "radio"))).toBe(false);
  // A fiction work (no track) still adds it.
  const ok = vaultWith({ novel: { dir: "chapters", added: "2026-09-01" } });
  expect(addOutput(ok.vault, ok.work, "radio").ok).toBe(true);
});

test("output add refuses a marker still on the deprecated format key, pointing at migrate outputs", () => {
  const { vault, work } = vaultWith(undefined);
  const refused = addOutput(vault, work, "blog");
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.message).toContain("pablo migrate outputs");
});

test("output list reports each declared output and the types not yet derived; plan rewrites plan.md", () => {
  const { vault, work } = vaultWith(TWO);
  const listed = listOutputs(work);
  expect(listed.ok).toBe(true);
  if (listed.ok) {
    expect(listed.outputs.map((o) => [o.type, o.drafted, o.total])).toEqual([
      ["novel", 2, 4],
      ["radio", 0, 4],
    ]);
    expect(listed.available).toEqual(["story", "blog"]);
  }
  const dry = planOutput(vault, work, "radio", { dryRun: true });
  expect(dry).toMatchObject({ ok: true, dryRun: true, changed: true, committed: false, path: "outputs/radio/plan.md" });
  expect(existsSync(join(work, "outputs", "radio", "plan.md"))).toBe(false);
  const planned = planOutput(vault, work, "radio");
  expect(planned).toMatchObject({ ok: true, changed: true, committed: true });
  expect(planOutput(vault, work, "radio")).toMatchObject({ ok: true, changed: false, committed: false });
  expect(planOutput(vault, work, "blog")).toMatchObject({ ok: false, code: 2 });
});

test("the output verb runs list/add/remove/plan off its VERBS entry", async () => {
  const { vault, home } = vaultWith({ novel: { dir: "chapters", added: "2026-09-01" } });
  const added = await verb("output").run({ sub: "add", type: "blog", project: "ice-house", "dry-run": false }, ctx(vault, home));
  expect(added).toMatchObject({ exitCode: 0, body: { ok: true, type: "blog" } });
  const listed = await verb("output").run({ sub: "list", project: "ice-house", "dry-run": false }, ctx(vault, home));
  expect((listed.body as { outputs: { type: string }[] }).outputs.map((o) => o.type)).toEqual(["novel", "blog"]);
  const unknown = await verb("output").run({ sub: "remove", type: "podcast", project: "ice-house", "dry-run": false }, ctx(vault, home));
  expect(unknown.exitCode).toBe(2);
});
