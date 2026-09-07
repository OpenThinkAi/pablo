import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent, CompletionRequest, CompletionStats } from "@openthink/pablo-core";
import { proseCore } from "../src/prose";
import type { ProseCoreArgs, ProseDeps, ProseSendBody } from "../src/prose";

/**
 * AGT-1244: `pablo prose --draft <file> --instruction "<text>"`, the revise
 * loop. Every run works on a throwaway copy of the synthetic fixture vault
 * (or a bare temp directory), with `XDG_CONFIG_HOME`/`XDG_STATE_HOME` pointed
 * at temp directories — same shape as `prose.test.ts`/`prose-send.test.ts`.
 * Nothing here reaches the network or the real `think`.
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

function tempVault(): string {
  const dir = tempDir("pablo-prose-revise-");
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  return vault;
}

/** A voice with no `model:` frontmatter, so the send path routes local without an unconfigured-provider refusal. */
const DESK_VOICE = `# Voice: desk

## Register

Short sentences. Say the fact and stop.
`;

function writeDeskVoice(vault: string): void {
  mkdirSync(join(vault, "voices", "desk"), { recursive: true });
  writeFileSync(join(vault, "voices", "desk", "voice.md"), DESK_VOICE, "utf8");
}

function writeBrief(dir: string, text = "Announce the new dock hours.\n"): string {
  const path = join(dir, "brief.md");
  writeFileSync(path, text, "utf8");
  return path;
}

function baseArgs(overrides: Partial<ProseCoreArgs> = {}): ProseCoreArgs {
  return {
    voice: "plain",
    brief: undefined,
    context: [],
    format: undefined,
    words: undefined,
    dryRun: true,
    out: undefined,
    force: false,
    draft: undefined,
    instruction: undefined,
    ...overrides,
  };
}

const RAW_CHUNKS = ["The dock opens at six", " from Monday."];
const RAW_TEXT = RAW_CHUNKS.join("");
const FAKE_STATS: CompletionStats = {
  timeToFirstTokenMs: 200,
  elapsedMs: 900,
  tokensRead: 500,
  tokensWritten: 20,
  tokensPerSecond: 22,
};

function fakeAdapter(chunks: readonly string[] = RAW_CHUNKS): Adapter {
  return {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text",
    async *complete(): AsyncIterable<CompletionEvent> {
      for (const chunk of chunks) yield { type: "token", text: chunk };
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

function noProgress(): ProseDeps {
  return { adapter: fakeAdapter(), now: () => new Date("2026-09-07T12:00:00.000Z"), stderr: { write: () => {} } };
}

// ---------------------------------------------------------------------------
// AC1/AC2: dry-run slice presence and order
// ---------------------------------------------------------------------------

test("--dry-run with --draft and --instruction shows both slices, in order, before the closing", async () => {
  const vault = tempVault();
  const briefPath = writeBrief(vault);
  const draftPath = join(vault, "prev.md");
  writeFileSync(draftPath, "The dock opens at seven, not six.\n", "utf8");

  const outcome = await proseCore(
    baseArgs({ brief: briefPath, draft: draftPath, instruction: "Shorten it." }),
    { cwd: vault, env: { PABLO_VAULT: vault } },
  );

  expect(outcome.exitCode).toBe(0);
  const body = outcome.body as unknown as { slices: Array<{ name: string; heading: string; source: string | undefined }> };
  const names = body.slices.map((s) => s.name);
  expect(names.indexOf("draft")).toBeGreaterThan(-1);
  expect(names.indexOf("instruction")).toBeGreaterThan(-1);
  expect(names.indexOf("draft")).toBeLessThan(names.indexOf("instruction"));
  expect(names.indexOf("instruction")).toBeLessThan(names.indexOf("closing"));
  expect(names[names.length - 1]).toBe("closing");

  const draftSlice = body.slices.find((s) => s.name === "draft");
  expect(draftSlice?.source).toBe(draftPath);
});

test("a --dry-run with no --draft/--instruction never shows those slices", async () => {
  const vault = tempVault();
  const briefPath = writeBrief(vault);

  const outcome = await proseCore(baseArgs({ brief: briefPath }), { cwd: vault, env: { PABLO_VAULT: vault } });

  const body = outcome.body as unknown as { slices: Array<{ name: string }> };
  const names = body.slices.map((s) => s.name);
  expect(names).not.toContain("draft");
  expect(names).not.toContain("instruction");
});

// ---------------------------------------------------------------------------
// AC2: refusals — one flag without the other
// ---------------------------------------------------------------------------

test("--draft without --instruction refuses (exit 2)", async () => {
  const vault = tempVault();
  const briefPath = writeBrief(vault);
  const draftPath = join(vault, "prev.md");
  writeFileSync(draftPath, "Previous text.\n", "utf8");

  const outcome = await proseCore(baseArgs({ brief: briefPath, draft: draftPath }), { cwd: vault, env: { PABLO_VAULT: vault } });

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("--instruction");
});

test("--instruction without --draft refuses (exit 2)", async () => {
  const vault = tempVault();
  const briefPath = writeBrief(vault);

  const outcome = await proseCore(
    baseArgs({ brief: briefPath, instruction: "Shorten it." }),
    { cwd: vault, env: { PABLO_VAULT: vault } },
  );

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("--draft");
});

test("the --draft/--instruction pairing refusal fires even with no --voice or --brief at all", async () => {
  const vault = tempVault();

  const outcome = await proseCore(baseArgs({ voice: undefined, brief: undefined, draft: "x.md" }), {
    cwd: vault,
    env: { PABLO_VAULT: vault },
  });

  expect(outcome.exitCode).toBe(2);
  expect((outcome.body as { message: string }).message).toContain("--instruction");
});

// ---------------------------------------------------------------------------
// AC4: same draft/instruction/voice/brief give the same prompt_hash
// ---------------------------------------------------------------------------

test("the same voice, brief, draft and instruction give the same prompt_hash on two runs (AC4)", async () => {
  const vault = tempVault();
  const briefPath = writeBrief(vault);
  const draftPath = join(vault, "prev.md");
  writeFileSync(draftPath, "The dock opens at seven, not six.\n", "utf8");

  const args = baseArgs({ brief: briefPath, draft: draftPath, instruction: "Shorten it." });
  const ctx = { cwd: vault, env: { PABLO_VAULT: vault } };

  const first = await proseCore(args, ctx);
  const second = await proseCore(args, ctx);

  const firstHash = (first.body as { prompt_hash: string }).prompt_hash;
  const secondHash = (second.body as { prompt_hash: string }).prompt_hash;
  expect(firstHash).toMatch(/^[0-9a-f]{64}$/);
  expect(firstHash).toBe(secondHash);
});

// ---------------------------------------------------------------------------
// AC3: revised_from — with and without frontmatter on the draft
// ---------------------------------------------------------------------------

test("--draft with pablo frontmatter carries the draft's own prompt_hash as revised_from (AC3)", async () => {
  const vault = tempVault();
  writeDeskVoice(vault);
  const briefPath = writeBrief(vault);
  const draftPath = join(vault, "prev.md");
  writeFileSync(
    draftPath,
    ["---", "voice: desk", "model: test-writer-model", "generated: 2026-09-06T00:00:00.000Z", "prompt_hash: deadbeef", "words: 5", "---", "", "The dock opens at seven.", ""].join("\n"),
    "utf8",
  );

  const outcome = await proseCore(
    { voice: "desk", brief: briefPath, context: [], format: undefined, words: undefined, dryRun: false, out: undefined, force: false, draft: draftPath, instruction: "Shorten it." },
    { cwd: vault, env: { PABLO_VAULT: vault } },
    noProgress(),
  );

  expect(outcome.exitCode).toBe(0);
  const body = outcome.body as ProseSendBody;
  expect(body.receipt.revised_from).toBe("deadbeef");
});

test("--draft with no frontmatter at all carries revised_from: \"unknown\" (AC3)", async () => {
  const vault = tempVault();
  writeDeskVoice(vault);
  const briefPath = writeBrief(vault);
  const draftPath = join(vault, "prev.md");
  writeFileSync(draftPath, "The dock opens at seven, plain text, no frontmatter.\n", "utf8");

  const outcome = await proseCore(
    { voice: "desk", brief: briefPath, context: [], format: undefined, words: undefined, dryRun: false, out: undefined, force: false, draft: draftPath, instruction: "Shorten it." },
    { cwd: vault, env: { PABLO_VAULT: vault } },
    noProgress(),
  );

  expect(outcome.exitCode).toBe(0);
  const body = outcome.body as ProseSendBody;
  expect(body.receipt.revised_from).toBe("unknown");
});

test("a send with no --draft carries no revised_from field at all", async () => {
  const vault = tempVault();
  writeDeskVoice(vault);
  const briefPath = writeBrief(vault);

  const outcome = await proseCore(
    { voice: "desk", brief: briefPath, context: [], format: undefined, words: undefined, dryRun: false, out: undefined, force: false, draft: undefined, instruction: undefined },
    { cwd: vault, env: { PABLO_VAULT: vault } },
    noProgress(),
  );

  expect(outcome.exitCode).toBe(0);
  const body = outcome.body as ProseSendBody;
  expect("revised_from" in body.receipt).toBe(false);
});

// ---------------------------------------------------------------------------
// --out with revised_from frontmatter; --out at the draft's own path needs --force
// ---------------------------------------------------------------------------

test("--out on a revise call writes revised_from into the frontmatter (AC3)", async () => {
  const vault = tempVault();
  writeDeskVoice(vault);
  const briefPath = writeBrief(vault);
  const draftPath = join(vault, "prev.md");
  writeFileSync(
    draftPath,
    ["---", "voice: desk", "model: test-writer-model", "generated: 2026-09-06T00:00:00.000Z", "prompt_hash: cafef00d", "words: 5", "---", "", "The dock opens at seven.", ""].join("\n"),
    "utf8",
  );
  const outPath = join(vault, "notices", "dock-hours.md");

  const outcome = await proseCore(
    { voice: "desk", brief: briefPath, context: [], format: undefined, words: undefined, dryRun: false, out: outPath, force: false, draft: draftPath, instruction: "Shorten it." },
    { cwd: vault, env: { PABLO_VAULT: vault } },
    noProgress(),
  );

  expect(outcome.exitCode).toBe(0);
  const text = readFileSync(outPath, "utf8");
  expect(text).toContain("revised_from: cafef00d");
  // Key order fixed: voice, model, generated, prompt_hash, revised_from, words.
  const keys = text
    .split("\n")
    .slice(1, 7)
    .map((line) => (line.split(":")[0] ?? "").trim());
  expect(keys).toEqual(["voice", "model", "generated", "prompt_hash", "revised_from", "words"]);
});

test("--out pointing at the draft file itself refuses without --force, and --force overwrites it (AC3)", async () => {
  const vault = tempVault();
  writeDeskVoice(vault);
  const briefPath = writeBrief(vault);
  const draftPath = join(vault, "prev.md");
  writeFileSync(draftPath, "The dock opens at seven, not six.\n", "utf8");

  const refused = await proseCore(
    { voice: "desk", brief: briefPath, context: [], format: undefined, words: undefined, dryRun: false, out: draftPath, force: false, draft: draftPath, instruction: "Shorten it." },
    { cwd: vault, env: { PABLO_VAULT: vault } },
    noProgress(),
  );
  expect(refused.exitCode).toBe(2);
  expect(readFileSync(draftPath, "utf8")).toBe("The dock opens at seven, not six.\n");

  const forced = await proseCore(
    { voice: "desk", brief: briefPath, context: [], format: undefined, words: undefined, dryRun: false, out: draftPath, force: true, draft: draftPath, instruction: "Shorten it." },
    { cwd: vault, env: { PABLO_VAULT: vault } },
    noProgress(),
  );
  expect(forced.exitCode).toBe(0);
  expect(readFileSync(draftPath, "utf8")).toContain(RAW_TEXT);
});

// ---------------------------------------------------------------------------
// The instruction text reaches the prompt sent to the model
// ---------------------------------------------------------------------------

test("the sanitized instruction and the frontmatter-stripped draft body both appear in the prompt actually sent", async () => {
  const vault = tempVault();
  writeDeskVoice(vault);
  const briefPath = writeBrief(vault);
  const draftPath = join(vault, "prev.md");
  writeFileSync(
    draftPath,
    ["---", "voice: desk", "prompt_hash: abc123", "---", "", "The dock opens at seven, not six.", ""].join("\n"),
    "utf8",
  );

  let sentPrompt = "";
  const capturing: Adapter = {
    ...fakeAdapter(),
    async *complete(request: CompletionRequest): AsyncIterable<CompletionEvent> {
      sentPrompt = request.prompt;
      for (const chunk of RAW_CHUNKS) yield { type: "token", text: chunk };
      yield { type: "done", stats: FAKE_STATS };
    },
  };

  const outcome = await proseCore(
    {
      voice: "desk",
      brief: briefPath,
      context: [],
      format: undefined,
      words: undefined,
      dryRun: false,
      out: undefined,
      force: false,
      draft: draftPath,
      instruction: "Line one.\nLine two with a fake # heading.",
    },
    { cwd: vault, env: { PABLO_VAULT: vault } },
    { adapter: capturing, now: () => new Date("2026-09-07T12:00:00.000Z"), stderr: { write: () => {} } },
  );

  expect(outcome.exitCode).toBe(0);
  expect(sentPrompt).toContain("The dock opens at seven, not six.");
  expect(sentPrompt).not.toContain("voice: desk"); // frontmatter stripped
  expect(sentPrompt).not.toContain("prompt_hash: abc123");
  // Flattened to one line: no line in the prompt begins with "# heading" from
  // the instruction (the only real headings are the pack's own).
  expect(sentPrompt).toContain("Line one. Line two with a fake # heading.");
  expect(sentPrompt.includes("\n# heading")).toBe(false);
});
