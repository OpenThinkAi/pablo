import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `runWrite` itself does the printing (see `write.ts`), so these exercise it
 * the same way `cli.test.ts` exercises the rest of the bin: spawn the real
 * process against a throwaway copy of the synthetic fixture vault, never
 * `~/writing`.
 */
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

function tempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-write-test-"));
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  return vault;
}

function runCli(args: string[], env: Record<string, string> = {}): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(["bun", "run", CLI, ...args], {
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

test("write --chapter 3 refuses (exit 2) naming chapter 2 as unwritten (AC1)", () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(
    ["write", "--project", "ice-house", "--chapter", "3", "--json"],
    { PABLO_VAULT: vault },
  );

  expect(exitCode).toBe(2);
  const body = JSON.parse(stdout);
  expect(body.ok).toBe(false);
  expect(body.code).toBe(2);
  expect(body.missing).toContain("chapter 2 is not written");

  rmSync(vault, { recursive: true, force: true });
});

test("write --chapter x (not a positive integer) refuses with exit 2", () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(
    ["write", "--project", "ice-house", "--chapter", "x", "--json"],
    { PABLO_VAULT: vault },
  );

  expect(exitCode).toBe(2);
  const body = JSON.parse(stdout);
  expect(body.ok).toBe(false);
  expect(body.code).toBe(2);

  rmSync(vault, { recursive: true, force: true });
});

test("write --chapter 2 --dry-run --json exits 0 with a stable prompt_hash and totalTokens > 0 (AC4, AC5)", () => {
  const vault = tempVault();

  const first = runCli(
    ["write", "--project", "ice-house", "--chapter", "2", "--dry-run", "--json"],
    { PABLO_VAULT: vault },
  );
  const second = runCli(
    ["write", "--project", "ice-house", "--chapter", "2", "--dry-run", "--json"],
    { PABLO_VAULT: vault },
  );

  expect(first.exitCode).toBe(0);
  expect(second.exitCode).toBe(0);

  const firstBody = JSON.parse(first.stdout);
  const secondBody = JSON.parse(second.stdout);

  expect(firstBody.ok).toBe(true);
  expect(firstBody.dryRun).toBe(true);
  expect(firstBody.totalTokens).toBeGreaterThan(0);
  expect(typeof firstBody.expectedOutputTokens).toBe("number");
  expect(firstBody.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(Array.isArray(firstBody.slices)).toBe(true);
  expect(firstBody.slices.length).toBeGreaterThan(0);

  // AC5: the same (vault files, N, opts) produce the same prompt_hash on two runs.
  expect(secondBody.prompt_hash).toBe(firstBody.prompt_hash);
  expect(secondBody.totalTokens).toBe(firstBody.totalTokens);

  rmSync(vault, { recursive: true, force: true });
});

test("write --chapter 2 --dry-run (prose) exits 0 and prints the slice table and an estimated wait", () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(
    ["write", "--project", "ice-house", "--chapter", "2", "--dry-run"],
    { PABLO_VAULT: vault },
  );

  expect(exitCode).toBe(0);
  expect(stdout).toContain("drafting pack");
  expect(stdout).toContain("Estimated wait");
  expect(stdout).toContain("timeline");

  rmSync(vault, { recursive: true, force: true });
});

test("write --chapter 2 (no --dry-run) exits 1 with the AGT-1237 message and sends nothing", () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(
    ["write", "--project", "ice-house", "--chapter", "2", "--json"],
    { PABLO_VAULT: vault },
  );

  expect(exitCode).toBe(1);
  const body = JSON.parse(stdout);
  expect(body.ok).toBe(false);
  expect(body.code).toBe(1);
  expect(body.message).toContain("AGT-1237");
  expect(body.message).toContain("--dry-run");

  rmSync(vault, { recursive: true, force: true });
});

test("write --project no-marker refuses (exit 2) before ever looking at --chapter", () => {
  const vault = tempVault();

  const { exitCode } = runCli(
    ["write", "--project", "no-marker", "--chapter", "1", "--json"],
    { PABLO_VAULT: vault },
  );

  expect(exitCode).toBe(2);

  rmSync(vault, { recursive: true, force: true });
});
