import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * These spawn the real bin, so they exercise argv parsing, exit codes and
 * stdout end to end. `PABLO_VAULT` always points at a throwaway copy of the
 * synthetic fixture — never the real `~/writing` vault.
 */
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

function tempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-cli-test-"));
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

test("pablo --help lists the P0 verbs and exits 0", () => {
  const { stdout, exitCode } = runCli(["--help"]);

  expect(exitCode).toBe(0);
  for (const verb of ["init", "resume", "status", "write", "save", "check", "dry-run", "mcp"]) {
    expect(stdout).toContain(verb);
  }
});

test("pablo with no verb prints help and exits 0", () => {
  const { exitCode, stdout } = runCli([]);

  expect(exitCode).toBe(0);
  expect(stdout).toContain("Usage: pablo");
});

test("resume --project nope --json exits 2 with a JSON refusal body", () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(["resume", "--project", "nope", "--json"], { PABLO_VAULT: vault });

  expect(exitCode).toBe(2);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: false, code: 2 });
  expect(typeof body.message).toBe("string");
  expect(Array.isArray(body.tried)).toBe(true);

  rmSync(vault, { recursive: true, force: true });
});

test("resume --project ice-house --json exits 1 (not implemented) once the project resolves", () => {
  const vault = tempVault();

  const { stdout, exitCode } = runCli(["resume", "--project", "ice-house", "--json"], { PABLO_VAULT: vault });

  expect(exitCode).toBe(1);
  const body = JSON.parse(stdout);
  expect(body).toMatchObject({ ok: false, code: 1 });
  expect(body.message).toContain("not implemented");

  rmSync(vault, { recursive: true, force: true });
});

test("an unknown verb exits 1", () => {
  const { exitCode, stderr } = runCli(["frobnicate"]);

  expect(exitCode).toBe(1);
  expect(stderr).toContain("unknown verb");
});
