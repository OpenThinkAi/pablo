import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import { type Adapter, type CompletionEvent, type CompletionRequest, parseConfig, route } from "@openthink/pablo-core";
import { main } from "../src/cli";
import { parsePeriodFacts } from "@openthink/pablo-core";
import { checkFacts, parseDistillAnswer, parseNameMap, renderPeriodFacts, RESEARCH_INTENT, swapNames } from "../src/distill";
import { mcpTools } from "../src/mcp";
import type { VerbContext } from "../src/verbs";
import { VERBS } from "../src/verbs";

/** AGT-2109: `research distill` / `distill_facts`, over a temp git copy of the fixture vault and a fake research agent. */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const cleanupDirs: string[] = [];
const REAL = "Halvorsen";

function sh(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

/** A research agent that records each prompt and answers with `answer`. Never a model. */
function fakeResearcher(answer: unknown): Adapter & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    id: "fake-research",
    model: "fake-research-model",
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

function setup(opts: { realNames?: boolean; names?: string; notes?: boolean } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pablo-distill-test-")));
  cleanupDirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  if (opts.notes !== false) {
    writeFileSync(
      join(work, "research", "ice-prices-1929.md"),
      `# Ice prices, 1929\n\nRetrieved: 2026-10-01\n\n${REAL} Ice Co. sold ice at four dollars a ton in January 1929.\n\n## Sources\n\n- https://example.test/ice\n`,
    );
    writeFileSync(join(work, "research", "harvest.md"), "# Harvest\n\nRetrieved: 2026-10-01\n\nCutting began when the ice was a foot thick.\n\n## Sources\n\n- Almanac 1930\n");
  }
  if (opts.names !== undefined) writeFileSync(join(work, "research", "names.md"), opts.names);
  if (opts.realNames !== undefined) {
    const path = join(work, "pablo.json");
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), realNames: opts.realNames }));
  }
  execFileSync("git", ["init", "-q", "-b", "main", vault]);
  sh(vault, "config", "user.name", "Test");
  sh(vault, "config", "user.email", "t@t.example");
  sh(vault, "add", "-A");
  sh(vault, "commit", "-qm", "base");
  const env = { PABLO_VAULT: vault, PABLO_HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "config"), PATH: process.env["PATH"] ?? "" };
  return { vault, work, env };
}

afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

function ctxWith(env: Record<string, string>, vault: string, researcher: Adapter): VerbContext {
  return { cwd: vault, env, stderr: { write: () => {} }, researcher };
}

async function distill(vault: string, env: Record<string, string>, researcher: Adapter) {
  const verb = VERBS.find((v) => v.name === "research")!;
  return verb.run({ sub: "distill", project: "ice-house" } as never, ctxWith(env, vault, researcher));
}

const ANSWER = {
  facts: [
    { fact: "Ice sold for four dollars a ton.", source: "ice-prices-1929", date: "1929-01", names: [] },
    { fact: "Cutting began at a foot of ice.", source: "research/harvest.md", names: [] },
    { fact: "Ice houses were packed in sawdust.", source: "", names: [] },
    { fact: "A ton weighed two thousand pounds.", source: "tonnage", names: [] },
  ],
};

test("research distill writes facts/period.md on a plan branch: one sourced fact per row, unsourced rows rejected", async () => {
  const { vault, env } = setup();
  const researcher = fakeResearcher(ANSWER);
  const r = await distill(vault, env, researcher);
  expect(r.exitCode).toBe(0);
  const body = r.body as { path: string; branch: string; facts: number; rejected: { reason: string }[]; provider: string };
  expect(body.path).toBe("novels/ice-house/facts/period.md");
  expect(body.branch).toMatch(/^plan\//);
  expect(body.facts).toBe(2);
  expect(body.provider).toBe("fake-research");
  expect(body.rejected.map((x) => x.reason)).toEqual(["a fact needs a source: the research note it came from", "research/tonnage.md does not exist"]);

  const text = sh(vault, "show", `${body.branch}:${body.path}`);
  expect(parsePeriodFacts(text)).toEqual([
    { fact: "Ice sold for four dollars a ton.", source: "ice-prices-1929", date: "1929-01" },
    { fact: "Cutting began at a foot of ice.", source: "harvest" },
  ]);
  expect(text).not.toContain("sawdust");
  // The agent read the notes; main is untouched.
  expect(researcher.prompts[0]).toContain("## Note ice-prices-1929");
  expect(researcher.prompts[0]).toContain("Cutting began when the ice was a foot thick.");
  expect(existsSync(join(vault, "novels/ice-house/facts/period.md"))).toBe(false);
});

test("research distill refuses a work with no research notes, and one where no fact survives", async () => {
  const empty = setup({ notes: false });
  const none = await distill(empty.vault, empty.env, fakeResearcher(ANSWER));
  expect(none.exitCode).toBe(2);
  expect((none.body as { message: string }).message).toContain("research/ has no notes");

  const { vault, env } = setup();
  const bad = await distill(vault, env, fakeResearcher({ facts: [{ fact: "No source here.", names: [] }] }));
  expect(bad.exitCode).toBe(2);
  expect(sh(vault, "branch", "--list", "plan/*").trim()).toBe("");

  const garbage = await distill(vault, env, fakeResearcher("I could not find anything."));
  expect(garbage.exitCode).toBe(1);
});

test("realNames: false swaps each research name for its bible counterpart", async () => {
  const { vault, env } = setup({ realNames: false, names: `| Research name | Bible name |\n| --- | --- |\n| ${REAL} Ice Co. | Nadeau |\n` });
  const researcher = fakeResearcher({ facts: [{ fact: `${REAL} Ice Co. sold ice at four dollars a ton.`, source: "ice-prices-1929", names: [`${REAL} Ice Co.`] }] });
  const r = await distill(vault, env, researcher);
  expect(r.exitCode).toBe(0);
  const body = r.body as { path: string; branch: string; swapped: { from: string; to: string }[] };
  expect(body.swapped).toEqual([{ from: `${REAL} Ice Co.`, to: "Nadeau" }]);
  const text = sh(vault, "show", `${body.branch}:${body.path}`);
  expect(text).toContain("| Nadeau sold ice at four dollars a ton. | ice-prices-1929 |");
  expect(text).not.toContain(REAL);
  // The agent was told to list the names it took from research.
  expect(researcher.prompts[0]).toContain('"names"');
});

test("realNames: false refuses research names with no bible counterpart, listing every one", async () => {
  // A mapping to a name the bible never uses is not a counterpart.
  const { vault, env } = setup({ realNames: false, names: `- ${REAL} Ice Co. -> Ghostname\n` });
  const r = await distill(
    vault,
    env,
    fakeResearcher({
      facts: [
        { fact: `${REAL} Ice Co. sold ice in Camden.`, source: "ice-prices-1929", names: [`${REAL} Ice Co.`, "Camden"] },
        // Already an invented (bible) name: not a research name to map.
        { fact: "The Nadeaus cut in January.", source: "harvest", names: ["Nadeau"] },
      ],
    }),
  );
  expect(r.exitCode).toBe(2);
  const body = r.body as { names: string[]; message: string };
  expect(body.names).toEqual(["Camden", `${REAL} Ice Co.`]);
  expect(body.message).toContain("research/names.md");
  expect(sh(vault, "branch", "--list", "plan/*").trim()).toBe("");
});

test("realNames true (the default) keeps research names as written", async () => {
  const { vault, env } = setup({ names: `- ${REAL} Ice Co. -> Nadeau\n` });
  const researcher = fakeResearcher({ facts: [{ fact: `${REAL} Ice Co. sold ice.`, source: "ice-prices-1929", names: ["Camden"] }] });
  const r = await distill(vault, env, researcher);
  expect(r.exitCode).toBe(0);
  const body = r.body as { path: string; branch: string };
  expect(sh(vault, "show", `${body.branch}:${body.path}`)).toContain(REAL);
  expect(body).not.toHaveProperty("swapped");
  expect(researcher.prompts[0]).not.toContain('In "names"');
  // names.md is the map, not a note the agent may cite.
  expect(researcher.prompts[0]).not.toContain("## Note names");
});

test("distill_facts is an MCP tool running the same distiller", async () => {
  const { vault, env } = setup();
  const tool = mcpTools().find((t) => t.name === "distill_facts");
  expect(tool?.description).toContain("facts/period.md");
  expect(Object.keys(tool?.args.shape ?? {})).toEqual(["project"]);
  const r = await tool!.run({ project: "ice-house" }, ctxWith(env, vault, fakeResearcher(ANSWER)));
  expect(r.exitCode).toBe(0);
  expect((r.body as { facts: number }).facts).toBe(2);
});

test("the research intent is planning-kind: unmapped, it goes to the first non-local provider", () => {
  const config = parseConfig(
    JSON.stringify({ providers: { anthropic: { kind: "anthropic", endpoint: "https://api.anthropic.com/v1", model: "test-claude", key: "env:X" } } }),
    "config.json",
  );
  expect(RESEARCH_INTENT).toEqual({ name: "research", kind: "planning" });
  expect(route(config, RESEARCH_INTENT)).toBe("anthropic");
});

test("the CLI dispatches pablo research distill and names both research actions", async () => {
  const { vault, env } = setup({ notes: false });
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const logs: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    expect(await main(["research", "distill", "--project", "ice-house", "--json"], vault)).toBe(2);
    expect(await main(["research", "nope", "--project", "ice-house", "--json"], vault)).toBe(2);
  } finally {
    console.log = log;
    console.error = err;
    for (const k of Object.keys(env)) if (saved[k] === undefined) delete process.env[k];
    Object.assign(process.env, saved);
  }
  expect(JSON.parse(logs[0] as string).message).toContain("research/ has no notes");
  expect(JSON.parse(logs[1] as string).message).toContain('"save", "distill", "plan", "waive" and "link"');
});

test("period facts round-trip through the table, pipes and all; the header is not a fact", () => {
  const facts = [
    { fact: "Ice | snow sold together.", source: "a", date: "1929" },
    { fact: "No date here.", source: "trade/b" },
  ];
  const text = renderPeriodFacts(facts);
  expect(parsePeriodFacts(text)).toEqual(facts);
  // AGT-2100's countFactRows counts the same rows: every `|` line but the header and separator.
  expect(text.split("\n").filter((l) => l.startsWith("|")).length - 2).toBe(2);
});

test("name maps, answers and swaps parse as documented", () => {
  expect([...parseNameMap("| Research name | Bible name |\n|---|---|\n| A B | C |\n- D -> E\n* F → G\n")]).toEqual([
    ["A B", "C"],
    ["D", "E"],
    ["F", "G"],
  ]);
  expect(parseDistillAnswer('```json\n[{"fact": " x  y ", "source": "s", "date": 1929}]\n```')).toEqual([{ fact: "x y", source: "s", date: "1929", names: [] }]);
  expect(parseDistillAnswer("nothing")).toBeUndefined();
  // Whole words only, longest first.
  expect(swapNames("Ann and Annabel met Ann Lee.", new Map([["Ann", "Bea"], ["Ann Lee", "Cy"]]))).toBe("Bea and Annabel met Cy.");
  const checked = checkFacts([{ fact: "x", source: "s", date: "Jan 1929", names: [] }, { fact: "y".repeat(300), source: "s", names: [] }], {
    noteIds: new Set(["s"]),
    realNames: true,
    nameMap: new Map(),
    bibleText: "",
  });
  expect(checked.ok && checked.rejected.map((r) => r.reason)).toEqual([
    '"Jan 1929" is not a story date (YYYY, YYYY-MM or YYYY-MM-DD)',
    "the fact is longer than 280 characters",
  ]);
});

/** AGT-2196: a researcher that answers the distill prompt with facts and the cross-check prompt with `contradictions`. */
function crosscheckResearcher(contradictions: unknown): Adapter & { prompts: string[] } {
  const inner = fakeResearcher(ANSWER);
  const prompts = inner.prompts;
  return {
    ...inner,
    async *complete(request: CompletionRequest): AsyncIterable<CompletionEvent> {
      const reply = request.prompt.includes("core documents against sourced period facts") ? { contradictions } : ANSWER;
      prompts.push(request.prompt);
      yield { type: "token", text: JSON.stringify(reply) };
      yield { type: "done", stats: { timeToFirstTokenMs: 1, elapsedMs: 1, tokensRead: 1, tokensWritten: 1, tokensPerSecond: 1 } };
    },
    prompts,
  };
}

test("research distill reports period brief / premise claims the new facts contradict", async () => {
  const { vault, work, env } = setup();
  writeFileSync(join(work, "bible", "period.md"), "# Period\n\nBy 1929 every ice house on the river had closed.\n");
  const r = await distill(vault, env, crosscheckResearcher([
    { document: "period brief", claim: "every ice house on the river had closed", fact: 1, why: "ice was still selling" },
    { document: "premise", claim: "x", fact: 99, why: "not a shown fact" },
    { document: "elsewhere", claim: "x", fact: 1, why: "not a shown document" },
  ]));
  expect(r.exitCode).toBe(0);
  const body = r.body as { contradictions: { document: string; claim: string; fact: string; source: string; why: string }[] };
  expect(body.contradictions).toEqual([
    { document: "period brief", claim: "every ice house on the river had closed", fact: "Ice sold for four dollars a ton.", source: "research/ice-prices-1929.md", why: "ice was still selling" },
  ]);
});

test("research distill's cross-check failing is a notice, not a failed distill", async () => {
  const { vault, env } = setup();
  const r = await distill(vault, env, fakeResearcher(ANSWER));
  expect(r.exitCode).toBe(0);
  const body = r.body as { contradictions: unknown[]; crosscheckNotice?: string };
  expect(body.contradictions).toEqual([]);
  expect(body.crosscheckNotice).toContain("core cross-check not run");
});
