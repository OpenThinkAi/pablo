/**
 * `pablo pronounce --suggest` (AGT-2303): model-proposed respellings for what `pronounce` flagged. The Python side is a
 * fake runner that returns canned `pronounce` JSON, and the planner is a fake adapter; nothing runs uv, Python or a
 * model. Which tokens are flagged, and that the lexicon's entries are never among them, is tested in
 * `packages/casting/tests/test_spoken.py`.
 *
 * Everything runs on a temp git copy of the synthetic fixture vault; never `~/writing`.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import type { Adapter, CompletionEvent, CompletionRequest } from "@openthink/pablo-core";
import { venvPython } from "../src/casting";
import type { CastingDeps } from "../src/casting";
import { castingVerbs } from "../src/casting-verbs";
import { castingText } from "../src/cli";
import { appendSuggestions, parseSuggestions, suggestItems, suggestPrompt } from "../src/pronounce-suggest";
import type { Verb, VerbContext } from "../src/verbs";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sh(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

/** What `pronounce` finds on the invented essay: two names, one abbreviation, a link, and `read` twice. */
const PRONOUNCED = {
  ok: true,
  output: "narrated",
  acronyms: false,
  lexicon: "outputs/narrated/pronounce.md",
  lexiconEntries: 1,
  changedLines: 0,
  units: [],
  unresolved: [
    { token: "Acemoglu", kind: "capitalised", count: 2, first: { unit: 1, line: 3 }, speaker: "NARRATOR", sentence: "The economist Daron Acemoglu disagrees." },
    { token: "Gov.", kind: "abbreviation", count: 1, first: { unit: 1, line: 5 }, speaker: "NARRATOR", sentence: "Gov. Hale agreed." },
    { token: "https://example.test/a", kind: "link", count: 1, first: { unit: 1, line: 6 }, speaker: "NARRATOR", sentence: "See https://example.test/a for more." },
  ],
  heteronyms: [
    { word: "read", unit: 1, line: 4, speaker: "NARRATOR", sentence: "She read the report last night." },
    { word: "lead", unit: 1, line: 7, speaker: "Dr. Hale", sentence: "The pipes were lead." },
  ],
};

interface Setup {
  vault: string;
  work: string;
  machine: CastingDeps;
  ctx: (planner?: Adapter) => VerbContext;
  verb: Verb;
  runs: string[][];
}

function setup(pronounced: unknown = PRONOUNCED, lexicon?: string): Setup {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pablo-suggest-")));
  dirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  delete marker["format"];
  writeFileSync(join(work, "pablo.json"), `${JSON.stringify({ ...marker, outputs: { novel: { dir: "chapters", added: "2026-09-01" }, narrated: { added: "2026-10-26", from: "novel" } } }, null, 2)}\n`);
  if (lexicon !== undefined) {
    mkdirSync(join(work, "outputs", "narrated"), { recursive: true });
    writeFileSync(join(work, "outputs", "narrated", "pronounce.md"), lexicon);
  }
  execFileSync("git", ["init", "-q", "-b", "main", vault]);
  sh(vault, "config", "user.name", "Test");
  sh(vault, "config", "user.email", "t@t.example");
  sh(vault, "add", "-A");
  sh(vault, "commit", "-qm", "base");

  const source = join(dir, "casting");
  mkdirSync(source);
  writeFileSync(join(source, "pyproject.toml"), '[project]\nname = "pablo-casting"\n');
  writeFileSync(join(source, "uv.lock"), "version = 1\n");
  const venv = join(source, ".venv");
  const layout = { source, venv, install: "checkout" as const };
  mkdirSync(join(venv, "bin"), { recursive: true });
  writeFileSync(venvPython(layout), "");
  const lock = createHash("sha256").update(readFileSync(join(source, "uv.lock"))).digest("hex");
  writeFileSync(join(venv, ".pablo-provisioned.json"), JSON.stringify({ lock, at: "2026-11-01T00:00:00Z", extras: [] }));
  const runs: string[][] = [];
  const machine: CastingDeps = {
    layout,
    which: () => "/fake/bin/uv",
    run: (argv) => {
      runs.push(argv.slice(3));
      return { code: 0, stdout: JSON.stringify(pronounced), stderr: "" };
    },
    now: () => new Date("2026-11-01T12:00:00Z"),
  };
  const found = castingVerbs(() => machine).find((v) => v.name === "pronounce");
  if (found === undefined) throw new Error("no pronounce verb");
  const env = { PATH: "/nowhere", PABLO_VAULT: vault, PABLO_HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "no-config") };
  return { vault, work, machine, verb: found, runs, ctx: (planner) => ({ cwd: vault, env, stderr: { write: () => undefined }, casting: machine, ...(planner ? { planner } : {}) }) };
}

/** A planner that records its prompts and answers with `answer`. Never a model. */
function fakePlanner(answer: unknown): Adapter & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: "fake-plan",
    model: "fake-plan-model",
    preferredOutput: "text",
    prompts,
    async *complete(request: CompletionRequest): AsyncIterable<CompletionEvent> {
      prompts.push(request.prompt);
      yield { type: "token", text: typeof answer === "string" ? answer : JSON.stringify(answer) };
      yield { type: "done", stats: { timeToFirstTokenMs: 1, elapsedMs: 1, tokensRead: 1, tokensWritten: 1, tokensPerSecond: 1 } };
    },
    async proposeEdit(): Promise<never> {
      throw new Error("not used");
    },
    async extractFacts(): Promise<never> {
      throw new Error("not used");
    },
  };
}

const ANSWER = {
  suggestions: [
    { id: 1, word: "Acemoglu", respelling: "ah-SEM-oh-glue", reason: "Turkish-Armenian name, stress on the second syllable" },
    { id: 2, word: "Gov.", respelling: "GUV-ner", reason: "the title said in full" },
    { id: 3, word: "read", respelling: "red", reason: "past tense here" },
  ],
};

test("the items are every flagged token and heteronym but links, numbered, with speaker and sentence", () => {
  const items = suggestItems(PRONOUNCED);
  expect(items.map((i) => [i.id, i.word, i.kind])).toEqual([
    [1, "Acemoglu", "capitalised"],
    [2, "Gov", "abbreviation"],
    [3, "read", "heteronym"],
    [4, "lead", "heteronym"],
  ]);
  const prompt = suggestPrompt(items);
  expect(prompt).toContain("The economist Daron Acemoglu disagrees.");
  expect(prompt).toContain("She read the report last night.");
  expect(prompt).not.toContain("example.test");
});

test("--suggest sends the flagged tokens to the planner and lands the proposals on a plan/ branch, never on main", async () => {
  const s = setup();
  const planner = fakePlanner({ suggestions: [{ id: 1, word: "Acemoglu", respelling: "ah-SEM-oh-glue", reason: "stress on the second syllable" }, { id: 3, word: "read", respelling: "red", reason: "past tense here" }] });
  const r = await s.verb.run({ project: "ice-house", output: "narrated", unit: 1, suggest: true } as never, s.ctx(planner));
  expect(r.exitCode).toBe(0);
  const body = r.body as { branch: string; path: string; sent: number; suggestions: Array<{ word: string; speaker?: string }>; provider: string };
  expect(body.sent).toBe(4);
  expect(planner.prompts).toHaveLength(1);
  expect(planner.prompts[0]).toContain("Gov.");
  expect(body.branch).toMatch(/^plan\//);
  expect(body.path).toBe("novels/ice-house/outputs/narrated/pronounce.md");
  const text = sh(s.vault, "show", `${body.branch}:${body.path}`);
  expect(text).toContain("Acemoglu -> ah-SEM-oh-glue");
  expect(text).toContain("NARRATOR: read -> red"); // a heteronym is scoped to the line's speaker
  expect(text).toContain("hear each before keeping it");
  expect(text).toContain("# unit 1 line 3: stress on the second syllable");
  expect(body.suggestions.find((x) => x.word === "Acemoglu")?.speaker).toBeUndefined();
  // Never applied: main has no lexicon, and the work tree is untouched.
  expect(existsSync(join(s.work, "outputs", "narrated", "pronounce.md"))).toBe(false);
  expect(sh(s.vault, "log", "main", "--format=%s").trim()).toBe("base");
  expect(s.runs.at(-1)).toContain("pronounce");
});

test("--suggest appends to an existing lexicon and keeps its entries", async () => {
  const s = setup(PRONOUNCED, "Zinfandel -> zin-fan-DELL\n");
  const r = await s.verb.run({ project: "ice-house", output: "narrated", suggest: true } as never, s.ctx(fakePlanner(ANSWER)));
  const body = r.body as { branch: string; path: string };
  const text = sh(s.vault, "show", `${body.branch}:${body.path}`);
  expect(text.startsWith("Zinfandel -> zin-fan-DELL\n")).toBe(true);
  expect(text).toContain("Gov -> GUV-ner");
});

test("--suggest refuses with no model configured, before it runs anything or writes a branch", async () => {
  const s = setup();
  const r = await s.verb.run({ project: "ice-house", output: "narrated", suggest: true } as never, s.ctx());
  expect(r.exitCode).toBe(2);
  expect((r.body as { message: string }).message).toContain("no model");
  expect(s.runs).toHaveLength(0);
  expect(sh(s.vault, "branch", "--list", "plan/*").trim()).toBe("");
});

test("--suggest sends nothing when nothing is flagged", async () => {
  const s = setup({ ...PRONOUNCED, unresolved: [], heteronyms: [] });
  const planner = fakePlanner(ANSWER);
  const r = await s.verb.run({ project: "ice-house", output: "narrated", suggest: true } as never, s.ctx(planner));
  expect(r.exitCode).toBe(0);
  expect((r.body as { sent: number }).sent).toBe(0);
  expect(planner.prompts).toHaveLength(0);
  expect(sh(s.vault, "branch", "--list", "plan/*").trim()).toBe("");
});

test("without --suggest the verb loads no model and writes nothing", async () => {
  const s = setup();
  const planner = fakePlanner(ANSWER);
  const r = await s.verb.run({ project: "ice-house", output: "narrated", suggest: false } as never, s.ctx(planner));
  expect(r.exitCode).toBe(0);
  expect(planner.prompts).toHaveLength(0);
  expect(sh(s.vault, "branch", "--list", "plan/*").trim()).toBe("");
});

test("a reply that is not the JSON asked for is an error and writes nothing", async () => {
  const s = setup();
  const r = await s.verb.run({ project: "ice-house", output: "narrated", suggest: true } as never, s.ctx(fakePlanner("I would say ah-SEM-oh-glue.")));
  expect(r.exitCode).toBe(1);
  expect(sh(s.vault, "branch", "--list", "plan/*").trim()).toBe("");
});

test("pablo checks every proposal: unknown ids, a different word, an empty or arrowed respelling, duplicates and unscopable heteronyms are dropped", () => {
  const items = suggestItems(PRONOUNCED);
  const { suggestions, rejected } = parseSuggestions(
    JSON.stringify({
      suggestions: [
        { id: 1, word: "Acemoglu", respelling: "ah-SEM-oh-glue", reason: "ok" },
        { id: 1, word: "Acemoglu", respelling: "ASS-eh-moglu", reason: "second try" },
        { id: 99, word: "Nobody", respelling: "no-BOD-ee", reason: "never sent" },
        { id: 2, word: "Hale", respelling: "hayl", reason: "wrong word for the id" },
        { id: 3, word: "read", respelling: "read", reason: "same as the word" },
        { id: 3, word: "read", respelling: "a -> b", reason: "arrow" },
        { id: 4, word: "lead", respelling: "led", reason: "the metal" },
      ],
    }),
    items,
  );
  expect(suggestions.map((s) => s.word)).toEqual(["Acemoglu"]);
  expect(rejected.map((r) => r.word).sort()).toEqual(["Nobody", "Hale", "lead", "read", "read"].sort());
});

test("appended entries are in the lexicon's own form and keep a comment on where each came from", () => {
  const text = appendSuggestions(
    "Zinfandel -> zin-fan-DELL",
    [
      { word: "Acemoglu", respelling: "ah-SEM-oh-glue", reason: "stress on the second", unit: 1, line: 3, kind: "capitalised" },
      { word: "read", respelling: "red", speaker: "NARRATOR", reason: "past tense", unit: 2, line: 9, kind: "heteronym" },
    ],
    { date: "2026-11-14", model: "fake/m" },
  );
  expect(text).toBe(
    [
      "Zinfandel -> zin-fan-DELL",
      "",
      "# Suggested by pablo pronounce --suggest, 2026-11-14 (fake/m). Proposals, not decisions: hear each before keeping it, and delete any that sounds worse.",
      "# unit 1 line 3: stress on the second",
      "Acemoglu -> ah-SEM-oh-glue",
      "# unit 2 line 9: past tense (a heteronym: scoped to this speaker, so it applies to all their lines)",
      "NARRATOR: read -> red",
      "",
    ].join("\n"),
  );
});

test("the plain text lists each proposal, what was dropped and where it was written", () => {
  const text = castingText("pronounce", {
    ok: true,
    output: "narrated",
    sent: 4,
    provider: "fake-plan",
    branch: "plan/2026-11-14-abc",
    path: "novels/x/outputs/narrated/pronounce.md",
    suggestions: [{ word: "read", respelling: "red", speaker: "NARRATOR", reason: "past", unit: 1, line: 4 }],
    rejected: [{ word: "lead", reason: "same as the word" }],
  });
  expect(text).toContain("NARRATOR: read -> red");
  expect(text).toContain("dropped lead");
  expect(text).toContain("nothing is applied");
  expect(text).toContain("pablo merge plan/2026-11-14-abc");
});
