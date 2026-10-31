/**
 * `pablo status` and `pablo resume` report the branches waiting for review
 * (AGT-1541): the change branches whose commits `main` does not have yet, from
 * the branch layer's `waitingBranches`. They replaced the per-chapter
 * `review: pending|approved|rejected|none` the JSONL review queue gave.
 *
 * Every test works in a temp copy of the fixture vault, never a real vault.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openText } from "../../tui/src/edit-pane";
import { paneWords } from "../../tui/src/word-count";
import { readWorkStatus, reportWithWords } from "../src/work-state";
import { workBookStages } from "../src/book";
import { screenTargetStore } from "../src/edit-session";
import { readerLeftovers, waitingBranches, waitingForReview } from "../src/branch";
import { readNovelState } from "../src/novel/machine";

const WORK = fileURLToPath(new URL("./fixtures/vault/novels/ice-house", import.meta.url));

let dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function git(repo: string, ...args: string[]): void {
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=t@t.example", ...args], { stdio: "pipe" });
}

/** A temp copy of the fixture novel as its own git repo on `main`. */
function tempRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pablo-status-test-")));
  dirs.push(dir);
  const work = join(dir, "ice-house");
  cpSync(WORK, work, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  git(work, "add", "-A");
  git(work, "commit", "-qm", "seed");
  return work;
}

/** A branch off `main` with one commit changing chapter 1, left checked out on `main` again. */
function branchWithChange(work: string, name: string): void {
  git(work, "checkout", "-q", "-b", name);
  writeFileSync(join(work, "chapters", "01-the-last-full-cut.md"), "Changed.\n");
  git(work, "commit", "-qam", "change");
  git(work, "checkout", "-q", "main");
}

describe("the novel machine no longer carries a review state per chapter", () => {
  test("a chapter is its number, file, status and title, and nothing about a queue", () => {
    expect(readNovelState(WORK).chapters).toEqual([
      { number: 1, file: "chapters/01-the-last-full-cut.md", status: "draft", title: "The Last Full Cut" },
    ]);
  });
});

describe("waitingForReview", () => {
  test("is empty outside a repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "pablo-status-test-"));
    dirs.push(dir);
    expect(waitingForReview(dir)).toEqual([]);
  });

  test("is empty when no change branch has commits main lacks", () => {
    const work = tempRepo();
    git(work, "branch", "draft/ch02");
    expect(waitingForReview(work)).toEqual([]);
  });

  test("lists the change branches with commits main lacks, sorted, and ignores other branches", () => {
    const work = tempRepo();
    branchWithChange(work, "revise/ab12");
    branchWithChange(work, "draft/ch02");
    branchWithChange(work, "scratch");
    expect(waitingForReview(work)).toEqual(["draft/ch02", "revise/ab12"]);
  });

  test("a branch that has been merged to main is no longer waiting", () => {
    const work = tempRepo();
    branchWithChange(work, "draft/ch02");
    git(work, "merge", "-q", "--no-edit", "draft/ch02");
    expect(waitingForReview(work)).toEqual([]);
  });
});

describe("waitingForReview is the work's own (AGT-2283)", () => {
  /** A vault repo with two works, a/ and b/, each with a file. */
  function twoWorks(): { vault: string; a: string; b: string } {
    const vault = realpathSync(mkdtempSync(join(tmpdir(), "pablo-status-two-")));
    dirs.push(vault);
    for (const w of ["a", "b"]) {
      cpSync(WORK, join(vault, w), { recursive: true });
    }
    execFileSync("git", ["init", "-q", "-b", "main", vault]);
    git(vault, "add", "-A");
    git(vault, "commit", "-qm", "seed");
    return { vault, a: join(vault, "a"), b: join(vault, "b") };
  }
  function change(vault: string, work: string, branch: string): void {
    git(vault, "checkout", "-q", "-b", branch);
    writeFileSync(join(work, "chapters", "01-the-last-full-cut.md"), `Changed on ${branch}.\n`);
    git(vault, "commit", "-qam", "change");
    git(vault, "checkout", "-q", "main");
  }

  test("a branch on work A shows nothing waiting on work B", () => {
    const { vault, a, b } = twoWorks();
    change(vault, a, "draft/ch02");
    expect(waitingForReview(a)).toEqual(["draft/ch02"]);
    expect(waitingForReview(b)).toEqual([]);
  });

  test("a branch with nothing left that main lacks (squash-merged) is not waiting", () => {
    const { vault, a } = twoWorks();
    change(vault, a, "revise/ab12");
    git(vault, "merge", "-q", "--squash", "revise/ab12");
    git(vault, "commit", "-qm", "squashed");
    expect(waitingForReview(a)).toEqual([]);
  });

  test("a reader/ branch is never waiting, and doctor's helper lists it", () => {
    const { vault, a } = twoWorks();
    change(vault, a, "reader/atara-2026-10-04");
    change(vault, a, "draft/ch02");
    expect(waitingForReview(a)).toEqual(["draft/ch02"]);
    expect(waitingBranches(vault)).toEqual({ ok: true, branches: ["draft/ch02"] });
    expect(readerLeftovers(vault)).toEqual([{ branch: "reader/atara-2026-10-04" }]);
  });
});

describe("unit word counts (AGT-2175)", () => {
  const CHAPTER = "chapters/01-the-last-full-cut.md";

  test("status reports each drafted unit's words, and the editor's live count for the saved file is that number", () => {
    const work = tempRepo();
    const raw = readFileSync(join(work, CHAPTER), "utf8");
    const unit = readWorkStatus(work).outputs["novel"]!.units.find((u) => u.file === CHAPTER)!;
    expect(unit.words).toBeGreaterThan(0);
    // The editor's count: the buffer `v e` opens over the same file.
    expect(paneWords(openText(raw, "sentences", 1))).toBe(unit.words!);
    // A file whose frontmatter holds words: the frontmatter is not counted, by either.
    writeFileSync(join(work, CHAPTER), "---\nchapter: 1\ntitle: A long frontmatter title here\n---\n\nOne two three.\nFour five.\n");
    const changed = readWorkStatus(work).outputs["novel"]!.units.find((u) => u.file === CHAPTER)!;
    expect(changed.words).toBe(5);
    expect(paneWords(openText(readFileSync(join(work, CHAPTER), "utf8"), "sentences", 1))).toBe(5);
  });

  test("the rail's stages carry the words too, for a per-work target's total", () => {
    const work = tempRepo();
    const stage = workBookStages(work).find((s) => s.file === CHAPTER || s.id === "chapter:1");
    expect(stage?.words).toBe(readWorkStatus(work).outputs["novel"]!.units.find((u) => u.file === CHAPTER)!.words);
  });

  test("targets persist in <work>/.pablo/targets.json, and a missing file is no targets", () => {
    const work = tempRepo();
    const store = screenTargetStore(work);
    expect(store.load()).toBeUndefined();
    store.save({ outputs: { novel: 80000 }, units: { [CHAPTER]: 3000 } });
    expect(existsSync(join(work, ".pablo", "targets.json"))).toBe(true);
    expect(screenTargetStore(work).load()).toEqual({ outputs: { novel: 80000 }, units: { [CHAPTER]: 3000 } });
  });
});

describe("shared-file units (AGT-2175)", () => {
  test("units that share one file report no words, so a section is never given the whole essay's count", () => {
    const report = { noun: "section", plural: "sections", dir: "x", drafted: 2, total: 2, units: [{ unit: 1, status: "draft", file: "chapters/01-the-last-full-cut.md" }, { unit: 2, status: "draft", file: "chapters/01-the-last-full-cut.md" }] };
    const work = tempRepo();
    expect(reportWithWords(work, report).units.map((u) => u.words)).toEqual([undefined, undefined]);
    expect(reportWithWords(work, { ...report, units: [report.units[0]!] }).units[0]!.words).toBeGreaterThan(0);
  });
});
