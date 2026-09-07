import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent, CompletionStats } from "@openthink/pablo-core";
import { EndpointHung, normalizeOutput } from "@openthink/pablo-core";
import { proseCore, runProse } from "../src/prose";
import type { ProseDeps, ProseSendBody } from "../src/prose";

/**
 * `pablo prose`'s send path (AGT-1242), exercised by calling `proseCore`
 * directly against a fake `Adapter` (`ProseDeps.adapter`) so no test here ever
 * touches the network — the same shape `write-send.test.ts` uses for `write`.
 *
 * Every run works on a throwaway copy of the synthetic fixture vault (or a
 * bare temp directory for the no-vault cases), with `XDG_CONFIG_HOME` AND
 * `XDG_STATE_HOME` pointed at temp directories: AC3 makes the state directory
 * a real write target, so a test that forgot `XDG_STATE_HOME` would append to
 * the author's actual `~/.local/state/pablo/receipts.jsonl`. Nothing here
 * reads or writes `~/writing`, the real config, or the real state directory.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

/**
 * A voice with no `model:` frontmatter, written into the vault copy by the
 * test itself: the fixture's `plain` voice deliberately carries
 * `model: anthropic` (AGT-1240's frontmatter fixture), which the per-voice
 * override would then refuse against a config that has only `local`. Its
 * rules carry one `Flagged:` line so AC4 has something of the voice's OWN to
 * find in the answer. Synthetic content, invented for this fixture.
 */
const DESK_VOICE = `# Voice: desk

## Register

Short sentences. Say the fact and stop.

## Flagged

Flagged: "We are pleased to announce a small change to the schedule."
`;

interface Env {
  readonly vault: string;
  readonly configHome: string;
  readonly stateHome: string;
  readonly env: Record<string, string | undefined>;
  readonly brief: string;
}

function tempVaultEnv(voiceName = "desk"): Env {
  const root = tempDir("pablo-prose-send-");
  const vault = join(root, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });

  const configHome = tempDir("pablo-prose-send-config-");
  const stateHome = tempDir("pablo-prose-send-state-");

  mkdirSync(join(vault, "voices", voiceName), { recursive: true });
  writeFileSync(join(vault, "voices", voiceName, "voice.md"), DESK_VOICE, "utf8");

  const brief = join(vault, "brief.md");
  writeFileSync(brief, "Announce the new dock hours.\n", "utf8");

  return {
    vault,
    configHome,
    stateHome,
    env: { PABLO_VAULT: vault, XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome },
    brief,
  };
}

/**
 * Raw model text with one em-dash and one verbatim copy of the desk voice's
 * flagged line — normalization has real work to do, and `check` has one
 * mechanical tell plus one voice-specific hit to find.
 */
const RAW_CHUNKS = [
  "The scale house opens at six",
  "—not seven—",
  "from Monday.\n\n",
  "We are pleased to announce a small change to the schedule.",
];
const RAW_TEXT = RAW_CHUNKS.join("");

const FAKE_STATS: CompletionStats = {
  timeToFirstTokenMs: 310,
  elapsedMs: 1450,
  tokensRead: 900,
  tokensWritten: 38,
  tokensPerSecond: 26,
};

function fakeAdapter(options: { readonly chunks?: readonly string[]; readonly error?: Error; readonly model?: string } = {}): Adapter {
  return {
    id: "local",
    model: options.model ?? "test-writer-model",
    preferredOutput: "text",
    async *complete(): AsyncIterable<CompletionEvent> {
      if (options.error) throw options.error;
      for (const chunk of options.chunks ?? RAW_CHUNKS) {
        yield { type: "token", text: chunk };
      }
      yield { type: "done", stats: FAKE_STATS };
    },
    async proposeEdit(): Promise<never> {
      throw new Error("fakeAdapter: proposeEdit is not implemented");
    },
    async extractFacts(): Promise<never> {
      throw new Error("fakeAdapter: extractFacts is not implemented");
    },
  };
}

/** An adapter whose stream yields nothing at all — not even `done`. */
function emptyStreamAdapter(): Adapter {
  return {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text",
    async *complete(): AsyncIterable<CompletionEvent> {
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

function progressSink(): { deps: ProseDeps; lines: string[] } {
  const lines: string[] = [];
  return {
    deps: {
      adapter: fakeAdapter(),
      now: () => new Date("2026-09-07T12:00:00.000Z"),
      stderr: { write: (text: string) => lines.push(text) },
    },
    lines,
  };
}

function sendArgs(overrides: Record<string, unknown> = {}) {
  return {
    voice: "desk",
    brief: "",
    context: [] as readonly string[],
    format: undefined,
    words: undefined,
    dryRun: false,
    out: undefined as string | undefined,
    force: false,
    draft: undefined as string | undefined,
    instruction: undefined as string | undefined,
    ...overrides,
  };
}

function receiptLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// AC1/AC2/AC4: send, normalized text, receipt shape, check hits
// ---------------------------------------------------------------------------

test("proseCore sends once and returns the normalized text, receipt and check hits (AC1, AC2, AC4)", async () => {
  const { vault, env, brief } = tempVaultEnv();
  const { deps, lines } = progressSink();

  const dry = await proseCore(sendArgs({ brief, dryRun: true }), { cwd: vault, env });
  const dryHash = (dry.body as { prompt_hash: string }).prompt_hash;

  const outcome = await proseCore(sendArgs({ brief }), { cwd: vault, env }, deps);

  expect(outcome.exitCode).toBe(0);
  const body = outcome.body as ProseSendBody;
  expect(body.ok).toBe(true);
  expect(body.text).toBe(normalizeOutput(RAW_TEXT));
  expect(body.text).not.toContain("—"); // normalized: no em-dash survives
  expect(body.path).toBeUndefined(); // no --out given

  expect(body.receipt.prompt_hash).toBe(dryHash);
  expect(body.receipt.model).toBe("test-writer-model");
  expect(body.receipt.tokensRead).toBe(FAKE_STATS.tokensRead as number);
  expect(body.receipt.tokensWritten).toBe(FAKE_STATS.tokensWritten);
  expect(body.receipt.timeToFirstTokenMs).toBe(310);
  expect(body.receipt.wallMs).toBe(1450);
  expect(body.receipt.words).toBe(body.text.split(/\s+/).filter((w) => w !== "").length);

  // AC4: the voice's OWN flagged line is reported, alongside the mechanical rules.
  expect(body.check.some((hit) => hit.rule === "flagged-line")).toBe(true);

  // AC5: progress went to the injected stderr sink only.
  expect(lines.some((line) => /waiting for first token/.test(line))).toBe(true);
  expect(lines.some((line) => /first token after/.test(line))).toBe(true);
});

test("the fiction voice's check rules come from style/prose.md (AC4)", async () => {
  const { vault, env, brief } = tempVaultEnv();
  const flagged = readFileSync(join(vault, "style", "prose.md"), "utf8")
    .split("\n")
    .find((line) => /^\s*Flagged:/.test(line));
  expect(flagged).toBeDefined();
  const flaggedText = /"([^"]*)"/.exec(flagged ?? "")?.[1];
  expect(flaggedText).toBeDefined();

  const outcome = await proseCore(
    sendArgs({ voice: "fiction", brief }),
    { cwd: vault, env },
    { adapter: fakeAdapter({ chunks: [`${flaggedText as string} And nothing else.`] }) },
  );

  expect(outcome.exitCode).toBe(0);
  const body = outcome.body as ProseSendBody;
  expect(body.check.some((hit) => hit.rule === "flagged-line")).toBe(true);
});

// ---------------------------------------------------------------------------
// AC2: --out, its frontmatter, its git commit, and the existing-file refusal
// ---------------------------------------------------------------------------

test("--out writes the text with provenance frontmatter and commits it inside a git repository (AC2)", async () => {
  const { vault, env, brief } = tempVaultEnv();
  execFileSync("git", ["-C", vault, "init", "-q"], { stdio: "pipe" });
  execFileSync("git", ["-C", vault, "config", "user.email", "test@example.invalid"], { stdio: "pipe" });
  execFileSync("git", ["-C", vault, "config", "user.name", "pablo test"], { stdio: "pipe" });

  const outPath = join(vault, "notices", "dock-hours.md");
  const { deps } = progressSink();
  const outcome = await proseCore(sendArgs({ brief, out: outPath }), { cwd: vault, env }, deps);

  expect(outcome.exitCode).toBe(0);
  const body = outcome.body as ProseSendBody;
  expect(body.path).toBe(outPath);
  expect(body.committed).toBe(true);

  const text = readFileSync(outPath, "utf8");
  const lines = text.split("\n");
  expect(lines[0]).toBe("---");
  expect(lines.slice(1, 6).map((line) => (line.split(":")[0] ?? "").trim())).toEqual([
    "voice",
    "model",
    "generated",
    "prompt_hash",
    "words",
  ]);
  expect(lines[6]).toBe("---");
  expect(text).toContain("voice: desk");
  expect(text).toContain("model: test-writer-model");
  expect(text).toContain("generated: 2026-09-07T12:00:00.000Z");
  expect(text).toContain(`prompt_hash: ${body.receipt.prompt_hash}`);
  expect(text).toContain(`words: ${body.receipt.words}`);
  expect(text).toContain(body.text);

  const committed = execFileSync("git", ["-C", vault, "show", "--name-only", "--format=%s", "HEAD"], {
    stdio: "pipe",
  }).toString();
  expect(committed).toContain("prose: dock-hours.md");
  expect(committed).toContain("notices/dock-hours.md");
});

test("--out outside a git repository still writes the file and returns a notice, never throwing (AC2)", async () => {
  const { vault, env, brief } = tempVaultEnv();
  const outPath = join(vault, "dock-hours.md");

  const outcome = await proseCore(sendArgs({ brief, out: outPath }), { cwd: vault, env }, { adapter: fakeAdapter() });

  expect(outcome.exitCode).toBe(0);
  const body = outcome.body as ProseSendBody;
  expect(existsSync(outPath)).toBe(true);
  expect(body.committed).toBe(false);
  expect(typeof body.notice).toBe("string");
});

test("an existing --out file refuses (exit 2) without sending, and --force overwrites it (AC2)", async () => {
  const { vault, env, brief } = tempVaultEnv();
  const outPath = join(vault, "dock-hours.md");
  writeFileSync(outPath, "hand-written, must not be clobbered\n", "utf8");
  const before = readFileSync(outPath);

  let sent = 0;
  const counting: Adapter = {
    ...fakeAdapter(),
    async *complete(): AsyncIterable<CompletionEvent> {
      sent += 1;
      for (const chunk of RAW_CHUNKS) yield { type: "token", text: chunk };
      yield { type: "done", stats: FAKE_STATS };
    },
  };

  const refused = await proseCore(sendArgs({ brief, out: outPath }), { cwd: vault, env }, { adapter: counting });
  expect(refused.exitCode).toBe(2);
  expect(refused.body).toMatchObject({ ok: false, code: 2 });
  expect(sent).toBe(0); // refused before the model call
  expect(readFileSync(outPath).equals(before)).toBe(true);

  const forced = await proseCore(sendArgs({ brief, out: outPath, force: true }), { cwd: vault, env }, { adapter: counting });
  expect(forced.exitCode).toBe(0);
  expect(sent).toBe(1);
  expect(readFileSync(outPath, "utf8")).toContain("The scale house opens at six");
});

// ---------------------------------------------------------------------------
// AC3: where the receipt lands
// ---------------------------------------------------------------------------

test("the receipt is appended to <vault>/.pablo/receipts.jsonl when a vault was found (AC3)", async () => {
  const { vault, env, brief } = tempVaultEnv();

  const outcome = await proseCore(sendArgs({ brief }), { cwd: vault, env }, { adapter: fakeAdapter() });
  expect(outcome.exitCode).toBe(0);

  const receipts = receiptLines(join(vault, ".pablo", "receipts.jsonl"));
  expect(receipts).toHaveLength(1);
  expect(receipts[0]?.["intent"]).toBe("prose");
  expect(receipts[0]?.["pack_kind"]).toBe("prose");
  expect(receipts[0]?.["prompt_hash"]).toBe((outcome.body as ProseSendBody).receipt.prompt_hash);
});

test("with no vault at all the receipt lands in $XDG_STATE_HOME/pablo/receipts.jsonl, created on first use (AC3)", async () => {
  const cwd = tempDir("pablo-prose-send-novault-");
  const configHome = tempDir("pablo-prose-send-config-");
  const stateHome = tempDir("pablo-prose-send-state-");
  mkdirSync(join(configHome, "pablo", "voices", "desk"), { recursive: true });
  writeFileSync(join(configHome, "pablo", "voices", "desk", "voice.md"), DESK_VOICE, "utf8");
  const brief = join(cwd, "brief.md");
  writeFileSync(brief, "Announce the new dock hours.\n", "utf8");

  const receiptsPath = join(stateHome, "pablo", "receipts.jsonl");
  expect(existsSync(receiptsPath)).toBe(false);

  const outcome = await proseCore(
    sendArgs({ brief }),
    { cwd, env: { XDG_CONFIG_HOME: configHome, XDG_STATE_HOME: stateHome } },
    { adapter: fakeAdapter() },
  );

  expect(outcome.exitCode).toBe(0);
  const receipts = receiptLines(receiptsPath);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]?.["intent"]).toBe("prose");
});

// ---------------------------------------------------------------------------
// AC1/AC5: refusals — unknown per-voice provider, hung endpoint, empty answer
// ---------------------------------------------------------------------------

test("a voice whose model: names an unknown provider refuses (exit 2), naming it, and never sends (AC1)", async () => {
  const { vault, env, brief } = tempVaultEnv();
  writeFileSync(join(vault, "voices", "desk", "voice.md"), `---\nmodel: nosuchprovider\n---\n\n${DESK_VOICE}`, "utf8");

  let sent = 0;
  const counting: Adapter = {
    ...fakeAdapter(),
    async *complete(): AsyncIterable<CompletionEvent> {
      sent += 1;
      yield { type: "done", stats: FAKE_STATS };
    },
  };

  const outcome = await proseCore(sendArgs({ brief }), { cwd: vault, env }, { adapter: counting });

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("nosuchprovider");
  expect(sent).toBe(0);
  expect(existsSync(join(vault, ".pablo", "receipts.jsonl"))).toBe(false);
});

test("a voice whose model: names a CONFIGURED provider routes to it (AC1)", async () => {
  const { vault, configHome, env, brief } = tempVaultEnv();
  mkdirSync(join(configHome, "pablo"), { recursive: true });
  writeFileSync(
    join(configHome, "pablo", "config.json"),
    JSON.stringify({ providers: { second: { endpoint: "http://127.0.0.1:9/v1", model: "second-model", local: true } } }),
    "utf8",
  );
  writeFileSync(join(vault, "voices", "desk", "voice.md"), `---\nmodel: second\n---\n\n${DESK_VOICE}`, "utf8");

  const outcome = await proseCore(sendArgs({ brief }), { cwd: vault, env }, { adapter: fakeAdapter() });

  expect(outcome.exitCode).toBe(0);
  const receipts = receiptLines(join(vault, ".pablo", "receipts.jsonl"));
  expect(receipts).toHaveLength(1);
});

test("a malformed config refuses (exit 2) rather than throwing (AC5)", async () => {
  const { vault, configHome, env, brief } = tempVaultEnv();
  mkdirSync(join(configHome, "pablo"), { recursive: true });
  writeFileSync(join(configHome, "pablo", "config.json"), "{ not json", "utf8");

  const outcome = await proseCore(sendArgs({ brief }), { cwd: vault, env }, { adapter: fakeAdapter() });

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
});

test("a hung endpoint refuses (exit 2) naming it, and writes no --out file (AC5)", async () => {
  const { vault, env, brief } = tempVaultEnv();
  const outPath = join(vault, "dock-hours.md");
  const hung = new EndpointHung("http://127.0.0.1:9999/v1", 0, 5000);

  const outcome = await proseCore(
    sendArgs({ brief, out: outPath }),
    { cwd: vault, env },
    { adapter: fakeAdapter({ error: hung }) },
  );

  expect(outcome.exitCode).toBe(2);
  expect((outcome.body as { message: string }).message).toContain("http://127.0.0.1:9999/v1");
  expect(existsSync(outPath)).toBe(false);
});

// ---------------------------------------------------------------------------
// AC2/AC4/AC5 through `runProse` — what actually reaches stdout
// ---------------------------------------------------------------------------

/** Captures every `console.log` made during `fn`, restoring it even on throw. */
async function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
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

function cliArgs(overrides: Record<string, unknown> = {}) {
  return {
    voice: "desk",
    brief: "",
    context: [] as readonly string[],
    format: undefined,
    words: undefined,
    dryRun: false,
    json: false,
    out: undefined as string | undefined,
    force: false,
    draft: undefined as string | undefined,
    instruction: undefined as string | undefined,
    ...overrides,
  };
}

test("runProse --json puts exactly one line on stdout, with ok/text/receipt/check (AC2, AC5)", async () => {
  const { vault, env, brief } = tempVaultEnv();
  const { deps } = progressSink();

  const { result, lines } = await captureStdout(() =>
    runProse(cliArgs({ brief, json: true }), { cwd: vault, env }, deps),
  );

  expect(result).toBe(0);
  expect(lines).toHaveLength(1);
  const body = JSON.parse(lines[0] as string);
  expect(body.ok).toBe(true);
  expect(typeof body.text).toBe("string");
  expect(Object.keys(body.receipt).sort()).toEqual([
    "model",
    "prompt_hash",
    "timeToFirstTokenMs",
    "tokensRead",
    "tokensWritten",
    "wallMs",
    "words",
  ]);
  expect(Array.isArray(body.check)).toBe(true);
});

test("runProse without --json puts the piece alone on stdout and the check hits after it on stderr (AC2, AC4, AC5)", async () => {
  const { vault, env, brief } = tempVaultEnv();
  const { deps, lines: progress } = progressSink();

  const { result, lines } = await captureStdout(() => runProse(cliArgs({ brief }), { cwd: vault, env }, deps));

  expect(result).toBe(0);
  // stdout is the deliverable and nothing else: one write, the piece itself.
  expect(lines).toEqual([normalizeOutput(RAW_TEXT)]);
  // The hits are reported, after the text, on the progress stream.
  expect(progress.some((line) => /flagged-line/.test(line))).toBe(true);
  expect(progress.some((line) => /first token after/.test(line))).toBe(true);
});

test("an empty answer refuses (exit 2) and writes no --out file (AC5)", async () => {
  const { vault, env, brief } = tempVaultEnv();
  const outPath = join(vault, "dock-hours.md");

  const outcome = await proseCore(
    sendArgs({ brief, out: outPath }),
    { cwd: vault, env },
    { adapter: emptyStreamAdapter() },
  );

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect(existsSync(outPath)).toBe(false);
});
