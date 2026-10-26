// AGT-2111 (pm project `pablo-platform`, D-9): the guided research checklist. `research plan` derives
// research/checklist.md from the period brief or thesis through the research agent (a fake adapter here, never a
// model); `research waive|link` and `research save --item` close items; the historical-fiction and nonfiction
// research gates pass only when every item is sourced or waived, and status/resume list the open ones. Every test
// works on a temp git copy of the fixture vault.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import type { Adapter, CompletionEvent, CompletionRequest } from "@openthink/pablo-core";
import { main } from "../src/cli";
import {
  CHECKLIST_FILE,
  checklistItems,
  itemStatus,
  mergeChecklist,
  PERIOD_CATEGORIES,
  parseChecklist,
  placeholderItem,
  renderChecklist,
} from "../src/core/checklist";
import { coreNext, coreStages, readCoreState, trackGate } from "../src/core/machine";
import { readResearchNotes } from "../src/distill";
import { mcpTools } from "../src/mcp";
import { parsePlanAnswer, planPrompt } from "../src/research-checklist";
import { buildResume, formatResumeProse } from "../src/resume";
import type { VerbContext, VerbResult } from "../src/verbs";
import { VERBS } from "../src/verbs";
import { formatStatusProse, readWorkStatus } from "../src/work-state";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK = { env: { PATH: "/nonexistent-bin-for-checklist-test" }, timeoutMs: 2000 };
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

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

const BRIEF = "# Period\n\nThe Hudson ice trade, winter 1888-89: the Great Blizzard, the Knickerbocker ice houses.\n";
const THESIS = "# Thesis\n\nThe ice house fed a town through the summer.\n";
const NOTE = (title: string) => `# ${title}\n\nRetrieved: 2026-10-26\n\nA finding.\n\n## Sources\n\n- https://example.org/${title}\n`;

/** A temp git copy of the fixture vault; `files` are written into the work before the first commit. */
function setup(track: string, files: Record<string, string> = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pablo-checklist-test-")));
  dirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  const markerPath = join(work, "pablo.json");
  writeFileSync(markerPath, JSON.stringify({ ...JSON.parse(readFileSync(markerPath, "utf8")), track }, null, 2));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(work, rel, ".."), { recursive: true });
    writeFileSync(join(work, rel), text);
  }
  execFileSync("git", ["init", "-q", "-b", "main", vault]);
  sh(vault, "config", "user.name", "Test");
  sh(vault, "config", "user.email", "t@t.example");
  sh(vault, "add", "-A");
  sh(vault, "commit", "-qm", "base");
  const env = { PABLO_VAULT: vault, PABLO_HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "config"), PATH: process.env["PATH"] ?? "" };
  return { vault, work, env };
}

function ctx(env: Record<string, string>, vault: string, researcher?: Adapter): VerbContext {
  return { cwd: vault, env, stderr: { write: () => {} }, ...(researcher ? { researcher } : {}) };
}

function research(vault: string, env: Record<string, string>, args: Record<string, unknown>, researcher?: Adapter): Promise<VerbResult> {
  const verb = VERBS.find((v) => v.name === "research")!;
  return verb.run({ project: "ice-house", source: [], item: [], ...args } as never, ctx(env, vault, researcher));
}

/** Merges a plan branch into main, as the author does after review. */
function merge(vault: string, branch: string): void {
  sh(vault, "merge", "-q", "--no-edit", branch);
}

const PLAN_ANSWER = {
  items: [
    { category: "people", item: "Who ran the Knickerbocker ice houses" },
    { category: "Daily life", item: "What a ton of ice cost in 1888" },
    { category: "technology", item: "How thick ice had to be to cut" },
    { category: "weather", item: "The blizzard's snowfall" },
    { category: "places", item: "" },
  ],
};

// --- the file: parse, status, render, merge -------------------------------------

test("a checklist row is waived with a reason, sourced by a sourced note, else open; the Status cell is not trusted", () => {
  const text =
    "# Research checklist\n\n| # | Category | Item | Status | Sources | Waived |\n| --- | --- | --- | --- | --- | --- |\n" +
    "| 1 | people | Who ran it | sourced | research/owners.md | |\n" +
    "| 2 | Daily life | Prices | sourced | missing-note | |\n" +
    "| 3 | language | Slang \\| cant | open | | never spoken on the page |\n" +
    "| x | dates | not a row | open | | |\n";
  const rows = parseChecklist(text);
  expect(rows.map((r) => [r.number, r.category, r.item])).toEqual([
    [1, "people", "Who ran it"],
    [2, "daily-life", "Prices"],
    [3, "language", "Slang | cant"],
  ]);
  const sourced = new Set(["owners"]);
  expect(rows.map((r) => itemStatus(r, sourced))).toEqual(["sourced", "open", "waived"]);
  // Rendering and reading back keeps every row and its status.
  const items = checklistItems(rows, sourced);
  const again = parseChecklist(renderChecklist(items, "period"));
  expect(checklistItems(again, sourced)).toEqual(items);
});

test("merging keeps existing rows, appends new items, rejects bad ones and gives an empty category a placeholder", () => {
  const existing = parseChecklist("| # | Category | Item | Status | Sources | Waived |\n|---|---|---|---|---|---|\n| 4 | people | Who ran the Knickerbocker ice houses | open | owners | |\n");
  const merged = mergeChecklist(existing, parsePlanAnswer(JSON.stringify(PLAN_ANSWER)) ?? [], PERIOD_CATEGORIES);
  expect(merged.rows[0]).toEqual(existing[0]!);
  expect(merged.rows.slice(1, 3).map((r) => [r.number, r.category, r.item])).toEqual([
    [5, "daily-life", "What a ton of ice cost in 1888"],
    [6, "technology", "How thick ice had to be to cut"],
  ]);
  expect(merged.rejected.map((r) => r.reason)).toEqual([
    "already on the checklist",
    '"weather" is not a checklist category (people, places, technology, language, daily-life, politics, dates)',
    "the item is empty",
  ]);
  // Every category is on the list: the ones the agent left empty get a placeholder to source or waive.
  expect(new Set(merged.rows.map((r) => r.category))).toEqual(new Set(PERIOD_CATEGORIES));
  expect(merged.rows.find((r) => r.category === "politics")?.item).toBe(placeholderItem("politics"));
});

test("the plan prompt carries the brief or the thesis and asks for the categories", () => {
  const period = planPrompt("period", BRIEF);
  expect(period).toContain("## Period brief");
  expect(period).toContain("Great Blizzard");
  for (const c of PERIOD_CATEGORIES) expect(period).toContain(c);
  const thesis = planPrompt("thesis", THESIS, { claims: "| 1 | x | y |" });
  expect(thesis).toContain("## Thesis");
  expect(thesis).toContain('category "claim"');
  expect(thesis).toContain("## Claims so far");
  expect(parsePlanAnswer("no json")).toBeUndefined();
});

// --- AC1: research plan -------------------------------------------------------

test("research plan writes research/checklist.md from the period brief on a plan branch, main untouched", async () => {
  const { vault, work, env } = setup("historical-fiction", { "bible/period.md": BRIEF });
  const researcher = fakeResearcher(PLAN_ANSWER);
  const r = await research(vault, env, { sub: "plan" }, researcher);
  expect(r.exitCode).toBe(0);
  const body = r.body as { path: string; branch: string; added: number; from: string; rejected: unknown[]; provider: string };
  expect(body.path).toBe(`novels/ice-house/${CHECKLIST_FILE}`);
  expect(body.branch).toMatch(/^plan\//);
  expect(body.from).toBe("bible/period.md");
  expect(body.provider).toBe("fake-research");
  expect(body.rejected).toHaveLength(2);
  expect(researcher.prompts[0]).toContain("Knickerbocker");
  expect(existsSync(join(work, CHECKLIST_FILE))).toBe(false);

  const text = sh(vault, "show", `${body.branch}:${body.path}`);
  expect(text).toContain("Derived from the period brief (bible/period.md)");
  const rows = parseChecklist(text);
  expect(rows.slice(0, 3).map((r) => r.item)).toEqual(["Who ran the Knickerbocker ice houses", "What a ton of ice cost in 1888", "How thick ice had to be to cut"]);
  expect(new Set(rows.map((r) => r.category))).toEqual(new Set(PERIOD_CATEGORIES));
  expect(text).toContain("| open |");
});

test("research plan on a nonfiction work derives claims to support from the thesis", async () => {
  const { vault, env } = setup("nonfiction", { "core/thesis.md": THESIS });
  const r = await research(vault, env, { sub: "plan" }, fakeResearcher({ items: [{ category: "claim", item: "Ice kept through August in sawdust" }] }));
  expect(r.exitCode).toBe(0);
  const body = r.body as { path: string; branch: string; from: string };
  expect(body.from).toBe("core/thesis.md");
  const rows = parseChecklist(sh(vault, "show", `${body.branch}:${body.path}`));
  expect(rows).toEqual([{ number: 1, category: "claim", item: "Ice kept through August in sawdust", sources: [] }]);
});

test("research plan refuses with no brief, and fails on an answer that is not the JSON asked for", async () => {
  const bare = setup("historical-fiction");
  const none = await research(bare.vault, bare.env, { sub: "plan" }, fakeResearcher(PLAN_ANSWER));
  expect(none.exitCode).toBe(2);
  expect((none.body as { message: string }).message).toContain("bible/period.md has no text");

  const { vault, env } = setup("historical-fiction", { "bible/period.md": BRIEF });
  const bad = await research(vault, env, { sub: "plan" }, fakeResearcher("I could not decide."));
  expect(bad.exitCode).toBe(1);
  expect((bad.body as { message: string }).message).toContain("did not answer with the checklist JSON");
});

// --- AC2: waive, link, save --item --------------------------------------------

const CHECKLIST =
  "| # | Category | Item | Status | Sources | Waived |\n| --- | --- | --- | --- | --- | --- |\n" +
  "| 1 | people | Who ran the ice houses | open | | |\n" +
  "| 2 | language | Ice-trade slang | open | | |\n" +
  "| 3 | technology | How thick ice had to be | open | | |\n";

test("research waive sets an item waived with its reason on a plan branch; no reason or no item is refused", async () => {
  const { vault, env } = setup("historical-fiction", { "bible/period.md": BRIEF, [CHECKLIST_FILE]: CHECKLIST });
  const r = await research(vault, env, { sub: "waive", entry: "#2", text: "the cutters never speak on the page" });
  expect(r.exitCode).toBe(0);
  const body = r.body as { path: string; branch: string; item: { status: string; waived: string }; open: number };
  expect(body.item).toMatchObject({ number: 2, status: "waived", waived: "the cutters never speak on the page" });
  expect(body.open).toBe(2);
  expect(sh(vault, "show", `${body.branch}:${body.path}`)).toContain("| 2 | language | Ice-trade slang | waived |  | the cutters never speak on the page |");

  expect((await research(vault, env, { sub: "waive", entry: "2", text: "  " })).exitCode).toBe(2);
  const unknown = await research(vault, env, { sub: "waive", entry: "9", text: "why" });
  expect((unknown.body as { message: string }).message).toContain("has no item #9");
});

test("research link closes an item with an existing sourced note; a note without sources is refused", async () => {
  const { vault, env } = setup("historical-fiction", {
    "bible/period.md": BRIEF,
    [CHECKLIST_FILE]: CHECKLIST,
    "research/owners.md": NOTE("owners"),
    "research/hunch.md": "# Hunch\n\nNo sources.\n",
  });
  const r = await research(vault, env, { sub: "link", entry: "1", text: "research/owners.md" });
  expect(r.exitCode).toBe(0);
  const body = r.body as { path: string; branch: string; item: { status: string; sources: string[] } };
  expect(body.item).toMatchObject({ status: "sourced", sources: ["owners"] });

  const hunch = await research(vault, env, { sub: "link", entry: "1", text: "hunch" });
  expect((hunch.body as { message: string }).message).toContain("has no ## Sources entry");
  const missing = await research(vault, env, { sub: "link", entry: "1", text: "nope" });
  expect((missing.body as { message: string }).message).toContain("research/nope.md does not exist");
});

test("research save --item writes the note and marks the item sourced on the same plan branch", async () => {
  const { vault, env } = setup("historical-fiction", { "bible/period.md": BRIEF, [CHECKLIST_FILE]: CHECKLIST });
  const r = await research(vault, env, { sub: "save", title: "Ice thickness", note: "A foot.", source: ["https://example.org/ice"], item: ["3"] });
  expect(r.exitCode).toBe(0);
  const body = r.body as { path: string; branch: string; note: string; items: { number: number; status: string }[]; open: number };
  expect(body.path).toBe("novels/ice-house/research/ice-thickness.md");
  expect(body.note).toBe("ice-thickness");
  expect(body.items).toMatchObject([{ number: 3, status: "sourced", sources: ["ice-thickness"] }]);
  expect(body.open).toBe(2);
  expect(parseChecklist(sh(vault, "show", `${body.branch}:novels/ice-house/${CHECKLIST_FILE}`))[2]?.sources).toEqual(["ice-thickness"]);

  // An unknown item is refused before anything is written.
  const before = sh(vault, "branch", "--list", "plan/*");
  const bad = await research(vault, env, { sub: "save", title: "Other", note: "x", source: ["s"], item: ["7"] });
  expect(bad.exitCode).toBe(2);
  expect(sh(vault, "branch", "--list", "plan/*")).toBe(before);
});

test("the checklist and the names map are never research notes for distill", () => {
  const { work } = setup("historical-fiction", { [CHECKLIST_FILE]: CHECKLIST, "research/owners.md": NOTE("owners") });
  expect(readResearchNotes(work).map((n) => n.id)).toEqual(["owners"]);
});

// --- AC3: the gates, status and resume ------------------------------------------

test("the historical research gate stays shut until every item is sourced or waived, and status/resume list open items", async () => {
  const { vault, work, env } = setup("historical-fiction", { "bible/period.md": BRIEF, "research/owners.md": NOTE("owners") });
  const stage = () => coreStages(readCoreState(work, "historical-fiction")).find((s) => s.id === "research");
  expect(stage()?.missing).toEqual(["research/checklist.md does not exist yet (pablo research plan)"]);
  expect(coreNext(readCoreState(work, "historical-fiction"))).toBe("plan the research checklist (pablo research plan)");

  // Plan, review, merge: three of the items are open.
  writeFileSync(join(work, CHECKLIST_FILE), CHECKLIST);
  expect(stage()).toMatchObject({ done: false, summary: "1 sourced note, checklist 0 sourced, 0 waived, 3 open" });
  expect(trackGate(readCoreState(work, "historical-fiction"))?.message).toBe("historical-fiction: checklist item #1 people: Who ran the ice houses is open");

  const status = readWorkStatus(work);
  expect(status.next).toStartWith("core: source or waive the open checklist items");
  const prose = formatStatusProse(status);
  expect(prose).toContain("open research (research/checklist.md):");
  expect(prose).toContain("  - #2 language: Ice-trade slang");
  const resumed = await buildResume(work, "ice-house", NO_THINK);
  expect(resumed.open.slice(0, 3).map((o) => o.text)).toEqual([
    "#1 people: Who ran the ice houses (open in research/checklist.md)",
    "#2 language: Ice-trade slang (open in research/checklist.md)",
    "#3 technology: How thick ice had to be (open in research/checklist.md)",
  ]);
  expect(formatResumeProse(resumed)).toContain("  - #3 technology: How thick ice had to be (open in research/checklist.md)");

  // Close them through the verbs, merging each branch as the author would.
  sh(vault, "add", "-A");
  sh(vault, "commit", "-qm", "checklist");
  for (const args of [
    { sub: "link", entry: "1", text: "owners" },
    { sub: "waive", entry: "2", text: "no dialogue in the trade's slang" },
  ]) {
    const r = await research(vault, env, args);
    expect(r.exitCode).toBe(0);
    merge(vault, (r.body as { branch: string }).branch);
  }
  expect(stage()?.done).toBe(false);
  const saved = await research(vault, env, { sub: "save", title: "Ice thickness", note: "A foot.", source: ["https://example.org/ice"], item: ["3"] });
  merge(vault, (saved.body as { branch: string }).branch);
  expect(stage()).toMatchObject({ done: true, summary: "2 sourced notes, checklist 2 sourced, 1 waived, 0 open", missing: [] });
  expect(formatStatusProse(readWorkStatus(work))).not.toContain("open research");
});

test("the nonfiction research gate needs the checklist closed too; fiction research stays optional", () => {
  const { work } = setup("nonfiction", { "core/thesis.md": THESIS, "research/owners.md": NOTE("owners"), [CHECKLIST_FILE]: "| # | Category | Item | Status | Sources | Waived |\n|---|---|---|---|---|---|\n| 1 | claim | Ice fed the town | open | | |\n" });
  expect(trackGate(readCoreState(work, "nonfiction"))?.message).toBe("nonfiction: checklist item #1 claim: Ice fed the town is open");
  writeFileSync(join(work, CHECKLIST_FILE), "| # | Category | Item | Status | Sources | Waived |\n|---|---|---|---|---|---|\n| 1 | claim | Ice fed the town | open | owners | |\n");
  expect(coreStages(readCoreState(work, "nonfiction")).find((s) => s.id === "research")?.done).toBe(true);

  const fiction = setup("fiction", { [CHECKLIST_FILE]: CHECKLIST });
  const research = coreStages(readCoreState(fiction.work, "fiction")).find((s) => s.id === "research");
  expect(research?.optional).toBe(true);
  expect(trackGate(readCoreState(fiction.work, "fiction"))).toBeUndefined();
});

// --- MCP and CLI ---------------------------------------------------------------------

test("plan_research, waive_research_item and link_research_item are MCP tools; save_research takes items", async () => {
  const tools = mcpTools();
  for (const name of ["plan_research", "waive_research_item", "link_research_item"]) expect(tools.some((t) => t.name === name)).toBe(true);
  expect(Object.keys(tools.find((t) => t.name === "save_research")?.args.shape ?? {})).toContain("items");

  const { vault, env } = setup("historical-fiction", { "bible/period.md": BRIEF, [CHECKLIST_FILE]: CHECKLIST });
  const waive = tools.find((t) => t.name === "waive_research_item")!;
  const r = await waive.run({ project: "ice-house", item: 1, reason: "a minor character" }, ctx(env, vault));
  expect(r.exitCode).toBe(0);
  const plan = tools.find((t) => t.name === "plan_research")!;
  const p = await plan.run({ project: "ice-house" }, ctx(env, vault, fakeResearcher(PLAN_ANSWER)));
  expect(p.exitCode).toBe(0);
});

test("the CLI takes waive's item and reason as positionals", async () => {
  const { vault, env } = setup("historical-fiction", { "bible/period.md": BRIEF, [CHECKLIST_FILE]: CHECKLIST });
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const logs: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    expect(await main(["research", "waive", "2", "never spoken", "--project", "ice-house"], vault)).toBe(0);
  } finally {
    console.log = log;
    console.error = err;
    for (const k of Object.keys(env)) if (saved[k] === undefined) delete process.env[k];
    Object.assign(process.env, saved);
  }
  expect(logs.join("\n")).toContain("#2 language: Ice-trade slang -> waived");
});
