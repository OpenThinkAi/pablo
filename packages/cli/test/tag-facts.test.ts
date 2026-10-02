import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import { scanFacts } from "@openthink/pablo-core";
import type { Adapter } from "@openthink/pablo-core";
import { runAgent } from "../src/harness/agent";
import { adapterClassifier, factFiles, parseProposals, runTagFacts } from "../src/harness/tag-facts";
import { startPlanSession } from "../src/plan";
import { type TagClassifier, tagFactsInFile } from "../src/record-fact";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const cleanupDirs: string[] = [];

function sh(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pablo-tagfacts-test-")));
  cleanupDirs.push(dir);
  const repo = join(dir, "vault");
  cpSync(FIXTURE_VAULT, repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "t@t.example");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "base");
  const env = { PABLO_VAULT: repo, PABLO_HOME: join(dir, "home"), PATH: "/usr/bin:/bin", HOME: dir, XDG_CONFIG_HOME: join(dir, "config") };
  return { dir, repo, work: join(repo, "novels/ice-house"), env };
}

afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

const invented: TagClassifier = async (_file, targets) => targets.map((t) => ({ index: t.index, kind: "invented" }));
const sink = () => {
  const lines: string[] = [];
  return { lines, write: (s: string) => (lines.push(s), true) };
};

test("running it on the fixture vault leaves no untagged fact on the plan branch, and never touches a chapter", async () => {
  const { repo, work, env } = setup();
  const out = sink();
  const code = await runTagFacts("ice-house", { cwd: repo, env, stdout: out, stderr: sink() }, { classify: invented, session: startPlanSession(repo, "ice-house", { env, date: "2026-10-01", id: "t1" }) });
  expect(code).toBe(0);

  const branch = "plan/2026-10-01-t1";
  const changed = sh(repo, "diff", "--name-only", `main..${branch}`).trim().split("\n");
  expect(changed.length).toBeGreaterThan(1);
  expect(changed.every((f) => f.startsWith("novels/ice-house/bible/") || f === "novels/ice-house/continuity.md")).toBe(true);
  expect(changed.some((f) => f.includes("chapters/") || f.includes("research/") || f.includes("notes/"))).toBe(false);

  for (const where of factFiles(work)) {
    const rel = where === "continuity" ? "continuity.md" : where;
    const text = sh(repo, "show", `${branch}:novels/ice-house/${rel}`);
    expect(scanFacts(text).untagged).toEqual([]);
  }
  // main and the working tree are untouched; commits are pablo's, one per file.
  expect(sh(repo, "status", "--porcelain").trim()).toBe("");
  expect(sh(repo, "log", "--format=%an|%s", `main..${branch}`).trim().split("\n").every((l) => l.startsWith("pablo|tag facts:"))).toBe(true);
  expect(out.lines.join("")).toContain(`facts tagged on ${branch}`);
});

test("a wrapped bullet becomes one tagged line and its chapter tag is kept", async () => {
  const { repo, work, env } = setup();
  const session = startPlanSession(repo, "ice-house", { env, date: "2026-10-01", id: "t2" });
  const r = await tagFactsInFile(session, work, "continuity", invented);
  expect(r.ok).toBe(true);
  const text = readFileSync(join(session.worktree as string, "novels/ice-house/continuity.md"), "utf8");
  expect(text).toContain("- The tally book is a green ledger with a broken spine, kept on the scale house windowsill. [ch01 §2] [invented]\n");
  expect(text).toContain("- Odile Nadeau is seventeen in January 1929. [ch01 §2] [invented]\n");
  // Non-fact lines are byte-for-byte the same.
  expect(text).toContain("## Who knows what\n");
  expect(text.endsWith("\n")).toBe(true);
});

test("a researched tag keeps its source; a bad or missing proposal defaults to author", async () => {
  const { repo, work, env } = setup();
  const session = startPlanSession(repo, "ice-house", { env, date: "2026-10-01", id: "t3" });
  const classify: TagClassifier = async () => [
    { index: 0, kind: "researched", source: "Smith, Ice Trade, p. 12" },
    { index: 1, kind: "researched" }, // no source: refused by the writer's rules
    { index: 2, kind: "bogus" },
    // 3.. missing
  ];
  const r = await tagFactsInFile(session, work, "continuity", classify);
  expect(r.ok && r.defaulted).toBe(r.ok ? r.tagged - 1 : 0);
  const facts = scanFacts(readFileSync(join(session.worktree as string, "novels/ice-house/continuity.md"), "utf8")).facts;
  expect(facts[0]?.fact.provenance).toEqual({ kind: "researched", source: "Smith, Ice Trade, p. 12" });
  expect(facts.slice(1).every((f) => f.fact.provenance?.kind === "author")).toBe(true);
});

test("a file with nothing untagged writes nothing and creates no branch", async () => {
  const { repo, work, env } = setup();
  const first = startPlanSession(repo, "ice-house", { env, date: "2026-10-01", id: "t4" });
  await tagFactsInFile(first, work, "continuity", invented);
  // The tagged text, committed on main, is a second session's input.
  sh(repo, "merge", "-q", "--ff-only", first.branch);
  const second = startPlanSession(repo, "ice-house", { env, date: "2026-10-01", id: "t5" });
  const r = await tagFactsInFile(second, work, "continuity", async () => {
    throw new Error("classifier must not be called");
  });
  expect(r).toMatchObject({ ok: true, tagged: 0 });
  expect(second.worktree).toBeUndefined();
});

test("research and chapters are not targets", async () => {
  const { repo, work, env } = setup();
  const session = startPlanSession(repo, "ice-house", { env, id: "t6" });
  for (const where of ["research/notes", "chapters/01-the-last-full-cut", "../x"]) {
    const r = await tagFactsInFile(session, work, where, invented);
    expect(r.ok).toBe(false);
  }
  expect(session.worktree).toBeUndefined();
  expect(factFiles(work).some((f) => f.startsWith("chapters") || f.startsWith("research"))).toBe(false);
});

test("parseProposals reads a fenced or chatty JSON answer and drops junk", () => {
  expect(parseProposals('```json\n[{"index":0,"kind":"invented"},{"index":1,"kind":"researched","source":"S"},{"x":1}]\n```')).toEqual([
    { index: 0, kind: "invented" },
    { index: 1, kind: "researched", source: "S" },
  ]);
  expect(parseProposals("Sure! [{\"index\":2,\"kind\":\"author\"}] done")).toEqual([{ index: 2, kind: "author" }]);
  expect(parseProposals("no json")).toEqual([]);
  expect(parseProposals("[not json]")).toEqual([]);
});

test("the planner classifier sends the facts and the research notes to the adapter it is given", async () => {
  const prompts: string[] = [];
  const adapter = {
    id: "fake",
    model: "fake",
    preferredOutput: "text",
    async *complete(req: { prompt: string }) {
      prompts.push(req.prompt);
      yield { type: "token", text: '[{"index":0,"kind":"author"}]' };
    },
  } as unknown as Adapter;
  const out = await adapterClassifier(adapter, "### research/ice.md\nIce notes")([ "continuity.md"][0] as string, [{ index: 0, heading: "## Dates", line: "- The cut began." }]);
  expect(out).toEqual([{ index: 0, kind: "author" }]);
  expect(prompts[0]).toContain("The cut began.");
  expect(prompts[0]).toContain("Ice notes");
});

test("`pablo agent --tag-facts` runs through runAgent with no message, using the injected classifier", async () => {
  const { repo, env } = setup();
  const out = sink();
  const err = sink();
  const code = await runAgent({ project: "ice-house", message: undefined, json: false, tagFacts: true }, { cwd: repo, env, stdout: out, stderr: err }, { tagFacts: { classify: invented } });
  expect(code).toBe(0);
  expect(err.lines).toEqual([]);
  expect(sh(repo, "branch", "--list", "--format=%(refname:short)", "plan/*").trim()).toStartWith("plan/");
});

test("--tag-facts without a project is a refusal", async () => {
  const { repo, env } = setup();
  const err = sink();
  expect(await runAgent({ project: undefined, message: undefined, json: false, tagFacts: true }, { cwd: repo, env, stdout: sink(), stderr: err })).toBe(2);
});
