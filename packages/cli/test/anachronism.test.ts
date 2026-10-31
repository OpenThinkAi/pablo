/**
 * The `anachronism` check for historical fiction (AGT-2113, pm project `pablo-platform`, D-10): out-of-period
 * words named with why and the period they belong to, verdicts cached per (period, term) in the work's
 * `.pablo/lexicon.json` (AGT-2187: in the main checkout, never a draft worktree). Every model call goes through a
 * fake `Ask` or a fake adapter replaying a fixture reply (`fixtures/anachronism/`, in the shapes Gemma 4 and Claude
 * answer); no test reaches a real model, and every work is a temp copy of the fixture vault.
 */

import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent, CompletionRequest } from "@openthink/pablo-core";
import {
  ASK_MAX_TOKENS,
  LEGACY_LEXICON_FILE,
  LEXICON_FILE,
  anachronismModel,
  checkAnachronisms,
  knownNamesOf,
  lexiconHome,
  parseVerdicts,
  periodOf,
  readLexicon,
  writeLexicon,
  termsByLine,
} from "../src/anachronism";
import { adapterAsk } from "../src/critique";
import { VERBS } from "../src/verbs";

const FIXTURE = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const REPLIES = fileURLToPath(new URL("./fixtures/anachronism", import.meta.url));
const reply = (name: string): string => readFileSync(join(REPLIES, name), "utf8");
const PERIOD = "The Hudson ice trade, winter 1888-89.";

const roots: string[] = [];
afterEach(() => {
  anachronismModel.ask = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A temp copy of the fixture vault whose work is on `track`, with a period brief and one unit of `prose`. */
function tempWork(prose: string, track = "historical-fiction", period = PERIOD): { vault: string; work: string; unit: string } {
  const vault = mkdtempSync(join(tmpdir(), "pablo-anachronism-"));
  roots.push(vault);
  cpSync(FIXTURE, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(work, "pablo.json"), JSON.stringify({ ...marker, track }, null, 2));
  writeFileSync(join(work, "bible", "period.md"), `# Period\n\n## When and where\n\n${period}\n\n## The events\n\nThe Great Blizzard.\n`);
  const unit = join(work, "chapters", "01-the-last-full-cut.md");
  writeFileSync(unit, `---\ntitle: one\nmodel: m\nprompt_hash: h\n---\n\n${prose}\n`);
  return { vault, work, unit };
}

/** The terms a prompt asks about. */
const termsOf = (prompt: string): string[] => prompt.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2));

/** A fake model answering in the line protocol: every asked term is in period except those in `out`. Records each prompt. */
function fakeAsk(out: Record<string, { why: string; belongs: string }>) {
  const prompts: string[] = [];
  const ask = async (prompt: string): Promise<string> => {
    prompts.push(prompt);
    const lines = termsOf(prompt).flatMap((term) => (out[term] ? [`${term} | ${out[term].why} | ${out[term].belongs}`] : []));
    return [...lines, "END", ""].join("\n");
  };
  return { ask, prompts };
}

/** A fake adapter whose `complete()` streams `text` in small tokens, recording each request (as a local endpoint would). */
function replayAdapter(text: string): { adapter: Adapter; requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  const adapter = {
    id: "fake",
    model: "fake-model",
    preferredOutput: "text",
    async *complete(request: CompletionRequest): AsyncIterable<CompletionEvent> {
      requests.push(request);
      for (let i = 0; i < text.length; i += 7) yield { type: "token", text: text.slice(i, i + 7) } as CompletionEvent;
    },
  } as unknown as Adapter;
  return { adapter, requests };
}

const TEENAGER = { teenager: { why: "the word came into use in the 1940s", belongs: "the 1940s onward" } };

test("a hit names the term, why it is out of period and the period it belongs to; the lexicon caches every verdict", async () => {
  const { work, unit } = tempWork("The teenager hauled ice from the river.");
  const fake = fakeAsk(TEENAGER);
  const progress: string[] = [];
  const result = await checkAnachronisms(work, [unit], { ask: fake.ask, progress: (line) => progress.push(line) });
  expect(result?.asked).toBe(1);
  // The wait is visible: what is asked, then each batch.
  expect(progress).toEqual([
    "anachronism: 0 of 4 word verdict(s) from the cache (injected), 4 to ask",
    `anachronism: asking injected about 4 word(s) in 1 batch(es); known verdicts come from ${LEXICON_FILE}`,
    "anachronism: batch 1/1",
  ]);
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
  expect(known["teenager"]).toEqual({ inPeriod: false, ...TEENAGER.teenager, model: "injected" });
  expect(known["hauled"]).toEqual({ inPeriod: true, model: "injected" });
  expect(known["river"]).toEqual({ inPeriod: true, model: "injected" });
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
  expect(result?.failed).toBe(true);
  expect(result?.hits.map((h) => h.term)).toEqual(["teenager"]);
});

test("a lexicon that does not parse is never overwritten; the check fails with a notice", async () => {
  const { work, unit } = tempWork("The teenager hauled ice.");
  mkdirSync(join(work, ".pablo"), { recursive: true });
  writeFileSync(join(work, LEXICON_FILE), "{ not json");
  const fake = fakeAsk(TEENAGER);
  const result = await checkAnachronisms(work, [unit], { ask: fake.ask });
  expect(result?.hits).toEqual([]);
  expect(result?.failed).toBe(true);
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
  expect(result?.failed).toBeUndefined();
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
  expect((result.body as { anachronism?: unknown }).anachronism).toEqual({ asked: 1, model: "injected", cached: 0, new: 4 });
});

test("helpers: the period, the terms of a line and a lenient verdict parse (JSON arrays are still read)", () => {
  expect(periodOf("# Period\n\nThe Hudson ice trade, winter 1888-89.\n")).toBe("The Hudson ice trade, winter 1888-89.");
  expect(periodOf("# Period\n\n## When and where\n\nNapa,\n1920s.\n\n## The events\n\nx\n")).toBe("Napa, 1920s.");
  expect(periodOf("# Period\n")).toBeUndefined();
  expect(termsByLine("---\ntitle: t\n---\nThe drive-in's sign, and it was okay.\n")).toEqual([
    { line: 4, raw: "The drive-in's sign, and it was okay.", terms: ["drive-in", "sign", "okay"] },
  ]);
  const verdicts = parseVerdicts('Sure:\n[{"term":"Okay","inPeriod":false},{"term":"other","inPeriod":false},{"term":"sign"}]', ["okay", "sign"]);
  // A verdict with no reason and no date is noise, read as in period (AGT-2284).
  expect([...verdicts]).toEqual([["okay", { inPeriod: true }]]);
  const long = parseVerdicts(JSON.stringify([{ term: "okay", inPeriod: false, why: "x".repeat(500), belongs: "the 1830s" }]), ["okay"]);
  expect(long.get("okay")?.why).toHaveLength(200);
});

// ---------------------------------------------------------------- AGT-2284: etymology and spelling are not anachronisms

test("etymology, undated, self-contradicting and spelling verdicts give no hit; a dated thing out of period still does", async () => {
  const { work, unit } = tempWork("The teenager hauled ice from the river, and the labor was hard.");
  const fake = fakeAsk({
    teenager: { why: "the word came into use in the 1940s", belongs: "the 1940s onward" },
    hauled: { why: "first recorded as a verb late", belongs: "N/A" },
    ice: { why: "the word is older than the thing", belongs: "" },
    river: { why: "the etymology of the word is 1950", belongs: "the 1950s" },
    labor: { why: "American spelling of labour", belongs: "the 1830s" },
  });
  const result = await checkAnachronisms(work, [unit], { ask: fake.ask });
  expect(result?.notice).toBeUndefined();
  expect(result?.hits.map((h) => h.term)).toEqual(["teenager"]);
  // The prompt asks about things, practices and idioms, wants a date, and rules out spelling variants.
  expect(fake.prompts[0]).toContain("THING, PRACTICE or IDIOM");
  expect(fake.prompts[0]).toContain("labor/labour");
  expect(fake.prompts[0]).toContain("year or decade");
});

test("a lexicon cached before AGT-2284 with an undated, N/A or spelling verdict reports no hit and asks nothing", async () => {
  const { work, unit } = tempWork("The depot and the labor.");
  const m = "injected";
  const old = { periods: { [PERIOD]: { depot: { inPeriod: false, why: "x", belongs: "N/A", model: m }, labor: { inPeriod: false, why: "spelling variant", belongs: "the 1830s", model: m }, the: { inPeriod: false, why: "y", belongs: "a later period", model: m } } } };
  writeLexicon(work, old);
  const fake = fakeAsk({});
  const result = await checkAnachronisms(work, [unit], { ask: fake.ask });
  expect(result?.hits).toEqual([]);
  // `depot` and `labor` stay cached (their dropped verdicts are never re-asked); no model call is made.
  expect(fake.prompts.flatMap(termsOf)).toEqual([]);
});

test("parseVerdicts drops a verdict with no date, `N/A`, or a spelling reason, and keeps a dated one", () => {
  const reply = ["depot | word from French | N/A", "levies | spelling variant | the 1800s", "okay | modern assent | the 1830s", "END", ""].join("\n");
  const verdicts = parseVerdicts(reply, ["depot", "levies", "okay"]);
  expect(verdicts.get("depot")).toEqual({ inPeriod: true });
  expect(verdicts.get("levies")).toEqual({ inPeriod: true });
  expect(verdicts.get("okay")).toEqual({ inPeriod: false, why: "modern assent", belongs: "the 1830s" });
});

// ---------------------------------------------------------------- AGT-2187: local models, loud failures, fewer words

const RADIO_1918 = "Rural New York, the winter of 1918.";

test("the line protocol: a Gemma 4 reply and a Claude reply both give verdicts, through an adapter's complete()", async () => {
  for (const name of ["gemma4-reply.txt", "claude-reply.txt"]) {
    const { work, unit } = tempWork("The radio played in the parlour while the teenager slept.", "historical-fiction", RADIO_1918);
    const { adapter, requests } = replayAdapter(reply(name));
    const result = await checkAnachronisms(work, [unit], { ask: adapterAsk(adapter, 5_000, ASK_MAX_TOKENS) });
    expect(result?.failed).toBeUndefined();
    expect(result?.notice).toBeUndefined();
    expect(result?.hits.map((h) => h.term).sort()).toEqual(["radio", "teenager"]);
    expect(result?.hits.find((h) => h.term === "radio")?.belongs).toBe("the 1920s onward");
    // Every unlisted term is in period once the reply says END, and the answer budget is stated (mlx_lm's default is 512).
    expect(readLexicon(work)?.periods[RADIO_1918]?.["parlour"]).toEqual({ inPeriod: true, model: "injected" });
    expect(requests[0]?.maxTokens).toBe(ASK_MAX_TOKENS);
    expect(requests[0]?.prompt).toContain("END");
  }
});

test("a reply cut short (no END) is a check error: check exits 1 with anachronism.failed, and nothing unjudged is cached", async () => {
  const { vault, work } = tempWork("The radio played in the parlour while the teenager slept.", "historical-fiction", RADIO_1918);
  anachronismModel.ask = async () => reply("gemma4-reply-cut.txt");
  const verb = VERBS.find((v) => v.name === "check")!;
  const ctx = { cwd: vault, env: { PABLO_VAULT: vault, PATH: "/usr/bin:/bin" }, stderr: { write: () => true } };
  const result = await verb.run({ project: "ice-house", across: false }, ctx as never);
  expect(result.exitCode).toBe(1);
  const block = (result.body as { anachronism?: { failed?: boolean; notice?: string } }).anachronism;
  expect(block?.failed).toBe(true);
  expect(block?.notice).toContain("got no verdict");
  // The half-written last line is not trusted, and no term is passed as in period.
  const known = readLexicon(work)?.periods[RADIO_1918] ?? {};
  expect(known["radio"]).toBeUndefined();
  expect(known["parlour"]).toBeUndefined();
});

test("the line parser tolerates bullets, tables, emphasis and a thinking block, and only END passes the unlisted", () => {
  const asked = ["radio", "okay", "parlour"];
  const table = "<think>radio? 1918...</think>\n| Term | Why | Period |\n|---|---|---|\n| **Radio** | broadcasting began in 1920 | the 1920s |\n1. okay: first recorded in 1839\nEND";
  expect([...parseVerdicts(table, asked)]).toEqual([
    ["radio", { inPeriod: false, why: "broadcasting began in 1920", belongs: "the 1920s" }],
    // `okay: why` with no period it belongs to names no date, so it is dropped (AGT-2284).
    ["okay", { inPeriod: true }],
    ["parlour", { inPeriod: true }],
  ]);
  // No END: only the listed term gets a verdict, so the rest are asked again rather than passed.
  expect([...parseVerdicts("radio | too late | the 1920s\n", asked)].map(([t]) => t)).toEqual(["radio"]);
  // A model that also lists in-period terms says so in the reason cell.
  expect(parseVerdicts("parlour | in period | -\nEND", asked).get("parlour")).toEqual({ inPeriod: true });
  // An echo of the asked terms is not a verdict.
  expect(parseVerdicts("- radio\n- okay\n", asked).size).toBe(0);
});

test("stopwords and the names the bible and continuity know are never sent: the fixture chapter's term count", async () => {
  const vault = mkdtempSync(join(tmpdir(), "pablo-anachronism-"));
  roots.push(vault);
  cpSync(FIXTURE, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(join(work, "pablo.json"), JSON.stringify({ ...marker, track: "historical-fiction" }, null, 2));
  writeFileSync(join(work, "bible", "period.md"), `# Period\n\n## When and where\n\n${PERIOD}\n`);
  const chapter = join(work, "chapters", "01-the-last-full-cut.md");
  const fake = fakeAsk({});
  await checkAnachronisms(work, [chapter], { ask: fake.ask });
  const sent = fake.prompts.flatMap(termsOf);

  const names = knownNamesOf(work);
  for (const name of ["Odile", "Marcel", "Wilfred", "Sprague", "Ezra"]) expect(names.has(name)).toBe(true);
  for (const word of ["odile", "marcel", "wilfred", "sprague", "ezra", "the", "had", "would", "you'll", "something", "under", "while"]) {
    expect(sent).not.toContain(word);
  }
  const everything = new Set(termsByLine(readFileSync(chapter, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "")).flatMap((l) => l.terms));
  // 319 words in, a fraction of them asked about; the count is pinned so a regression in the filter shows.
  expect(sent.length).toBe(93);
  expect(sent.length).toBeLessThan(everything.size);
  expect(sent).toContain("sawdust");
});

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

test("a check in a draft worktree caches in the main checkout's .pablo/, leaves the worktree clean, and survives its removal", async () => {
  const { vault, work } = tempWork("The teenager hauled ice from the river.");
  writeFileSync(join(vault, ".gitignore"), ".pablo/\n");
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "t@example.com");
  git(vault, "config", "user.name", "T");
  git(vault, "add", "-A");
  git(vault, "commit", "-q", "-m", "init");
  const tree = join(mkdtempSync(join(tmpdir(), "pablo-anachronism-wt-")), "draft");
  roots.push(dirname(tree));
  git(vault, "worktree", "add", "-q", "-b", "draft/ch01", tree);
  const draftWork = join(tree, "novels", "ice-house");

  expect(realpathSync(lexiconHome(draftWork))).toBe(realpathSync(work));
  const result = await checkAnachronisms(draftWork, [join(draftWork, "chapters", "01-the-last-full-cut.md")], { ask: fakeAsk(TEENAGER).ask });
  expect(result?.hits.map((h) => h.term)).toEqual(["teenager"]);
  expect(existsSync(join(draftWork, LEXICON_FILE))).toBe(false);
  expect(existsSync(join(draftWork, LEGACY_LEXICON_FILE))).toBe(false);
  expect(git(tree, "status", "--porcelain", "--ignored")).toBe("");
  expect(existsSync(join(work, LEXICON_FILE))).toBe(true);

  // The worktree goes (as a merge removes it); the verdicts stay, so a re-check on main asks nothing.
  git(vault, "worktree", "remove", tree);
  const again = await checkAnachronisms(work, [join(work, "chapters", "01-the-last-full-cut.md")], {
    ask: async () => {
      throw new Error("the model was called");
    },
  });
  expect(again?.asked).toBe(0);
  expect(again?.hits.map((h) => h.term)).toEqual(["teenager"]);
});

test("a legacy facts/lexicon.json seeds a missing cache and is never written", async () => {
  const { work, unit } = tempWork("The teenager hauled ice from the river.");
  mkdirSync(join(work, "facts"), { recursive: true });
  const legacy = { periods: { [PERIOD]: { teenager: { inPeriod: false, why: "1940s word", belongs: "the 1940s" }, hauled: { inPeriod: true }, ice: { inPeriod: true }, river: { inPeriod: true } } } };
  writeFileSync(join(work, LEGACY_LEXICON_FILE), JSON.stringify(legacy));
  // The seed records no model, so a known model does not reuse it (AGT-2288): it asks again.
  const fake = fakeAsk({});
  const result = await checkAnachronisms(work, [unit], { ask: fake.ask });
  expect(result?.asked).toBe(1);
  expect(result?.hits).toEqual([]);
  expect(JSON.parse(readFileSync(join(work, LEGACY_LEXICON_FILE), "utf8"))).toEqual(legacy);
  // Marked `"model": "*"` (the author's own verdicts), the seed is obeyed by every model.
  const own = { periods: { [PERIOD]: { teenager: { inPeriod: false, why: "1940s word", belongs: "the 1940s", model: "*" }, hauled: { inPeriod: true, model: "*" }, ice: { inPeriod: true, model: "*" }, river: { inPeriod: true, model: "*" } } } };
  writeFileSync(join(work, LEGACY_LEXICON_FILE), JSON.stringify(own));
  rmSync(join(work, LEXICON_FILE));
  const again = await checkAnachronisms(work, [unit], {
    ask: async () => {
      throw new Error("the model was called");
    },
  });
  expect(again?.asked).toBe(0);
  expect(again?.hits.map((h) => h.term)).toEqual(["teenager"]);
});

// ---------------------------------------------------------------- AGT-2288: verdicts belong to the model that gave them

test("a verdict cached by model A is not used by model B; B asks again and its answer replaces A's", async () => {
  const { work, unit } = tempWork("The teenager hauled ice from the river.");
  const a = fakeAsk(TEENAGER);
  const first = await checkAnachronisms(work, [unit], { ask: a.ask, model: "local/qwen" });
  expect(first?.hits.map((h) => h.term)).toEqual(["teenager"]);
  expect(first?.model).toBe("local/qwen");

  // Model B says nothing is out of period: it is asked about every word, and A's hit is gone.
  const b = fakeAsk({});
  const progress: string[] = [];
  const second = await checkAnachronisms(work, [unit], { ask: b.ask, model: "claude-code/claude-opus", progress: (l) => progress.push(l) });
  expect(second?.asked).toBe(1);
  expect(second?.cached).toBe(0);
  expect(second?.hits).toEqual([]);
  expect(b.prompts.flatMap(termsOf)).toContain("teenager");
  expect(progress[0]).toBe("anachronism: 0 of 4 word verdict(s) from the cache (claude-code/claude-opus), 4 to ask");
  expect(readLexicon(work)?.periods[PERIOD]?.["teenager"]).toEqual({ inPeriod: true, model: "claude-code/claude-opus" });

  // The same model again reuses its own verdicts and says how many.
  const never = async (): Promise<string> => {
    throw new Error("the model was called");
  };
  const third = await checkAnachronisms(work, [unit], { ask: never, model: "claude-code/claude-opus", progress: (l) => progress.push(l) });
  expect(third?.asked).toBe(0);
  expect(third?.cached).toBe(4);
  expect(progress).toContain("anachronism: 4 of 4 word verdict(s) from the cache (claude-code/claude-opus), 0 to ask");
});

test("a hand-written verdict marked model * is obeyed by every model; an unmarked legacy one is not reused", async () => {
  const { work, unit } = tempWork("The teenager hauled ice.");
  writeLexicon(work, { periods: { [PERIOD]: { teenager: { inPeriod: false, why: "1940s word", belongs: "the 1940s", model: "*" }, hauled: { inPeriod: true } } } });
  const fake = fakeAsk({});
  const result = await checkAnachronisms(work, [unit], { ask: fake.ask, model: "local/qwen" });
  expect(result?.hits.map((h) => h.term)).toEqual(["teenager"]);
  // `hauled` has no model: asked again. `teenager` (model *) is not.
  expect(fake.prompts.flatMap(termsOf)).toEqual(["hauled", "ice"]);
});

test("--fresh drops the period's cached verdicts, whoever gave them", async () => {
  const { work, unit } = tempWork("The teenager hauled ice.");
  await checkAnachronisms(work, [unit], { ask: fakeAsk(TEENAGER).ask, model: "local/qwen" });
  const fake = fakeAsk({});
  const result = await checkAnachronisms(work, [unit], { ask: fake.ask, model: "local/qwen", fresh: true });
  expect(result?.asked).toBe(1);
  expect(result?.cached).toBe(0);
  expect(result?.hits).toEqual([]);
  expect(fake.prompts.flatMap(termsOf)).toContain("teenager");
});

test("a draft branch is checked against main's period brief, not its own stale one", async () => {
  const { vault, work } = tempWork("The teenager hauled ice from the river.");
  writeFileSync(join(vault, ".gitignore"), ".pablo/\n");
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "t@example.com");
  git(vault, "config", "user.name", "T");
  git(vault, "add", "-A");
  git(vault, "commit", "-q", "-m", "init");
  const tree = join(mkdtempSync(join(tmpdir(), "pablo-anachronism-wt-")), "draft");
  roots.push(dirname(tree));
  git(vault, "worktree", "add", "-q", "-b", "draft/ch01", tree);
  const draftWork = join(tree, "novels", "ice-house");
  // Main's brief moves on after the branch was cut.
  const NEW = "The Hudson ice trade, winter 1890.";
  writeFileSync(join(work, "bible", "period.md"), `# Period\n\n## When and where\n\n${NEW}\n`);
  const fake = fakeAsk({});
  await checkAnachronisms(draftWork, [join(draftWork, "chapters", "01-the-last-full-cut.md")], { ask: fake.ask, coreDir: work });
  expect(fake.prompts[0]).toContain(NEW);
  expect(fake.prompts[0]).not.toContain(PERIOD);
  expect(Object.keys(readLexicon(work)?.periods ?? {})).toEqual([NEW]);
});
