/**
 * The `fact-accuracy` check (AGT-2112, pm project `pablo-platform`, D-10): `check --output <type> [--unit N]` holds a
 * historical-fiction unit's sentences to the work's distilled period facts on the `check` intent. The model is always
 * a fake `Ask` reading the prompt it is given; no test reaches a provider.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWork, runCheck, screenChecks, withFactAccuracy } from "../src/check";
import type { CheckSuccess } from "../src/check";
import type { Ask } from "../src/critique";
import { checkFactAccuracy, draftSentences, factAccuracyModel, factHitsPath, parseContradictions, savedFactHits } from "../src/fact-accuracy";
import { VERBS } from "../src/verbs";
import { anachronismModel } from "../src/anachronism";

const FIXTURE = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const UNIT = "chapters/01-the-last-full-cut.md";

const roots: string[] = [];
// The anachronism check (AGT-2113) runs beside fact accuracy on these works: its seam fails fast, so no test reaches a model.
beforeEach(() => {
  anachronismModel.ask = async () => {
    throw new Error("no model in tests");
  };
});
afterEach(() => {
  delete anachronismModel.ask;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete factAccuracyModel.ask;
});

/** A temp copy of the fixture vault whose ice-house work is historical fiction with these `facts/period.md` rows. */
function work(rows: readonly string[], track = "historical-fiction"): { vault: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "pablo-fact-accuracy-"));
  roots.push(root);
  const vault = join(root, "vault");
  cpSync(FIXTURE, vault, { recursive: true });
  const dir = join(vault, "novels", "ice-house");
  const marker = join(dir, "pablo.json");
  const { format: _format, ...rest } = JSON.parse(readFileSync(marker, "utf8")) as Record<string, unknown>;
  writeFileSync(marker, JSON.stringify({ ...rest, track, outputs: { novel: { dir: "chapters", added: "2026-10-10" } } }));
  mkdirSync(join(dir, "facts"), { recursive: true });
  writeFileSync(join(dir, "facts", "period.md"), ["| Fact | Source | Story date |", "|---|---|---|", ...rows, ""].join("\n"));
  return { vault, dir };
}

/** A fake model: reports each `[sentence substring, fact substring, why]` it finds among the prompt's S/F lines. */
function fakeAsk(pairs: ReadonlyArray<readonly [string, string, string]>): Ask & { prompts: string[] } {
  const prompts: string[] = [];
  const ask = (async (prompt: string) => {
    prompts.push(prompt);
    const numbered = (tag: string) => [...prompt.matchAll(new RegExp(`^${tag}(\\d+)\\. (.*)$`, "gm"))].map((m) => ({ n: Number(m[1]), text: m[2] as string }));
    const sentences = numbered("S");
    const facts = numbered("F");
    const contradictions = pairs.flatMap(([s, f, why]) => {
      const sentence = sentences.find((x) => x.text.includes(s));
      const fact = facts.find((x) => x.text.includes(f));
      return sentence && fact ? [{ sentence: sentence.n, fact: fact.n, why }] : [];
    });
    return `\`\`\`json\n${JSON.stringify({ contradictions })}\n\`\`\``;
  }) as Ask & { prompts: string[] };
  ask.prompts = prompts;
  return ask;
}

const SCALE_FACT = "| Ice cakes on the river were cut thirty inches square | ice-harvest | 1928 |";
const AGREE_FACT = "| Harvest crews marked the ice grid with a horse-drawn plow | ice-harvest | |";
const LATER_FACT = "| Mechanical refrigeration closed the river ice houses | refrigeration | 1934 |";

function scan(dir: string, vault: string, unit?: number): CheckSuccess {
  const outcome = checkWork(vault, dir, undefined, "novel", unit);
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome;
}

test("a contradiction: the hit quotes the draft sentence, the contradicted fact and its source", async () => {
  const { vault, dir } = work([SCALE_FACT, AGREE_FACT]);
  const ask = fakeAsk([["Twenty-two inch squares", "thirty inches square", "the cakes were thirty inches, not twenty-two"]]);
  const { outcome, factAccuracy } = await withFactAccuracy(scan(dir, vault), dir, "novel", () => ask);

  const hits = outcome.hits.filter((h) => h.rule === "fact-accuracy");
  expect(hits).toHaveLength(1);
  const hit = hits[0] as unknown as Record<string, unknown>;
  expect(hit["path"]).toBe(UNIT);
  expect(hit["excerpt"]).toBe("Twenty-two inch squares, the lines scored");
  expect(hit["fact"]).toBe("Ice cakes on the river were cut thirty inches square");
  expect(hit["source"]).toBe("research/ice-harvest.md");
  expect(hit["detail"]).toBe('contradicts "Ice cakes on the river were cut thirty inches square" (research/ice-harvest.md): the cakes were thirty inches, not twenty-two');
  // The line is the sentence's line in the file.
  const lines = readFileSync(join(dir, UNIT), "utf8").split("\n");
  expect(lines[(hit["line"] as number) - 1]).toContain("Twenty-two inch squares");
  expect(factAccuracy).toEqual({ checked: 1 });
  // The prompt carries the facts and the sentences as fenced data, never the research notes.
  expect(ask.prompts).toHaveLength(1);
  expect(ask.prompts[0]).toContain("<story_data");
  expect(ask.prompts[0]).toContain("F1. Ice cakes on the river were cut thirty inches square (from 1928)");
});

test("an agreement: the model is asked and reports nothing, so there is no hit", async () => {
  const { vault, dir } = work([AGREE_FACT]);
  const ask = fakeAsk([]);
  const { outcome, factAccuracy } = await withFactAccuracy(scan(dir, vault), dir, "novel", () => ask);
  expect(outcome.hits.filter((h) => h.rule === "fact-accuracy")).toEqual([]);
  expect(ask.prompts).toHaveLength(1);
  expect(factAccuracy).toEqual({ checked: 1 });
});

test("a unit with no relevant facts (every row dated after it) is never sent to the model", async () => {
  const { vault, dir } = work([LATER_FACT]);
  let built = 0;
  const ask = fakeAsk([["Twenty-two", "refrigeration", "x"]]);
  const { outcome, factAccuracy } = await withFactAccuracy(scan(dir, vault), dir, "novel", () => {
    built++;
    return ask;
  });
  expect(outcome.hits.filter((h) => h.rule === "fact-accuracy")).toEqual([]);
  expect(ask.prompts).toEqual([]);
  expect(built).toBe(0);
  expect(factAccuracy).toEqual({ checked: 0 });
});

test("only historical fiction is checked, and only with facts/period.md", async () => {
  const fiction = work([SCALE_FACT], "fiction");
  const ask = fakeAsk([["Twenty-two", "thirty", "x"]]);
  expect((await withFactAccuracy(scan(fiction.dir, fiction.vault), fiction.dir, "novel", () => ask)).factAccuracy).toBeUndefined();
  const bare = work([]);
  rmSync(join(bare.dir, "facts"), { recursive: true });
  expect((await withFactAccuracy(scan(bare.dir, bare.vault), bare.dir, "novel", () => ask)).factAccuracy).toBeUndefined();
  // Without --output the check is the plain scan.
  const named = work([SCALE_FACT]);
  expect((await withFactAccuracy(scan(named.dir, named.vault), named.dir, undefined, () => ask)).factAccuracy).toBeUndefined();
  expect(ask.prompts).toEqual([]);
});

test("a model that cannot be built or fails is a notice, never a failed check", async () => {
  const { vault, dir } = work([SCALE_FACT]);
  const none = await withFactAccuracy(scan(dir, vault), dir, "novel", () => "no provider is configured");
  expect(none.factAccuracy).toEqual({ checked: 0, notice: "fact-accuracy not run: no provider is configured" });
  const failing: Ask = async () => {
    throw new Error("endpoint down");
  };
  const failed = await withFactAccuracy(scan(dir, vault), dir, "novel", () => failing);
  expect(failed.factAccuracy?.notice).toBe(`fact-accuracy stopped at ${UNIT}: endpoint down`);
  const garbled: Ask = async () => "I could not decide.";
  const unread = await withFactAccuracy(scan(dir, vault), dir, "novel", () => garbled);
  expect(unread.factAccuracy?.notice).toContain("not the contradictions JSON");
});

test("prose mode says which unit it is asking about before each model call", async () => {
  const { vault, dir } = work([SCALE_FACT]);
  const lines: string[] = [];
  await withFactAccuracy(scan(dir, vault), dir, "novel", () => fakeAsk([]), (line) => lines.push(line));
  expect(lines).toEqual([`fact-accuracy: ${UNIT} (1/1), 1 period fact, asking the check model…`]);
});

test("control characters in the model's reason never reach the terminal", () => {
  expect(parseContradictions('{"contradictions":[{"sentence":1,"fact":1,"why":"bad\\u001b[2Jwhy"}]}', 1, 1)[0]?.why).toBe("bad [2Jwhy");
});

test("a reply naming a sentence or fact that was not shown is dropped", () => {
  expect(parseContradictions('{"contradictions":[{"sentence":9,"fact":1},{"sentence":"S2","fact":"F1","why":"w"},{"sentence":2,"fact":1}]}', 3, 1)).toEqual([
    { sentence: 2, fact: 1, why: "w" },
  ]);
});

test("draft sentences skip frontmatter, headings and fences and keep their file lines", async () => {
  const text = "---\nstory_date: 1929\n---\n\n# One\n\nIt was cold. The pond rang.\n```\nNot prose.\n```\nDone.\n";
  expect(draftSentences(text)).toEqual([
    { line: 7, text: "It was cold." },
    { line: 7, text: "The pond rang." },
    { line: 11, text: "Done." },
  ]);
  expect(await checkFactAccuracy(text, "x.md", [], fakeAsk([]))).toEqual([]);
});

test("pablo check --output novel --unit 1 --json reports fact-accuracy hits and a summary; the screen shows them while the unit is unchanged", async () => {
  const { vault, dir } = work([SCALE_FACT]);
  const ask = fakeAsk([["Twenty-two inch squares", "thirty inches", "wrong size"]]);
  const logs: string[] = [];
  const original = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  let code: number;
  try {
    code = await runCheck({ json: true, file: undefined, output: "novel", unit: "1" }, vault, dir, undefined, () => ask);
  } finally {
    console.log = original;
  }
  expect(code).toBe(0);
  const body = JSON.parse(logs[0] as string) as { hits: Array<Record<string, unknown>>; factAccuracy: unknown };
  expect(body.hits.filter((h) => h["rule"] === "fact-accuracy").map((h) => h["source"])).toEqual(["research/ice-harvest.md"]);
  expect(body.factAccuracy).toEqual({ checked: 1 });

  // Saved for the screen, keyed to the unit's text.
  const text = readFileSync(join(dir, UNIT), "utf8");
  expect(JSON.parse(readFileSync(factHitsPath(dir), "utf8")).units[UNIT].hits).toHaveLength(1);
  const screen = screenChecks(vault, dir);
  expect(screen(UNIT, text).filter((h) => h.rule === "fact-accuracy")).toHaveLength(1);
  expect(savedFactHits(dir, UNIT, `${text}\nAn added line.\n`)).toEqual([]);
});

test("check --unit names a unit the output does not have: refused, exit 2", async () => {
  const { vault, dir } = work([SCALE_FACT]);
  const outcome = checkWork(vault, dir, undefined, "novel", 7);
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.code).toBe(2);
    expect(outcome.message).toContain("no unit 7");
  }
  const errors: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    expect(await runCheck({ json: false, file: undefined, output: "novel", unit: "x" }, vault, dir, undefined, () => fakeAsk([]))).toBe(2);
  } finally {
    console.error = original;
  }
  expect(errors[0]).toContain("--unit must be a positive whole number");
  const both = checkWork(vault, dir, UNIT, "novel", 1);
  expect(both.ok ? "" : both.message).toContain("cannot be combined with --file");
});

test("the MCP check verb runs fact-accuracy too, on the injected model seam", async () => {
  const { vault, dir } = work([SCALE_FACT]);
  factAccuracyModel.ask = fakeAsk([["Twenty-two inch squares", "thirty inches", "wrong size"]]);
  const verb = VERBS.find((v) => v.name === "check");
  if (verb === undefined) throw new Error("no check verb");
  const args = verb.args.parse({ project: "ice-house", output: "novel", unit: 1 });
  const result = await verb.run(args as never, { cwd: vault, env: { ...process.env, PABLO_VAULT: vault }, stderr: { write: () => true } } as never);
  expect(result.exitCode).toBe(0);
  const body = result.body as { hits: Array<Record<string, unknown>>; factAccuracy: unknown };
  expect(body.hits.filter((h) => h["rule"] === "fact-accuracy")).toHaveLength(1);
  expect(body.factAccuracy).toEqual({ checked: 1 });
});

test("the prompt carries the unit's story date and each fact's date; a date contradiction is caught", async () => {
  const { vault, dir } = work(["| The river ice houses closed in 1934 | refrigeration | 1934 |"]);
  const unit = join(dir, UNIT);
  writeFileSync(unit, "---\ntitle: One\n---\n\nIn January 1929 the river ice houses were already shuttered.\n");
  const ask = fakeAsk([["already shuttered", "ice houses closed", "closed in 1934, not 1929"]]);
  const hits = await checkFactAccuracy(readFileSync(unit, "utf8"), UNIT, [{ fact: "The river ice houses closed in 1934", source: "refrigeration", date: "1934" }], ask, "1929-01");
  expect(hits).toHaveLength(1);
  expect(hits[0]?.source).toBe("research/refrigeration.md");
  expect(ask.prompts[0]).toContain("The draft is set on 1929-01.");
  expect(ask.prompts[0]).toContain("story date 1929-01");
  expect(ask.prompts[0]).toContain("F1. The river ice houses closed in 1934 (from 1934)");
  void vault;
});
