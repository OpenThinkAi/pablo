import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDiff, stitch } from "@openthink/pablo-core";
import type { ReaderConfig } from "@openthink/pablo-core";
import { branchDiff, worktreePath } from "../src/branch";
import { readComments } from "../src/comments";
import { reviewCommentsOf } from "../src/critique";
import { movedLine, notesPull } from "../src/notes";
import { finishReview } from "../src/review-finish";
import { readRound, realRunner } from "../src/share";
import type { RoundRecord, RunResult, Runner } from "../src/share";
import { notesWith } from "../src/verbs";

/**
 * AGT-1587: `pablo notes pull`. Nothing reaches GitHub: `gh` is answered by a fake runner serving a recorded review
 * (fixtures/notes-pull/review.json, invented text), git runs for real against a temp copy of the fixture vault, and
 * branch worktrees go under a temp PABLO_HOME. No `think`: the PATH is think-free.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const RECORDED = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/notes-pull/review.json", import.meta.url)), "utf8")) as {
  reviews: Record<string, unknown>[];
  comments: Record<string, unknown>[];
};
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString("utf8")}`);
  return r.stdout.toString("utf8").trim();
}

const CH = "novels/ice-house/chapters/02-the-saws.md";
// Lines: 6 saws, 7 slept, 9 Again, 10 lamp, 11 ice, 13 dawn, 14 spoke.
const TEXT = [
  "---",
  "chapter: 2",
  "title: The Saws",
  "---",
  "",
  "The saws ran all night.",
  "Nobody slept.",
  "",
  '"Again," said Odile.',
  "She set the lamp down.",
  "The ice groaned under the floor.",
  "",
  "By dawn the river was quiet.",
  "Nobody spoke of it.",
  "",
].join("\n");

const READERS = new Map<string, ReaderConfig>([["atara", { github: "atara-test", name: "Atara Test", email: "atara@example.com" }]]);

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pablo-notes-pull-"));
  dirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const project = join(vault, "novels", "ice-house");
  mkdirSync(join(project, "chapters"), { recursive: true });
  writeFileSync(join(vault, CH), TEXT);
  mkdirSync(join(project, "notes"), { recursive: true });
  writeFileSync(join(project, "notes", "secret.md"), "never shared\n");
  writeFileSync(join(vault, ".gitignore"), ".pablo/\n");
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  const vaultCommit = git(vault, "rev-parse", "main");
  const round: RoundRecord = {
    id: "atara-2026-10-02",
    project: "ice-house",
    reader: "atara",
    github: "atara-test",
    vaultCommit,
    chapters: [{ number: 2, path: CH }],
    repo: "OpenThinkAi/ice-house-reading",
    pr: 7,
    prUrl: "https://github.com/OpenThinkAi/ice-house-reading/pull/7",
    base: "round/atara-2026-10-02-base",
    head: "round/atara-2026-10-02",
    state: "open",
    createdAt: "2026-10-02T12:00:00.000Z",
  };
  mkdirSync(join(vault, ".pablo", "rounds"), { recursive: true });
  writeFileSync(join(vault, ".pablo", "rounds", `${round.id}.json`), JSON.stringify(round, null, 2));
  const env = { PATH: NO_THINK_PATH, XDG_CONFIG_HOME: join(dir, "xdg-c"), XDG_STATE_HOME: join(dir, "state"), PABLO_HOME: join(dir, "home"), PABLO_VAULT: vault };
  return { dir, vault, project, round, env };
}

interface FakeGh {
  run: Runner;
  gh: string[][];
}

/** gh answered from the recording; git passed through (temp repos only). `files` is what the reading repo holds at the review's commit. */
function fakeGh(files: Record<string, string>, recorded: { reviews: unknown[]; comments: unknown[] } = RECORDED): FakeGh {
  const gh: string[][] = [];
  const run: Runner = (command, args, options) => {
    if (command === "git") return realRunner(command, args, options);
    gh.push([...args]);
    const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });
    const endpoint = args[1] ?? "";
    const lines = (items: unknown[]) => ok(items.map((i) => JSON.stringify(i)).join("\n") + "\n");
    if (args[0] === "api" && endpoint === "repos/OpenThinkAi/ice-house-reading/pulls/7/reviews") return lines(recorded.reviews);
    if (args[0] === "api" && endpoint === "repos/OpenThinkAi/ice-house-reading/pulls/7/comments") return lines(recorded.comments);
    const m = /^repos\/OpenThinkAi\/ice-house-reading\/contents\/(.+)\?ref=([0-9a-f]+)$/.exec(endpoint);
    if (args[0] === "api" && m) {
      const path = (m[1] as string).split("/").map(decodeURIComponent).join("/");
      const text = files[path];
      if (text === undefined) return { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
      return ok(JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(text).toString("base64").replace(/(.{60})/g, "$1\n") }));
    }
    return { code: 1, stdout: "", stderr: `fake gh: unexpected ${args.join(" ")}` };
  };
  return { run, gh };
}

function pull(s: ReturnType<typeof setup>, fake: FakeGh, readers = READERS) {
  return notesPull({ vaultRoot: s.vault, projectPath: s.project, slug: "ice-house", readers, run: fake.run, env: s.env, now: () => new Date("2026-10-03T10:00:00.000Z") });
}

const BRANCH = "reader/atara-2026-10-02";

test("a submitted review becomes reader/<round>: one commit per suggestion, authored as the reader, exactly the lines it covered (AC1, AC2)", () => {
  const s = setup();
  // main moves on after the round was shared: the branch still starts at the round's commit.
  writeFileSync(join(s.vault, "novels", "ice-house", "README.md"), "moved on\n");
  git(s.vault, "commit", "-qam", "main moves");
  const fake = fakeGh({ [CH]: TEXT });
  const outcome = pull(s, fake);
  expect(outcome.skipped).toEqual([]);
  expect(outcome.code).toBe(0);
  expect(outcome.pulled).toHaveLength(1);
  expect(outcome.pulled[0]).toMatchObject({ round: "atara-2026-10-02", branch: BRANCH, comments: 6 });
  expect(outcome.pulled[0]?.commits).toHaveLength(2);

  expect(git(s.vault, "rev-parse", `${BRANCH}~2`)).toBe(s.round.vaultCommit);
  const authors = git(s.vault, "log", "--format=%an <%ae>|%cn", `${s.round.vaultCommit}..${BRANCH}`).split("\n");
  expect(authors).toEqual(["Atara Test <atara@example.com>|Atara Test", "Atara Test <atara@example.com>|Atara Test"]);
  // Each commit touches only the chapter, and the first carries the reader's note.
  expect(git(s.vault, "log", "--reverse", "--format=%B%x00", `${s.round.vaultCommit}..${BRANCH}`)).toContain("say who");
  expect(git(s.vault, "diff", "--name-only", `${s.round.vaultCommit}..${BRANCH}`)).toBe(CH);

  const after = git(s.vault, "show", `${BRANCH}:${CH}`) + "\n";
  expect(after).toBe(
    TEXT.replace("Nobody slept.\n", "Nobody in the house slept.\nNot even the dog.\n").replace(
      "By dawn the river was quiet.\nNobody spoke of it.\n",
      "By dawn the river had gone quiet.\nNobody spoke of it, not even Odile.\n",
    ),
  );
  // The first commit is the first suggestion alone.
  expect(git(s.vault, "show", `${BRANCH}~1:${CH}`) + "\n").toBe(TEXT.replace("Nobody slept.\n", "Nobody in the house slept.\nNot even the dog.\n"));

  const record = readRound(s.vault, "atara-2026-10-02");
  expect(record?.pulled).toEqual({ branch: BRANCH, reviews: [9001], at: "2026-10-03T10:00:00.000Z" });
  // Only the API was asked: the reviews, the comments, and the chapter at the review's commit.
  expect(fake.gh.map((a) => a[1])).toEqual([
    "repos/OpenThinkAi/ice-house-reading/pulls/7/reviews",
    "repos/OpenThinkAi/ice-house-reading/pulls/7/comments",
    `repos/OpenThinkAi/ice-house-reading/contents/${CH}?ref=4f1c2a9e8b7d6c5b4a39281706f5e4d3c2b1a090`,
  ]);
});

test("every comment lands in the branch's store as source reader with its tag, at its line on the branch (AC3)", () => {
  const s = setup();
  pull(s, fakeGh({ [CH]: TEXT }));
  const stored = readComments(s.project, BRANCH);
  expect(stored).toEqual([
    { source: "reader", path: "", review: true, author: "Atara Test", body: "Loved the cold in this one.\nA few spots dragged." },
    // The suggestion's note sits on the two lines that replaced line 7.
    { source: "reader", tag: "fix", path: CH, line: 8, startLine: 7, author: "Atara Test", body: "say who" },
    // Line 9 and 10-11 moved down one: the first suggestion added a line above them.
    { source: "reader", tag: "keep", path: CH, line: 10, author: "Atara Test", body: "Love Odile here." },
    { source: "reader", tag: "fix", path: CH, line: 12, startLine: 11, author: "Atara Test", body: "This beat feels rushed." },
    { source: "reader", tag: "keep", path: CH, author: "Atara Test", body: "The pacing works." },
    // An outdated comment is read from its original line.
    { source: "reader", tag: "fix", path: CH, line: 6, author: "Atara Test", body: "Which saws?" },
  ]);
  // Matt's own reply and review on the PR are not the reader's notes.
  expect(JSON.stringify(stored)).not.toContain("Agreed.");
  expect(JSON.stringify(stored)).not.toContain("Author note");
});

test("review mode: the suggestions are separate edits and the comments are boxes; s merges forward onto the current main (AC4)", async () => {
  const s = setup();
  pull(s, fakeGh({ [CH]: TEXT }));
  const diff = branchDiff(s.vault, BRANCH);
  if (!diff.ok) throw new Error(diff.notice);
  const edits = stitch(parseDiff(diff.text));
  expect(edits).toHaveLength(2);
  expect(edits.map((e) => e.addedLines.map((l) => l.line))).toEqual([[7, 8], [14, 15]]);
  expect(reviewCommentsOf(s.project, BRANCH).filter((c) => c.source === "reader")).toHaveLength(6);

  // main changes a line no suggestion touched; accepting everything merges the reader's branch over it.
  writeFileSync(join(s.vault, CH), TEXT.replace("She set the lamp down.", "She set the lamp on the sill."));
  git(s.vault, "commit", "-qam", "main edits the lamp");
  const done = await finishReview(s.project, BRANCH, { removed: [], added: [] }, { slug: "ice-house", env: s.env, now: () => new Date("2026-10-03T12:00:00.000Z") });
  expect(done.ok).toBe(true);
  const merged = readFileSync(join(s.vault, CH), "utf8");
  expect(merged).toContain("She set the lamp on the sill.");
  expect(merged).toContain("Not even the dog.");
  expect(merged).toContain("Nobody spoke of it, not even Odile.");
});

test("a suggestion on a line main has since changed is a conflict: main is left as it was, the branch stays (AC4)", async () => {
  const s = setup();
  pull(s, fakeGh({ [CH]: TEXT }));
  writeFileSync(join(s.vault, CH), TEXT.replace("Nobody slept.", "Nobody slept a wink."));
  git(s.vault, "commit", "-qam", "main edits line 7");
  const before = git(s.vault, "rev-parse", "main");
  const done = await finishReview(s.project, BRANCH, { removed: [], added: [] }, { slug: "ice-house", env: s.env });
  expect(done.ok).toBe(false);
  if (!done.ok) expect(done.notice).toContain("Merge conflict in novels/ice-house/chapters/02-the-saws.md");
  expect(git(s.vault, "rev-parse", "main")).toBe(before);
  expect(git(s.vault, "branch", "--list", BRANCH)).toContain(BRANCH);
});

test("re-running pull for a pulled round does nothing, not even an API call; nor after the branch is merged and gone (AC5)", () => {
  const s = setup();
  pull(s, fakeGh({ [CH]: TEXT }));
  const head = git(s.vault, "rev-parse", BRANCH);
  const again = fakeGh({ [CH]: TEXT });
  const outcome = pull(s, again);
  expect(outcome.code).toBe(0);
  expect(outcome.pulled).toEqual([]);
  expect(outcome.skipped.map((r) => r.reason)).toEqual(["pulled"]);
  expect(again.gh).toEqual([]);
  expect(git(s.vault, "rev-parse", BRANCH)).toBe(head);
  expect(readComments(s.project, BRANCH)).toHaveLength(6);

  git(s.vault, "worktree", "remove", "--force", worktreePath("ice-house", BRANCH, s.env));
  git(s.vault, "branch", "-D", BRANCH);
  expect(pull(s, fakeGh({ [CH]: TEXT })).pulled).toEqual([]);
  expect(git(s.vault, "branch", "--list", BRANCH)).toBe("");
});

test("a round with no submitted review from the reader is waiting: nothing is made", () => {
  const s = setup();
  const reviews = [{ ...(RECORDED.reviews[1] as object), state: "PENDING" }, RECORDED.reviews[0]];
  const outcome = pull(s, fakeGh({ [CH]: TEXT }, { reviews, comments: RECORDED.comments }));
  expect(outcome.code).toBe(0);
  expect(outcome.skipped.map((r) => r.reason)).toEqual(["waiting"]);
  expect(git(s.vault, "branch", "--list", "reader/*")).toBe("");
  expect(readRound(s.vault, "atara-2026-10-02")?.pulled).toBeUndefined();
});

const withComment = (extra: Record<string, unknown>) => ({ reviews: RECORDED.reviews, comments: [...RECORDED.comments, { ...(RECORDED.comments[1] as object), id: 199, ...extra }] });

test("a comment on any file that is not one of the round's chapters refuses the whole round and touches nothing", () => {
  for (const path of ["novels/ice-house/notes/secret.md", "../../etc/passwd", "/etc/passwd", "novels/ice-house/chapters/03-other.md", ".git/config"]) {
    const s = setup();
    const outcome = pull(s, fakeGh({ [CH]: TEXT }, withComment({ path, body: "```suggestion\npwned\n```", line: 1 })));
    expect(outcome.code).toBe(2);
    expect(outcome.skipped[0]?.reason).toBe("refused");
    expect(git(s.vault, "branch", "--list", "reader/*")).toBe("");
    expect(existsSync(join(s.project, ".pablo", "comments"))).toBe(false);
    expect(readFileSync(join(s.project, "notes", "secret.md"), "utf8")).toBe("never shared\n");
    expect(readRound(s.vault, "atara-2026-10-02")?.pulled).toBeUndefined();
  }
});

test("the author comes only from pablo's reader config: a reader missing from it, or a login that does not match, is refused", () => {
  const s = setup();
  const none = pull(s, fakeGh({ [CH]: TEXT }), new Map());
  expect(none.skipped[0]).toMatchObject({ reason: "refused" });
  expect(none.skipped[0]?.message).toContain('reader "atara"');
  const other = pull(s, fakeGh({ [CH]: TEXT }), new Map([["atara", { github: "someone-else", name: "X", email: "x@example.com" }]]));
  expect(other.skipped[0]).toMatchObject({ reason: "refused" });
  expect(git(s.vault, "branch", "--list", "reader/*")).toBe("");
});

test("a reading repo whose chapter is not the text the round shared is refused: its line numbers cannot be trusted", () => {
  const s = setup();
  const outcome = pull(s, fakeGh({ [CH]: TEXT.replace("Nobody slept.\n", "") }));
  expect(outcome.code).toBe(2);
  expect(outcome.skipped[0]?.message).toContain("not the text the round shared");
  expect(git(s.vault, "branch", "--list", "reader/*")).toBe("");
});

test("a damaged round record is refused, never turned into an API path or a branch", () => {
  const s = setup();
  writeFileSync(join(s.vault, ".pablo", "rounds", `${s.round.id}.json`), JSON.stringify({ ...s.round, repo: "evil/x", pr: 7 }));
  const fake = fakeGh({ [CH]: TEXT });
  expect(pull(s, fake).skipped[0]?.reason).toBe("refused");
  expect(fake.gh).toEqual([]);
  writeFileSync(join(s.vault, ".pablo", "rounds", `${s.round.id}.json`), JSON.stringify({ ...s.round, chapters: [{ number: 2, path: "../outside/chapters/x.md" }] }));
  expect(pull(s, fake).skipped[0]?.reason).toBe("refused");
  expect(fake.gh).toEqual([]);
});

test("an overlapping or out-of-range suggestion is not applied; it is kept as a comment and named in a notice", () => {
  const s = setup();
  const outcome = pull(
    s,
    fakeGh(
      { [CH]: TEXT },
      withComment({ body: "**[fix]** shorter\n\n```suggestion\nNobody.\n```", line: 7, original_line: 7 }),
    ),
  );
  expect(outcome.code).toBe(0);
  expect(outcome.pulled[0]?.commits).toHaveLength(2);
  expect(outcome.notices.join("\n")).toContain("overlap");
  const kept = readComments(s.project, BRANCH).find((c) => c.body.includes("Nobody."));
  expect(kept).toMatchObject({ source: "reader", tag: "fix", path: CH });
  expect(kept?.body).toContain("shorter");
});

test("movedLine follows lines through taken suggestions", () => {
  const taken = [
    { lines: { start: 3, end: 3 }, replacement: ["a", "b"] },
    { lines: { start: 6, end: 7 }, replacement: [] },
  ];
  expect([1, 2, 3, 4, 5, 6, 7, 8].map((l) => movedLine(l, taken))).toEqual([1, 2, 3, 5, 6, 6, 6, 7]);
});

test("notesWith reads readers from pablo's config; pablo notes refuses a bad action and is listed as a verb", async () => {
  const s = setup();
  mkdirSync(join(s.dir, "xdg-c", "pablo"), { recursive: true });
  writeFileSync(join(s.dir, "xdg-c", "pablo", "config.json"), JSON.stringify({ readers: { atara: { github: "atara-test", name: "Atara Test", email: "atara@example.com" } } }));
  const result = await notesWith({ sub: "pull", project: "ice-house" }, { cwd: s.vault, env: s.env, stderr: { write() {} } }, fakeGh({ [CH]: TEXT }).run);
  expect(result.exitCode).toBe(0);
  expect((result.body as { pulled: unknown[] }).pulled).toHaveLength(1);
  expect(git(s.vault, "log", "-1", "--format=%an", BRANCH)).toBe("Atara Test");

  const run = (args: string[]) => Bun.spawnSync(["bun", "run", CLI, ...args], { cwd: s.vault, env: s.env });
  expect(run(["notes", "--project", "ice-house"]).exitCode).toBe(2);
  expect(run(["notes", "push", "--project", "ice-house"]).exitCode).toBe(2);
  expect(run(["notes", "pull"]).exitCode).toBe(2);
  const help = run(["--help"]).stdout.toString();
  const [verbs, later] = help.split("Later (not yet implemented):");
  expect(verbs).toMatch(/^ {2}notes$/m);
  expect(later).not.toMatch(/^ {2}notes$/m);
});
