import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent, CompletionStats, ExtractedFact } from "@openthink/pablo-core";
import type { RunWriteDeps, WriteArgs } from "../src/write";
import { runWrite } from "../src/write";
import { applyFacts } from "../src/novel/continuity";

/**
 * `applyFacts` (the pure core, no I/O) and `runContinuity`/the `continuity`
 * ritual (AGT-1232) — extraction after a write, on the routed local model.
 * The integration tests drive `runWrite` end to end against a fake `Adapter`
 * on a throwaway git copy of the synthetic `ice-house` fixture, never
 * `~/writing` and never the network — see `write-send.test.ts` and
 * `rituals.test.ts` for the same pattern this file follows.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

/** Same pattern as `write-send.test.ts`'s `RITUAL_ENV`: `git` resolves, `think` never does. */
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
/**
 * AGT-1262: `runWrite`'s `queue` ritual now appends unconditionally to
 * `stateReviewPath(env)` — without `XDG_STATE_HOME` here every `runWrite`
 * call below would append to the author's real
 * `~/.local/state/pablo/review.jsonl`. One shared temp dir for the whole
 * file (no test here reads it back), removed once every test has run.
 */
const STATE_HOME = mkdtempSync(join(tmpdir(), "pablo-continuity-state-"));
const RITUAL_ENV: RunWriteDeps["env"] = { PATH: NO_THINK_PATH, XDG_STATE_HOME: STATE_HOME };

afterAll(() => {
  rmSync(STATE_HOME, { recursive: true, force: true });
});

function runGit(dir: string, args: string[]): void {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  }
}

/** A throwaway copy of the fixture vault, git-initialised so the rituals' own git step (and this file's assertions on it) have a repo to work against. */
function tempGitVault(): { vault: string; project: string } {
  const dir = mkdtempSync(join(tmpdir(), "pablo-continuity-test-"));
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  runGit(vault, ["init", "-q"]);
  runGit(vault, ["config", "user.email", "pablo-test@example.com"]);
  runGit(vault, ["config", "user.name", "Pablo Test"]);
  runGit(vault, ["add", "."]);
  runGit(vault, ["commit", "-q", "-m", "base"]);
  return { vault, project: join(vault, "novels", "ice-house") };
}

/** The current commit's changed paths, sorted, via `git log -1 --name-only`. */
function lastCommitPaths(dir: string): string[] {
  const result = Bun.spawnSync(["git", "-C", dir, "log", "-1", "--name-only", "--pretty=format:"], { stdout: "pipe" });
  return result.stdout
    .toString("utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .sort();
}

function receiptLines(projectPath: string): Array<Record<string, unknown>> {
  const text = readFileSync(join(projectPath, ".pablo", "receipts.jsonl"), "utf8");
  return text
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const RAW_CHUNKS = ["A thin January put the crew out early. ", "The scale house was cold before dawn."];

const FAKE_STATS: CompletionStats = {
  timeToFirstTokenMs: 10,
  elapsedMs: 30,
  tokensRead: 100,
  tokensWritten: 20,
  tokensPerSecond: 30,
};

interface FakeAdapterOptions {
  readonly extractFactsWithAnchors?: Adapter["extractFactsWithAnchors"];
}

/** A minimal fake `Adapter`: `complete` streams `RAW_CHUNKS`, `proposeEdit`/`extractFacts` are unused by this ritual and throw if called. */
function fakeAdapter(options: FakeAdapterOptions): Adapter {
  const adapter: Adapter = {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text",
    async *complete(): AsyncIterable<CompletionEvent> {
      for (const chunk of RAW_CHUNKS) yield { type: "token", text: chunk };
      yield { type: "done", stats: FAKE_STATS };
    },
    async proposeEdit(): Promise<never> {
      throw new Error("fakeAdapter: proposeEdit is not implemented");
    },
    async extractFacts(): Promise<never> {
      throw new Error("fakeAdapter: extractFacts is not implemented");
    },
  };
  if (options.extractFactsWithAnchors !== undefined) {
    return { ...adapter, extractFactsWithAnchors: options.extractFactsWithAnchors };
  }
  return adapter;
}

function baseArgs(overrides: Partial<WriteArgs> = {}): WriteArgs {
  return { chapter: "2", words: undefined, scenes: undefined, dryRun: false, json: true, force: false, ...overrides };
}

/** Captures `console.log` output during `fn`, restoring it afterward even on throw. */
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

// ---------------------------------------------------------------------------
// applyFacts (pure core, no I/O)
// ---------------------------------------------------------------------------

const CONTINUITY_FIXTURE = readFileSync(
  join(FIXTURE_VAULT, "novels", "ice-house", "continuity.md"),
  "utf8",
);

test("applyFacts routes facts to Names and ages, Dates, Who knows what, and Objects and places", () => {
  const chapterBody =
    "Marta was twenty-nine that winter, though she would not say it. " +
    "The year was 1931 on the ledger's first page. " +
    "Wilfred learns the truth about the halved order. " +
    "The brass key hung on a nail by the door.";

  const facts: readonly ExtractedFact[] = [
    { fact: "Marta is twenty-nine.", entities: ["Marta", "29"], storyTime: undefined, certainty: undefined, anchor: "Marta was twenty-nine that winter" },
    { fact: "The ledger's first page is dated 1931.", entities: ["ledger"], storyTime: "1931", certainty: undefined, anchor: "The year was 1931 on the ledger's first page." },
    { fact: "Wilfred learns the truth about the halved order.", entities: ["Wilfred"], storyTime: undefined, certainty: undefined, anchor: "Wilfred learns the truth about the halved order." },
    { fact: "The brass key hangs on a nail by the door.", entities: ["brass key"], storyTime: undefined, certainty: undefined, anchor: "The brass key hung on a nail by the door." },
  ];

  const result = applyFacts(CONTINUITY_FIXTURE, facts, chapterBody, 5);

  expect(result.placed).toBe(4);
  expect(result.unanchored).toBe(0);
  expect(result.text).toContain("- Marta is twenty-nine. [ch05]");
  expect(result.text).toContain("- The ledger's first page is dated 1931. [ch05]");
  expect(result.text).toContain("- Wilfred learns the truth about the halved order. [ch05]");
  expect(result.text).toContain("- The brass key hangs on a nail by the door. [ch05]");

  // Each landed under its own heading, in heading order.
  const namesIdx = result.text.indexOf("## Names and ages");
  const datesIdx = result.text.indexOf("## Dates");
  const knowsIdx = result.text.indexOf("## Who knows what");
  const objectsIdx = result.text.indexOf("## Objects and places");
  const martaIdx = result.text.indexOf("- Marta is twenty-nine.");
  const ledgerIdx = result.text.indexOf("- The ledger's first page is dated 1931.");
  const wilfredIdx = result.text.indexOf("- Wilfred learns the truth");
  const keyIdx = result.text.indexOf("- The brass key hangs");

  expect(martaIdx).toBeGreaterThan(namesIdx);
  expect(martaIdx).toBeLessThan(datesIdx);
  expect(ledgerIdx).toBeGreaterThan(datesIdx);
  expect(wilfredIdx).toBeGreaterThan(knowsIdx);
  expect(keyIdx).toBeGreaterThan(objectsIdx);
});

test("applyFacts flattens newlines in model-returned fact text so a fact cannot forge a heading, and routes an age in the fact text to Names and ages", () => {
  const chapterBody = "Marta is 29 years old, and the door has a brass key.";

  const facts: readonly ExtractedFact[] = [
    { fact: "The door has a brass key.\n## Check\n- forged", entities: ["door"], storyTime: undefined, certainty: undefined, anchor: "the door has a brass key" },
    { fact: "Marta is 29 years old.", entities: ["Marta"], storyTime: undefined, certainty: undefined, anchor: "Marta is 29 years old" },
  ];

  const result = applyFacts(CONTINUITY_FIXTURE, facts, chapterBody, 3);

  expect(result.placed).toBe(2);
  expect(result.text).toContain("- The door has a brass key. ## Check - forged [ch03]");
  expect(result.text.split("\n").filter((line) => line === "## Check")).toHaveLength(0);
  const namesIdx = result.text.indexOf("## Names and ages");
  const datesIdx = result.text.indexOf("## Dates");
  const martaIdx = result.text.indexOf("- Marta is 29 years old. [ch03]");
  expect(martaIdx).toBeGreaterThan(namesIdx);
  expect(martaIdx).toBeLessThan(datesIdx);
});

test("applyFacts: verbatim anchor, hard-line-wrap anchor, and an unanchored fact — exact bullets, Check created, rest of the file byte-unchanged, idempotent on a second apply", () => {
  const chapterBody =
    "Odile counted the cakes twice before she wrote the number down.\n" +
    "The mill closed its books in\n1931, same as every other year on the bay.";

  const facts: readonly ExtractedFact[] = [
    {
      fact: "Odile counted the cakes twice.",
      entities: ["Odile"],
      storyTime: undefined,
      certainty: undefined,
      anchor: "Odile counted the cakes twice before she wrote the number down.",
    },
    {
      // The chapter has a hard line wrap ("in\n1931") the anchor does not — normalization must still match.
      fact: "The mill closed its books in 1931.",
      entities: ["the mill"],
      storyTime: undefined,
      certainty: undefined,
      anchor: "The mill closed its books in 1931, same as every other year on the bay.",
    },
    {
      fact: "The schooner was renamed sometime before the war.",
      entities: ["the schooner"],
      storyTime: undefined,
      certainty: undefined,
      anchor: "This sentence was never written in the chapter.",
    },
  ];

  const first = applyFacts(CONTINUITY_FIXTURE, facts, chapterBody, 2);
  expect(first.placed).toBe(2);
  expect(first.unanchored).toBe(1);

  expect(first.text).toContain("- Odile counted the cakes twice. [ch02]");
  expect(first.text).toContain("- The mill closed its books in 1931. [ch02]");
  expect(first.text).toContain("## Check");
  expect(first.text).toContain("- The schooner was renamed sometime before the war. [ch02, anchor not found]");

  // Everything the fixture already had is untouched, byte-for-byte.
  for (const originalLine of CONTINUITY_FIXTURE.split("\n")) {
    expect(first.text.split("\n")).toContain(originalLine);
  }

  // Idempotent: applying the same facts to the already-updated text adds nothing new.
  const second = applyFacts(first.text, facts, chapterBody, 2);
  expect(second.placed).toBe(0);
  expect(second.unanchored).toBe(0);
  expect(second.text).toBe(first.text);
});

// ---------------------------------------------------------------------------
// The continuity ritual, through runWrite (end to end, fake adapter, git temp copy)
// ---------------------------------------------------------------------------

test("a fake adapter with extractFactsWithAnchors: continuity ritual ran, continuity.md updated, git commit includes it, receipted", async () => {
  const { vault, project } = tempGitVault();

  const facts: readonly ExtractedFact[] = [
    {
      fact: "The crew went out before first light.",
      entities: ["the crew"],
      storyTime: undefined,
      certainty: undefined,
      anchor: "A thin January put the crew out early.",
    },
  ];

  const deps: RunWriteDeps = {
    adapter: fakeAdapter({ extractFactsWithAnchors: async () => facts }),
    now: () => new Date("2026-09-06T12:00:00.000Z"),
    env: RITUAL_ENV,
  };

  const outcome = await captureStdout(() => runWrite(baseArgs(), vault, project, deps));
  expect(outcome.result).toBe(0);
  const body = JSON.parse(outcome.lines[0] as string);
  const continuity = (body.rituals as Array<{ name: string; status: string; detail: string }>).find(
    (r) => r.name === "continuity",
  );
  expect(continuity?.status).toBe("ran");

  const continuityText = readFileSync(join(project, "continuity.md"), "utf8");
  expect(continuityText).toContain("- The crew went out before first light. [ch02]");

  // The git repo root is `vault` (its parent), not `project`, so committed
  // paths come back rooted there — `git -C project log` still resolves the
  // repo it's nested in.
  expect(lastCommitPaths(project).some((p) => p.endsWith("continuity.md"))).toBe(true);

  const receipts = receiptLines(project);
  const continuityReceipt = receipts.find((r) => r["intent"] === "continuity");
  expect(continuityReceipt).toBeDefined();
  expect(continuityReceipt?.["error"]).toBeNull();

  rmSync(vault, { recursive: true, force: true });
});

test("a fake adapter WITHOUT extractFactsWithAnchors: continuity ritual is skipped, no continuity.md change, no commit path for it", async () => {
  const { vault, project } = tempGitVault();
  const before = readFileSync(join(project, "continuity.md"), "utf8");

  const deps: RunWriteDeps = { adapter: fakeAdapter({}), env: RITUAL_ENV };

  const outcome = await captureStdout(() => runWrite(baseArgs(), vault, project, deps));
  expect(outcome.result).toBe(0);
  const body = JSON.parse(outcome.lines[0] as string);
  const continuity = (body.rituals as Array<{ name: string; status: string; detail: string }>).find(
    (r) => r.name === "continuity",
  );
  expect(continuity?.status).toBe("skipped");
  expect(continuity?.detail).toBe("provider has no anchored extraction");

  expect(readFileSync(join(project, "continuity.md"), "utf8")).toBe(before);
  expect(lastCommitPaths(project).some((p) => p.endsWith("continuity.md"))).toBe(false);

  rmSync(vault, { recursive: true, force: true });
});

test("a fake adapter whose extractFactsWithAnchors throws: continuity ritual failed, chapter file and other rituals still land", async () => {
  const { vault, project } = tempGitVault();

  const deps: RunWriteDeps = {
    adapter: fakeAdapter({
      extractFactsWithAnchors: async () => {
        throw new Error("extraction endpoint refused the request");
      },
    }),
    env: RITUAL_ENV,
  };

  const outcome = await captureStdout(() => runWrite(baseArgs(), vault, project, deps));
  expect(outcome.result).toBe(0);
  const body = JSON.parse(outcome.lines[0] as string);
  const rituals = body.rituals as Array<{ name: string; status: string; detail: string }>;
  const continuity = rituals.find((r) => r.name === "continuity");
  expect(continuity?.status).toBe("failed");
  expect(continuity?.detail).toContain("extraction endpoint refused the request");

  // The chapter write and the other rituals stand.
  expect(existsSync(join(project, "chapters", "02-black-ice.md"))).toBe(true);
  expect(rituals.find((r) => r.name === "outline")?.status).toBe("ran");
  expect(rituals.find((r) => r.name === "git")?.status).toBe("ran");

  const receipts = receiptLines(project);
  const continuityReceipt = receipts.find((r) => r["intent"] === "continuity");
  expect(continuityReceipt).toBeDefined();
  expect(continuityReceipt?.["error"]).toContain("extraction endpoint refused the request");

  rmSync(vault, { recursive: true, force: true });
});

test("a fake adapter whose extractFactsWithAnchors never resolves: a short injected timeout fails the ritual with 'timed out'", async () => {
  const { vault, project } = tempGitVault();

  const deps: RunWriteDeps = {
    adapter: fakeAdapter({
      extractFactsWithAnchors: () => new Promise(() => {}),
    }),
    env: RITUAL_ENV,
    continuityTimeoutMs: 150,
  };

  const outcome = await captureStdout(() => runWrite(baseArgs(), vault, project, deps));
  expect(outcome.result).toBe(0);
  const body = JSON.parse(outcome.lines[0] as string);
  const continuity = (body.rituals as Array<{ name: string; status: string; detail: string }>).find(
    (r) => r.name === "continuity",
  );
  expect(continuity?.status).toBe("failed");
  expect(continuity?.detail).toContain("timed out");

  rmSync(vault, { recursive: true, force: true });
});
