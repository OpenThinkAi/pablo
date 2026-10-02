import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent } from "@openthink/pablo-core";
import { waitingBranches } from "../src/branch";
import { locateSelection, replacementLines, screenReviser } from "../src/screen-revise";

/**
 * The screen's reviser (AGT-1544): `reviseCore` against a fake Adapter and `take` on a temp git copy of the fixture
 * vault, with a think-free PATH and temp state/home/config dirs, so nothing reaches a model, `think`, or the author's
 * real directories.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const FILE = "chapters/01-the-last-full-cut.md";
const HEAD = "---\nchapter: 1\ntitle: The Last Full Cut\nstatus: draft\n---\n\n";
const BODY = [
  "The pond rang under the horse before it rang under the saws.",
  "Odile heard it from the scale house doorway.",
  "She wrote the time in the green book.",
  "",
  "Marcel had marked the grid at first light. Twenty-two inch squares.",
  "",
  "Wilfred came up the ramp.",
].join("\n");

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pablo-screen-revise-"));
  roots.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const project = join(vault, "novels", "ice-house");
  writeFileSync(join(project, FILE), `${HEAD}${BODY}\n`);
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "t@example.com");
  git(vault, "config", "user.name", "T");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  const env = { PATH: NO_THINK_PATH, XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), PABLO_HOME: join(dir, "home") };
  return { vault, project, env };
}

/** An adapter that answers `text` in two chunks and keeps the prompts it was sent. */
function adapter(text: string, prompts: string[] = []): Adapter {
  return {
    id: "local",
    model: "test-reviser-model",
    preferredOutput: "text",
    async *complete(req: { prompt: string }): AsyncIterable<CompletionEvent> {
      prompts.push(req.prompt);
      yield { type: "token", text: text.slice(0, 20) };
      yield { type: "token", text: text.slice(20) };
      yield { type: "done", stats: { timeToFirstTokenMs: 300, elapsedMs: 1200, tokensRead: 700, tokensWritten: 30, tokensPerSecond: 25 } };
    },
    async proposeEdit(): Promise<never> { throw new Error("not implemented"); },
    async extractFacts(): Promise<never> { throw new Error("not implemented"); },
  };
}

// The selection a screen would hand over: the second and third sentences of the first paragraph (stored lines 7 and 8).
const SELECTION = { file: FILE, sentences: ["Odile heard it from the scale house doorway.", "She wrote the time in the green book."], stored: { from: 7, to: 8 } };

test("locateSelection finds the selected sentences in their lines and keeps the rest of a line around them", () => {
  const raw = `${HEAD}${BODY}\n`;
  const lines = raw.split("\n");
  expect(lines[SELECTION.stored.from]).toBe(SELECTION.sentences[0]!);
  const whole = locateSelection(raw, SELECTION.sentences, SELECTION.stored)!;
  expect(raw.slice(whole.start, whole.end)).toBe(`${SELECTION.sentences[0]}\n${SELECTION.sentences[1]}`);
  expect([whole.prefix, whole.suffix]).toEqual(["", ""]);
  // an unsplit line holding two sentences, the second selected: the first stays as the prefix
  const at = lines.findIndex((l) => l.startsWith("Marcel"));
  const two = locateSelection(raw, ["Twenty-two inch squares."], { from: at, to: at })!;
  expect(raw.slice(two.start, two.end)).toBe("Twenty-two inch squares.");
  expect(two.prefix).toBe("Marcel had marked the grid at first light. ");
  expect(locateSelection(raw, ["x"], { from: 99, to: 99 })).toBeUndefined();
  expect(replacementLines("Squares, twenty-two inch. They were scored by the plow.", two)).toEqual(["Marcel had marked the grid at first light.", "Squares, twenty-two inch.", "They were scored by the plow."]);
});

test("revise sends the selection joined into a paragraph, streams partial text, unwraps a quoted answer, and writes nothing", async () => {
  const { vault, project, env } = setup();
  const before = readFileSync(join(project, FILE), "utf8");
  const prompts: string[] = [];
  const partials: string[] = [];
  const result = await screenReviser(vault, project, { adapter: adapter('"Odile heard the pond from the scale house. She wrote the time down first."', prompts), env })
    .revise({ ...SELECTION, instruction: "tighten it" }, (t) => partials.push(t));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.candidate).toBe("Odile heard the pond from the scale house. She wrote the time down first.");
  expect(result.model).toBe("test-reviser-model");
  expect(result.receipt).toMatch(/^[0-9a-f]{8,}/);
  expect(partials.length).toBeGreaterThan(0);
  expect(partials[partials.length - 1]).toBe(result.candidate);
  // the model sees one paragraph, never the sentence lines
  expect(prompts[0]).toContain("Odile heard it from the scale house doorway. She wrote the time in the green book.");
  expect(prompts[0]).not.toContain("doorway.\nShe wrote");
  expect(prompts[0]).toContain("tighten it");
  expect(readFileSync(join(project, FILE), "utf8")).toBe(before);
});

test("an empty instruction or a file outside the project is refused before any model call", async () => {
  const { vault, project, env } = setup();
  const prompts: string[] = [];
  const reviser = screenReviser(vault, project, { adapter: adapter("x", prompts), env });
  const none = await reviser.revise({ ...SELECTION, instruction: "  " }, () => {});
  expect(none.ok).toBe(false);
  const out = await reviser.revise({ ...SELECTION, file: "../../../etc/passwd", instruction: "x" }, () => {});
  expect(out.ok).toBe(false);
  expect(prompts).toEqual([]);
});

test("take commits the candidate on revise/<short-id> as the model with its receipt, one sentence per line, main untouched", async () => {
  const { vault, project, env } = setup();
  const reviser = screenReviser(vault, project, { adapter: adapter("Odile heard the pond from the scale house. She wrote the time down first."), env });
  const r = await reviser.revise({ ...SELECTION, instruction: "tighten it" }, () => {});
  if (!r.ok) throw new Error(r.message);
  const mainBefore = git(vault, "rev-parse", "main");
  const taken = await reviser.take({ ...SELECTION, instruction: "tighten it", candidate: r.candidate, offered: r.candidate, receipt: r.receipt, model: r.model });
  expect(taken.ok).toBe(true);
  if (!taken.ok) return;
  expect(taken.branch).toBe(`revise/${r.receipt.slice(0, 7)}`);
  expect(git(vault, "rev-parse", "main")).toBe(mainBefore);
  expect(readFileSync(join(project, FILE), "utf8")).toBe(`${HEAD}${BODY}\n`);

  const onBranch = git(vault, "show", `${taken.branch}:novels/ice-house/${FILE}`);
  expect(onBranch).toContain("The pond rang under the horse before it rang under the saws.\nOdile heard the pond from the scale house.\nShe wrote the time down first.\n\nMarcel");
  expect(onBranch).not.toContain("green book");
  expect(git(vault, "log", "-1", "--format=%an", taken.branch)).toBe("test-reviser-model");
  const message = git(vault, "log", "-1", "--format=%B", taken.branch);
  expect(message).toContain("tighten it");
  expect(message).toContain(`Receipt: ${r.receipt}`);
  expect(git(vault, "diff", "--name-only", `main...${taken.branch}`)).toBe(`novels/ice-house/${FILE}`);
  // the branch is the one the review lists
  const waiting = waitingBranches(vault);
  expect(waiting.ok && waiting.branches).toContain(taken.branch);
});

test("an edited candidate is what is committed, authored as the project's author, and a second take on the same receipt gets -v2", async () => {
  const { vault, project, env } = setup();
  const reviser = screenReviser(vault, project, { adapter: adapter("Odile heard the pond."), env });
  const r = await reviser.revise({ ...SELECTION, instruction: "shorter" }, () => {});
  if (!r.ok) throw new Error(r.message);
  const edited = "Odile heard the pond ring. Then she wrote the time.";
  const first = await reviser.take({ ...SELECTION, instruction: "shorter", candidate: edited, offered: r.candidate, receipt: r.receipt, model: r.model });
  const second = await reviser.take({ ...SELECTION, instruction: "shorter", candidate: edited, offered: r.candidate, receipt: r.receipt, model: r.model });
  if (!first.ok || !second.ok) throw new Error("take failed");
  expect(second.branch).toBe(`${first.branch}-v2`);
  expect(git(vault, "show", `${first.branch}:novels/ice-house/${FILE}`)).toContain("Odile heard the pond ring.\nThen she wrote the time.\n");
  expect(git(vault, "log", "-1", "--format=%an", first.branch)).toBe("matt");
  expect(git(vault, "log", "-1", "--format=%s", first.branch)).toContain("(edited)");
});

test("a mid-line selection keeps the rest of its line around the candidate", async () => {
  const { vault, project, env } = setup();
  const reviser = screenReviser(vault, project, { adapter: adapter("Squares of twenty-two inches."), env });
  const at = `${HEAD}${BODY}`.split("\n").findIndex((l) => l.startsWith("Marcel"));
  const sel = { file: FILE, sentences: ["Twenty-two inch squares."], stored: { from: at, to: at } };
  const r = await reviser.revise({ ...sel, instruction: "reword" }, () => {});
  if (!r.ok) throw new Error(r.message);
  const taken = await reviser.take({ ...sel, instruction: "reword", candidate: r.candidate, offered: r.candidate, receipt: r.receipt, model: r.model });
  if (!taken.ok) throw new Error(taken.message);
  expect(git(vault, "show", `${taken.branch}:novels/ice-house/${FILE}`)).toContain("Marcel had marked the grid at first light.\nSquares of twenty-two inches.\n");
});

test("take refuses, leaving no branch, when the candidate is empty or the chapter has changed under the selection", async () => {
  const { vault, project, env } = setup();
  const reviser = screenReviser(vault, project, { adapter: adapter("x"), env });
  const base = { ...SELECTION, instruction: "i", offered: "c", receipt: "abcdef0123456789", model: "m" };
  const empty = await reviser.take({ ...base, candidate: "   " });
  expect(empty.ok).toBe(false);
  // the live file moves on after the revise: the stored lines no longer hold the selection
  writeFileSync(join(project, FILE), `${HEAD}A new first line.\n${BODY}\n`);
  const stale = await reviser.take({ ...base, candidate: "Something else." });
  expect(stale.ok).toBe(false);
  if (!stale.ok) expect(stale.message).toContain("no longer");
  expect(git(vault, "branch", "--list", "revise/*")).toBe("");
  expect(existsSync(join(env.PABLO_HOME, "worktrees", "ice-house", "revise", "abcdef0"))).toBe(false);
});
