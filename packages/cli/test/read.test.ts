import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cachedRoundDir, fetchRound, listReaderRounds, parseRoundRef, readCachedRound } from "../src/read";
import { readSent, readerRoundsDir, sentPath } from "../src/submit";
import type { RunResult, Runner } from "../src/share";
import { parseCliArgs, runReadRounds } from "../src/cli";

/**
 * AGT-1583: the reader's `pablo read --list` / `pablo read <round>`. Nothing
 * here reaches GitHub: `gh` is a fake Runner (or, for the one end-to-end test,
 * a fake `gh` script on PATH), and the cache lives in a temp XDG_STATE_HOME.
 * There is no vault and no pablo project anywhere in this file.
 */
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-read-test-"));
  dirs.push(dir);
  return dir;
}

const SHA = "a".repeat(40);
const SHA2 = "b".repeat(40);
const REPO = "OpenThinkAi/ice-house-reading";
const CH3 = "novels/ice-house/chapters/03-the-thaw.md";
const CH4 = "novels/ice-house/chapters/04-the-flood.md";
const TEXT: Record<string, string> = { [CH3]: "Ice gave way by March.\nThe river rose.\n", [CH4]: "The flood came.\n" };

function ok(stdout: string): RunResult {
  return { code: 0, stdout, stderr: "" };
}

interface World {
  /** Head sha per `<repo>#<pr>`. */
  heads: Record<string, string>;
  state?: string;
  files: string[];
  calls: string[][];
  fail?: (args: readonly string[]) => boolean;
}

function fakeGh(world: World): Runner {
  return (command, args) => {
    world.calls.push([command, ...args]);
    if (command !== "gh") return { code: 1, stdout: "", stderr: "unexpected git" };
    if (world.fail?.(args)) return { code: 1, stdout: "", stderr: "boom" };
    const endpoint = args[args.indexOf("GET") + 1] as string;
    if (endpoint === "search/issues") {
      const q = args[args.indexOf("-f") + 1] as string;
      expect(q).toContain("review-requested:@me");
      expect(q).toContain("org:OpenThinkAi");
      return ok(
        JSON.stringify({
          items: [
            { number: 7, title: "Ice House: chapter 3", html_url: `https://github.com/${REPO}/pull/7`, repository_url: `https://api.github.com/repos/${REPO}`, user: { login: "matt" }, created_at: "2026-10-02T10:00:00Z" },
            { number: 1, title: "not a reading repo", html_url: "x", repository_url: "https://api.github.com/repos/OpenThinkAi/pablo", user: { login: "matt" }, created_at: "2026-10-01T10:00:00Z" },
          ],
        }),
      );
    }
    const files = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files$/.exec(endpoint);
    if (files) return ok(JSON.stringify([...world.files, "notes/secret.md", "../escape/chapters/x.md"].map((filename) => ({ filename }))));
    const pull = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(endpoint);
    if (pull) {
      const key = `${pull[1]}#${pull[2]}`;
      const sha = world.heads[key];
      if (sha === undefined) return { code: 1, stdout: "", stderr: "Not Found" };
      return ok(
        JSON.stringify({ number: Number(pull[2]), state: world.state ?? "open", title: "Ice House: chapter 3", html_url: `https://github.com/${pull[1]}/pull/${pull[2]}`, user: { login: "matt" }, created_at: "2026-10-02T10:00:00Z", head: { sha, ref: `round/atara-2026-10-02`, repo: { full_name: pull[1] } } }),
      );
    }
    const contents = /^repos\/[^/]+\/[^/]+\/contents\/(.+)$/.exec(endpoint);
    if (contents) {
      expect(args).toContain(`ref=${world.heads[`${REPO}#7`]}`);
      const path = decodeURIComponent(contents[1] as string);
      return TEXT[path] === undefined ? { code: 1, stdout: "", stderr: "Not Found" } : ok(TEXT[path] as string);
    }
    return { code: 1, stdout: "", stderr: `unexpected ${endpoint}` };
  };
}

/** What Submit leaves behind (AGT-1585): `<id>.sent.json` in the round's cache dir. */
function markSent(repo: string, pr: number, env: Record<string, string>): void {
  const dir = cachedRoundDir({ repo, pr }, env);
  mkdirSync(dir, { recursive: true });
  if (readCachedRound({ repo, pr }, env) === undefined) writeFileSync(join(dir, "round.json"), JSON.stringify({ id: "atara-2026-10-02" }));
  writeFileSync(sentPath(dir, "atara-2026-10-02"), JSON.stringify({ id: "atara-2026-10-02", repo, pr, commit: SHA, reviewId: 1, reviewUrl: "u", sentAt: "2026-10-03T00:00:00Z" }));
}

function world(extra: Partial<World> = {}): World {
  return { heads: { [`${REPO}#7`]: SHA }, files: [CH3], calls: [], ...extra };
}

test("parseRoundRef accepts reading repos of the org only", () => {
  expect(parseRoundRef("ice-house-reading#7")).toEqual({ repo: REPO, pr: 7 });
  expect(parseRoundRef("OpenThinkAi/ice-house-reading#7")).toEqual({ repo: REPO, pr: 7 });
  expect(parseRoundRef("OpenThinkAi/ice-house-reading/7")).toEqual({ repo: REPO, pr: 7 });
  expect(parseRoundRef("evil/ice-house-reading#7")).toBeUndefined();
  expect(parseRoundRef("OpenThinkAi/pablo#7")).toBeUndefined();
  expect(parseRoundRef("ice-house-reading#0x")).toBeUndefined();
  expect(parseRoundRef("novels/ice-house/chapters/03.md")).toBeUndefined();
});

test("list: open requested rounds in reading repos, with chapters, sender and date", () => {
  const env = { XDG_STATE_HOME: temp() };
  const w = world({ files: [CH3, CH4] });
  const out = listReaderRounds({ run: fakeGh(w), env });
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  expect(out.rounds).toHaveLength(1); // the non-reading repo is dropped
  const [round] = out.rounds;
  expect(round).toMatchObject({ repo: REPO, pr: 7, ref: `${REPO}#7`, sender: "matt", date: "2026-10-02T10:00:00Z", status: "waiting" });
  expect(round?.chapters.map((c) => [c.number, c.path])).toEqual([[3, CH3], [4, CH4]]); // notes/ and ../ paths are ignored
  expect(w.calls.every((c) => c[0] === "gh")).toBe(true);
});

test("list: a round submitted from this machine is marked sent, even once GitHub no longer requests it", () => {
  const env = { XDG_STATE_HOME: temp() };
  const w = world({ heads: { [`${REPO}#7`]: SHA, "OpenThinkAi/valleys-shadow-reading#2": SHA2 } });
  markSent("OpenThinkAi/valleys-shadow-reading", 2, env);
  markSent(REPO, 7, env);
  const out = listReaderRounds({ run: fakeGh(w), env });
  if (!out.ok) return;
  expect(out.rounds.map((r) => r.status)).toEqual(["sent", "sent"]);
  expect(readSent(cachedRoundDir({ repo: REPO, pr: 7 }, env), "atara-2026-10-02")).toBeDefined();
});

test("list: waiting rounds sort before sent ones; a closed sent round is dropped", () => {
  const env = { XDG_STATE_HOME: temp() };
  markSent("OpenThinkAi/valleys-shadow-reading", 2, env);
  const w = world({ heads: { "OpenThinkAi/valleys-shadow-reading#2": SHA2 } });
  const base = fakeGh(w);
  const out = listReaderRounds({ run: base, env });
  expect(out.ok && out.rounds.map((r) => r.status)).toEqual(["waiting", "sent"]);
  const closed = listReaderRounds({
    run: (c, a) => {
      const r = base(c, a);
      return a.includes("repos/OpenThinkAi/valleys-shadow-reading/pulls/2") ? ok(JSON.stringify({ state: "closed" })) : r;
    },
    env,
  });
  expect(closed.ok && closed.rounds.map((r) => r.ref)).toEqual([`${REPO}#7`]);
});

test("list: a gh failure is an error; a chapter-list failure still lists the round, with a notice", () => {
  const env = { XDG_STATE_HOME: temp() };
  const down = listReaderRounds({ run: fakeGh(world({ fail: () => true })), env });
  expect(down.ok).toBe(false);
  const partial = listReaderRounds({ run: fakeGh(world({ fail: (a) => a.some((x) => x.endsWith("/files")) })), env });
  expect(partial.ok && partial.rounds[0]?.chapters).toEqual([]);
  expect(partial.ok && partial.notices.length).toBe(1);
});

test("read <round>: fetches the chapters at the head commit into the cache and records it", () => {
  const env = { XDG_STATE_HOME: temp() };
  const w = world({ files: [CH3, CH4] });
  const out = fetchRound({ run: fakeGh(w), env, ref: { repo: REPO, pr: 7 }, now: () => new Date("2026-10-03T00:00:00Z") });
  expect(out.ok).toBe(true);
  if (!out.ok) return;
  const dir = cachedRoundDir({ repo: REPO, pr: 7 }, env);
  expect(out.dir).toBe(dir);
  expect(dir).toBe(join(readerRoundsDir(env), REPO, "7"));
  expect(readCachedRound({ repo: REPO, pr: 7 }, env)?.id).toBe("atara-2026-10-02");
  expect(readCachedRound({ repo: REPO, pr: 7 }, env)?.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(readFileSync(join(dir, CH3), "utf8")).toBe(TEXT[CH3] as string);
  expect(readFileSync(join(dir, CH4), "utf8")).toBe(TEXT[CH4] as string);
  expect(existsSync(join(dir, "notes", "secret.md"))).toBe(false);
  expect(readCachedRound({ repo: REPO, pr: 7 }, env)).toMatchObject({ commit: SHA, sender: "matt", fetchedAt: "2026-10-03T00:00:00.000Z" });
  expect(w.calls.every((c) => c[0] === "gh")).toBe(true);
});

test("read <round>: unchanged head is not fetched again; a moved head replaces the chapters and keeps sent.json", () => {
  const env = { XDG_STATE_HOME: temp() };
  const w = world();
  const ref = { repo: REPO, pr: 7 };
  fetchRound({ run: fakeGh(w), env, ref });
  markSent(REPO, 7, env);
  const before = w.calls.length;
  const again = fetchRound({ run: fakeGh(w), env, ref });
  expect(again.ok && again.reused).toBe(true);
  expect(w.calls.slice(before).some((c) => c.some((x) => x.includes("/contents/")))).toBe(false);

  TEXT[CH3] = "Changed.\n";
  w.heads[`${REPO}#7`] = SHA2;
  const moved = fetchRound({ run: fakeGh(w), env, ref });
  TEXT[CH3] = "Ice gave way by March.\nThe river rose.\n";
  expect(moved.ok && !moved.reused && moved.round.commit).toBe(SHA2);
  expect(readFileSync(join(cachedRoundDir(ref, env), CH3), "utf8")).toBe("Changed.\n");
  expect(readSent(cachedRoundDir(ref, env), "atara-2026-10-02")).toBeDefined();
});

test("read <round>: refuses closed PRs, forks, non-reading repos; a failed fetch leaves the cache untouched", () => {
  const env = { XDG_STATE_HOME: temp() };
  const ref = { repo: REPO, pr: 7 };
  expect(fetchRound({ run: fakeGh(world({ state: "closed" })), env, ref })).toMatchObject({ ok: false, code: 2 });
  expect(fetchRound({ run: fakeGh(world()), env, ref: { repo: "OpenThinkAi/pablo", pr: 7 } })).toMatchObject({ ok: false, code: 2 });
  const fork: Runner = (c, a) => {
    const r = fakeGh(world())(c, a);
    return r.stdout.includes('"head"') ? ok(r.stdout.replace(`"full_name":"${REPO}"`, '"full_name":"mallory/ice-house-reading"')) : r;
  };
  expect(fetchRound({ run: fork, env, ref })).toMatchObject({ ok: false, code: 2 });
  expect(fetchRound({ run: fakeGh(world({ heads: {} })), env, ref })).toMatchObject({ ok: false, code: 1 });

  fetchRound({ run: fakeGh(world()), env, ref });
  const w = world({ heads: { [`${REPO}#7`]: SHA2 }, fail: (a) => a.some((x) => x.includes("/contents/")) });
  expect(fetchRound({ run: fakeGh(w), env, ref })).toMatchObject({ ok: false, code: 1 });
  expect(readCachedRound(ref, env)?.commit).toBe(SHA);
  expect(readFileSync(join(cachedRoundDir(ref, env), CH3), "utf8")).toBe(TEXT[CH3] as string);
});

test("runReadRounds prints the list and the fetch result; no vault, project or marker involved", () => {
  const env = { XDG_STATE_HOME: temp() };
  const lines: string[] = [];
  const spy = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    expect(runReadRounds(parseCliArgs(["read", "--list"]), fakeGh(world()), env)).toBe(0);
    expect(lines[0]).toContain(`${REPO}#7`);
    expect(lines[0]).toContain("chapters 3");
    expect(lines[0]).toContain("2026-10-02");
    lines.length = 0;
    expect(runReadRounds(parseCliArgs(["read", "ice-house-reading#7"]), fakeGh(world()), env)).toBe(0);
    expect(lines[0]).toContain("fetched");
    lines.length = 0;
    expect(runReadRounds(parseCliArgs(["read", "--list", "--json"]), fakeGh(world()), env)).toBe(0);
    expect(JSON.parse(lines[0] as string).rounds[0].ref).toBe(`${REPO}#7`);
  } finally {
    console.log = spy;
  }
});

test("end to end: the real CLI with a fake gh on PATH and no vault", () => {
  const dir = temp();
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho '{"items":[]}'\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const result = Bun.spawnSync(["bun", "run", CLI, "read", "--list", "--json"], {
    cwd: dir,
    env: { PATH: `${bin}:${dirname(Bun.which("bun") ?? "/usr/local/bin/bun")}:/usr/bin:/bin`, HOME: dir, XDG_STATE_HOME: join(dir, "state") },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString("utf8"))).toMatchObject({ ok: true, rounds: [] });
});
