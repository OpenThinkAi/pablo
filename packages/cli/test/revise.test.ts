import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent, CompletionStats } from "@openthink/pablo-core";
import type { ReviseCoreArgs, ReviseCoreContext, ReviseDeps, ReviseDryRunBody, ReviseSendBody } from "../src/revise";
import { reviseCore } from "../src/revise";

/**
 * `reviseCore`'s send path, exercised by calling it directly against a fake
 * `Adapter` (see `ReviseDeps.adapter`) so no test ever touches the network,
 * on a throwaway copy of the synthetic fixture vault (never `~/writing`).
 * Mirrors `write-send.test.ts`'s and `prose-send.test.ts`'s own pattern.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const CHAPTER_RELATIVE = join("chapters", "01-the-last-full-cut.md");

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

function tempVault(): { vault: string; project: string } {
  const dir = tempDir("pablo-revise-test-");
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  return { vault, project: join(vault, "novels", "ice-house") };
}

/**
 * `XDG_CONFIG_HOME` pointed at a fresh, empty temp directory on every context
 * this file builds, so a call that reaches `loadConfig` never reads the real
 * `~/.config/pablo/config.json` on whatever machine the test runs on.
 */
function ctxFor(vault: string, project: string): ReviseCoreContext {
  const configHome = tempDir("pablo-revise-config-");
  return { vaultRoot: vault, projectPath: project, env: { XDG_CONFIG_HOME: configHome } };
}

const FAKE_STATS: CompletionStats = {
  timeToFirstTokenMs: 210,
  elapsedMs: 900,
  tokensRead: 600,
  tokensWritten: 18,
  tokensPerSecond: 20,
};

/** Raw model text with one em-dash and one pair of curly quotes — normalization has real work to do. */
const RAW_CHUNKS = ["The scale showed", "—true and steady. ", "“Write it down,”", " Wilfred said."];

function fakeAdapter(options: { readonly chunks?: readonly string[]; readonly model?: string } = {}): Adapter {
  return {
    id: "local",
    model: options.model ?? "test-revise-model",
    preferredOutput: "text",
    async *complete(): AsyncIterable<CompletionEvent> {
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

function silentStderr(): { write(text: string): void } {
  return { write: () => {} };
}

function receiptLines(projectPath: string): Array<Record<string, unknown>> {
  const path = join(projectPath, ".pablo", "receipts.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function baseArgs(overrides: Partial<ReviseCoreArgs> = {}): ReviseCoreArgs {
  return {
    file: CHAPTER_RELATIVE,
    passage: undefined,
    start: undefined,
    end: undefined,
    instruction: "Make Wilfred's line more anxious.",
    dryRun: false,
    ...overrides,
  };
}

/** A passage that occurs exactly once in the fixture chapter. */
const UNIQUE_PASSAGE = '"Weigh it," Wilfred said.';
/** A phrase that occurs exactly twice in the fixture chapter — see the file's two `green book` sentences. */
const REPEATED_PASSAGE = "the green book";

test("revise refuses (exit 2) when --passage matches nothing", async () => {
  const { vault, project } = tempVault();

  const outcome = await reviseCore(baseArgs({ passage: "a line that is nowhere in this manuscript" }), ctxFor(vault, project));

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("not found");
});

test("revise refuses (exit 2) when --passage matches more than once, naming the count", async () => {
  const { vault, project } = tempVault();

  const outcome = await reviseCore(baseArgs({ passage: REPEATED_PASSAGE }), ctxFor(vault, project));

  expect(outcome.exitCode).toBe(2);
  const body = outcome.body as { ok: false; code: number; message: string };
  expect(body.ok).toBe(false);
  expect(body.message).toContain("2 places");
});

test("revise refuses (exit 2) when both --passage and --start/--end are given", async () => {
  const { vault, project } = tempVault();

  const outcome = await reviseCore(baseArgs({ passage: UNIQUE_PASSAGE, start: 0, end: 5 }), ctxFor(vault, project));

  expect(outcome.exitCode).toBe(2);
  expect((outcome.body as { message: string }).message).toContain("not both");
});

test("revise refuses (exit 2) when neither --passage nor --start/--end are given", async () => {
  const { vault, project } = tempVault();

  const outcome = await reviseCore(baseArgs(), ctxFor(vault, project));

  expect(outcome.exitCode).toBe(2);
  expect((outcome.body as { message: string }).message).toContain("requires --passage");
});

test("revise refuses (exit 2) when only one of --start/--end is given", async () => {
  const { vault, project } = tempVault();

  const outcome = await reviseCore(baseArgs({ start: 0 }), ctxFor(vault, project));

  expect(outcome.exitCode).toBe(2);
  expect((outcome.body as { message: string }).message).toContain("--start requires --end");
});

test("revise refuses (exit 2) when --instruction is missing", async () => {
  const { vault, project } = tempVault();

  const outcome = await reviseCore(baseArgs({ passage: UNIQUE_PASSAGE, instruction: undefined }), ctxFor(vault, project));

  expect(outcome.exitCode).toBe(2);
  expect((outcome.body as { message: string }).message).toContain("--instruction");
});

test("revise refuses (exit 2) when --file resolves outside the project", async () => {
  const { vault, project } = tempVault();

  const outcome = await reviseCore(baseArgs({ file: "../../QWEN.md", passage: UNIQUE_PASSAGE }), ctxFor(vault, project));

  expect(outcome.exitCode).toBe(2);
  expect((outcome.body as { message: string }).message).toContain("outside the work");
});

test("--dry-run prints the pack slice by slice (rules, before, passage, after, instruction, closing) and sends nothing", async () => {
  const { vault, project } = tempVault();

  const outcome = await reviseCore(baseArgs({ passage: UNIQUE_PASSAGE, dryRun: true }), ctxFor(vault, project));

  expect(outcome.exitCode).toBe(0);
  const body = outcome.body as ReviseDryRunBody;
  expect(body.ok).toBe(true);
  expect(body.dryRun).toBe(true);
  expect(body.slices.map((s) => s.name)).toEqual(["rules", "before", "passage", "after", "instruction", "closing"]);
  expect(typeof body.prompt_hash).toBe("string");
  expect(body.prompt_hash.length).toBeGreaterThan(0);

  // A dry run never appends a receipt.
  expect(receiptLines(project)).toHaveLength(0);
});

test("the same inputs give the same prompt_hash twice (AC4)", async () => {
  const { vault, project } = tempVault();
  const ctx = ctxFor(vault, project);

  const first = await reviseCore(baseArgs({ passage: UNIQUE_PASSAGE, dryRun: true }), ctx);
  const second = await reviseCore(baseArgs({ passage: UNIQUE_PASSAGE, dryRun: true }), ctx);

  const hashOf = (outcome: typeof first): string => (outcome.body as { prompt_hash: string }).prompt_hash;
  expect(hashOf(first)).toBe(hashOf(second));
  expect(hashOf(first).length).toBeGreaterThan(0);
});

test("--start/--end locates the same span --passage would have located", async () => {
  const { vault, project } = tempVault();

  const raw = readFileSync(join(project, CHAPTER_RELATIVE), "utf8");
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "");
  const start = body.indexOf(UNIQUE_PASSAGE);
  expect(start).toBeGreaterThan(-1);
  const end = start + UNIQUE_PASSAGE.length;

  const viaPassage = await reviseCore(baseArgs({ passage: UNIQUE_PASSAGE, dryRun: true }), ctxFor(vault, project));
  const viaRange = await reviseCore(baseArgs({ start, end, dryRun: true }), ctxFor(vault, project));

  expect(viaRange.exitCode).toBe(0);
  const hashOf = (outcome: typeof viaPassage): string => (outcome.body as { prompt_hash: string }).prompt_hash;
  expect(hashOf(viaRange)).toBe(hashOf(viaPassage));
});

test("a fake-adapter send returns the candidate, leaves the file byte-identical, and writes a revise receipt", async () => {
  const { vault, project } = tempVault();
  const ctx = ctxFor(vault, project);
  const deps: ReviseDeps = { adapter: fakeAdapter(), stderr: silentStderr() };

  const filePath = join(project, CHAPTER_RELATIVE);
  const before = readFileSync(filePath);

  const dryRun = await reviseCore(baseArgs({ passage: UNIQUE_PASSAGE, dryRun: true }), ctx);
  const dryRunBody = dryRun.body as { prompt_hash: string };

  const outcome = await reviseCore(baseArgs({ passage: UNIQUE_PASSAGE }), ctx, deps);

  expect(outcome.exitCode).toBe(0);
  const body = outcome.body as ReviseSendBody;
  expect(body.ok).toBe(true);
  expect(body.candidate).toContain("The scale showed");
  expect(body.candidate).toContain("true and steady");
  expect(body.candidate).not.toContain("—"); // no em-dash: normalizeOutput ran
  expect(body.candidate).not.toMatch(/[“”‘’]/); // no curly quotes

  expect(body.span.start).toBeGreaterThanOrEqual(0);
  expect(body.span.end).toBeGreaterThan(body.span.start);

  expect(body.receipt["prompt_hash"]).toBe(dryRunBody.prompt_hash);
  expect(body.receipt["model"]).toBe("test-revise-model");

  // AC3: the file is byte-identical after the call.
  const after = readFileSync(filePath);
  expect(after.equals(before)).toBe(true);

  // AC4: every real call is receipted with pack_kind "revise".
  const receipts = receiptLines(project);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]?.["pack_kind"]).toBe("revise");
  expect(receipts[0]?.["prompt_hash"]).toBe(dryRunBody.prompt_hash);
  expect(receipts[0]?.["error"]).toBeNull();
});

test("an empty model answer refuses (exit 2) and still leaves the file untouched", async () => {
  const { vault, project } = tempVault();
  const ctx = ctxFor(vault, project);
  const deps: ReviseDeps = { adapter: fakeAdapter({ chunks: [] }), stderr: silentStderr() };

  const filePath = join(project, CHAPTER_RELATIVE);
  const before = readFileSync(filePath);

  const outcome = await reviseCore(baseArgs({ passage: UNIQUE_PASSAGE }), ctx, deps);

  expect(outcome.exitCode).toBe(2);
  expect((outcome.body as { ok: false }).ok).toBe(false);

  const after = readFileSync(filePath);
  expect(after.equals(before)).toBe(true);
});
