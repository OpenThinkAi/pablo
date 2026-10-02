import { afterAll, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent, CompletionRequest, CompletionStats } from "@openthink/pablo-core";
import { EndpointHung, normalizeOutput, splitManuscript } from "@openthink/pablo-core";
import type { ProgressSink, RunWriteDeps, WriteArgs } from "../src/write";
import { runWrite } from "../src/write";
import { worktreePath } from "../src/branch";
import { mergeDraft } from "../src/novel/merge";

/**
 * `runWrite`'s send path (AGT-1237) — exercised by calling it directly
 * against a fake `Adapter` (see `RunWriteDeps.adapter`) so no test ever
 * touches the network, on a throwaway copy of the synthetic fixture vault
 * (never `~/writing`). `cli.test.ts`/`write.test.ts` still cover the
 * `--dry-run` path (and everything argv-parsing) by spawning the real bin.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

/**
 * A PATH that can still run `git` (the AGT-1231 rituals' git step) but
 * resolves no `think` — same pattern as `cli.test.ts`'s `NO_THINK_PATH`.
 * `runWrite` now runs the after-write rituals unconditionally on the live
 * path, and one of them shells out to `think`; every test in this file must
 * pass this as `deps.env` or it would make a real `think sync` call against
 * the dev machine's actual cortex.
 */
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
/**
 * AGT-1536: `write` commits on a `draft/chNN` worktree under `$PABLO_HOME`
 * (default `~/.cache/pablo`), so every env here pins `PABLO_HOME` at a
 * directory inside the test's own temp dir — worktree paths are keyed by
 * project slug and branch only, and would collide across tests (and leak into
 * the author's real cache) otherwise.
 */
function ritualEnv(vault: string): Record<string, string> {
  return { PATH: NO_THINK_PATH, PABLO_HOME: join(vault, "..", "pablo-home") };
}

/** Where `write --chapter 2` put its chapter file: inside the draft branch's worktree. */
function draftChapterFile(vault: string, branch = "draft/ch02"): string {
  const home = ritualEnv(vault)["PABLO_HOME"];
  return join(worktreePath("ice-house", branch, { PABLO_HOME: home }), "novels", "ice-house", "chapters", "02-black-ice.md");
}

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8").trim();
}

function tempVault(): { vault: string; project: string } {
  const dir = mkdtempSync(join(tmpdir(), "pablo-write-send-test-"));
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  return { vault, project: join(vault, "novels", "ice-house") };
}

/** Raw model text with one em-dash and one pair of curly quotes — normalization has real work to do. */
const RAW_TEXT =
  "The storm came up from the coast—sharp and sudden. " +
  "“Come in,” she said, though nothing in her voice welcomed him.";

/** The same text, split into a few streamed chunks — never one giant token. */
const RAW_CHUNKS = [
  "The storm came up from the coast",
  "—sharp and sudden. ",
  "“Come in,” she said, ",
  "though nothing in her voice welcomed him.",
];

const FAKE_STATS: CompletionStats = {
  timeToFirstTokenMs: 420,
  elapsedMs: 1830,
  tokensRead: 1200,
  tokensWritten: 42,
  tokensPerSecond: 30,
};

function fakeAdapter(options: {
  /** Receives each `complete` request, so a test can see what sampling was sent. */
  readonly onRequest?: (request: CompletionRequest) => void;
  readonly chunks?: readonly string[];
  readonly error?: Error;
  readonly stats?: CompletionStats;
  readonly model?: string;
}): Adapter {
  return {
    id: "local",
    model: options.model ?? "test-writer-model",
    preferredOutput: "text",
    async *complete(request: CompletionRequest): AsyncIterable<CompletionEvent> {
      options.onRequest?.(request);
      if (options.error) throw options.error;
      for (const chunk of options.chunks ?? []) {
        yield { type: "token", text: chunk };
      }
      yield { type: "done", stats: options.stats ?? FAKE_STATS };
    },
    async proposeEdit(): Promise<never> {
      throw new Error("fakeAdapter: proposeEdit is not implemented");
    },
    async extractFacts(): Promise<never> {
      throw new Error("fakeAdapter: extractFacts is not implemented");
    },
  };
}

/** An adapter whose stream never yields anything at all — not even `done`. */
function emptyStreamAdapter(): Adapter {
  return {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text",
    async *complete(): AsyncIterable<CompletionEvent> {
      // yields nothing
      await Promise.resolve();
    },
    async proposeEdit(): Promise<never> {
      throw new Error("fakeAdapter: proposeEdit is not implemented");
    },
    async extractFacts(): Promise<never> {
      throw new Error("fakeAdapter: extractFacts is not implemented");
    },
  };
}

function progressSink(): { sink: ProgressSink; lines: string[] } {
  const lines: string[] = [];
  return { sink: { write: (text: string) => lines.push(text) }, lines };
}

/** Captures every `console.log` call made during `fn`, restoring it afterward even on throw. */
async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
  // eslint-disable-next-line no-console
  console.log = ((...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  }) as typeof console.log;
  try {
    const result = await fn();
    return { result, lines };
  } finally {
    console.log = original;
  }
}

function baseArgs(overrides: Partial<WriteArgs> = {}): WriteArgs {
  return { chapter: "2", words: undefined, scenes: undefined, dryRun: false, json: true, force: false, ...overrides };
}

function receiptLines(projectPath: string): Array<Record<string, unknown>> {
  const text = readFileSync(join(projectPath, ".pablo", "receipts.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("runWrite sends, normalizes, and writes the chapter file with a fake adapter (AC1, AC2, AC3)", async () => {
  const { vault, project } = tempVault();

  const dryRun = await captureStdout(() => runWrite(baseArgs({ dryRun: true }), vault, project));
  const dryRunBody = JSON.parse(dryRun.lines[0] as string);

  const { sink, lines: progressLines } = progressSink();
  const deps: RunWriteDeps = {
    adapter: fakeAdapter({ chunks: RAW_CHUNKS }),
    now: () => new Date("2026-09-06T12:00:00.000Z"),
    stderr: sink,
    env: ritualEnv(vault),
  };

  const sent = await captureStdout(() => runWrite(baseArgs(), vault, project, deps));
  expect(sent.result).toBe(0);
  expect(sent.lines).toHaveLength(1); // AC4: stdout carries only the JSON

  const body = JSON.parse(sent.lines[0] as string);
  expect(body.ok).toBe(true);
  expect(body.path).toBe("chapters/02-black-ice.md");

  // AGT-1536: the chapter is committed on draft/ch02 in a worktree; main has no chapter 2.
  expect(body.branch).toBe("draft/ch02");
  const filePath = draftChapterFile(vault);
  expect(body.worktree).toBe(join(vault, "..", "pablo-home", "worktrees", "ice-house", "draft", "ch02"));
  expect(existsSync(filePath)).toBe(true);
  expect(existsSync(join(project, "chapters", "02-black-ice.md"))).toBe(false);
  expect(git(vault, "branch", "--show-current")).toBe("main");
  expect(git(vault, "log", "-1", "--format=%s", "main")).toBe("base");
  expect(git(vault, "log", "-1", "--format=%an|%B", "draft/ch02")).toContain("test-writer-model|ice-house: draft chapter 2");
  expect(git(vault, "log", "-1", "--format=%B", "draft/ch02")).toContain(`Receipt: ${dryRunBody.prompt_hash}`);
  expect(git(vault, "show", "--name-only", "--format=", "draft/ch02")).toBe("novels/ice-house/chapters/02-black-ice.md");
  // The after-write steps wait for the merge: none of them touched main's tree.
  expect(git(vault, "status", "--porcelain", "-uno")).toBe("");
  // No review queue (AGT-1541): the branch is the thing waiting for review, and the body says no more than that.
  expect(Object.keys(body)).not.toContain("rituals");
  expect(Object.keys(body)).not.toContain("piece");
  const fileText = readFileSync(filePath, "utf8");

  const lines = fileText.split("\n");
  expect(lines[0]).toBe("---");
  const keyOf = (line: string): string => (line.split(":")[0] ?? "").trim();
  const keys = lines.slice(1, 10).map(keyOf);
  expect(keys).toEqual(["chapter", "title", "pov", "story_date", "status", "words", "model", "generated", "prompt_hash"]);
  expect(lines[10]).toBe("---");

  expect(fileText).toContain("chapter: 2");
  expect(fileText).toContain("status: draft");
  expect(fileText).toContain("model: test-writer-model");
  expect(fileText).toContain("generated: 2026-09-06T12:00:00.000Z");
  expect(fileText).toContain(`prompt_hash: ${dryRunBody.prompt_hash}`);

  // AGT-1531: saved one sentence per line.
  const expectedNormalized = normalizeOutput(RAW_TEXT);
  expect(fileText).toContain(splitManuscript(expectedNormalized));
  expect(fileText).toContain("sharp and sudden.\n\"Come in,\"");
  expect(fileText).not.toContain("—"); // no em-dash
  expect(fileText).not.toMatch(/[“”‘’]/); // no curly quotes

  const expectedWords = expectedNormalized.split(/\s+/).filter((w) => w !== "").length;
  expect(fileText).toContain(`words: ${expectedWords}`);
  expect(body.receipt.words).toBe(expectedWords);

  const receipts = receiptLines(project);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]?.["prompt_hash"]).toBe(dryRunBody.prompt_hash);
  expect(body.receipt.prompt_hash).toBe(dryRunBody.prompt_hash);

  // AC4: progress went to the injected stderr sink, not stdout.
  expect(progressLines.some((l) => /waiting for first token/.test(l))).toBe(true);
  expect(progressLines.some((l) => /first token after/.test(l))).toBe(true);

  rmSync(vault, { recursive: true, force: true });
});

test("the human receipt names the branch (AGT-1536 AC3)", async () => {
  const { vault, project } = tempVault();
  const deps: RunWriteDeps = { adapter: fakeAdapter({ chunks: RAW_CHUNKS }), env: ritualEnv(vault) };
  const sent = await captureStdout(() => runWrite(baseArgs({ json: false }), vault, project, deps));
  expect(sent.result).toBe(0);
  expect(sent.lines[0]).toBe("wrote chapters/02-black-ice.md (" + sent.lines[0]?.match(/\((\d+) words\)/)?.[1] + " words) on branch draft/ch02");
  rmSync(vault, { recursive: true, force: true });
});

test("a second draft of the same chapter goes to draft/ch02-v2 and leaves the first alone (AGT-1536)", async () => {
  const { vault, project } = tempVault();
  await captureStdout(() => runWrite(baseArgs(), vault, project, { adapter: fakeAdapter({ chunks: RAW_CHUNKS }), env: ritualEnv(vault) }));
  const second = await captureStdout(() =>
    runWrite(baseArgs(), vault, project, { adapter: fakeAdapter({ chunks: ["A second, different draft."] }), env: ritualEnv(vault) }),
  );
  expect(second.result).toBe(0);
  expect(JSON.parse(second.lines[0] as string).branch).toBe("draft/ch02-v2");
  expect(readFileSync(draftChapterFile(vault, "draft/ch02-v2"), "utf8")).toContain("A second, different draft.");
  expect(readFileSync(draftChapterFile(vault), "utf8")).toContain("sharp and sudden");
  rmSync(vault, { recursive: true, force: true });
});

test("a project outside any git repository refuses (exit 2) before the model is called (AGT-1536)", async () => {
  const { vault, project } = tempVault();
  rmSync(join(vault, ".git"), { recursive: true, force: true });
  const requests: CompletionRequest[] = [];
  const deps: RunWriteDeps = { adapter: fakeAdapter({ chunks: RAW_CHUNKS, onRequest: (r) => requests.push(r) }), env: ritualEnv(vault) };
  const outcome = await captureStdout(() => runWrite(baseArgs(), vault, project, deps));
  expect(outcome.result).toBe(2);
  expect(JSON.parse(outcome.lines[0] as string).message).toContain("git repository");
  expect(requests).toHaveLength(0);
  rmSync(vault, { recursive: true, force: true });
});

test("once merged, a second run without --force refuses (exit 2) and leaves main's file byte-identical", async () => {
  const { vault, project } = tempVault();
  const deps: RunWriteDeps = { adapter: fakeAdapter({ chunks: RAW_CHUNKS }), env: ritualEnv(vault) };

  await captureStdout(() => runWrite(baseArgs(), vault, project, deps));
  const merged = await mergeDraft(project, "draft/ch02", { slug: "ice-house", env: ritualEnv(vault) });
  expect(merged.ok).toBe(true);

  const filePath = join(project, "chapters", "02-black-ice.md");
  const before = readFileSync(filePath);

  const second = await captureStdout(() =>
    runWrite(baseArgs(), vault, project, { adapter: fakeAdapter({ chunks: RAW_CHUNKS }), env: ritualEnv(vault) }),
  );
  expect(second.result).toBe(2);
  const body = JSON.parse(second.lines[0] as string);
  expect(body.ok).toBe(false);
  expect(body.code).toBe(2);

  expect(readFileSync(filePath).equals(before)).toBe(true);
  expect(git(vault, "branch", "--list", "draft/*")).toBe("");

  rmSync(vault, { recursive: true, force: true });
});

test("write --force over a merged chapter drafts on a fresh draft/ch02; main's file is untouched until that merges", async () => {
  const { vault, project } = tempVault();
  await captureStdout(() => runWrite(baseArgs(), vault, project, { adapter: fakeAdapter({ chunks: RAW_CHUNKS }), env: ritualEnv(vault) }));
  await mergeDraft(project, "draft/ch02", { slug: "ice-house", env: ritualEnv(vault) });

  const filePath = join(project, "chapters", "02-black-ice.md");
  const before = readFileSync(filePath, "utf8");

  const otherChunks = ["A wholly different draft", " of the same beat, for the --force test."];
  const forced = await captureStdout(() =>
    runWrite(baseArgs({ force: true }), vault, project, { adapter: fakeAdapter({ chunks: otherChunks }), env: ritualEnv(vault) }),
  );
  expect(forced.result).toBe(0);
  expect(readFileSync(filePath, "utf8")).toBe(before);
  expect(readFileSync(draftChapterFile(vault), "utf8")).toContain("A wholly different draft");

  rmSync(vault, { recursive: true, force: true });
});

test("a fake adapter that throws EndpointHung refuses (exit 2) naming the endpoint, writes no file", async () => {
  const { vault, project } = tempVault();
  const hung = new EndpointHung("http://127.0.0.1:9999/v1", 0, 5000);
  const deps: RunWriteDeps = { adapter: fakeAdapter({ error: hung }), env: ritualEnv(vault) };

  const outcome = await captureStdout(() => runWrite(baseArgs(), vault, project, deps));
  expect(outcome.result).toBe(2);
  const body = JSON.parse(outcome.lines[0] as string);
  expect(body.ok).toBe(false);
  expect(body.code).toBe(2);
  expect(body.message).toContain("http://127.0.0.1:9999/v1");

  expect(existsSync(join(project, "chapters", "02-black-ice.md"))).toBe(false);
  expect(git(vault, "branch", "--list", "draft/*")).toBe(""); // the unused branch is discarded
  expect(existsSync(draftChapterFile(vault))).toBe(false);

  // withReceipts logs an error receipt on a thrown call (measurement: "wall",
  // error set) — that is not the completed-call receipt this ticket's AC3
  // describes, so assert it carries an error rather than token stats.
  const receipts = receiptLines(project);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]?.["error"]).not.toBeNull();
  expect(receipts[0]?.["tokens_written"]).toBeNull();

  rmSync(vault, { recursive: true, force: true });
});

test("an empty stream refuses (exit 2) and writes no file", async () => {
  const { vault, project } = tempVault();
  const deps: RunWriteDeps = { adapter: emptyStreamAdapter(), env: ritualEnv(vault) };

  const outcome = await captureStdout(() => runWrite(baseArgs(), vault, project, deps));
  expect(outcome.result).toBe(2);
  const body = JSON.parse(outcome.lines[0] as string);
  expect(body.ok).toBe(false);
  expect(body.code).toBe(2);

  expect(existsSync(join(project, "chapters", "02-black-ice.md"))).toBe(false);
  expect(git(vault, "branch", "--list", "draft/*")).toBe("");

  rmSync(vault, { recursive: true, force: true });
});

test("the human (non --json) output has no 'piece <id>' or ritual lines (AGT-1541)", async () => {
  const { vault, project } = tempVault();
  const deps: RunWriteDeps = {
    adapter: fakeAdapter({ chunks: RAW_CHUNKS }),
    now: () => new Date("2026-09-06T12:00:00.000Z"),
    env: ritualEnv(vault),
  };

  const humanSent = await captureStdout(() => runWrite(baseArgs({ json: false }), vault, project, deps));
  expect(humanSent.result).toBe(0);
  expect(humanSent.lines.some((line) => /^piece |^ritual /.test(line))).toBe(false);

  rmSync(vault, { recursive: true, force: true });
});

/** Runs one send of chapter 2 with the given args and returns what the adapter was asked and the receipt line written. */
async function sendSampled(args: Partial<WriteArgs>) {
  const { vault, project } = tempVault();
  const requests: CompletionRequest[] = [];
  const deps: RunWriteDeps = {
    adapter: fakeAdapter({ chunks: RAW_CHUNKS, onRequest: (request) => requests.push(request) }),
    now: () => new Date("2026-09-06T12:00:00.000Z"),
    stderr: progressSink().sink,
    env: ritualEnv(vault),
  };
  const sent = await captureStdout(() => runWrite(baseArgs(args), vault, project, deps));
  const receipt = existsSync(join(project, ".pablo", "receipts.jsonl")) ? receiptLines(project)[0] : undefined;
  return { sent, requests, receipt };
}

test("write sends a temperature by default and records it in the receipt, leaving prompt_hash alone (AGT-1272 AC1, AC2)", async () => {
  const { sent, requests, receipt } = await sendSampled({});
  expect(sent.result).toBe(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.temperature).toBe(0.8);
  expect(requests[0]).not.toHaveProperty("seed");

  const body = JSON.parse(sent.lines[0] as string);
  expect(body.receipt.temperature).toBe(0.8);
  expect(body.receipt).not.toHaveProperty("seed");
  expect((receipt?.["params"] as Record<string, number>)["temperature"]).toBe(0.8);
  expect(receipt?.["prompt_hash"]).toBe(body.receipt.prompt_hash);
});

test("write --temperature and --seed override the default and reach the receipt (AGT-1272 AC1, AC2)", async () => {
  const { sent, requests, receipt } = await sendSampled({ temperature: "1.1", seed: "99" });
  expect(sent.result).toBe(0);
  expect(requests[0]?.temperature).toBe(1.1);
  expect(requests[0]?.seed).toBe(99);
  expect(receipt?.["params"]).toMatchObject({ temperature: 1.1, seed: 99 });
  expect(JSON.parse(sent.lines[0] as string).receipt).toMatchObject({ temperature: 1.1, seed: 99 });
});

test("the prompt_hash is the same whatever the sampling (AGT-1272 AC2)", async () => {
  const cold = await sendSampled({ temperature: "0" });
  const hot = await sendSampled({ temperature: "1.5", seed: "3" });
  expect(cold.receipt?.["prompt_hash"]).toBe(hot.receipt?.["prompt_hash"]);
});

test("write refuses a temperature outside 0 to 2 and a non-integer seed before sending anything", async () => {
  for (const bad of [{ temperature: "3" }, { temperature: "hot" }, { temperature: "-1" }, { seed: "1.5" }, { seed: "x" }]) {
    const { sent, requests } = await sendSampled(bad);
    expect(sent.result).toBe(2);
    expect(requests).toHaveLength(0);
  }
});

test("write saves one sentence per line, paragraphs blank-line separated, and the model is sent no splits (AGT-1531)", async () => {
  const { vault, project } = tempVault();
  const base = fakeAdapter({
    chunks: ["The storm came up. It did not stop.\n\n", "Odile waited. Then she opened the door."],
  });
  const prompts: string[] = [];
  const adapter: Adapter = {
    ...base,
    async *complete(request) {
      prompts.push(request.prompt);
      yield* base.complete(request);
    },
  };

  const run = await captureStdout(() =>
    runWrite(baseArgs(), vault, project, { adapter, env: ritualEnv(vault), stderr: progressSink().sink }),
  );
  expect(run.result).toBe(0);

  const fileText = readFileSync(draftChapterFile(vault), "utf8");
  const body = fileText.slice(fileText.indexOf("\n---\n") + 5).trim();
  expect(body).toBe(
    ["The storm came up.", "It did not stop.", "", "Odile waited.", "Then she opened the door."].join("\n"),
  );

  // One send, and the pack side is pinned by pack-prose-revise.test.ts.
  expect(prompts).toHaveLength(1);
  rmSync(vault, { recursive: true, force: true });
});

test("write --direction puts a direction slice in the pack and records direction: in the frontmatter (AGT-1562)", async () => {
  const { vault, project } = tempVault();
  const requests: CompletionRequest[] = [];
  const direction = "slower, stay on Cora: no new scenes";
  const code = await runWrite(
    { chapter: "2", words: undefined, scenes: undefined, dryRun: false, json: true, force: false, direction },
    vault,
    project,
    { adapter: fakeAdapter({ chunks: RAW_CHUNKS, onRequest: (r) => requests.push(r) }), env: ritualEnv(vault), stderr: progressSink().sink },
  );
  expect(code).toBe(0);
  expect(requests[0]?.prompt).toContain("# Direction for this chapter");
  expect(requests[0]?.prompt).toContain(direction);
  const written = readFileSync(draftChapterFile(vault), "utf8");
  expect(written).toContain(`direction: "${direction}"`);
  // On the draft branch, not main.
  expect(git(vault, "branch", "--list", "draft/ch02")).toContain("draft/ch02");
});

test("write without a direction adds no slice and no frontmatter key (AGT-1562)", async () => {
  const { vault, project } = tempVault();
  const requests: CompletionRequest[] = [];
  const code = await runWrite(
    { chapter: "2", words: undefined, scenes: undefined, dryRun: false, json: true, force: false, direction: "   " },
    vault,
    project,
    { adapter: fakeAdapter({ chunks: RAW_CHUNKS, onRequest: (r) => requests.push(r) }), env: ritualEnv(vault), stderr: progressSink().sink },
  );
  expect(code).toBe(0);
  expect(requests[0]?.prompt).not.toContain("Direction for this chapter");
  expect(readFileSync(draftChapterFile(vault), "utf8")).not.toContain("direction:");
});
