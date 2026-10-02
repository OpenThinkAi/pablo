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
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitingForReview } from "../src/branch";
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
