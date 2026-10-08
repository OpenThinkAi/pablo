import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pabloExec, screenPuller, screenRefresh, screenRounds, type ExecResult, type PabloExec } from "../src/screen-reviews";

/**
 * The screen's live data (AGT-1640) and its pull (AGT-1641): the rounds poller and the puller against a fake child
 * pablo, the refresh against a temp git copy of the fixture vault, and one real child `share --list` so the arguments
 * are the verb's own. Nothing reaches GitHub, a model, `think` or the author's real directories.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pablo-screen-reviews-"));
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

/** A child pablo that answers with `result` and records what it was asked. */
function fake(result: Partial<ExecResult>) {
  const calls: { args: readonly string[]; cwd: string }[] = [];
  const exec: PabloExec = async (args, cwd) => { calls.push({ args, cwd }); return { code: 0, stdout: "", stderr: "", ...result }; };
  return { exec, calls };
}
const json = (body: unknown) => ({ stdout: JSON.stringify(body) });

test("rounds: share --list's open and submitted rounds become reading and submitted; pulled ones are left out", async () => {
  const f = fake(json({ ok: true, rounds: [
    { id: "atara-2026-10-04", reader: "atara", chapters: [3], status: "submitted", pr: 1, prUrl: "u" },
    { id: "ben-2026-10-05", reader: "ben", chapters: [1, 2], status: "open", pr: 2, prUrl: "u" },
    { id: "cy-2026-09-30", reader: "cy", chapters: [1], status: "pulled", closed: true, pr: 3, prUrl: "u" },
  ], notices: [] }));
  const r = await screenRounds("/w/ice-house", "ice-house", f.exec)();
  expect(f.calls).toEqual([{ args: ["share", "--list", "--project", "ice-house", "--json"], cwd: "/w/ice-house" }]);
  expect(r).toEqual({ ok: true, rounds: [
    { id: "atara-2026-10-04", reader: "atara", chapters: [3], status: "submitted" },
    { id: "ben-2026-10-05", reader: "ben", chapters: [1, 2], status: "reading" },
  ] });
});

test("rounds: a round GitHub could not be asked about comes back as a note; a refusal or no JSON is a failure", async () => {
  const noted = await screenRounds("/w", "w", fake(json({ ok: true, rounds: [], notices: ["pablo: share --list: atara-2026-10-04: gh: not logged in"] })).exec)();
  expect(noted).toEqual({ ok: true, rounds: [], note: "atara-2026-10-04: gh: not logged in" });
  expect(await screenRounds("/w", "w", fake(json({ ok: false, message: "pablo: no project w" })).exec)()).toEqual({ ok: false, message: "pablo: no project w" });
  expect(await screenRounds("/w", "w", fake({ code: 1, stdout: "", stderr: "warming up\npablo: boom\n" }).exec)()).toEqual({ ok: false, message: "pablo: boom" });
});

test("pull: notes pull's entry for the round gives its branch and what came in", async () => {
  const f = fake(json({ ok: true, pulled: [{ round: "atara-2026-10-04", branch: "reader/atara-2026-10-04", commits: ["a", "b"], comments: 1 }], skipped: [], notices: ["pablo: notes pull: kept one suggestion as a comment"] }));
  const r = await screenPuller("/w/ice-house", "ice-house", f.exec)("atara-2026-10-04");
  expect(f.calls[0]?.args).toEqual(["notes", "pull", "--project", "ice-house", "--json"]);
  expect(r).toEqual({ ok: true, branch: "reader/atara-2026-10-04", lines: ["2 suggestions, 1 comment", "pablo: notes pull: kept one suggestion as a comment"] });
});

test("pull: a round pulled earlier opens its branch; a round still waiting or refused says why", async () => {
  const already = fake(json({ ok: true, pulled: [], skipped: [{ round: "atara-2026-10-04", reason: "pulled", message: "already" }], notices: [] }));
  expect(await screenPuller("/w", "w", already.exec)("atara-2026-10-04")).toEqual({ ok: true, branch: "reader/atara-2026-10-04", lines: ["already pulled"] });
  const waiting = fake(json({ ok: true, pulled: [], skipped: [{ round: "atara-2026-10-04", reason: "waiting", message: "pablo: notes pull: atara-2026-10-04: no submitted review from atara yet" }], notices: [] }));
  expect(await screenPuller("/w", "w", waiting.exec)("atara-2026-10-04")).toEqual({ ok: false, message: "pablo: notes pull: atara-2026-10-04: no submitted review from atara yet" });
  expect(await screenPuller("/w", "w", fake({ code: 1, stdout: "not json", stderr: "pablo: gh failed" }).exec)("x")).toEqual({ ok: false, message: "pablo: gh failed" });
});

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

test("the real child: share --list --json from the work's directory answers for a work with no rounds", async () => {
  const { project, env } = setup();
  const r = await screenRounds(project, "ice-house", pabloExec(CLI, env))();
  expect(r).toEqual({ ok: true, rounds: [] });
});
