/**
 * The vault's git repository, as pablo talks to it.
 *
 * Two jobs, both for the review queue (AGT-1205): **commit the file after an
 * accept** (AC3) and **read a paragraph's earlier text back out of history**
 * (AC4). Nothing else in pablo runs git, and nothing here knows what a
 * proposal is — the commit message arrives already written.
 *
 * Three rules this module keeps:
 *
 * 1. **Never a shell string.** Every call is an argument array through
 *    `Bun.spawnSync`, so a filename with a space, a quote, or a leading `-`
 *    is a filename and not syntax.
 * 2. **Never `git add -A`.** A commit names exactly one path, and the commit
 *    itself carries that pathspec too, so an unrelated dirty file in the vault
 *    is never swept in — not even one that was already staged.
 * 3. **Git failing is a notice, not an exception.** The manuscript is written
 *    before any of this runs; a vault that is not a repository, a missing
 *    `git`, a rejected hook, all end as one line in the status bar. Nothing
 *    here can block a write that already happened.
 *
 * It is deliberately **synchronous**. Two accepts in a row must produce two
 * commits in that order, and `git` serialises on `index.lock` rather than
 * queueing, so an async commit would need a queue of its own to avoid losing a
 * race with the author's next keypress. Synchronous also means no child
 * process outlives the call, so `view.stop()` has nothing here to abort.
 */

import { resolve, sep } from "node:path";

/** The raw result of one `git` invocation. */
export interface GitRun {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** What the author is told after an accept (AC3). */
export interface CommitOutcome {
  readonly committed: boolean;
  /** One line for the status bar. Empty when the commit landed. */
  readonly notice: string;
}

/** One commit touching the manuscript, newest first. */
export interface CommitEntry {
  readonly sha: string;
  /** The full message, subject and body, exactly as it was written. */
  readonly message: string;
}

/** How `planRevert` reads history. Injected, so its logic is testable without git. */
export interface GitReader {
  /** Commits that touched the file, newest first. */
  log(): readonly CommitEntry[];
  /** The file's content at `ref`, or `undefined` when the ref or the path is absent. */
  show(ref: string): string | undefined;
}

function textOf(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  return String(value);
}

/** One `git` call. Argument array, no shell, never throws. */
export function git(args: readonly string[]): GitRun {
  try {
    const run = Bun.spawnSync({
      cmd: ["git", ...args],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return { ok: run.exitCode === 0, stdout: textOf(run.stdout), stderr: textOf(run.stderr) };
  } catch (error) {
    // A missing `git` on PATH lands here, and it is a notice like any other.
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
}

function firstLine(...candidates: readonly string[]): string {
  for (const candidate of candidates) {
    const line = candidate.split("\n").find((row) => row.trim().length > 0);
    if (line !== undefined) return line.trim().slice(0, 120);
  }
  return "";
}

/** Where a manuscript sits in the repository that holds it. */
export interface Repo {
  /** The repository root, as git resolves it. */
  readonly root: string;
  /** The path git knows the file by: root-relative, POSIX separators. */
  readonly path: string;
}

/**
 * The repository a manuscript is in, and the name git knows it by.
 *
 * Both halves are asked of git rather than derived, and the reason is not
 * fussiness. `--show-toplevel` returns the **resolved** root — on macOS a vault
 * under `/tmp` comes back as `/private/var/folders/…` — so subtracting it from
 * an unresolved path with `path.relative` yields a string of `../..` that names
 * the right file and is useless in a commit message, a `git show`, or anything
 * else. Asking for `--show-prefix` in the same call gets the two from one
 * resolution, so they cannot disagree.
 *
 * `undefined` means the file is not in a repository, which is a supported way
 * to run pablo: the vault is markdown files, and git is what the author's own
 * vault happens to have.
 */
export function repoFor(file: string): Repo | undefined {
  const full = resolve(file);
  const run = git(["-C", directoryOf(full), "rev-parse", "--show-toplevel", "--show-prefix"]);
  if (!run.ok) return undefined;

  const [root, prefix = ""] = run.stdout.split("\n").map((row) => row.trim());
  if (root === undefined || root === "") return undefined;

  const name = full.slice(full.lastIndexOf(sep) + 1);
  return { root, path: `${prefix}${name}` };
}

function directoryOf(file: string): string {
  const full = resolve(file);
  const at = full.lastIndexOf(sep);
  return at <= 0 ? sep : full.slice(0, at);
}

/**
 * Commit exactly one file with exactly one message (AC3).
 *
 * `add -- <file>` so a proposal accepted into a file git has never seen still
 * commits, and then `commit -- <file>`, whose pathspec makes the commit a
 * partial one: it takes the working tree copy of that path and *nothing else*,
 * so anything else the author had staged stays staged and uncommitted.
 */
export function commitFile(file: string, message: string): CommitOutcome {
  const repo = repoFor(file);
  if (repo === undefined) {
    return { committed: false, notice: "written, but not committed: this vault is not a git repository" };
  }
  const { root } = repo;

  const add = git(["-C", root, "add", "--", file]);
  if (!add.ok) {
    return { committed: false, notice: `written, but git add failed: ${firstLine(add.stderr, add.stdout)}` };
  }

  const commit = git(["-C", root, "commit", "--quiet", "-m", message, "--", file]);
  if (!commit.ok) {
    return { committed: false, notice: `written, but git commit failed: ${firstLine(commit.stderr, commit.stdout)}` };
  }
  return { committed: true, notice: "" };
}

/**
 * The separators `readerFor` splits the log on: ASCII unit and record
 * separators. A commit body carries newlines and blank lines of its own, and
 * any printable delimiter could appear inside a message pablo did not write.
 */
const FIELD = "\u001f";
const RECORD = "\u001e";

/** A `GitReader` over the real repository the file lives in (AC4). */
export function readerFor(file: string): GitReader {
  const repo = repoFor(file);
  const root = repo?.root;
  const path = repo?.path;

  let entries: CommitEntry[] | undefined;
  const shown = new Map<string, string | undefined>();

  return {
    log(): readonly CommitEntry[] {
      if (entries !== undefined) return entries;
      if (root === undefined || path === undefined) {
        entries = [];
        return entries;
      }
      const run = git(["-C", root, "log", `--format=%H${FIELD}%B${RECORD}`, "--", path]);
      entries = !run.ok
        ? []
        : run.stdout
            .split(RECORD)
            .map((record) => record.trim())
            .filter((record) => record.length > 0)
            .flatMap((record) => {
              const at = record.indexOf(FIELD);
              if (at === -1) return [];
              return [{ sha: record.slice(0, at).trim(), message: record.slice(at + 1) }];
            });
      return entries;
    },

    show(ref: string): string | undefined {
      if (root === undefined || path === undefined) return undefined;
      if (shown.has(ref)) return shown.get(ref);
      const run = git(["-C", root, "show", `${ref}:${path}`]);
      const content = run.ok ? run.stdout : undefined;
      shown.set(ref, content);
      return content;
    },
  };
}
