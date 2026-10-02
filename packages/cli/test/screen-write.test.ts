import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent } from "@openthink/pablo-core";
import { screenWriter } from "../src/screen-write";

/**
 * The screen's writer (AGT-1542): `runWrite` against a fake Adapter on a temp git copy of the fixture vault, with a
 * think-free PATH and temp state/home dirs, so nothing reaches a model, `think`, or the author's real directories.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function git(dir: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pablo-screen-write-"));
  roots.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "t@example.com");
  git(vault, "config", "user.name", "T");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  const env = { PATH: NO_THINK_PATH, XDG_STATE_HOME: join(dir, "state"), PABLO_HOME: join(dir, "home") };
  return { vault, project: join(vault, "novels", "ice-house"), env };
}

const adapter: Adapter = {
  id: "local",
  model: "test-writer-model",
  preferredOutput: "text",
  async *complete(): AsyncIterable<CompletionEvent> {
    yield { type: "token", text: "The storm came up from the coast. " };
    yield { type: "token", text: "She said nothing." };
    yield { type: "done", stats: { timeToFirstTokenMs: 400, elapsedMs: 1800, tokensRead: 1200, tokensWritten: 42, tokensPerSecond: 30 } };
  },
  async proposeEdit(): Promise<never> { throw new Error("not implemented"); },
  async extractFacts(): Promise<never> { throw new Error("not implemented"); },
};

test("writes the chapter on a draft branch, streams progress lines, and returns the receipt", async () => {
  const { vault, project, env } = setup();
  const progress: string[] = [];
  const result = await screenWriter(vault, project, { adapter, env })(2, (l) => progress.push(l));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.branch).toBe("draft/ch02");
  expect(result.lines[0]).toContain("on branch draft/ch02");
  expect(result.lines.join("\n")).toContain("read 1200 tokens");
  expect(progress[0]).toBe("waiting for first token…");
  expect(progress.some((l) => l.startsWith("first token after"))).toBe(true);
});

test("a refusal comes back with its missing reasons, and nothing is made", async () => {
  const { vault, project, env } = setup();
  const result = await screenWriter(vault, project, { adapter, env })(9, () => {});
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.message).toContain("chapter 9 is not ready");
  expect(result.missing.length).toBeGreaterThan(0);
});
