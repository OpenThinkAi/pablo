import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDiff, stitch } from "@openthink/pablo-core";
import type { Adapter, CompletionEvent, Edit } from "@openthink/pablo-core";
import { branchDiff, commitAs, createBranch, worktreePath } from "../src/branch";
import { addComment, commentsPath, readComments } from "../src/comments";
import { authorNotesOf, finishReview, screenCommenter, insideDir, revertLines, revertRejected, screenFinisher } from "../src/review-finish";
import type { Rejected } from "../src/review-finish";
import { runWrite } from "../src/write";

/**
 * AGT-1540: finishing a review merges only the accepted changes, runs the after-write steps and deletes the branch.
 * Temp git copy of the fixture vault, a fake Adapter, a think-free PATH and temp state/home dirs: no model, no `think`.
 */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");

const dirs: string[] = [];
afterEach(() => { while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true }); });

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString("utf8")}`);
  return r.stdout.toString("utf8").trim();
}

const CH1 = "chapters/01-the-last-full-cut.md";
const BASE = ["---", "chapter: 1", "title: The Last Full Cut", "words: 40", "model: base-model", "---", "", "The pond rang under the horse.", "Odile heard it from the doorway.", "She wrote the time in the green book.", "", "Marcel had marked the grid at first light.", "The men poled the raft to the water door.", "Nobody spoke of the order.", ""].join("\n");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pablo-review-finish-"));
  dirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const project = join(vault, "novels", "ice-house");
  writeFileSync(join(project, CH1), BASE);
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  const env = { PATH: NO_THINK_PATH, XDG_STATE_HOME: join(dir, "state"), PABLO_HOME: join(dir, "home") };
  return { vault, project, env, opts: { slug: "ice-house", env, now: () => new Date("2026-10-02T12:00:00.000Z") } };
}

/** A revise branch changing chapter 1: the second sentence reworded (edit 0), a sentence added after the grid line (edit 1), the last line removed (edit 2). */
function reviseBranch(vault: string, env: Record<string, string>): string {
  const branch = "revise/ab12";
  const made = createBranch(vault, "ice-house", branch, env);
  if (!made.ok) throw new Error(made.notice);
  const file = join(made.path as string, "novels", "ice-house", CH1);
  const lines = BASE.split("\n");
  lines[8] = "Odile heard it from the scale house.";
  lines.splice(12, 0, "The cold had a sound of its own.");
  const text = lines.join("\n").replace("Nobody spoke of the order.\n", "");
  writeFileSync(file, text);
  const c = commitAs(made.path as string, { message: "revise", author: { name: "Model", email: "model@localhost" } });
  if (!c.ok) throw new Error(c.notice);
  return branch;
}

function editsOf(vault: string, branch: string): Edit[] {
  const d = branchDiff(vault, branch);
  if (!d.ok) throw new Error(d.notice);
  return stitch(parseDiff(d.text));
}

/** What the screen sends: the lines each rejected edit owns. */
const rejecting = (edits: readonly Edit[]): Rejected => ({ removed: edits.flatMap((e) => e.removedLines), added: edits.flatMap((e) => e.addedLines) });

const none: Rejected = { removed: [], added: [] };
const chapter = (project: string) => readFileSync(join(project, CH1), "utf8");

test("the stitcher splits the revise branch into the three edits the tests reject from", () => {
  const { vault, env } = setup();
  const edits = editsOf(vault, reviseBranch(vault, env));
  expect(edits.map((e) => e.kind)).toEqual(["change", "add", "remove"]);
});

test("accepting everything merges the branch whole and deletes the branch and its worktree; a revise drafted nothing, so no after-write step runs (AC1-3, AGT-1642)", async () => {
  const { vault, project, env, opts } = setup();
  const readmeBefore = readFileSync(join(project, "README.md"), "utf8");
  const branch = reviseBranch(vault, env);
  const done = await finishReview(project, branch, none, opts);
  expect(done.ok).toBe(true);
  if (!done.ok) return;
  expect(done.merged).toBe(true);
  expect(done.rituals).toEqual([]); // no outline tick, README "drafted", continuity re-extraction or think "drafted"
  expect(existsSync(join(project, "notes", "2026-10-02-chapter-01.md"))).toBe(false);
  expect(readFileSync(join(project, "README.md"), "utf8")).toBe(readmeBefore);
  expect(chapter(project)).toContain("Odile heard it from the scale house.");
  expect(chapter(project)).toContain("The cold had a sound of its own.");
  expect(chapter(project)).not.toContain("Nobody spoke of the order.");
  expect(git(vault, "branch", "--list", "revise/*")).toBe("");
  expect(existsSync(worktreePath("ice-house", branch, env))).toBe(false);
});

test("a rejected edit never reaches main: the accepted ones merge, the rejected one keeps its old text", async () => {
  const { vault, project, env, opts } = setup();
  const branch = reviseBranch(vault, env);
  const edits = editsOf(vault, branch);
  const done = await finishReview(project, branch, rejecting([edits[0]!, edits[2]!]), opts);
  expect(done.ok).toBe(true);
  const text = chapter(project);
  expect(text).toContain("Odile heard it from the doorway."); // edit 0 rejected: the old sentence is back
  expect(text).not.toContain("scale house.");
  expect(text).toContain("The cold had a sound of its own."); // edit 1 accepted
  expect(text).toContain("Nobody spoke of the order."); // edit 2 (a removal) rejected: the line is back
  // Only the accepted change differs from what main had before; the file is otherwise byte-for-byte the base.
  expect(text).toBe(BASE.replace("The men poled", "The cold had a sound of its own.\nThe men poled"));
  expect(git(vault, "branch", "--list", "revise/*")).toBe("");
  expect(existsSync(worktreePath("ice-house", branch, env))).toBe(false);
});

test("rejecting every edit discards the branch without a merge or any after-write step", async () => {
  const { vault, project, env, opts } = setup();
  const branch = reviseBranch(vault, env);
  const before = git(vault, "rev-parse", "main");
  const done = await finishReview(project, branch, rejecting(editsOf(vault, branch)), opts);
  expect(done).toMatchObject({ ok: true, merged: false, rituals: [] });
  expect(git(vault, "rev-parse", "main")).toBe(before);
  expect(chapter(project)).toBe(BASE);
  expect(existsSync(join(project, "notes", "2026-10-02-chapter-01.md"))).toBe(false);
  expect(git(vault, "branch", "--list", "revise/*")).toBe("");
});

const adapter: Adapter = {
  id: "local",
  model: "test-writer-model",
  preferredOutput: "text",
  async *complete(): AsyncIterable<CompletionEvent> {
    yield { type: "token", text: "The storm came up from the coast. She let him in." };
    yield { type: "done", stats: { timeToFirstTokenMs: 1, elapsedMs: 2, tokensRead: 3, tokensWritten: 4, tokensPerSecond: 5 } };
  },
  async proposeEdit(): Promise<never> { throw new Error("not implemented"); },
  async extractFacts(): Promise<never> { throw new Error("not implemented"); },
};

test("a written draft finishes through mergeDraft: accepted, it lands on main with its after-write steps; rejected, no file reaches main", async () => {
  for (const reject of [false, true]) {
    const { vault, project, env, opts } = setup();
    const log = console.log;
    console.log = () => {};
    try {
      const code = await runWrite({ chapter: "2", words: undefined, scenes: undefined, dryRun: false, json: true, force: false }, vault, project, { adapter, env, stderr: { write: () => {} } });
      expect(code).toBe(0);
    } finally {
      console.log = log;
    }
    const edits = editsOf(vault, "draft/ch02");
    const done = await finishReview(project, "draft/ch02", reject ? rejecting(edits) : none, { ...opts, extractor: adapter });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(existsSync(join(project, "chapters", "02-black-ice.md"))).toBe(!reject);
    expect(done.merged).toBe(!reject);
    expect(done.rituals.length).toBe(reject ? 0 : 6);
    expect(git(vault, "branch", "--list", "draft/*")).toBe("");
  }
});

test("a path that leaves the project, or a line the branch did not change, refuses the finish and touches nothing", async () => {
  const { vault, project, env, opts } = setup();
  const branch = reviseBranch(vault, env);
  const before = git(vault, "rev-parse", "main");
  const tip = git(vault, "rev-parse", branch);
  for (const bad of [
    { removed: [{ path: "../outside.md", line: 1 }], added: [] },
    { removed: [], added: [{ path: "/etc/passwd", line: 1 }] },
    { removed: [{ path: "novels/ice-house/.git/config", line: 1 }], added: [] },
    { removed: [{ path: `novels/ice-house/${CH1}`, line: 1 }], added: [] }, // line 1 is not a changed line
  ] satisfies Rejected[]) {
    const done = await finishReview(project, branch, bad, opts);
    expect(done.ok).toBe(false);
  }
  expect(git(vault, "rev-parse", "main")).toBe(before);
  expect(git(vault, "rev-parse", branch)).toBe(tip);
  expect(git(vault, "branch", "--list", "revise/*")).toContain("revise/ab12");
});

test("a merge that conflicts leaves main as it was and the branch (with its revert commit) in place", async () => {
  const { vault, project, env, opts } = setup();
  const branch = reviseBranch(vault, env);
  const edits = editsOf(vault, branch);
  // main moves the same sentence the branch rewrote.
  writeFileSync(join(project, CH1), chapter(project).replace("Odile heard it from the doorway.", "Odile heard it from the yard."));
  git(vault, "commit", "-qam", "main moves");
  const before = git(vault, "rev-parse", "main");
  const done = await finishReview(project, branch, rejecting([edits[2]!]), opts);
  expect(done.ok).toBe(false);
  expect(git(vault, "rev-parse", "main")).toBe(before);
  expect(git(vault, "status", "--porcelain")).toBe("");
  expect(git(vault, "branch", "--list", "revise/*")).toContain("revise/ab12");
});

test("revertLines undoes the rejected lines by number and refuses text that no longer matches the diff", () => {
  const diff = "diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1,3 +1,3 @@\n One.\n-Two.\n+Too.\n Three.\n";
  const file = parseDiff(diff)[0]!;
  const cur = "One.\nToo.\nThree.\n", base = "One.\nTwo.\nThree.\n";
  expect(revertLines(file, cur, base, { removed: new Set([2]), added: new Set([2]) })).toBe(base);
  expect(revertLines(file, cur, base, { removed: new Set(), added: new Set() })).toBe(cur);
  expect(revertLines(file, "One.\nChanged.\nThree.\n", base, { removed: new Set([2]), added: new Set([2]) })).toBeUndefined();
  // Dropping only the added line leaves a removal; restoring only the removed one leaves both.
  expect(revertLines(file, cur, base, { removed: new Set(), added: new Set([2]) })).toBe("One.\nThree.\n");
  expect(revertLines(file, cur, base, { removed: new Set([2]), added: new Set() })).toBe("One.\nTwo.\nToo.\nThree.\n");
});

test("insideDir accepts project-relative paths only", () => {
  const { project } = setup();
  expect(insideDir(project, "chapters/new.md")).toBe(join(project, "chapters/new.md"));
  for (const bad of ["", "../x", "a/../../x", "/etc/passwd", ".git/config", "a/.git/hooks/x"]) expect(insideDir(project, bad)).toBeUndefined();
});

test("revertRejected on a branch with no worktree adds one, and finishing removes it", async () => {
  const { vault, project, env, opts } = setup();
  const branch = reviseBranch(vault, env);
  git(vault, "worktree", "remove", "--force", worktreePath("ice-house", branch, env));
  const edits = editsOf(vault, branch);
  const reverted = revertRejected(vault, "ice-house", branch, rejecting([edits[1]!]), env);
  expect(reverted).toEqual({ ok: true, files: 1 });
  const done = await finishReview(project, branch, none, opts);
  expect(done.ok).toBe(true);
  expect(chapter(project)).not.toContain("The cold had a sound");
});

test("screenFinisher returns the screen's lines: the merge, and the note when the author commented", async () => {
  const { vault, project, env, opts } = setup();
  const branch = reviseBranch(vault, env);
  const edits = editsOf(vault, branch);
  const finish = screenFinisher(project, { env, now: opts.now, extractor: adapter });
  const r = await finish(branch, rejecting([edits[0]!]));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.lines[0]).toMatch(/^merged revise\/ab12 into main \(/);
  expect(r.lines.some((l) => l.startsWith("outline: "))).toBe(false); // a revise drafted nothing
  const refused = await finish("revise/nope", none);
  expect(refused.ok).toBe(false);
});

// AGT-1581: the author's own comments survive the merge in the chapter's note; a discarded branch writes none.
const REPO_CH1 = `novels/ice-house/${CH1}`;
const author = (path: string, line: number | undefined, body: string, startLine?: number) =>
  ({ source: "author", path, ...(line !== undefined ? { line } : {}), ...(startLine !== undefined ? { startLine } : {}), author: "matt", body }) as const;

test("finishing a review appends the branch's author comments, with their line text, to the chapter's dated note, committed on main (AC3)", async () => {
  const { vault, project, env, opts } = setup();
  const branch = reviseBranch(vault, env);
  addComment(project, branch, author(REPO_CH1, 9, "Scale house? Say which one."));
  addComment(project, branch, author(REPO_CH1, 8, "Keep this opening.", 8));
  addComment(project, branch, { ...author(REPO_CH1, 9, "A reader's, not mine."), source: "reader" });
  const done = await finishReview(project, branch, none, opts);
  expect(done.ok && done.merged).toBe(true);
  const note = readFileSync(join(project, "notes", "2026-10-02-chapter-01.md"), "utf8");
  expect(note).toContain("Author comments:");
  expect(note).toContain('- line 9: "Odile heard it from the scale house."\n  Scale house? Say which one.');
  expect(note).toContain('- line 8: "The pond rang under the horse."\n  Keep this opening.');
  expect(note).not.toContain("reader's");
  // Committed with the rest of the after-write steps, so it is on main; the branch's store goes with the branch.
  expect(git(vault, "ls-files", "novels/ice-house/notes")).toContain("2026-10-02-chapter-01.md");
  expect(git(vault, "status", "--porcelain", "novels/ice-house/notes")).toBe("");
  expect(existsSync(commentsPath(project, branch))).toBe(false);
});

test("comments on a rejected line are still kept as written (their text is what the author saw); a branch with no author comments adds no section", async () => {
  const { vault, project, env, opts } = setup();
  const branch = reviseBranch(vault, env);
  addComment(project, branch, author(REPO_CH1, 9, "Why change this?"));
  const edits = editsOf(vault, branch);
  await finishReview(project, branch, rejecting([edits[0]!]), opts);
  const note = readFileSync(join(project, "notes", "2026-10-02-chapter-01.md"), "utf8");
  expect(note).toContain('"Odile heard it from the scale house."');
  const second = setup();
  const b2 = reviseBranch(second.vault, second.env);
  await finishReview(second.project, b2, none, second.opts);
  // With no author comments a revise writes no note at all (AGT-1642: nothing was drafted).
  expect(existsSync(join(second.project, "notes", "2026-10-02-chapter-01.md"))).toBe(false);
});

test("a branch discarded by rejecting everything writes its author comments nowhere (AC4)", async () => {
  const { vault, project, env, opts } = setup();
  const branch = reviseBranch(vault, env);
  addComment(project, branch, author(REPO_CH1, 9, "Discard me."));
  const done = await finishReview(project, branch, rejecting(editsOf(vault, branch)), opts);
  expect(done).toMatchObject({ ok: true, merged: false });
  expect(existsSync(join(project, "notes", "2026-10-02-chapter-01.md"))).toBe(false);
  expect(readComments(project, branch)).toEqual([]);
});

test("authorNotesOf quotes the lines as the branch has them, skips other sources and the summary, and tolerates a missing file", () => {
  const { vault, project, env } = setup();
  const branch = reviseBranch(vault, env);
  addComment(project, branch, author(REPO_CH1, 9, "one"));
  addComment(project, branch, author("novels/ice-house/chapters/09-gone.md", 2, "two"));
  addComment(project, branch, { ...author("", undefined, "summary"), review: true });
  addComment(project, branch, { ...author(REPO_CH1, 9, "three"), source: "critic" });
  const notes = authorNotesOf(project, vault, branch);
  expect(notes.map((n) => [n.body, n.text])).toEqual([["one", "Odile heard it from the scale house."], ["two", ""]]);
});

test("screenCommenter stores the comment as the author, under the project's author name", () => {
  const { vault, project, env } = setup();
  const branch = reviseBranch(vault, env);
  const save = screenCommenter(project);
  expect(save(branch, { source: "author", path: REPO_CH1, line: 9, author: "", body: "hm" })).toEqual({ ok: true });
  expect(readComments(project, branch)).toEqual([{ source: "author", path: REPO_CH1, line: 9, author: "matt", body: "hm" }]);
  expect(save(branch, { source: "author", path: "", author: "", body: "no file" })).toMatchObject({ ok: false });
});
