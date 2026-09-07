import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProsePack, proseCore } from "../src/prose";
import { readVoice } from "../src/voice";

/**
 * Every test below works on a throwaway copy of the synthetic fixture vault
 * (or a bare temp directory, for the no-vault cases) — never `~/writing` or
 * the real `~/.config/pablo`. See `CLAUDE.md`'s "never write into ~/writing"
 * rule and this ticket's "never write into any real vault" constraint.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const cleanupDirs: string[] = [];

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-prose-test-"));
  cleanupDirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  return vault;
}

function tempConfigHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-prose-config-"));
  cleanupDirs.push(dir);
  return dir;
}

function writeBrief(dir: string, text = "Announce the new dock hours.\n"): string {
  const path = join(dir, "brief.md");
  writeFileSync(path, text, "utf8");
  return path;
}

/**
 * Every spawned run gets a throwaway `XDG_STATE_HOME` as well as whatever the
 * caller passes: the send path appends its receipt to
 * `$XDG_STATE_HOME/pablo/receipts.jsonl` when there is no vault (AGT-1242's
 * AC3), and a test that forgot it would append to the author's real log.
 */
function runCli(args: string[], env: Record<string, string> = {}, stdin?: string): { stdout: string; stderr: string; exitCode: number } {
  const stateHome = mkdtempSync(join(tmpdir(), "pablo-prose-state-"));
  cleanupDirs.push(stateHome);
  const result = Bun.spawnSync(["bun", "run", CLI, ...args], {
    env: { ...process.env, XDG_STATE_HOME: stateHome, ...env },
    ...(stdin !== undefined ? { stdin: Buffer.from(stdin) } : {}),
  });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode };
}

// ---------------------------------------------------------------------------
// buildProsePack — pure over TextSources
// ---------------------------------------------------------------------------

test("buildProsePack resolves --format to its stanza text and refuses an unknown one", async () => {
  const vault = tempVault();
  const voice = readVoice(join(vault, "voices", "plain"));

  const ok = buildProsePack(voice, {
    brief: { path: "brief.md", text: "Announce the change." },
    context: [],
    format: "email",
    words: undefined,
  });
  expect(ok.ok).toBe(true);
  if (ok.ok) expect(ok.pack.prompt).toContain("Subject:");

  const bad = buildProsePack(voice, {
    brief: { path: "brief.md", text: "Announce the change." },
    context: [],
    format: "bogus",
    words: undefined,
  });
  expect(bad.ok).toBe(false);
  if (!bad.ok) {
    expect(bad.code).toBe(2);
    expect(bad.message).toContain("bogus");
  }
});

// ---------------------------------------------------------------------------
// proseCore — dry-run JSON shape (AC2), refusals (AC4), determinism (AC3)
// ---------------------------------------------------------------------------

test("proseCore dry-run on the fixture's plain voice returns AC2's exact shape", async () => {
  const vault = tempVault();
  const briefPath = writeBrief(vault);

  const outcome = await proseCore(
    { voice: "plain", brief: briefPath, context: [], format: undefined, words: undefined, dryRun: true, out: undefined, force: false },
    { cwd: vault, env: { PABLO_VAULT: vault } },
  );

  expect(outcome.exitCode).toBe(0);
  expect(outcome.body).toMatchObject({ ok: true, dryRun: true });
  const body = outcome.body as unknown as {
    slices: Array<{ name: string; heading: string; tokens: number }>;
    totalTokens: number;
    expectedOutputTokens: number;
    prompt_hash: string;
    adjustments: unknown[];
  };
  expect(Array.isArray(body.slices)).toBe(true);
  expect(body.slices.map((s) => s.name)).toEqual(["rules", "exemplars", "brief", "closing"]);
  expect(typeof body.totalTokens).toBe("number");
  expect(typeof body.expectedOutputTokens).toBe("number");
  expect(body.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(Array.isArray(body.adjustments)).toBe(true);
  expect(outcome.pack).toBeDefined();
});

// AGT-1242 replaced AGT-1241's "not wired to the model yet" exit-1 branch with
// the real send path. The fixture's `plain` voice carries `model: anthropic`
// in its frontmatter and the temp config home has no such provider, so this
// exercises AC1's per-voice override refusing an unknown provider — and, like
// every send-path test, never reaches an endpoint. The full send path lives in
// prose-send.test.ts against a fake adapter.
test("proseCore without --dry-run, on a voice whose model: names an unconfigured provider, refuses (exit 2)", async () => {
  const vault = tempVault();
  const configHome = tempConfigHome();
  const briefPath = writeBrief(vault);

  const outcome = await proseCore(
    { voice: "plain", brief: briefPath, context: [], format: undefined, words: undefined, dryRun: false, out: undefined, force: false },
    { cwd: vault, env: { PABLO_VAULT: vault, XDG_CONFIG_HOME: configHome } },
  );

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("anthropic");
});

test("proseCore with two context files in argument order shows both in the slice table, in order", async () => {
  const vault = tempVault();
  const briefPath = writeBrief(vault);
  const aPath = join(vault, "a.md");
  const bPath = join(vault, "b.md");
  writeFileSync(aPath, "The first context file.\n", "utf8");
  writeFileSync(bPath, "The second context file.\n", "utf8");

  const outcome = await proseCore(
    { voice: "plain", brief: briefPath, context: [aPath, bPath], format: undefined, words: undefined, dryRun: true, out: undefined, force: false },
    { cwd: vault, env: { PABLO_VAULT: vault } },
  );

  expect(outcome.exitCode).toBe(0);
  const body = outcome.body as unknown as { slices: Array<{ name: string; source: string | undefined }> };
  const contextSlices = body.slices.filter((s) => s.name.startsWith("context-"));
  expect(contextSlices.map((s) => s.source)).toEqual([aPath, bPath]);
});

test("proseCore: the same voice, brief, context and options produce the same prompt_hash on two runs (AC3)", async () => {
  const vault = tempVault();
  const briefPath = writeBrief(vault);
  const contextPath = join(vault, "c.md");
  writeFileSync(contextPath, "Some context.\n", "utf8");

  const args = { voice: "plain", brief: briefPath, context: [contextPath], format: "email", words: 200, dryRun: true, out: undefined, force: false } as const;
  const ctx = { cwd: vault, env: { PABLO_VAULT: vault } };

  const first = await proseCore(args, ctx);
  const second = await proseCore(args, ctx);

  expect(first.body).toMatchObject({ ok: true });
  expect((first.body as { prompt_hash: string }).prompt_hash).toBe((second.body as { prompt_hash: string }).prompt_hash);
});

test("proseCore without --voice refuses (exit 2)", async () => {
  const vault = tempVault();
  const briefPath = writeBrief(vault);

  const outcome = await proseCore(
    { voice: undefined, brief: briefPath, context: [], format: undefined, words: undefined, dryRun: true, out: undefined, force: false },
    { cwd: vault, env: { PABLO_VAULT: vault } },
  );

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("--voice");
});

test("proseCore with an unresolvable voice refuses (exit 2), naming what it tried", async () => {
  const vault = tempVault();
  const briefPath = writeBrief(vault);

  const outcome = await proseCore(
    { voice: "nosuchvoice", brief: briefPath, context: [], format: undefined, words: undefined, dryRun: true, out: undefined, force: false },
    { cwd: vault, env: { PABLO_VAULT: vault } },
  );

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as unknown as { tried: string[] }).tried.length).toBeGreaterThan(0);
});

test("proseCore without --brief refuses (exit 2)", async () => {
  const vault = tempVault();

  const outcome = await proseCore(
    { voice: "plain", brief: undefined, context: [], format: undefined, words: undefined, dryRun: true, out: undefined, force: false },
    { cwd: vault, env: { PABLO_VAULT: vault } },
  );

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("--brief");
});

test("proseCore with an unreadable --brief file refuses", async () => {
  const vault = tempVault();

  const outcome = await proseCore(
    { voice: "plain", brief: join(vault, "does-not-exist.md"), context: [], format: undefined, words: undefined, dryRun: true, out: undefined, force: false },
    { cwd: vault, env: { PABLO_VAULT: vault } },
  );

  expect(outcome.body).toMatchObject({ ok: false });
  expect((outcome.body as { message: string }).message).toContain("does-not-exist.md");
});

test("proseCore with an unreadable --context file refuses", async () => {
  const vault = tempVault();
  const briefPath = writeBrief(vault);

  const outcome = await proseCore(
    {
      voice: "plain",
      brief: briefPath,
      context: [join(vault, "no-such-context.md")],
      format: undefined,
      words: undefined,
      dryRun: true,
      out: undefined,
      force: false,
    },
    { cwd: vault, env: { PABLO_VAULT: vault } },
  );

  expect(outcome.body).toMatchObject({ ok: false });
  expect((outcome.body as { message: string }).message).toContain("no-such-context.md");
});

test("proseCore with an unknown --format refuses (exit 2), naming the known formats", async () => {
  const vault = tempVault();
  const briefPath = writeBrief(vault);

  const outcome = await proseCore(
    { voice: "plain", brief: briefPath, context: [], format: "bogus", words: undefined, dryRun: true, out: undefined, force: false },
    { cwd: vault, env: { PABLO_VAULT: vault } },
  );

  expect(outcome.exitCode).toBe(2);
  expect(outcome.body).toMatchObject({ ok: false, code: 2 });
  expect((outcome.body as { message: string }).message).toContain("bogus");
});

// AC4: no --project or --project is required; running with no vault at all
// works with a global voice.
test("proseCore with no vault at all resolves a global voice under XDG_CONFIG_HOME", async () => {
  const noVaultCwd = mkdtempSync(join(tmpdir(), "pablo-prose-novault-"));
  cleanupDirs.push(noVaultCwd);
  const configHome = tempConfigHome();
  mkdirSync(join(configHome, "pablo", "voices", "memo", "exemplars"), { recursive: true });
  writeFileSync(join(configHome, "pablo", "voices", "memo", "voice.md"), "# Voice: memo\n\nShort and plain.\n", "utf8");
  const briefPath = writeBrief(noVaultCwd);

  const outcome = await proseCore(
    { voice: "memo", brief: briefPath, context: [], format: undefined, words: undefined, dryRun: true, out: undefined, force: false },
    { cwd: noVaultCwd, env: { XDG_CONFIG_HOME: configHome } },
  );

  expect(outcome.exitCode).toBe(0);
  expect(outcome.body).toMatchObject({ ok: true, dryRun: true });
});

// ---------------------------------------------------------------------------
// Through the spawned CLI — argv parsing, --json/prose text, stdin, exit codes
// ---------------------------------------------------------------------------

test("prose --dry-run --json through the CLI prints AC2's shape and exits 0", async () => {
  const vault = tempVault();
  const briefPath = writeBrief(vault);

  const { stdout, exitCode } = runCli(["prose", "--voice", "plain", "--brief", briefPath, "--dry-run", "--json"], {
    PABLO_VAULT: vault,
  });

  expect(exitCode).toBe(0);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: true, dryRun: true });
  expect(typeof body.prompt_hash).toBe("string");
});

test("prose --dry-run (no --json) through the CLI prints the human-readable slice table and wait estimate", async () => {
  const vault = tempVault();
  const briefPath = writeBrief(vault);

  const { stdout, exitCode } = runCli(["prose", "--voice", "plain", "--brief", briefPath, "--dry-run"], { PABLO_VAULT: vault });

  expect(exitCode).toBe(0);
  expect(stdout).toContain("prose pack");
  expect(stdout).toContain("Estimated wait");
});

test("prose --brief - reads stdin through the CLI", async () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(
    ["prose", "--voice", "plain", "--brief", "-", "--dry-run", "--json"],
    { PABLO_VAULT: vault },
    "Announce the new dock hours from stdin.\n",
  );

  expect(exitCode).toBe(0);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: true, dryRun: true });
});

test("prose with no --voice through the CLI exits 2, naming the problem", async () => {
  const vault = tempVault();
  const briefPath = writeBrief(vault);

  const { stdout, exitCode } = runCli(["prose", "--brief", briefPath, "--dry-run", "--json"], { PABLO_VAULT: vault });

  expect(exitCode).toBe(2);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: false, code: 2 });
  expect(body.message).toContain("--voice");
});

test("prose --format bogus through the CLI exits 2", async () => {
  const vault = tempVault();
  const briefPath = writeBrief(vault);

  const { stdout, exitCode } = runCli(
    ["prose", "--voice", "plain", "--brief", briefPath, "--format", "bogus", "--dry-run", "--json"],
    { PABLO_VAULT: vault },
  );

  expect(exitCode).toBe(2);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: false, code: 2 });
});

test("prose without --dry-run through the CLI, on a voice naming an unconfigured provider, exits 2", async () => {
  const vault = tempVault();
  const configHome = tempConfigHome();
  const briefPath = writeBrief(vault);

  const { stdout, exitCode } = runCli(["prose", "--voice", "plain", "--brief", briefPath, "--json"], {
    PABLO_VAULT: vault,
    XDG_CONFIG_HOME: configHome,
  });

  expect(exitCode).toBe(2);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: false, code: 2 });
  expect(body.message).toContain("anthropic");
});

test("prose with no vault at all through the CLI, from a directory with no marker, resolves a global voice", async () => {
  const noVaultCwd = mkdtempSync(join(tmpdir(), "pablo-prose-cli-novault-"));
  cleanupDirs.push(noVaultCwd);
  const configHome = tempConfigHome();
  mkdirSync(join(configHome, "pablo", "voices", "memo", "exemplars"), { recursive: true });
  writeFileSync(join(configHome, "pablo", "voices", "memo", "voice.md"), "# Voice: memo\n\nShort and plain.\n", "utf8");
  const briefPath = writeBrief(noVaultCwd);

  // `PABLO_VAULT` is deliberately stripped, not just left unset — the real
  // shell running this test could have it exported (this is a pablo repo).
  const env: Record<string, string | undefined> = { ...process.env, XDG_CONFIG_HOME: configHome };
  delete env["PABLO_VAULT"];

  const result = Bun.spawnSync(["bun", "run", CLI, "prose", "--voice", "memo", "--brief", briefPath, "--dry-run", "--json"], {
    env,
    cwd: noVaultCwd,
  });

  expect(result.exitCode).toBe(0);
  const body = JSON.parse(result.stdout.toString());
  expect(body).toMatchObject({ ok: true, dryRun: true });
});

test("two --dry-run --json runs of the same invocation through the CLI produce the same prompt_hash (AC3)", async () => {
  const vault = tempVault();
  const briefPath = writeBrief(vault);
  const args = ["prose", "--voice", "plain", "--brief", briefPath, "--words", "200", "--dry-run", "--json"];

  const first = runCli(args, { PABLO_VAULT: vault });
  const second = runCli(args, { PABLO_VAULT: vault });

  expect(first.exitCode).toBe(0);
  expect(second.exitCode).toBe(0);
  expect(JSON.parse(first.stdout).prompt_hash).toBe(JSON.parse(second.stdout).prompt_hash);
});
