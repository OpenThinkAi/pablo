import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitFile, git, readerFor, repoFor } from "../src/git";

/**
 * The git helpers, against a **real repository this test creates in a temp
 * directory**. Never Matt's vault: the repo is initialised here, given its own
 * `user.name`, `user.email` and `commit.gpgsign=false` as local config so it
 * neither borrows the machine's identity nor fails on a machine that requires
 * signing, and removed afterwards.
 */

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop() ?? "", { recursive: true, force: true });
});

interface Repo {
  readonly root: string;
  readonly path: string;
}

function repository(): Repo {
  const root = mkdtempSync(join(tmpdir(), "pablo-git-"));
  directories.push(root);
  mkdirSync(join(root, "chapters"), { recursive: true });
  const path = join(root, "chapters", "01-the-cellar.md");
  writeFileSync(path, "# One\n\nThe cellar was cold.\n", "utf8");

  expect(git(["init", "-b", "main", root]).ok).toBe(true);
  git(["-C", root, "config", "user.name", "pablo test"]);
  git(["-C", root, "config", "user.email", "pablo@example.invalid"]);
  git(["-C", root, "config", "commit.gpgsign", "false"]);
  expect(git(["-C", root, "add", "-A"]).ok).toBe(true);
  expect(git(["-C", root, "commit", "--quiet", "-m", "the first draft"]).ok).toBe(true);
  return { root, path };
}

test("the repo path is the one git knows, even through a symlinked root", () => {
  const repo = repository();
  const found = repoFor(repo.path);

  expect(found).toBeDefined();
  expect(found?.path).toBe("chapters/01-the-cellar.md");

  // On macOS the temp root is reached through `/tmp -> /private/var/…`, so
  // `--show-toplevel` resolves it and subtracting it from the unresolved path
  // with `path.relative` would produce a string of `../..`. Asking git for both
  // halves is what keeps the answer usable in a commit message and a `git show`.
  expect(found?.path.startsWith("..")).toBe(false);
  expect(git(["-C", repo.root, "show", `HEAD:${found?.path ?? ""}`]).ok).toBe(true);
});

test("a file outside any repository is not a failure", () => {
  const loose = mkdtempSync(join(tmpdir(), "pablo-loose-"));
  directories.push(loose);
  const path = join(loose, "notes.md");
  writeFileSync(path, "not in a repo\n", "utf8");

  expect(repoFor(path)).toBeUndefined();
  expect(readerFor(path).log()).toEqual([]);
  expect(readerFor(path).show("HEAD")).toBeUndefined();

  const outcome = commitFile(path, "pablo: nothing to see");
  expect(outcome.committed).toBe(false);
  expect(outcome.notice).toContain("not a git repository");
});

test("a commit names one path and leaves everything else alone", () => {
  const repo = repository();

  // Two other files dirty, one of them already staged.
  const staged = join(repo.root, "chapters", "02-the-press.md");
  writeFileSync(staged, "# Two\n", "utf8");
  git(["-C", repo.root, "add", "--", staged]);
  writeFileSync(join(repo.root, "notes.md"), "loose\n", "utf8");

  writeFileSync(repo.path, "# One\n\nThe cellar held its cold.\n", "utf8");
  const outcome = commitFile(repo.path, "pablo: accept a proposal (prompt) in 01-the-cellar.md");
  expect(outcome.committed).toBe(true);
  expect(outcome.notice).toBe("");

  const files = git(["-C", repo.root, "show", "--name-only", "--format=", "HEAD"]).stdout.trim();
  expect(files).toBe("chapters/01-the-cellar.md");

  // The staged file is still staged and still uncommitted, and the loose one is
  // still untracked: pablo committed a path, not the state of the tree.
  const status = git(["-C", repo.root, "status", "--porcelain"]).stdout;
  expect(status).toContain("02-the-press.md");
  expect(status).toContain("notes.md");
});

test("a filename that looks like an option is a filename", () => {
  const repo = repository();
  // `--` before the pathspec, and an argument array rather than a shell string,
  // is what makes this a file and not a flag or an injection.
  const awkward = join(repo.root, "chapters", "--not-a-flag  'quoted'.md");
  writeFileSync(awkward, "# Odd\n", "utf8");

  expect(commitFile(awkward, "pablo: a file with an awkward name").committed).toBe(true);
  expect(git(["-C", repo.root, "show", "--name-only", "--format=", "HEAD"]).stdout).toContain("not-a-flag");
});

test("the reader walks the file's history newest first, with each version", () => {
  const repo = repository();

  writeFileSync(repo.path, "# One\n\nThe cellar held its cold.\n", "utf8");
  expect(commitFile(repo.path, "pablo: the second version").committed).toBe(true);

  const reader = readerFor(repo.path);
  const log = reader.log();
  expect(log).toHaveLength(2);
  expect(log[0]?.message).toContain("the second version");
  expect(log[1]?.message).toContain("the first draft");

  const head = log[0]?.sha ?? "";
  expect(reader.show(head)).toContain("held its cold");
  expect(reader.show(`${head}^`)).toContain("was cold");
  // The reader caches, so a repeated read is one `git show` and the same answer.
  expect(reader.show(head)).toBe(readerFor(repo.path).show(head) ?? "");
  expect(reader.show("nope^{}")).toBeUndefined();

  // And the working tree is what it was: nothing here writes.
  expect(readFileSync(repo.path, "utf8")).toContain("held its cold");
});

test("a commit that would change nothing is a notice, not a crash", () => {
  const repo = repository();
  const outcome = commitFile(repo.path, "pablo: nothing changed");
  expect(outcome.committed).toBe(false);
  expect(outcome.notice).toContain("git commit failed");
});
