/**
 * Checking a pending draft before it is accepted (AGT-2188, pm project `pablo-platform`, D-10, D-22): `check --unit N`
 * and `--branch` read the draft's branch when main lacks the unit, the post-write check runs for every essay
 * section, an empty scan says "nothing to check", and `--strict` fails on a hit. No test reaches a model.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent } from "@openthink/pablo-core";
import { checkWork, checkWorkOrPending, runCheck } from "../src/check";
import { initTrack } from "../src/init";
import { mergeDraft } from "../src/novel/merge";
import { addOutput } from "../src/output-verbs";
import { runWrite } from "../src/write";
import type { WriteArgs } from "../src/write";
import { useLocalConfigHome } from "./local-config";

useLocalConfigHome();

const CONFORMANCE = fileURLToPath(new URL("./fixtures/conformance", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const STATE_HOME = mkdtempSync(join(tmpdir(), "pablo-essay-state-"));
const NOW = () => new Date("2026-10-26T12:00:00Z");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => rmSync(STATE_HOME, { recursive: true, force: true }));

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8").trim();
}

const THESIS = "# Thesis\n\nThe printing press changed who could argue in public.\n";
const CLAIMS = "# Claims\n\n| # | Claim | Sources |\n|---|---|---|\n| 1 | Gutenberg's press was working in Mainz by 1455 | gutenberg |\n| 2 | Pamphlets spread Luther's theses within weeks | luther-pamphlets |\n| 3 | Literacy rose in print towns | literacy |\n";
const OUTLINE = "# Outline\n\n| # | Section | What it covers |\n|---|---|---|\n| 1 | The press arrives | Mainz and the first books (#1) |\n| 2 | The pamphlet war | Luther and speed (#2, #3) |\n| 3 | Who reads now | What changed |\n";
const NOTE = (id: string, title: string): string => `# ${title}\n\nRetrieved: 2026-10-20\n\nThe raw note about ${id}, never sent to the writer.\n\n## Sources\n\n- https://example.org/${id}\n`;

/** A git vault (the conformance fixture's `style/`) holding a nonfiction work with a full core and, optionally, the essay output. */
function nonfiction(opts: { essay?: boolean } = {}): { vault: string; work: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "pablo-essay-"));
  dirs.push(root);
  const vault = join(root, "vault");
  cpSync(CONFORMANCE, vault, { recursive: true });
  rmSync(join(vault, "novels"), { recursive: true, force: true });
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "config", "commit.gpgsign", "false");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  const made = initTrack(vault, "the-press", "The Press", "nonfiction", { now: NOW, author: "Test Author" });
  if (!made.ok) throw new Error(made.message);
  const work = made.path;
  writeFileSync(join(work, "core", "thesis.md"), THESIS);
  writeFileSync(join(work, "core", "claims.md"), CLAIMS);
  writeFileSync(join(work, "core", "outline.md"), OUTLINE);
  writeFileSync(join(work, "research", "gutenberg.md"), NOTE("gutenberg", "Gutenberg in Mainz"));
  writeFileSync(join(work, "research", "luther-pamphlets.md"), NOTE("luther-pamphlets", "Luther's pamphlets"));
  writeFileSync(join(work, "research", "literacy.md"), NOTE("literacy", "Literacy in print towns"));
  writeFileSync(
    join(work, "research", "checklist.md"),
    "| # | Category | Item | Status | Sources | Waived |\n| --- | --- | --- | --- | --- | --- |\n| 1 | claim | The press | waived | | common knowledge |\n",
  );
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "the core");
  if (opts.essay === true) {
    const added = addOutput(vault, work, "essay", { now: NOW });
    if (!added.ok) throw new Error(`output add failed: ${JSON.stringify(added)}`);
  }
  return { vault, work, home: join(root, "pablo-home") };
}

/** A writer that answers one paragraph with a citation, plus a stray heading it should not keep. */
function fakeEssayWriter(text = "## A heading the writer added\n\nMainz had a working press by 1455 [#1]. It changed what a town could read."): Adapter {
  return {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text",
    async *complete(): AsyncIterable<CompletionEvent> {
      yield { type: "token", text };
      yield { type: "done", stats: { timeToFirstTokenMs: 10, elapsedMs: 20, tokensRead: 100, tokensWritten: 30, tokensPerSecond: 600 } };
    },
    async proposeEdit(): Promise<never> {
      throw new Error("not used");
    },
    async extractFacts(): Promise<never> {
      throw new Error("not used");
    },
  };
}

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const log = console.log;
  console.log = (text: unknown) => void lines.push(String(text));
  return { lines, restore: () => void (console.log = log) };
}

async function write(vault: string, work: string, home: string, unit: string, extra: Partial<WriteArgs> = {}, adapter = fakeEssayWriter()): Promise<{ code: number; body: Record<string, unknown> }> {
  const out = capture();
  let code: number;
  try {
    code = await runWrite(
      { chapter: undefined, output: "essay", unit, words: undefined, scenes: undefined, dryRun: false, json: true, force: false, ...extra } as WriteArgs,
      vault,
      work,
      { adapter, env: { PATH: NO_THINK_PATH, XDG_STATE_HOME: STATE_HOME, PABLO_HOME: home }, stderr: { write: () => {} }, now: NOW },
    );
  } finally {
    out.restore();
  }
  return { code, body: JSON.parse(out.lines.join("\n") || "{}") as Record<string, unknown> };
}

const DASHED = "Mainz had a working press by 1455 [#1]. Little did he know how it would change what a town could read.";

test("check --unit N checks section N's pending draft, and main alone still refuses it", async () => {
  const { vault, work, home } = nonfiction({ essay: true });
  const first = await write(vault, work, home, "1", {}, fakeEssayWriter(DASHED));
  expect(first.code).toBe(0);
  const env = { PATH: NO_THINK_PATH, PABLO_HOME: home };
  expect(checkWork(vault, work, undefined, "essay", 1).ok).toBe(false);
  const picked = checkWorkOrPending(vault, work, undefined, "essay", 1, undefined, env);
  expect(picked.outcome.ok).toBe(true);
  if (!picked.outcome.ok) return;
  expect(picked.outcome.branch).toBe("draft/essay-01");
  expect(picked.workDir).not.toBe(work);
  expect(picked.outcome.hits.some((h) => h.rule === "foreshadow" && h.path === "outputs/essay/essay.md")).toBe(true);
  // A unit with no draft anywhere is still the old refusal.
  const none = checkWorkOrPending(vault, work, undefined, "essay", 3, undefined, env);
  expect(none.outcome.ok).toBe(false);
  if (!none.outcome.ok) expect(none.outcome.message).toContain("has no unit 3");
});

test("check --branch checks that draft branch's units", async () => {
  const { vault, work, home } = nonfiction({ essay: true });
  await write(vault, work, home, "1", {}, fakeEssayWriter(DASHED));
  const env = { PATH: NO_THINK_PATH, PABLO_HOME: home };
  const picked = checkWorkOrPending(vault, work, undefined, "essay", undefined, "draft/essay-01", env);
  expect(picked.outcome.ok && picked.outcome.branch).toBe("draft/essay-01");
  const missing = checkWorkOrPending(vault, work, undefined, "essay", undefined, "draft/nope", env);
  expect(missing.outcome.ok).toBe(false);
  if (!missing.outcome.ok) expect(missing.outcome.message).toContain("no such branch");
});

test("the post-write check runs for every essay section, not only the first", async () => {
  const { vault, work, home } = nonfiction({ essay: true });
  await write(vault, work, home, "1");
  const merged = await mergeDraft(work, "draft/essay-01", { slug: "the-press", env: { PATH: NO_THINK_PATH }, now: NOW });
  expect(merged.ok).toBe(true);
  const second = await write(vault, work, home, "2", {}, fakeEssayWriter("Luther's theses were in print within weeks [#2]. Little did he know what came next."));
  expect(second.code).toBe(0);
  const hits = second.body["check"] as Array<{ rule: string }>;
  expect(hits.some((h) => h.rule === "foreshadow")).toBe(true);
  expect(second.body["checkNotices"] ?? []).toEqual([]);
});

test("check with nothing drafted says nothing to check, naming the output", async () => {
  const { vault, work } = nonfiction({ essay: true });
  const out = capture();
  let code: number;
  try {
    code = await runCheck({ json: false, file: undefined, output: "essay" }, vault, work);
  } finally {
    out.restore();
  }
  expect(code).toBe(0);
  expect(out.lines.join("\n")).toContain("nothing to check: no drafted sections in outputs/essay/ (essay output)");
  expect(out.lines.join("\n")).not.toContain("no hits");
});

test("check --strict exits 1 when a hit is reported, 0 otherwise", async () => {
  const { vault, work, home } = nonfiction({ essay: true });
  await write(vault, work, home, "1", {}, fakeEssayWriter(DASHED));
  const prev = process.env["PABLO_HOME"];
  process.env["PABLO_HOME"] = home;
  const out = capture();
  try {
    const loose = await runCheck({ json: true, file: undefined, output: "essay", unit: "1" }, vault, work);
    const strict = await runCheck({ json: true, file: undefined, output: "essay", unit: "1", strict: true }, vault, work);
    expect(loose).toBe(0);
    expect(strict).toBe(1);
    const body = JSON.parse(out.lines[0] as string) as { branch?: string };
    expect(body.branch).toBe("draft/essay-01");
  } finally {
    out.restore();
    if (prev === undefined) delete process.env["PABLO_HOME"];
    else process.env["PABLO_HOME"] = prev;
  }
  // Nothing drafted, nothing to report: strict passes.
  const clean = nonfiction({ essay: true });
  const quiet = capture();
  try {
    expect(await runCheck({ json: true, file: undefined, output: "essay", strict: true }, clean.vault, clean.work)).toBe(0);
  } finally {
    quiet.restore();
  }
});
