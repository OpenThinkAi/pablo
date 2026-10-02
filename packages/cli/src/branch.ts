/**
 * The branch layer (AGT-1535): every change to the manuscript is a git branch,
 * checked out as a worktree so `main` is never disturbed while a draft, a
 * revise pass, an edit or a reader's rewrites accumulate. Design: the
 * `ai-terminal` pm doc `screen`, "Changes are branches".
 *
 * Worktrees live under `<root>/worktrees/<slug>/<branch>` where `<root>` is
 * `$PABLO_HOME` if set, else `~/.cache/pablo`. Nothing here ever writes into
 * the vault's working tree except `mergeBranch`, which merges into `main`.
 *
 * Same convention as `gitCommit` in `init.ts`: a git failure is a returned
 * notice, never a thrown exception.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Env = Record<string, string | undefined>;

/** The four kinds of change branch, by prefix. */
export const BRANCH_KINDS = ["draft", "revise", "edit", "reader"] as const;
export type BranchKind = (typeof BRANCH_KINDS)[number];

export interface Author {
  name: string;
  email: string;
}

export type BranchResult = { ok: true; path?: string; sha?: string } | { ok: false; notice: string };

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function errMessage(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const stderr = e.stderr ? e.stderr.toString().trim() : "";
  return stderr || e.message || String(err);
}

function git(repo: string, args: readonly string[], env?: Env): string {
  return execFileSync("git", ["-C", repo, ...args], {
    stdio: "pipe",
    encoding: "utf8",
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
}

/** `$PABLO_HOME`, else `~/.cache/pablo`. */
export function pabloHome(env: Env = process.env): string {
  return env["PABLO_HOME"] || join(homedir(), ".cache", "pablo");
}

/** `<pabloHome>/worktrees/<slug>/<branch>` — the branch's worktree directory. */
export function worktreePath(slug: string, branch: string, env: Env = process.env): string {
  return join(pabloHome(env), "worktrees", slug, branch);
}

/** The kind a branch name belongs to, or undefined if it is not a change branch. */
export function branchKind(branch: string): BranchKind | undefined {
  return BRANCH_KINDS.find((k) => branch.startsWith(`${k}/`) && branch.length > k.length + 1);
}

function validate(slug: string, branch: string): string | undefined {
  if (!SLUG_PATTERN.test(slug)) return `pablo: branch: invalid project slug "${slug}"`;
  if (!branchKind(branch)) return `pablo: branch: "${branch}" must start with one of ${BRANCH_KINDS.map((k) => `${k}/`).join(", ")}`;
  if (branch.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) {
    return `pablo: branch: invalid branch name "${branch}"`;
  }
  try {
    execFileSync("git", ["check-ref-format", "--branch", branch], { stdio: "pipe" });
  } catch {
    return `pablo: branch: invalid branch name "${branch}"`;
  }
  return undefined;
}

/**
 * Creates `branch` from `main` and checks it out as a worktree under
 * `worktreePath(slug, branch)`. Refuses a name outside the four kinds, a
 * branch that already exists, and a missing `main`.
 */
export function createBranch(repo: string, slug: string, branch: string, env: Env = process.env): BranchResult {
  const invalid = validate(slug, branch);
  if (invalid) return { ok: false, notice: invalid };

  const path = worktreePath(slug, branch, env);
  if (existsSync(path)) return { ok: false, notice: `pablo: branch: ${path} already exists` };

  try {
    mkdirSync(dirname(path), { recursive: true });
    git(repo, ["worktree", "add", "-b", branch, path, "main"]);
  } catch (err) {
    return { ok: false, notice: `pablo: git worktree add failed: ${errMessage(err)}` };
  }
  return { ok: true, path };
}

export interface CommitOptions {
  message: string;
  author: Author;
  /** A model's commits carry its receipt hash in the message (`Receipt: <hash>`). */
  receipt?: string;
  /** Paths relative to the worktree; default is every tracked and new file. */
  paths?: readonly string[];
}

/**
 * Commits in a branch's worktree as `author`. Never `git add -A` of the
 * vault: callers name paths, and the default (`.`) is scoped to the worktree,
 * which holds only this branch's changes.
 */
export function commitAs(worktree: string, opts: CommitOptions): BranchResult {
  const paths = opts.paths && opts.paths.length > 0 ? opts.paths : ["."];
  const message = opts.receipt ? `${opts.message}\n\nReceipt: ${opts.receipt}` : opts.message;
  const identity: Env = {
    GIT_AUTHOR_NAME: opts.author.name,
    GIT_AUTHOR_EMAIL: opts.author.email,
    GIT_COMMITTER_NAME: opts.author.name,
    GIT_COMMITTER_EMAIL: opts.author.email,
  };
  try {
    git(worktree, ["add", "--", ...paths]);
  } catch (err) {
    return { ok: false, notice: `pablo: git add failed: ${errMessage(err)}` };
  }
  try {
    git(worktree, ["commit", "-m", message], identity);
    return { ok: true, sha: git(worktree, ["rev-parse", "HEAD"]).trim() };
  } catch (err) {
    return { ok: false, notice: `pablo: git commit failed: ${errMessage(err)}` };
  }
}

export type BranchList = Record<BranchKind, string[]>;

/** Change branches grouped by kind, sorted by name. Branches of no kind (`main`) are omitted. */
export function listBranches(repo: string): { ok: true; branches: BranchList } | { ok: false; notice: string } {
  let out: string;
  try {
    out = git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  } catch (err) {
    return { ok: false, notice: `pablo: git branch list failed: ${errMessage(err)}` };
  }
  const branches: BranchList = { draft: [], revise: [], edit: [], reader: [] };
  for (const name of out.split("\n").filter(Boolean).sort()) {
    const kind = branchKind(name);
    if (kind) branches[kind].push(name);
  }
  return { ok: true, branches };
}

/**
 * Merges `branch` into `main` with a merge commit, run in the repo's own
 * checkout (which must have `main` checked out and be clean). A conflict is
 * aborted so `main` is left as it was, and returned as a notice.
 */
export function mergeBranch(repo: string, branch: string, env: Env = process.env): BranchResult {
  if (!branchKind(branch)) return { ok: false, notice: `pablo: merge: "${branch}" is not a change branch` };
  try {
    const head = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    if (head !== "main") return { ok: false, notice: `pablo: merge: ${repo} has "${head}" checked out, not main` };
  } catch (err) {
    return { ok: false, notice: `pablo: git rev-parse failed: ${errMessage(err)}` };
  }
  const identity: Env = {
    GIT_COMMITTER_NAME: env["GIT_COMMITTER_NAME"] ?? "pablo",
    GIT_COMMITTER_EMAIL: env["GIT_COMMITTER_EMAIL"] ?? "pablo@localhost",
    GIT_AUTHOR_NAME: env["GIT_AUTHOR_NAME"] ?? "pablo",
    GIT_AUTHOR_EMAIL: env["GIT_AUTHOR_EMAIL"] ?? "pablo@localhost",
  };
  try {
    git(repo, ["merge", "--no-ff", "-m", `merge ${branch}`, branch], identity);
    return { ok: true, sha: git(repo, ["rev-parse", "HEAD"]).trim() };
  } catch (err) {
    const notice = `pablo: git merge failed: ${errMessage(err)}`;
    try {
      git(repo, ["merge", "--abort"]);
    } catch {
      // nothing to abort (e.g. unknown branch): the merge never started
    }
    return { ok: false, notice };
  }
}

/**
 * Deletes the branch and its worktree. An unmerged branch is refused unless
 * `force` — a rejected draft is deleted with `force: true`, a merged one
 * without.
 */
export function deleteBranch(
  repo: string,
  slug: string,
  branch: string,
  opts: { force?: boolean; env?: Env } = {},
): BranchResult {
  const invalid = validate(slug, branch);
  if (invalid) return { ok: false, notice: invalid };

  const path = worktreePath(slug, branch, opts.env ?? process.env);
  if (existsSync(path)) {
    try {
      git(repo, ["worktree", "remove", ...(opts.force ? ["--force"] : []), path]);
    } catch (err) {
      return { ok: false, notice: `pablo: git worktree remove failed: ${errMessage(err)}` };
    }
  } else {
    try {
      git(repo, ["worktree", "prune"]);
    } catch {
      // best effort: a stale registration only blocks the branch delete below
    }
  }
  try {
    git(repo, ["branch", opts.force ? "-D" : "-d", branch]);
  } catch (err) {
    return { ok: false, notice: `pablo: git branch delete failed: ${errMessage(err)}` };
  }
  return { ok: true };
}
