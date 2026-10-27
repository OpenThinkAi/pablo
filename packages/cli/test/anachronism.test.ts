/**
 * The `anachronism` check for historical fiction (AGT-2113, pm project `pablo-platform`, D-10): out-of-period
 * words named with why and the period they belong to, verdicts cached per (period, term) in the work's
 * `facts/lexicon.json`. Every model call goes through a fake `Ask`; no test reaches a real model, and every work is
 * a temp copy of the fixture vault.
 */

import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LEXICON_FILE, anachronismModel, checkAnachronisms, parseVerdicts, periodOf, readLexicon, termsByLine } from "../src/anachronism";
import { VERBS } from "../src/verbs";

const FIXTURE = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const PERIOD = "The Hudson ice trade, winter 1888-89.";

const roots: string[] = [];
afterEach(() => {
  anachronismModel.ask = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temp copy of the fixture vault whose work is on `track`, with a period brief and one unit of `prose`. */
function tempWork(prose: string, track = "historical-fiction"): { vault: string; work: string; unit: string } {
  const vault = mkdtempSync(join(tmpdir(), "pablo-anachronism-"));
  roots.push(vault);
  cpSync(FIXTURE, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(work, "pablo.json"), JSON.stringify({ ...marker, track }, null, 2));
  writeFileSync(join(work, "bible", "period.md"), `# Period\n\n## When and where\n\n${PERIOD}\n\n## The events\n\nThe Great Blizzard.\n`);
  const unit = join(work, "chapters", "01-the-last-full-cut.md");
  writeFileSync(unit, `---\ntitle: one\nmodel: m\nprompt_hash: h\n---\n\n${prose}\n`);
  return { vault, work, unit };
}

/** A fake model: every asked term is in period except those in `out`. Records each prompt. */
function fakeAsk(out: Record<string, { why: string; belongs: string }>) {
  const prompts: string[] = [];
  const ask = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    const terms = prompt.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
    return JSON.stringify(terms.map((term) => (out[term] ? { term, inPeriod: false, ...out[term] } : { term, inPeriod: true })));
  };
  return { ask, prompts };
}

const TEENAGER = { teenager: { why: "the word came into use in the 1940s", belongs: "the 1940s onward" } };

test("a hit names the term, why it is out of period and the period it belongs to; the lexicon caches every verdict", async () => {
  const { work, unit } = tempWork("The teenager hauled ice from the river.");
  const fake = fakeAsk(TEENAGER);
  const progress: string[] = [];
  const result = await checkAnachronisms(work, [unit], { ask: fake.ask, progress: (line) => progress.push(line) });
  expect(result?.asked).toBe(1);
  // The wait is visible: what is asked, then each batch.
  expect(progress).toEqual([`anachronism: asking the check model about 4 new word(s) in 1 batch(es); known verdicts come from ${LEXICON_FILE}`, "anachronism: batch 1/1"]);
  expect(result?.notice).toBeUndefined();
  expect(result?.hits).toEqual([
    {
      path: "chapters/01-the-last-full-cut.md",
      line: 7,
      rule: "anachronism",
      excerpt: "The teenager hauled ice from the river.",
      detail: '"teenager": the word came into use in the 1940s; belongs to the 1940s onward',
      term: "teenager",
      why: "the word came into use in the 1940s",
      belongs: "the 1940s onward",
    },
  ]);
  // The model saw the period and bare terms, never the sentence.
  expect(fake.prompts[0]).toContain(PERIOD);
  expect(fake.prompts[0]).not.toContain("hauled ice from the river");
  // Cached in the work, per (period, term), in-period verdicts too.
  expect(existsSync(join(work, LEXICON_FILE))).toBe(true);
  const known = readLexicon(work)?.periods[PERIOD] ?? {};
  expect(known["teenager"]).toEqual({ inPeriod: false, ...TEENAGER.teenager });
  expect(known["hauled"]).toEqual({ inPeriod: true });
  expect(known["river"]).toEqual({ inPeriod: true });
});

test("a cached hit: a re-check makes no model call for known terms and reports the same hit", async () => {
  const { work, unit } = tempWork("The teenager hauled ice from the river.");
  await checkAnachronisms(work, [unit], { ask: fakeAsk(TEENAGER).ask });
  const never = async (): Promise<string> => {
    throw new Error("the model was called");
  };
  const again = await checkAnachronisms(work, [unit], { ask: never });
  expect(again?.asked).toBe(0);
  expect(again?.notice).toBeUndefined();
  expect(again?.hits.map((h) => h.term)).toEqual(["teenager"]);

  // A new sentence asks only about the terms the lexicon lacks.
  writeFileSync(unit, "The teenager sawed the ice.\n");
  const fake = fakeAsk({});
  const third = await checkAnachronisms(work, [unit], { ask: fake.ask });
  expect(third?.asked).toBe(1);
  expect(fake.prompts[0]?.split("\n").filter((l) => l.startsWith("- "))).toEqual(["- sawed"]);
  expect(third?.hits.map((h) => h.term)).toEqual(["teenager"]);
});

test("a clean sentence has no hits", async () => {
  const { work, unit } = tempWork("The cutters sawed blocks from the frozen river at dawn.");
  const result = await checkAnachronisms(work, [unit], { ask: fakeAsk({}).ask });
  expect(result?.hits).toEqual([]);
  expect(result?.notice).toBeUndefined();
});

test("a model that cannot be asked leaves a notice and keeps the cached hits", async () => {
  const { work, unit } = tempWork("The teenager hauled ice.");
  await checkAnachronisms(work, [unit], { ask: fakeAsk(TEENAGER).ask });
  writeFileSync(unit, "The teenager hauled ice by sledge.\n");
  const result = await checkAnachronisms(work, [unit], {
    ask: async () => {
      throw new Error("no provider");
    },
  });
  expect(result?.notice).toBe(
    "anachronism: incomplete; 1 new word(s) not judged, cached verdicts still reported: no provider. Check the provider the `check` intent routes to (`pablo config test`; `pablo init --config` if none is set).",
  );
  expect(result?.hits.map((h) => h.term)).toEqual(["teenager"]);
});

test("a lexicon that does not parse is never overwritten; the check is skipped with a notice", async () => {
  const { work, unit } = tempWork("The teenager hauled ice.");
  mkdirSync(join(work, "facts"), { recursive: true });
  writeFileSync(join(work, LEXICON_FILE), "{ not json");
  const fake = fakeAsk(TEENAGER);
  const result = await checkAnachronisms(work, [unit], { ask: fake.ask });
  expect(result?.hits).toEqual([]);
  expect(result?.notice).toContain("is not a lexicon");
  expect(fake.prompts).toEqual([]);
  expect(readFileSync(join(work, LEXICON_FILE), "utf8")).toBe("{ not json");
});

test("only historical-fiction works are checked, and a work without a period brief is skipped with a notice", async () => {
  const fiction = tempWork("The teenager hauled ice.", "fiction");
  expect(await checkAnachronisms(fiction.work, [fiction.unit], { ask: fakeAsk(TEENAGER).ask })).toBeUndefined();

  const { work, unit } = tempWork("The teenager hauled ice.");
  writeFileSync(join(work, "bible", "period.md"), "# Period\n\n## When and where\n");
  const result = await checkAnachronisms(work, [unit], { ask: fakeAsk(TEENAGER).ask });
  expect(result?.hits).toEqual([]);
  expect(result?.notice).toContain("bible/period.md");
});

test("`check` puts anachronism hits in hits[] through the anachronismModel seam", async () => {
  const { vault } = tempWork("The teenager hauled ice from the river.");
  anachronismModel.ask = fakeAsk(TEENAGER).ask;
  const verb = VERBS.find((v) => v.name === "check")!;
  const ctx = { cwd: vault, env: { PABLO_VAULT: vault, PATH: "/usr/bin:/bin" }, stderr: { write: () => true } };
  const result = await verb.run({ project: "ice-house", across: false }, ctx as never);
  expect(result.exitCode).toBe(0);
  const hits = (result.body as { hits: Array<{ rule: string; term?: string }> }).hits;
  expect(hits.filter((h) => h.rule === "anachronism").map((h) => h.term)).toEqual(["teenager"]);
  expect((result.body as { anachronism?: unknown }).anachronism).toEqual({ asked: 1 });
});

test("helpers: the period, the terms of a line and a lenient verdict parse", () => {
  expect(periodOf("# Period\n\nThe Hudson ice trade, winter 1888-89.\n")).toBe("The Hudson ice trade, winter 1888-89.");
  expect(periodOf("# Period\n\n## When and where\n\nNapa,\n1920s.\n\n## The events\n\nx\n")).toBe("Napa, 1920s.");
  expect(periodOf("# Period\n")).toBeUndefined();
  expect(termsByLine("---\ntitle: t\n---\nThe drive-in's sign, and it was okay.\n")).toEqual([
    { line: 4, raw: "The drive-in's sign, and it was okay.", terms: ["drive-in", "sign", "okay"] },
  ]);
  const verdicts = parseVerdicts('Sure:\n[{"term":"Okay","inPeriod":false},{"term":"other","inPeriod":false},{"term":"sign"}]', ["okay", "sign"]);
  expect([...verdicts]).toEqual([["okay", { inPeriod: false, why: "no reason given", belongs: "a later period" }]]);
  const long = parseVerdicts(JSON.stringify([{ term: "okay", inPeriod: false, why: "x".repeat(500), belongs: "the 1830s" }]), ["okay"]);
  expect(long.get("okay")?.why).toHaveLength(200);
});
