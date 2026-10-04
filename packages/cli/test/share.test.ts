import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReaderConfig } from "@openthink/pablo-core";
import { VERBS, shareWith } from "../src/verbs";
import { chaptersLabel, isReadingRepoUrl, listRounds, parseChapterSpec, readRound, realRunner, shareRound } from "../src/share";
import type { RunResult, Runner } from "../src/share";
import { mcpTools } from "../src/mcp";

/**
 * AGT-1582: `pablo share`. Nothing here reaches GitHub: `gh` is answered by a
 * fake runner (it is never delegated to the real binary), git runs for real
 * against temp repositories, and the "reading repo" is a local bare repo whose
 * path the fake `gh repo view` reports as the repo's url.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8");
}

const CH2 = "---\nchapter: 2\ntitle: The Saws\n---\n\nThe saws ran all night.\nNobody slept.\n\n\"Again,\" said Odile.\n";
const CH3 = "---\nchapter: 3\ntitle: The Thaw\n---\n\nIce gave way by March.\nThe river rose.\n";

interface Setup {
  dir: string;
  vault: string;
  project: string;
  env: Record<string, string>;
}

function setup(): Setup {
  const dir = mkdtempSync(join(tmpdir(), "pablo-share-test-"));
  dirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const chapters = join(vault, "novels", "ice-house", "chapters");
  writeFileSync(join(chapters, "02-the-saws.md"), CH2);
  // Notes and a bible exist in the vault: none of it may reach the reading repo.
  mkdirSync(join(vault, "novels", "ice-house", "notes"), { recursive: true });
  writeFileSync(join(vault, "novels", "ice-house", "notes", "secret.md"), "never shared\n");
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  // Chapter 3 is written but only on a branch, and chapter 4 only in the working tree.
  git(vault, "checkout", "-q", "-b", "draft/ch03");
  writeFileSync(join(chapters, "03-the-thaw.md"), CH3);
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "ch3");
  git(vault, "checkout", "-q", "main");
  writeFileSync(join(chapters, "04-uncommitted.md"), "Not committed.\n");
  return {
    dir,
    vault,
    project: join(vault, "novels", "ice-house"),
    env: { PATH: NO_THINK_PATH, XDG_CONFIG_HOME: join(dir, "xdg-c"), XDG_STATE_HOME: join(dir, "xdg-s"), PABLO_VAULT: vault },
  };
}

const READERS = new Map<string, ReaderConfig>([["atara", { github: "atara-test", name: "Atara Test", email: "atara@example.com" }]]);

interface FakeGh {
  run: Runner;
  /** Every gh invocation, in order. */
  gh: string[][];
  remote: string;
}

/** gh answered in memory; git passed through to the real binary (against temp repos only). */
function fakeRunner(dir: string, opts: { exists?: boolean; isPrivate?: boolean; reviewerFails?: boolean; prFails?: boolean; invite?: "has" | "invited" | "fails" } = {}): FakeGh {
  const remote = join(dir, "reading.git");
  const gh: string[][] = [];
  let exists = opts.exists ?? false;
  if (exists) git(dir, "init", "-q", "--bare", remote);
  const run: Runner = (command, args, options) => {
    if (command === "git") return realRunner(command, args, options);
    gh.push([...args]);
    const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });
    const bad = (stderr: string): RunResult => ({ code: 1, stdout: "", stderr });
    const [group, verb] = args;
    if (group === "repo" && verb === "view") {
      return exists ? ok(JSON.stringify({ url: remote, isPrivate: opts.isPrivate ?? true })) : bad("Could not resolve to a Repository");
    }
    if (group === "repo" && verb === "create") {
      git(dir, "init", "-q", "--bare", remote);
      exists = true;
      return ok("");
    }
    if (group === "pr" && verb === "create") return opts.prFails ? bad("boom") : ok("https://github.com/OpenThinkAi/ice-house-reading/pull/7\n");
    if (group === "api") {
      if (opts.invite === "fails") return bad("Resource not accessible");
      return ok(opts.invite === "invited" ? JSON.stringify({ id: 99, invitee: { login: "atara-test" } }) : "");
    }
    if (group === "pr" && verb === "edit") return opts.reviewerFails ? bad("not a collaborator") : ok("");
    return bad(`fake gh: unexpected ${args.join(" ")}`);
  };
  return { run, gh, remote };
}

function share(s: Setup, fake: FakeGh, overrides: Partial<Parameters<typeof shareRound>[0]> = {}) {
  return shareRound({
    vaultRoot: s.vault,
    projectPath: s.project,
    slug: "ice-house",
    title: "The Ice House",
    reader: "atara",
    chapters: "2",
    readers: READERS,
    run: fake.run,
    now: () => new Date(2026, 9, 2, 12),
    tmpRoot: s.dir,
    acceptUrl: () => true, // the fake remote is a local bare repo
    ...overrides,
  });
}

test("parseChapterSpec and chaptersLabel", () => {
  expect(parseChapterSpec("3")).toEqual([3]);
  expect(parseChapterSpec("3-5")).toEqual([3, 4, 5]);
  for (const bad of ["", "0", "5-3", "a", "3-", "1,2", "1-9999", "-1"]) expect(parseChapterSpec(bad)).toBeUndefined();
  expect(chaptersLabel([3])).toBe("chapter 3");
  expect(chaptersLabel([3, 4, 5])).toBe("chapters 3-5");
  expect(chaptersLabel([1, 3, 4])).toBe("chapters 1, 3-4");
});

test("share creates the private repo on first use, pushes base and head, opens the PR, records the round", () => {
  const s = setup();
  const fake = fakeRunner(s.dir);
  const outcome = share(s, fake);
  if (!outcome.ok) throw new Error(outcome.message);

  expect(fake.gh[0]).toEqual(["repo", "view", "OpenThinkAi/ice-house-reading", "--json", "url,isPrivate"]);
  expect(fake.gh[1]).toEqual(["repo", "create", "OpenThinkAi/ice-house-reading", "--private"]);
  const create = fake.gh.find((a) => a[0] === "pr" && a[1] === "create") as string[];
  expect(create).toContain("round/atara-2026-10-02-base");
  expect(create).toContain("round/atara-2026-10-02");
  expect(create[create.indexOf("--title") + 1]).toBe("The Ice House: chapter 2");
  expect(fake.gh.find((a) => a[1] === "edit")).toEqual(["pr", "edit", "7", "--repo", "OpenThinkAi/ice-house-reading", "--add-reviewer", "atara-test"]);

  const head = "round/atara-2026-10-02";
  const base = `${head}-base`;
  const chapterPath = "novels/ice-house/chapters/02-the-saws.md";
  // The base has none of the shared chapters; the head has them byte for byte, and nothing else.
  expect(git(fake.remote, "ls-tree", "-r", "--name-only", base).trim()).toBe("");
  expect(git(fake.remote, "ls-tree", "-r", "--name-only", head).trim()).toBe(chapterPath);
  expect(git(fake.remote, "show", `${head}:${chapterPath}`)).toBe(CH2);
  expect(git(fake.remote, "rev-parse", `${head}~1`).trim()).toBe(git(fake.remote, "rev-parse", base).trim());
  expect(git(fake.remote, "for-each-ref", "--format=%(refname)").trim().split("\n").sort()).toEqual([`refs/heads/${head}`, `refs/heads/${base}`]);

  const vaultCommit = git(s.vault, "rev-parse", "main").trim();
  const record = JSON.parse(readFileSync(join(s.vault, ".pablo", "rounds", "atara-2026-10-02.json"), "utf8"));
  expect(record).toMatchObject({
    id: "atara-2026-10-02",
    reader: "atara",
    vaultCommit,
    chapters: [{ number: 2, path: chapterPath }],
    repo: "OpenThinkAi/ice-house-reading",
    pr: 7,
    state: "open",
  });
  expect(readRound(s.vault, "atara-2026-10-02")?.pr).toBe(7);
  expect(listRounds(s.vault).map((r) => r.id)).toEqual(["atara-2026-10-02"]);
  expect(outcome.round.prUrl).toBe("https://github.com/OpenThinkAi/ice-house-reading/pull/7");
  // The throwaway work tree is gone.
  expect(readdirSync(s.dir).filter((n) => n.startsWith("pablo-share-"))).toEqual([]);
});

test("a repo that already exists is reused, not created", () => {
  const s = setup();
  const fake = fakeRunner(s.dir, { exists: true });
  const outcome = share(s, fake);
  expect(outcome.ok).toBe(true);
  expect(fake.gh.some((a) => a[0] === "repo" && a[1] === "create")).toBe(false);
});

test("share refuses a chapter that is not on main, naming it, and touches nothing", () => {
  const s = setup();
  for (const [chapters, named] of [["3", "chapter 3"], ["4", "chapter 4"], ["2-3", "chapter 3"], ["9", "chapter 9"]] as const) {
    const fake = fakeRunner(s.dir);
    const outcome = share(s, fake, { chapters });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) continue;
    expect(outcome.code).toBe(2);
    expect(outcome.message).toContain(named);
    expect(fake.gh).toEqual([]);
  }
  expect(existsSync(join(s.vault, ".pablo", "rounds"))).toBe(false);
});

test("share refuses a reader that is not in the config, and bad arguments", () => {
  const s = setup();
  const fake = fakeRunner(s.dir);
  const unknown = share(s, fake, { reader: "nobody" });
  expect(unknown).toMatchObject({ ok: false, code: 2 });
  expect(unknown.ok ? "" : unknown.message).toContain('reader "nobody"');
  expect(share(s, fake, { readers: new Map() })).toMatchObject({ ok: false, code: 2 });
  expect(share(s, fake, { reader: undefined })).toMatchObject({ ok: false, code: 2 });
  expect(share(s, fake, { chapters: undefined })).toMatchObject({ ok: false, code: 2 });
  expect(share(s, fake, { chapters: "two" })).toMatchObject({ ok: false, code: 2 });
  expect(fake.gh).toEqual([]);
});

test("share refuses to push to a reading repo that is not private", () => {
  const s = setup();
  const fake = fakeRunner(s.dir, { exists: true, isPrivate: false });
  const outcome = share(s, fake);
  expect(outcome).toMatchObject({ ok: false, code: 2 });
  expect(git(fake.remote, "for-each-ref").trim()).toBe("");
});

test("a second round for the same reader on the same day is refused", () => {
  const s = setup();
  const fake = fakeRunner(s.dir);
  expect(share(s, fake).ok).toBe(true);
  expect(share(s, fake)).toMatchObject({ ok: false, code: 2 });
});

test("a reviewer request that fails is a notice; the round is still recorded", () => {
  const s = setup();
  const fake = fakeRunner(s.dir, { reviewerFails: true });
  const outcome = share(s, fake);
  if (!outcome.ok) throw new Error(outcome.message);
  expect(outcome.notices.join("\n")).toContain("atara-test");
  expect(readRound(s.vault, "atara-2026-10-02")).toBeDefined();
});

test("a PR that cannot be opened is an error and records no round", () => {
  const s = setup();
  const fake = fakeRunner(s.dir, { prFails: true });
  const outcome = share(s, fake);
  expect(outcome).toMatchObject({ ok: false, code: 1 });
  expect(outcome.ok ? "" : outcome.message).toContain("compare/round/atara-2026-10-02-base...round/atara-2026-10-02");
  expect(existsSync(join(s.vault, ".pablo", "rounds"))).toBe(false);
});

test("a multi-chapter range shares every chapter in one PR", () => {
  const s = setup();
  // Land chapter 3 on main.
  git(s.vault, "merge", "-q", "--no-edit", "draft/ch03");
  const fake = fakeRunner(s.dir);
  const outcome = share(s, fake, { chapters: "2-3" });
  if (!outcome.ok) throw new Error(outcome.message);
  expect(git(fake.remote, "ls-tree", "-r", "--name-only", "round/atara-2026-10-02").trim().split("\n")).toEqual([
    "novels/ice-house/chapters/02-the-saws.md",
    "novels/ice-house/chapters/03-the-thaw.md",
  ]);
  expect(fake.gh.filter((a) => a[0] === "pr" && a[1] === "create")).toHaveLength(1);
  expect((fake.gh.find((a) => a[1] === "create" && a[0] === "pr") as string[]).join(" ")).toContain("The Ice House: chapters 2-3");
});

test("the verb is CLI only: no MCP tool, and shareWith reads readers from the config file", async () => {
  expect(VERBS.some((v) => v.name === "share")).toBe(true);
  expect(mcpTools().some((t) => t.name === "share")).toBe(false);

  const s = setup();
  mkdirSync(join(s.dir, "xdg-c", "pablo"), { recursive: true });
  writeFileSync(
    join(s.dir, "xdg-c", "pablo", "config.json"),
    JSON.stringify({ readers: { atara: { github: "atara-test", name: "Atara Test", email: "atara@example.com" } } }),
  );
  const fake = fakeRunner(s.dir);
  const result = await shareWith(
    { project: "ice-house", reader: "atara", chapters: "2" },
    { cwd: s.vault, env: s.env, stderr: { write() {} } },
    fake.run,
    () => true, // the fake remote is a local bare repo
  );
  expect(result.exitCode).toBe(0);
  expect((result.body as { pr: number }).pr).toBe(7);
});

test("pablo share refuses through the CLI before any gh call (exit 2)", () => {
  const s = setup();
  const run = (args: string[]) => Bun.spawnSync(["bun", "run", CLI, ...args], { cwd: s.vault, env: s.env });
  expect(run(["share", "--project", "ice-house", "--chapters", "2"]).exitCode).toBe(2);
  expect(run(["share", "--project", "ice-house", "--reader", "atara"]).exitCode).toBe(2);
  const noReader = run(["share", "--project", "ice-house", "--reader", "atara", "--chapters", "2", "--json"]);
  expect(noReader.exitCode).toBe(2);
  expect(JSON.parse(noReader.stdout.toString()).message).toContain('reader "atara"');
  mkdirSync(join(s.dir, "xdg-c", "pablo"), { recursive: true });
  writeFileSync(
    join(s.dir, "xdg-c", "pablo", "config.json"),
    JSON.stringify({ readers: { atara: { github: "atara-test", name: "Atara", email: "a@example.com" } } }),
  );
  const notOnMain = run(["share", "--project", "ice-house", "--reader", "atara", "--chapters", "3", "--json"]);
  expect(notOnMain.exitCode).toBe(2);
  expect(JSON.parse(notOnMain.stdout.toString()).message).toContain("chapter 3");
  const help = run(["--help"]).stdout.toString();
  const [verbs, later] = help.split("Later (not yet implemented):");
  expect(verbs).toMatch(/^ {2}share$/m);
  expect(later).not.toMatch(/^ {2}share$/m);
});

test("a remote URL that is not the reading repo's https github.com URL is refused before any push", () => {
  const s = setup();
  for (const url of ["ext::sh -c 'touch /tmp/pwned'", "file:///etc", "/tmp/local.git", "https://evil.example/OpenThinkAi/ice-house-reading", "-oProxyCommand=x"]) {
    const fake = fakeRunner(s.dir, { exists: true });
    const run: Runner = (command, args, options) =>
      command === "gh" && args[0] === "repo" && args[1] === "view"
        ? { code: 0, stdout: JSON.stringify({ url, isPrivate: true }), stderr: "" }
        : fake.run(command, args, options);
    const outcome = share(s, fake, { run, acceptUrl: undefined });
    expect(outcome).toMatchObject({ ok: false, code: 2 });
    expect(git(fake.remote, "for-each-ref").trim()).toBe("");
  }
  expect(isReadingRepoUrl("https://github.com/OpenThinkAi/ice-house-reading", "OpenThinkAi/ice-house-reading")).toBe(true);
  expect(isReadingRepoUrl("https://github.com/OpenThinkAi/ice-house-reading.git", "OpenThinkAi/ice-house-reading")).toBe(true);
  expect(isReadingRepoUrl("https://github.com/OpenThinkAi/other", "OpenThinkAi/ice-house-reading")).toBe(false);
});

const PUT_ATARA = ["api", "-X", "PUT", "repos/OpenThinkAi/ice-house-reading/collaborators/atara-test", "-f", "permission=pull"];

test("share ensures read access before requesting the review; already a collaborator changes nothing", () => {
  const s = setup();
  const fake = fakeRunner(s.dir, { invite: "has" });
  const outcome = share(s, fake);
  if (!outcome.ok) throw new Error(outcome.message);
  const put = fake.gh.findIndex((a) => a[0] === "api");
  const review = fake.gh.findIndex((a) => a[0] === "pr" && a[1] === "edit");
  expect(fake.gh[put]).toEqual(PUT_ATARA);
  expect(put).toBeGreaterThan(-1);
  expect(put).toBeLessThan(review);
  expect(outcome.notices).toEqual([]);
});

test("a pending invitation is stated plainly and the round is still recorded", () => {
  const s = setup();
  const fake = fakeRunner(s.dir, { invite: "invited" });
  const outcome = share(s, fake);
  if (!outcome.ok) throw new Error(outcome.message);
  expect(outcome.notices.join("\n")).toContain("must accept the invitation GitHub emailed them (once per book)");
  expect(readRound(s.vault, outcome.round.id)?.pr).toBe(7);
});

test("a review request that fails after an invitation says how to re-request it", () => {
  const s = setup();
  const fake = fakeRunner(s.dir, { invite: "invited", reviewerFails: true });
  const outcome = share(s, fake);
  if (!outcome.ok) throw new Error(outcome.message);
  const text = outcome.notices.join("\n");
  expect(text).toContain("invitation is not accepted");
  expect(text).toContain("gh pr edit 7 --repo OpenThinkAi/ice-house-reading --add-reviewer atara-test");
});

test("a failed invite is noticed, the review is still attempted, the round is recorded", () => {
  const s = setup();
  const fake = fakeRunner(s.dir, { invite: "fails" });
  const outcome = share(s, fake);
  if (!outcome.ok) throw new Error(outcome.message);
  expect(outcome.notices.join("\n")).toContain("could not invite atara-test");
  expect(fake.gh.some((a) => a[0] === "pr" && a[1] === "edit")).toBe(true);
});

test("a reader login that is not a GitHub username is refused before any gh call", () => {
  for (const github of ["bad login", "-lead", "trail-", "a--b", "x/../y", "a".repeat(40), "", "o;rm"]) {
    const s = setup();
    const fake = fakeRunner(s.dir);
    const readers = new Map<string, ReaderConfig>([["atara", { github, name: "A", email: "a@example.com" }]]);
    const outcome = share(s, fake, { readers });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe(2);
    expect(fake.gh).toEqual([]);
  }
});

test("a review request that fails for a reader who already has access does not blame access", () => {
  const s = setup();
  const fake = fakeRunner(s.dir, { invite: "has", reviewerFails: true });
  const outcome = share(s, fake);
  if (!outcome.ok) throw new Error(outcome.message);
  const text = outcome.notices.join("\n");
  expect(text).not.toContain("they need access");
  expect(text).toContain("already have access");
  expect(text).toContain("gh pr edit 7 --repo OpenThinkAi/ice-house-reading --add-reviewer atara-test");
});
