import { afterAll, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent, CompletionStats } from "@openthink/pablo-core";
import { EndpointHung, normalizeOutput } from "@openthink/pablo-core";
import { readEvents } from "../src/review";
import type { QueuedEvent } from "../src/review";
import type { ProgressSink, RunWriteDeps, WriteArgs } from "../src/write";
import { runWrite } from "../src/write";

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
 *
 * AGT-1262: the rituals also now include an unconditional `queue` step that
 * appends to `stateReviewPath(env)` — a global path, never vault-relative —
 * so `RITUAL_ENV` also pins `XDG_STATE_HOME` at a throwaway directory; a test
 * that forgot it would append to the author's real
 * `~/.local/state/pablo/review.jsonl` (this leaked once during this ticket's
 * own build, before this fix — see the commit history).
 */
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const SHARED_STATE_HOME = mkdtempSync(join(tmpdir(), "pablo-write-send-state-"));
const RITUAL_ENV: RunWriteDeps["env"] = { PATH: NO_THINK_PATH, XDG_STATE_HOME: SHARED_STATE_HOME };

afterAll(() => {
  rmSync(SHARED_STATE_HOME, { recursive: true, force: true });
});

function tempVault(): { vault: string; project: string } {
  const dir = mkdtempSync(join(tmpdir(), "pablo-write-send-test-"));
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
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
  readonly chunks?: readonly string[];
  readonly error?: Error;
  readonly stats?: CompletionStats;
  readonly model?: string;
}): Adapter {
  return {
    id: "local",
    model: options.model ?? "test-writer-model",
    preferredOutput: "text",
    async *complete(): AsyncIterable<CompletionEvent> {
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

/** `<stateHome>/pablo/review.jsonl`'s `queued` events (AGT-1262), in order. */
function queuedEvents(stateHome: string): QueuedEvent[] {
  return readEvents(join(stateHome, "pablo", "review.jsonl")).filter(
    (event): event is QueuedEvent => event.type === "queued",
  );
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
    env: RITUAL_ENV,
  };

  const sent = await captureStdout(() => runWrite(baseArgs(), vault, project, deps));
  expect(sent.result).toBe(0);
  expect(sent.lines).toHaveLength(1); // AC4: stdout carries only the JSON

  const body = JSON.parse(sent.lines[0] as string);
  expect(body.ok).toBe(true);
  expect(body.path).toBe("chapters/02-black-ice.md");

  const filePath = join(project, "chapters", "02-black-ice.md");
  expect(existsSync(filePath)).toBe(true);
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

  const expectedNormalized = normalizeOutput(RAW_TEXT);
  expect(fileText).toContain(expectedNormalized);
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

  // AGT-1262 AC1/AC4: the queue ritual ran and the same piece id is in the JSON body.
  expect(typeof body.piece).toBe("string");
  const queueRitual = (body.rituals as Array<{ name: string; status: string }>).find((r) => r.name === "queue");
  expect(queueRitual?.status).toBe("ran");

  rmSync(vault, { recursive: true, force: true });
});

test("a second run without --force refuses (exit 2) and leaves the file byte-identical", async () => {
  const { vault, project } = tempVault();
  const deps: RunWriteDeps = { adapter: fakeAdapter({ chunks: RAW_CHUNKS }), env: RITUAL_ENV };

  await captureStdout(() => runWrite(baseArgs(), vault, project, deps));

  const filePath = join(project, "chapters", "02-black-ice.md");
  const before = readFileSync(filePath);

  const second = await captureStdout(() =>
    runWrite(baseArgs(), vault, project, { adapter: fakeAdapter({ chunks: RAW_CHUNKS }), env: RITUAL_ENV }),
  );
  expect(second.result).toBe(2);
  const body = JSON.parse(second.lines[0] as string);
  expect(body.ok).toBe(false);
  expect(body.code).toBe(2);

  const after = readFileSync(filePath);
  expect(after.equals(before)).toBe(true);

  rmSync(vault, { recursive: true, force: true });
});

test("write --force overwrites an existing chapter file", async () => {
  const { vault, project } = tempVault();
  await captureStdout(() => runWrite(baseArgs(), vault, project, { adapter: fakeAdapter({ chunks: RAW_CHUNKS }), env: RITUAL_ENV }));

  const filePath = join(project, "chapters", "02-black-ice.md");
  const before = readFileSync(filePath, "utf8");

  const otherChunks = ["A wholly different draft", " of the same beat, for the --force test."];
  const forced = await captureStdout(() =>
    runWrite(baseArgs({ force: true }), vault, project, { adapter: fakeAdapter({ chunks: otherChunks }), env: RITUAL_ENV }),
  );
  expect(forced.result).toBe(0);

  const after = readFileSync(filePath, "utf8");
  expect(after).not.toBe(before);
  expect(after).toContain("A wholly different draft");

  rmSync(vault, { recursive: true, force: true });
});

test("a fake adapter that throws EndpointHung refuses (exit 2) naming the endpoint, writes no file", async () => {
  const { vault, project } = tempVault();
  const hung = new EndpointHung("http://127.0.0.1:9999/v1", 0, 5000);
  const deps: RunWriteDeps = { adapter: fakeAdapter({ error: hung }), env: RITUAL_ENV };

  const outcome = await captureStdout(() => runWrite(baseArgs(), vault, project, deps));
  expect(outcome.result).toBe(2);
  const body = JSON.parse(outcome.lines[0] as string);
  expect(body.ok).toBe(false);
  expect(body.code).toBe(2);
  expect(body.message).toContain("http://127.0.0.1:9999/v1");

  expect(existsSync(join(project, "chapters", "02-black-ice.md"))).toBe(false);

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
  const deps: RunWriteDeps = { adapter: emptyStreamAdapter(), env: RITUAL_ENV };

  const outcome = await captureStdout(() => runWrite(baseArgs(), vault, project, deps));
  expect(outcome.result).toBe(2);
  const body = JSON.parse(outcome.lines[0] as string);
  expect(body.ok).toBe(false);
  expect(body.code).toBe(2);

  expect(existsSync(join(project, "chapters", "02-black-ice.md"))).toBe(false);

  rmSync(vault, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AGT-1262: the queue ritual — `queued` event fields, the human `piece <id>`
// trailing line, and failure isolation.
// ---------------------------------------------------------------------------

test("the queued event carries the chapter title, path, vault, project, words and prompt_hash (AC1)", async () => {
  const { vault, project } = tempVault();
  const stateHome = mkdtempSync(join(tmpdir(), "pablo-write-send-state-"));
  const deps: RunWriteDeps = {
    adapter: fakeAdapter({ chunks: RAW_CHUNKS }),
    now: () => new Date("2026-09-06T12:00:00.000Z"),
    env: { PATH: NO_THINK_PATH, XDG_STATE_HOME: stateHome },
  };

  const sent = await captureStdout(() => runWrite(baseArgs(), vault, project, deps));
  expect(sent.result).toBe(0);
  const body = JSON.parse(sent.lines[0] as string);

  const filePath = join(project, "chapters", "02-black-ice.md");
  const queued = queuedEvents(stateHome);
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({
    id: body.piece,
    kind: "chapter",
    title: "Black Ice",
    path: filePath,
    vault,
    project: "ice-house",
    words: body.receipt.words,
    prompt_hash: body.receipt.prompt_hash,
  });

  rmSync(vault, { recursive: true, force: true });
  rmSync(stateHome, { recursive: true, force: true });
});

test("the human (non --json) output ends with a 'piece <id>' line naming the same id as --json's piece field (AC4)", async () => {
  const { vault, project } = tempVault();
  const stateHome = mkdtempSync(join(tmpdir(), "pablo-write-send-state-"));
  const deps: RunWriteDeps = {
    adapter: fakeAdapter({ chunks: RAW_CHUNKS }),
    now: () => new Date("2026-09-06T12:00:00.000Z"),
    env: { PATH: NO_THINK_PATH, XDG_STATE_HOME: stateHome },
  };

  const humanSent = await captureStdout(() => runWrite(baseArgs({ json: false }), vault, project, deps));
  expect(humanSent.result).toBe(0);
  expect(humanSent.lines[humanSent.lines.length - 1]).toMatch(/^piece [0-9a-z-]+$/);

  const queued = queuedEvents(stateHome);
  expect(queued).toHaveLength(1);
  const pieceLine = humanSent.lines[humanSent.lines.length - 1] as string;
  expect(pieceLine).toBe(`piece ${queued[0]?.id}`);

  rmSync(vault, { recursive: true, force: true });
  rmSync(stateHome, { recursive: true, force: true });
});

test("an unwritable state directory: the queue ritual reports status 'failed' but the write itself still succeeds (AC5)", async () => {
  const { vault, project } = tempVault();
  const stateHome = mkdtempSync(join(tmpdir(), "pablo-write-send-state-"));
  const pabloDir = join(stateHome, "pablo");
  mkdirSync(pabloDir, { recursive: true });
  chmodSync(pabloDir, 0o500); // read+execute only: appendEvent's mkdirSync/appendFileSync both fail

  const deps: RunWriteDeps = {
    adapter: fakeAdapter({ chunks: RAW_CHUNKS }),
    env: { PATH: NO_THINK_PATH, XDG_STATE_HOME: stateHome },
  };

  try {
    const sent = await captureStdout(() => runWrite(baseArgs(), vault, project, deps));
    expect(sent.result).toBe(0); // the write itself is unaffected
    const body = JSON.parse(sent.lines[0] as string);
    expect(body.ok).toBe(true);
    expect(typeof body.piece).toBe("string"); // AC4: still present even though queueing failed

    const queueRitual = (body.rituals as Array<{ name: string; status: string; detail: string }>).find(
      (r) => r.name === "queue",
    );
    expect(queueRitual?.status).toBe("failed");

    expect(existsSync(join(project, "chapters", "02-black-ice.md"))).toBe(true);
  } finally {
    chmodSync(pabloDir, 0o700);
    rmSync(vault, { recursive: true, force: true });
    rmSync(stateHome, { recursive: true, force: true });
  }
});
