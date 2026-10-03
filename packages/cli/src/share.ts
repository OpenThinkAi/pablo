/**
 * `pablo share` (AGT-1582) — opens a reading round: the chapters a reader is
 * to read, as a GitHub pull request on the book's private reading repo. Design:
 * `pm project show ai-terminal --doc readers` ("How it maps to GitHub", "What
 * Matt does").
 *
 * The reading repo holds `chapters/` files and nothing else, so the reader
 * never receives the bible, beats or notes. A round is two branches in it:
 *
 *  - `round/<reader>-<date>-base` — one empty commit, WITHOUT the shared chapters;
 *  - `round/<reader>-<date>` — that commit plus the shared chapters exactly as
 *    stored (one sentence per line) at the vault `main` commit the round
 *    records, under the same paths they have in the vault.
 *
 * The PR (head into base) therefore adds every line of every shared chapter,
 * which is what makes every sentence a commentable line on GitHub. The round is
 * then recorded in the vault at `<vault>/.pablo/rounds/<round-id>.json` (see
 * `RoundRecord`): the later tickets (`read`, `notes pull`, round housekeeping,
 * the tray) read it back with `readRound` / `listRounds`.
 *
 * Every `gh` and git call is an argument array handed to an injected `Runner`;
 * nothing here shells out any other way. Tests pass a fake `gh` and use local
 * bare repositories as the reading repo's remote (the `url` that
 * `gh repo view --json url` reports is where the branches are pushed).
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ReaderConfig } from "@openthink/pablo-core";

/** The GitHub org the reading repos live under (private; confirmed 2026-10-02). */
export const READING_ORG = "OpenThinkAi";

/** The only files that ever reach a reading repo: a work's chapter files, by their vault path. */
const CHAPTER_PATH = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*chapters\/[^/]+\.md$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROUND_ID = SLUG;
const GIT_IDENTITY = ["-c", "user.name=pablo", "-c", "user.email=pablo@users.noreply.github.com", "-c", "commit.gpgsign=false"];

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd?: string;
}

/**
 * Runs one external command with an argument array (never a shell string).
 * The one seam through which `share` reaches git and `gh`: production passes
 * `realRunner`, tests pass a fake that answers `gh` and runs `git` against
 * temp repositories.
 */
export type Runner = (command: "git" | "gh", args: readonly string[], options?: RunOptions) => RunResult;

/** The production runner: `Bun.spawnSync` with an argument array, stdin closed. */
export const realRunner: Runner = (command, args, options = {}) => {
  try {
    const result = Bun.spawnSync([command, ...args], { cwd: options.cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
  } catch (error) {
    return { code: 1, stdout: "", stderr: (error as Error).message };
  }
};

// ---------------------------------------------------------------------------
// The round record
// ---------------------------------------------------------------------------

export type RoundState = "open";

export interface RoundChapter {
  readonly number: number;
  /** The chapter's path in the vault (and in the reading repo), e.g. `novels/ice-house/chapters/03-the-saws.md`. */
  readonly path: string;
}

/** `<vault>/.pablo/rounds/<id>.json`: what a later verb needs to find the round again. */
export interface RoundRecord {
  /** `<reader>-<date>`; the file name, and the branch name without `round/`. */
  readonly id: string;
  /** The work's slug (the reading repo is `<org>/<project>-reading`). */
  readonly project: string;
  /** The reader's key in pablo's config `readers`. */
  readonly reader: string;
  /** The reader's GitHub login. */
  readonly github: string;
  /** The vault `main` commit the shared chapters were read at. `notes pull` builds from it. */
  readonly vaultCommit: string;
  readonly chapters: readonly RoundChapter[];
  /** `<org>/<project>-reading`. */
  readonly repo: string;
  readonly pr: number;
  readonly prUrl: string;
  /** `round/<id>-base` and `round/<id>`. */
  readonly base: string;
  readonly head: string;
  readonly state: RoundState;
  /** ISO timestamp. */
  readonly createdAt: string;
}

/** `<vault>/.pablo/rounds` — machine state, gitignored with the rest of `.pablo/`. */
export function roundsDir(vaultRoot: string): string {
  return join(vaultRoot, ".pablo", "rounds");
}

/** One round's record, or undefined when there is none (or it is unreadable). */
export function readRound(vaultRoot: string, id: string): RoundRecord | undefined {
  if (!ROUND_ID.test(id)) return undefined; // an id is a file name: never a path
  try {
    return JSON.parse(readFileSync(join(roundsDir(vaultRoot), `${id}.json`), "utf8")) as RoundRecord;
  } catch {
    return undefined;
  }
}

/** Every recorded round, oldest first by creation time. Unreadable records are skipped. */
export function listRounds(vaultRoot: string): RoundRecord[] {
  const dir = roundsDir(vaultRoot);
  if (!existsSync(dir)) return [];
  const rounds: RoundRecord[] = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    try {
      rounds.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as RoundRecord);
    } catch {
      // A damaged record is skipped, not fatal: the others are still rounds.
    }
  }
  return rounds.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---------------------------------------------------------------------------
// Chapter selection
// ---------------------------------------------------------------------------

/** `3` or `3-5` to [3] or [3, 4, 5]; undefined for anything else (or a backwards or huge range). */
export function parseChapterSpec(spec: string): number[] | undefined {
  const match = /^(\d+)(?:-(\d+))?$/.exec(spec.trim());
  if (!match) return undefined;
  const first = Number(match[1]);
  const last = match[2] === undefined ? first : Number(match[2]);
  if (first < 1 || last < first || last - first >= 100) return undefined;
  const numbers: number[] = [];
  for (let n = first; n <= last; n++) numbers.push(n);
  return numbers;
}

/** `chapter 3`, `chapters 3-5`, `chapters 1, 3-4`. */
export function chaptersLabel(numbers: readonly number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && (sorted[j + 1] as number) === (sorted[j] as number) + 1) j++;
    runs.push(j > i ? `${sorted[i]}-${sorted[j]}` : String(sorted[i]));
    i = j + 1;
  }
  return `${sorted.length === 1 ? "chapter" : "chapters"} ${runs.join(", ")}`;
}

// ---------------------------------------------------------------------------
// share
// ---------------------------------------------------------------------------

export interface ShareOptions {
  /** The vault root (where `.pablo/rounds/` goes). */
  readonly vaultRoot: string;
  /** The work's directory, inside the vault's git repository. */
  readonly projectPath: string;
  /** The work's marker slug and title. */
  readonly slug: string;
  readonly title: string;
  /** `--reader <name>`: a key of the config's `readers`. */
  readonly reader: string | undefined;
  /** `--chapters 3` or `3-5`. */
  readonly chapters: string | undefined;
  /** The config's `readers` map. */
  readonly readers: ReadonlyMap<string, ReaderConfig>;
  readonly run: Runner;
  readonly now?: () => Date;
  /** Where the throwaway reading-repo work tree is made. Default: the OS temp directory. */
  readonly tmpRoot?: string;
  /** Default: `OpenThinkAi`. */
  readonly org?: string;
}

export interface ShareSuccess {
  readonly ok: true;
  readonly code: 0;
  readonly round: RoundRecord;
  /** Where the record was written. */
  readonly recordPath: string;
  /** Things that did not stop the round but the author should know. */
  readonly notices: readonly string[];
}

export interface ShareFailure {
  readonly ok: false;
  /** 2 = refused (a precondition), 1 = error (git/gh failed). */
  readonly code: 1 | 2;
  readonly message: string;
}

export type ShareOutcome = ShareSuccess | ShareFailure;

function refuse(message: string): ShareFailure {
  return { ok: false, code: 2, message };
}

function fail(message: string): ShareFailure {
  return { ok: false, code: 1, message };
}

function describe(result: RunResult): string {
  return (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).split("\n").slice(0, 3).join(" / ");
}

function localDate(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The chapter files on the vault's `main`, by chapter number: `NN-<name>.md` under `<prefix>chapters/`.
 * `root` is the git work tree root: `ls-tree` paths and pathspecs are relative to the working directory. */
function chaptersOnMain(run: Runner, root: string, prefix: string): Map<number, string[]> | ShareFailure {
  const listed = run("git", ["ls-tree", "--name-only", "main", "--", `${prefix}chapters/`], { cwd: root });
  if (listed.code !== 0) return fail(`pablo: share: cannot list chapters on main (${describe(listed)})`);
  const byNumber = new Map<number, string[]>();
  for (const path of listed.stdout.split("\n").filter((line) => line !== "")) {
    const match = /^(\d{2,})-[^/]*\.md$/.exec(path.slice(`${prefix}chapters/`.length));
    if (!match) continue;
    const number = Number(match[1]);
    byNumber.set(number, [...(byNumber.get(number) ?? []), path]);
  }
  return byNumber;
}

/**
 * Opens a reading round: checks the chapters and the reader, makes sure the
 * book's private reading repo exists, pushes the round's base and head
 * branches, opens the PR with the reader as requested reviewer, and records the
 * round in the vault. Nothing is recorded until the PR exists; a failure after
 * the branches are pushed leaves them on the (private) reading repo and says so.
 */
export function shareRound(options: ShareOptions): ShareOutcome {
  const { run } = options;
  const org = options.org ?? READING_ORG;

  if (options.reader === undefined || options.reader === "") return refuse("pablo: share requires --reader <name>");
  if (options.chapters === undefined || options.chapters === "") return refuse("pablo: share requires --chapters <N|N-M>");
  const numbers = parseChapterSpec(options.chapters);
  if (numbers === undefined) {
    return refuse(`pablo: share: --chapters must be a chapter number or a range like 3-5 (got "${options.chapters}")`);
  }
  const reader = options.readers.get(options.reader);
  if (reader === undefined) {
    const known = [...options.readers.keys()];
    return refuse(
      `pablo: share: reader "${options.reader}" is not in pablo's config "readers"` +
        (known.length === 0 ? " (none are configured)" : ` (configured: ${known.join(", ")})`),
    );
  }
  if (!SLUG.test(options.slug)) return refuse(`pablo: share: the project slug "${options.slug}" cannot name a reading repo`);

  // The vault's git repository and where the work sits in it.
  const prefixResult = run("git", ["rev-parse", "--show-prefix"], { cwd: options.projectPath });
  if (prefixResult.code !== 0) return refuse(`pablo: share: ${options.projectPath} is not inside a git repository`);
  const prefix = prefixResult.stdout.trim();
  const rootResult = run("git", ["rev-parse", "--show-toplevel"], { cwd: options.projectPath });
  if (rootResult.code !== 0) return refuse(`pablo: share: ${options.projectPath} is not inside a git repository`);
  const gitRoot = rootResult.stdout.trim();
  const mainResult = run("git", ["rev-parse", "--verify", "main^{commit}"], { cwd: options.projectPath });
  if (mainResult.code !== 0) return refuse("pablo: share: the vault has no main branch to share from");
  const vaultCommit = mainResult.stdout.trim();

  // Every shared chapter must be on main, as committed there.
  const onMain = chaptersOnMain(run, gitRoot, prefix);
  if (!(onMain instanceof Map)) return onMain;
  const chapters: RoundChapter[] = [];
  for (const number of numbers) {
    const paths = onMain.get(number) ?? [];
    if (paths.length === 0) return refuse(`pablo: share: chapter ${number} is not on main (merge it before sharing)`);
    if (paths.length > 1) return refuse(`pablo: share: chapter ${number} matches more than one file on main (${paths.join(", ")})`);
    const path = paths[0] as string;
    if (!CHAPTER_PATH.test(path)) return refuse(`pablo: share: ${path} is not a chapter file; only chapters/ files are shared`);
    chapters.push({ number, path });
  }

  const now = (options.now ?? (() => new Date()))();
  const id = `${options.reader}-${localDate(now)}`;
  const head = `round/${id}`;
  const base = `${head}-base`;
  const repo = `${org}/${options.slug}-reading`;
  const recordPath = join(roundsDir(options.vaultRoot), `${id}.json`);
  if (existsSync(recordPath)) {
    return refuse(`pablo: share: round ${id} already exists (${recordPath}); one round per reader per day`);
  }

  // The chapters exactly as stored at that commit.
  const contents: { path: string; text: string }[] = [];
  for (const chapter of chapters) {
    const blob = run("git", ["show", `${vaultCommit}:${chapter.path}`], { cwd: gitRoot });
    if (blob.code !== 0) return fail(`pablo: share: cannot read ${chapter.path} at ${vaultCommit.slice(0, 7)} (${describe(blob)})`);
    contents.push({ path: chapter.path, text: blob.stdout });
  }

  // The private reading repo: use it, or create it on first use.
  let found = viewRepo(run, repo);
  if (!found.ok) {
    const created = run("gh", ["repo", "create", repo, "--private"]);
    if (created.code !== 0) return fail(`pablo: share: cannot create ${repo} (${describe(created)})`);
    found = viewRepo(run, repo);
    if (!found.ok) return fail(`pablo: share: created ${repo} but cannot read it back (${found.reason})`);
  }
  if (!found.isPrivate) return refuse(`pablo: share: ${repo} is not private; refusing to push chapters to it`);
  const url = found.url;

  const workRoot = mkdtempSync(join(options.tmpRoot ?? tmpdir(), "pablo-share-"));
  try {
    const gitIn = (args: readonly string[]): RunResult => run("git", [...GIT_IDENTITY, ...args], { cwd: workRoot });
    const taken = gitIn(["ls-remote", "--heads", url, `refs/heads/${head}`, `refs/heads/${base}`]);
    if (taken.code !== 0) return fail(`pablo: share: cannot reach ${repo} (${describe(taken)})`);
    if (taken.stdout.trim() !== "") return refuse(`pablo: share: ${repo} already has the branch ${head}; one round per reader per day`);

    for (const step of [
      ["init", "-q", "-b", base],
      ["commit", "-q", "--allow-empty", "-m", `Round base for ${options.reader}, without the shared chapters`],
      ["checkout", "-q", "-b", head],
    ]) {
      const done = gitIn(step);
      if (done.code !== 0) return fail(`pablo: share: git ${step[0]} failed (${describe(done)})`);
    }
    for (const { path, text } of contents) {
      // Defence in depth: the same pattern that picked the paths gates every write.
      if (!CHAPTER_PATH.test(path) || path.split("/").includes("..")) return fail(`pablo: share: refusing to stage ${path}`);
      mkdirSync(dirname(join(workRoot, path)), { recursive: true });
      writeFileSync(join(workRoot, path), text, "utf8");
    }
    for (const step of [
      ["add", "--", ...contents.map((c) => c.path)],
      ["commit", "-q", "-m", `${chaptersLabel(numbers)} for ${options.reader} (vault ${vaultCommit.slice(0, 12)})`],
      ["push", "-q", url, `refs/heads/${base}`, `refs/heads/${head}`],
    ]) {
      const done = gitIn(step);
      if (done.code !== 0) return fail(`pablo: share: git ${step[0]} failed (${describe(done)})`);
    }

    const label = chaptersLabel(numbers);
    const opened = run("gh", [
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      base,
      "--head",
      head,
      "--title",
      `${options.title}: ${label}`,
      "--body",
      `Reading round for ${reader.name}: ${label} of ${options.title}.`,
    ]);
    if (opened.code !== 0) {
      return fail(`pablo: share: pushed ${head} and ${base} to ${repo} but could not open the PR (${describe(opened)})`);
    }
    const prUrl = opened.stdout.trim().split("\n").pop()?.trim() ?? "";
    const prMatch = /\/pull\/(\d+)\s*$/.exec(prUrl);
    if (!prMatch) return fail(`pablo: share: opened a PR on ${repo} but cannot read its URL from "${prUrl}"`);
    const pr = Number(prMatch[1]);

    const notices: string[] = [];
    const requested = run("gh", ["pr", "edit", String(pr), "--repo", repo, "--add-reviewer", reader.github]);
    if (requested.code !== 0) {
      notices.push(
        `pablo: share: could not request ${reader.github} as reviewer (${describe(requested)}); ` +
          `they need access to ${repo}, then request the review on the PR`,
      );
    }

    const round: RoundRecord = {
      id,
      project: options.slug,
      reader: options.reader,
      github: reader.github,
      vaultCommit,
      chapters,
      repo,
      pr,
      prUrl,
      base,
      head,
      state: "open",
      createdAt: now.toISOString(),
    };
    mkdirSync(roundsDir(options.vaultRoot), { recursive: true });
    writeFileSync(recordPath, `${JSON.stringify(round, null, 2)}\n`, "utf8");
    return { ok: true, code: 0, round, recordPath, notices };
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
}

type RepoView = { ok: true; url: string; isPrivate: boolean } | { ok: false; reason: string };

/** `gh repo view <repo> --json url,isPrivate`: where to push, and whether it is private. */
function viewRepo(run: Runner, repo: string): RepoView {
  const result = run("gh", ["repo", "view", repo, "--json", "url,isPrivate"]);
  if (result.code !== 0) return { ok: false, reason: describe(result) };
  try {
    const parsed = JSON.parse(result.stdout) as { url?: unknown; isPrivate?: unknown };
    if (typeof parsed.url !== "string" || parsed.url === "") return { ok: false, reason: "no url in gh's answer" };
    return { ok: true, url: parsed.url, isPrivate: parsed.isPrivate === true };
  } catch {
    return { ok: false, reason: "gh's answer was not JSON" };
  }
}
