import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { screenRefresh } from "../src/screen-refresh";

/**
 * The screen's live data (AGT-1640): the refresh against a temp git copy of the fixture vault. Nothing reaches
 * GitHub, a model, `think` or the author's real directories.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pablo-screen-refresh-"));
  roots.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "t@example.com");
  git(vault, "config", "user.name", "T");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  const env = { PATH: NO_THINK_PATH, HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "config"), XDG_STATE_HOME: join(dir, "state"), PABLO_HOME: join(dir, "home"), PABLO_VAULT: vault };
  return { vault, project: join(vault, "novels", "ice-house"), env };
}

test("refresh: the book read again shows a branch made after the first read, and its chapter as waiting", () => {
  const { vault, project } = setup();
  const refresh = screenRefresh(project);
  const before = refresh();
  expect(before?.branches).toEqual([]);
  const stages = before?.stages ?? [];
  expect(stages.some((s) => s.id === "chapters")).toBe(true);
  git(vault, "checkout", "-q", "-b", "edit/abc123");
  git(vault, "commit", "-q", "--allow-empty", "-m", "an edit");
  git(vault, "checkout", "-q", "main");
  expect(refresh()?.branches).toEqual(["edit/abc123"]);
});
