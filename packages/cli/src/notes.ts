/**
 * `pablo notes pull` (AGT-1587) — a reader's submitted review becomes a branch in the vault that Matt reviews like any
 * other change. Design: `pm project show ai-terminal --doc readers` ("What Matt does").
 *
 * For every recorded round of the work (`RoundRecord`, AGT-1582) that has not been pulled yet:
 *
 *  1. read the PR's reviews and review comments through the GitHub API (`gh api`, via the injected `Runner`) and keep
 *     the reader's submitted ones (a round with none is still waiting);
 *  2. check that the reading repo's chapters, at the commit the review was made on, are byte for byte the vault's
 *     chapters at the round's recorded commit: the review's line numbers are only meaningful against that text;
 *  3. map the review back to marks (core `parseReview`, AGT-1584's inverse) and refuse the round if any mark names a
 *     file that is not one of the round's recorded chapters;
 *  4. create `reader/<round id>` from the round's vault commit and make one commit per suggestion, authored as the
 *     reader (name and email from pablo's validated reader config, never from GitHub), each replacing exactly the
 *     lines it covered (core `applySuggestions`, against the original line numbers);
 *  5. write every comment — line, multi-line, file, the summary — and every suggestion's note to the branch's comment
 *     store (AGT-1580) with `source: "reader"`, line numbers moved to where those lines sit on the branch;
 *  6. mark the round pulled in its record, so running pull again does nothing.
 *
 * A review with no suggestion to take (comments only, or every suggestion kept as a comment) still gets one empty
 * commit on the branch, authored as the reader ("notes from <name> on <chapters>"): without a commit `waitingBranches`
 * would not list the branch and the book rail would never show it.
 *
 * A round that fails part-way is undone (its branch and comments deleted) so a later pull can try again. After a
 * successful pull the round is closed (AGT-1588, `closeRound`): its PR closed, its `round/` branches deleted, its
 * record `pulled`. A close that fails is a notice, and the next `notes pull` retries it.
 */

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applySuggestions, parseReview } from "@openthink/pablo-core";
import type { GitHubReview, GitHubReviewComment, LineRange, ReaderConfig, ResolvedMark, ResolvedSuggestion } from "@openthink/pablo-core";
import { branchExists, commitAs, createBranch, deleteBranch, repoRoot } from "./branch";
import { commentsPath, readComments, writeComments } from "./comments";
import type { StoredComment } from "./comments";
import { insideDir } from "./review-finish";
import { closeRound } from "./round-housekeeping";
import { CHAPTER_PATH, READING_ORG, chaptersLabel, listRounds, markRoundPulled, } from "./share";
import type { RoundRecord, RunResult, Runner } from "./share";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** Review states that mean "submitted" (a PENDING review is still the reader's draft; a DISMISSED one was withdrawn). */
const SUBMITTED = new Set(["COMMENTED", "APPROVED", "CHANGES_REQUESTED"]);

type Env = Record<string, string | undefined>;

export interface NotesPullOptions {
  /** The vault root (where `.pablo/rounds/` is). */
  readonly vaultRoot: string;
  /** The work's directory (its comment store is `<projectPath>/.pablo/comments/`). */
  readonly projectPath: string;
  /** The work's marker slug: only this work's rounds are pulled. */
  readonly slug: string;
  /** pablo's config `readers` (validated by core's config loader): the only source of a commit's author. */
  readonly readers: ReadonlyMap<string, ReaderConfig>;
  readonly run: Runner;
  /** For `PABLO_HOME` (where the branch's worktree goes). Default: `process.env`. */
  readonly env?: Env;
  readonly now?: () => Date;
}

/** One round pulled into the vault. */
export interface PulledRound {
  readonly round: string;
  readonly branch: string;
  /** The commit of each suggestion, in order. */
  readonly commits: readonly string[];
  /** How many entries went to the comment store. */
  readonly comments: number;
  /** Whether the round's PR is closed and its `round/` branches deleted (AGT-1588); false: see the notices, the next pull retries. */
  readonly closed: boolean;
}

/** One round not pulled this time, and why. `waiting` is not a failure. */
export interface SkippedRound {
  readonly round: string;
  readonly reason: "pulled" | "waiting" | "refused" | "error";
  readonly message: string;
}

export interface NotesPullOutcome {
  /** 0 when nothing failed; 1 when any round hit an error; 2 when any round was refused (and none errored). */
  readonly code: 0 | 1 | 2;
  readonly pulled: readonly PulledRound[];
  readonly skipped: readonly SkippedRound[];
  /** Things that did not stop a round but the author should know (e.g. a suggestion kept as a comment). */
  readonly notices: readonly string[];
}

/** `<org>/<slug>-reading`, the only repos a round may name. */
export function readingRepoOf(project: string): string {
  return `${READING_ORG}/${project}-reading`;
}

/** The vault branch a round's review is pulled into. */
export function readerBranch(round: Pick<RoundRecord, "id">): string {
  return `reader/${round.id}`;
}

/**
 * Why a round record (local state, but still a file anyone could edit) cannot be pulled, or undefined when every
 * field this verb turns into a command, an API path, a branch or a file path has the shape `share` gave it.
 */
export function roundProblem(round: RoundRecord): string | undefined {
  if (typeof round.id !== "string" || !SLUG.test(round.id)) return "its id is not a plain name";
  if (typeof round.reader !== "string" || !SLUG.test(round.reader)) return "its reader is not a plain name";
  if (typeof round.project !== "string" || !SLUG.test(round.project)) return "its project is not a plain slug";
  if (round.repo !== readingRepoOf(round.project)) return `its repo is not ${readingRepoOf(round.project)}`;
  if (!Number.isInteger(round.pr) || round.pr < 1) return "its PR number is not a number";
  if (typeof round.vaultCommit !== "string" || !SHA.test(round.vaultCommit)) return "its vault commit is not a commit sha";
  if (typeof round.github !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(round.github)) return "its GitHub login is not a login";
  if (!Array.isArray(round.chapters) || round.chapters.length === 0) return "it records no chapters";
  for (const c of round.chapters) {
    if (typeof c?.path !== "string" || !CHAPTER_PATH.test(c.path) || c.path.split("/").some((s: string) => s === ".." || s === ".")) {
      return `it records ${JSON.stringify(c?.path)}, which is not a chapter path`;
    }
  }
  return undefined;
}

function describe(result: RunResult): string {
  return (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).split("\n").slice(0, 3).join(" / ");
}

/** `gh api <endpoint> --paginate --jq '.[]'`: every element of a paginated array, one JSON value per line. */
function ghList(run: Runner, endpoint: string): unknown[] | string {
  const result = run("gh", ["api", endpoint, "--paginate", "--jq", ".[]"]);
  if (result.code !== 0) return `gh api ${endpoint} failed (${describe(result)})`;
  const items: unknown[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      return `gh api ${endpoint} returned something that is not JSON`;
    }
  }
  return items;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const loginOf = (v: unknown): string | undefined => (isRecord(v) && isRecord(v["user"]) && typeof v["user"]["login"] === "string" ? v["user"]["login"] : undefined);
const sameLogin = (a: string | undefined, b: string): boolean => a !== undefined && a.toLowerCase() === b.toLowerCase();
const optNumber = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

/** A GitHub review comment narrowed to the fields `parseReview` reads, or undefined when it is not one. */
function reviewCommentOf(raw: Record<string, unknown>): GitHubReviewComment | undefined {
  if (typeof raw["path"] !== "string" || typeof raw["body"] !== "string") return undefined;
  return {
    path: raw["path"],
    body: raw["body"],
    line: optNumber(raw["line"]),
    start_line: optNumber(raw["start_line"]),
    original_line: optNumber(raw["original_line"]),
    original_start_line: optNumber(raw["original_start_line"]),
    subject_type: typeof raw["subject_type"] === "string" ? raw["subject_type"] : null,
    in_reply_to_id: optNumber(raw["in_reply_to_id"]),
  };
}

type Fetched = { ok: true; review: GitHubReview; reviews: number[]; commit: string } | { ok: false; waiting: boolean; message: string };

/** The reader's submitted review(s) on the round's PR, joined into one review: bodies (the summary) and comments. */
function fetchReview(run: Runner, round: RoundRecord): Fetched {
  const base = `repos/${round.repo}/pulls/${round.pr}`;
  const listed = ghList(run, `${base}/reviews`);
  if (typeof listed === "string") return { ok: false, waiting: false, message: listed };
  const mine = listed.filter(isRecord).filter((r) => sameLogin(loginOf(r), round.github) && typeof r["state"] === "string" && SUBMITTED.has(r["state"]));
  if (mine.length === 0) return { ok: false, waiting: true, message: `no submitted review from ${round.github} yet` };

  const ids: number[] = [];
  const commits = new Set<string>();
  const bodies: string[] = [];
  for (const r of mine) {
    const id = optNumber(r["id"]);
    if (id === null) return { ok: false, waiting: false, message: "a review has no id" };
    if (typeof r["commit_id"] !== "string" || !SHA.test(r["commit_id"])) return { ok: false, waiting: false, message: `review ${id} has no commit` };
    ids.push(id);
    commits.add(r["commit_id"]);
    if (typeof r["body"] === "string" && r["body"].trim() !== "") bodies.push(r["body"]);
  }
  // Line numbers are only comparable when every review was made on the same commit of the round.
  if (commits.size !== 1) return { ok: false, waiting: false, message: `${round.github}'s reviews were made on different commits of the round` };

  const all = ghList(run, `${base}/comments`);
  if (typeof all === "string") return { ok: false, waiting: false, message: all };
  const comments: GitHubReviewComment[] = [];
  for (const raw of all.filter(isRecord)) {
    // Only the reader's own comments on their submitted reviews: not Matt's replies, not anyone else's.
    if (!sameLogin(loginOf(raw), round.github) || !ids.includes(optNumber(raw["pull_request_review_id"]) ?? -1)) continue;
    const comment = reviewCommentOf(raw);
    if (comment === undefined) return { ok: false, waiting: false, message: "a review comment has no path or body" };
    comments.push(comment);
  }
  return { ok: true, review: { body: bodies.join("\n\n"), comments }, reviews: ids, commit: [...commits][0] as string };
}

/** The reading repo's file at `commit`, through the contents API, or a message. */
function readingFile(run: Runner, repo: string, path: string, commit: string): string | { message: string } {
  const endpoint = `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${commit}`;
  const result = run("gh", ["api", endpoint]);
  if (result.code !== 0) return { message: `cannot read ${path} at ${commit.slice(0, 7)} on ${repo} (${describe(result)})` };
  try {
    const parsed = JSON.parse(result.stdout) as { content?: unknown; encoding?: unknown };
    if (parsed.encoding !== "base64" || typeof parsed.content !== "string") return { message: `${repo} did not return ${path} as base64` };
    return Buffer.from(parsed.content.replace(/\s/g, ""), "base64").toString("utf8");
  } catch {
    return { message: `${repo} returned something that is not JSON for ${path}` };
  }
}

/** Where original line `line` of a file sits once `applied` (original coordinates, non-overlapping) are taken. */
export function movedLine(line: number, applied: readonly Pick<ResolvedSuggestion, "lines" | "replacement">[]): number {
  let delta = 0;
  for (const s of [...applied].sort((a, b) => a.lines.start - b.lines.start)) {
    const size = s.lines.end - s.lines.start + 1;
    if (s.lines.end < line) {
      delta += s.replacement.length - size;
      continue;
    }
    if (s.lines.start <= line) {
      // Inside a replaced range: the same offset into the replacement, or its last line; a deletion, the line before.
      const start = s.lines.start + delta;
      if (s.replacement.length === 0) return Math.max(1, start - 1);
      return start + Math.min(line - s.lines.start, s.replacement.length - 1);
    }
    break;
  }
  return line + delta;
}

/** A range of original lines moved the same way. */
export function movedRange(lines: LineRange, applied: readonly Pick<ResolvedSuggestion, "lines" | "replacement">[]): LineRange {
  const start = movedLine(lines.start, applied);
  const end = movedLine(lines.end, applied);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

/** The lines a taken suggestion's replacement occupies on the branch (for a deletion, the line before it). */
export function replacedRange(s: Pick<ResolvedSuggestion, "lines" | "replacement">, applied: readonly Pick<ResolvedSuggestion, "lines" | "replacement">[]): LineRange {
  const start = movedLine(s.lines.start, applied);
  return { start, end: start + Math.max(0, s.replacement.length - 1) };
}

/** Commit messages are argv: no NUL, and a note is kept to a readable size. */
const clean = (text: string): string => text.replace(/\0/g, "").trim().slice(0, 2000);

const where = (lines: LineRange): string => (lines.start === lines.end ? `line ${lines.start}` : `lines ${lines.start}-${lines.end}`);

/** Where the store wants a comment: one line, or a span. */
const placed = (lines: LineRange): { line: number; startLine?: number } => (lines.start === lines.end ? { line: lines.end } : { line: lines.end, startLine: lines.start });

type RoundResult = { ok: true; pulled: PulledRound; notices: string[] } | { ok: false; reason: SkippedRound["reason"]; message: string };

function pullRound(options: NotesPullOptions, repo: string, round: RoundRecord): RoundResult {
  const { run } = options;
  const env = options.env ?? process.env;
  const refuse = (message: string): RoundResult => ({ ok: false, reason: "refused", message });
  const error = (message: string): RoundResult => ({ ok: false, reason: "error", message });

  const problem = roundProblem(round);
  if (problem !== undefined) return refuse(`the round record cannot be used: ${problem}`);
  const reader = options.readers.get(round.reader);
  if (reader === undefined) return refuse(`reader "${round.reader}" is not in pablo's config "readers"; their suggestions need a name and email to be authored as`);
  if (reader.github.toLowerCase() !== round.github.toLowerCase()) {
    return refuse(`the round was shared with ${round.github}, but pablo's config names ${reader.github} as reader "${round.reader}"`);
  }
  const branch = readerBranch(round);
  if (branchExists(repo, branch)) return refuse(`${branch} already exists in the vault but the round is not marked pulled; delete the branch to pull again`);

  const fetched = fetchReview(run, round);
  if (!fetched.ok) return fetched.waiting ? { ok: false, reason: "waiting", message: fetched.message } : error(fetched.message);

  // The chapters as the round recorded them: path -> text at the vault commit.
  const chapters = new Map<string, string>();
  for (const { path } of round.chapters) {
    const blob = run("git", ["show", `${round.vaultCommit}:${path}`], { cwd: repo });
    if (blob.code !== 0) return error(`cannot read ${path} at the round's vault commit ${round.vaultCommit.slice(0, 7)} (${describe(blob)})`);
    chapters.set(path, blob.stdout);
  }

  let marks: readonly ResolvedMark[];
  let summary: string;
  try {
    ({ marks, summary } = parseReview(fetched.review));
  } catch (e) {
    return refuse(`the review cannot be read: ${(e as Error).message}`);
  }
  // Every path is external input: it must be one of the round's recorded chapters, exactly.
  for (const mark of marks) {
    if (!chapters.has(mark.path)) return refuse(`the review comments on ${JSON.stringify(mark.path.slice(0, 200))}, which is not a chapter of this round`);
  }
  // The review's line numbers are lines of the reading repo's file at the review's commit: it must be the vault's text.
  for (const path of new Set(marks.filter((m) => m.kind !== "chapter").map((m) => m.path))) {
    const remote = readingFile(run, round.repo, path, fetched.commit);
    if (typeof remote !== "string") return error(remote.message);
    if (remote !== chapters.get(path)) return refuse(`${path} on ${round.repo} at ${fetched.commit.slice(0, 7)} is not the text the round shared; its line numbers cannot be trusted`);
  }

  // Which suggestions can be taken: each against the original lines, none overlapping an earlier one.
  const notices: string[] = [];
  const applied = new Map<string, ResolvedSuggestion[]>();
  const kept: { mark: ResolvedSuggestion; why: string }[] = [];
  const order: ResolvedSuggestion[] = [];
  for (const mark of marks) {
    if (mark.kind !== "suggestion") continue;
    const before = applied.get(mark.path) ?? [];
    try {
      applySuggestions(chapters.get(mark.path) as string, [...before, mark]);
    } catch (e) {
      kept.push({ mark, why: (e as Error).message.replace(/^pablo: /, "") });
      notices.push(`pablo: notes pull: ${round.id}: a suggestion on ${mark.path} ${where(mark.lines)} was not applied (${(e as Error).message.replace(/^pablo: /, "")}); kept as a comment`);
      continue;
    }
    applied.set(mark.path, [...before, mark]);
    order.push(mark);
  }

  const made = createBranch(repo, options.slug, branch, env, round.vaultCommit);
  if (!made.ok) return error(made.notice);
  const worktree = made.path as string;
  const undo = (message: string): RoundResult => {
    deleteBranch(repo, options.slug, branch, { force: true, env });
    rmSync(commentsPath(options.projectPath, branch), { force: true });
    return error(message);
  };

  // One commit per suggestion, in the order the reader made them; each file's text is the original with every
  // suggestion so far taken, so the line numbers never drift.
  const commits: string[] = [];
  const taken = new Map<string, ResolvedSuggestion[]>();
  for (const s of order) {
    const file = insideDir(worktree, s.path);
    if (file === undefined) return undo(`${s.path} is not a file inside the vault`);
    const sofar = [...(taken.get(s.path) ?? []), s];
    taken.set(s.path, sofar);
    writeFileSync(file, applySuggestions(chapters.get(s.path) as string, sofar), "utf8");
    const note = s.note ? `\n\n${clean(s.note)}` : "";
    const tag = s.tag ? ` [${s.tag}]` : "";
    const committed = commitAs(worktree, {
      message: `Reader suggestion from ${reader.name}${tag}: ${s.path} ${where(s.lines)}${note}\n\nRound: ${round.id} (${round.repo}#${round.pr})`,
      author: { name: reader.name, email: reader.email },
      paths: [s.path],
    });
    if (!committed.ok) return undo(committed.notice);
    commits.push(committed.sha as string);
  }
  if (order.length === 0) {
    // Nothing to take, but the review is still something to look at: one empty commit makes the branch reviewable.
    const committed = commitAs(worktree, {
      message: `notes from ${reader.name} on ${chaptersLabel(round.chapters.map((c) => c.number))}\n\nRound: ${round.id} (${round.repo}#${round.pr})`,
      author: { name: reader.name, email: reader.email },
      allowEmpty: true,
    });
    if (!committed.ok) return undo(committed.notice);
    // Not a suggestion's commit: `commits` counts suggestions, and this one carries none.
  }

  // The comments, at the lines they sit on in the branch's text.
  const by = (path: string) => applied.get(path) ?? [];
  const entries: StoredComment[] = [];
  const author = reader.name;
  if (summary.trim() !== "") entries.push({ source: "reader", path: "", review: true, author, body: summary });
  for (const mark of marks) {
    const tag = mark.tag === undefined ? {} : { tag: mark.tag };
    if (mark.kind === "chapter") {
      entries.push({ source: "reader", ...tag, path: mark.path, author, body: mark.body });
    } else if (mark.kind === "comment") {
      const text = chapters.get(mark.path) as string;
      const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      if (mark.lines.start < 1 || mark.lines.end > lines || mark.lines.start > mark.lines.end) {
        // A line the chapter does not have: kept on the file, not dropped.
        entries.push({ source: "reader", ...tag, path: mark.path, author, body: mark.body });
        notices.push(`pablo: notes pull: ${round.id}: a comment on ${mark.path} ${where(mark.lines)} is outside the chapter; kept on the file`);
      } else {
        entries.push({ source: "reader", ...tag, path: mark.path, ...placed(movedRange(mark.lines, by(mark.path))), author, body: mark.body });
      }
    } else if (order.includes(mark)) {
      // A taken suggestion's note sits on the lines that replaced the old ones.
      if (mark.note || mark.tag) entries.push({ source: "reader", ...tag, path: mark.path, ...placed(replacedRange(mark, by(mark.path))), author, body: mark.note ?? "" });
    } else {
      const why = kept.find((k) => k.mark === mark)?.why ?? "not applied";
      const text = `Suggested (not applied: ${why}):\n${mark.replacement.map((l) => `> ${l}`).join("\n") || "> (delete these lines)"}`;
      const body = mark.note ? `${mark.note}\n\n${text}` : text;
      entries.push({ source: "reader", ...tag, path: mark.path, author, body });
    }
  }
  try {
    writeComments(options.projectPath, branch, [...readComments(options.projectPath, branch), ...entries]);
  } catch (e) {
    return undo(`cannot write the comments (${(e as Error).message})`);
  }

  const at = (options.now ?? (() => new Date()))().toISOString();
  if (!markRoundPulled(options.vaultRoot, round.id, { branch, reviews: fetched.reviews, at })) return undo(`cannot mark round ${round.id} pulled`);
  const closed = closeRound({ vaultRoot: options.vaultRoot, round, run });
  if (!closed.ok) notices.push(`pablo: notes pull: ${round.id}: pulled into ${branch}, but the round is not closed yet (${closed.message}); the next pull retries`);
  return { ok: true, pulled: { round: round.id, branch, commits, comments: entries.length, closed: closed.ok }, notices };
}

/**
 * Pulls every submitted, not-yet-pulled reader review of the work's rounds into `reader/<round id>` branches. A round
 * already pulled is skipped without a single API call; a round with no submitted review is reported as waiting.
 */
export function notesPull(options: NotesPullOptions): NotesPullOutcome {
  const repo = repoRoot(options.projectPath);
  if (repo === undefined) {
    return { code: 2, pulled: [], skipped: [{ round: "", reason: "refused", message: `pablo: notes pull: ${options.projectPath} is not inside a git repository` }], notices: [] };
  }
  const pulled: PulledRound[] = [];
  const skipped: SkippedRound[] = [];
  const notices: string[] = [];
  for (const round of listRounds(options.vaultRoot).filter((r) => r.project === options.slug)) {
    const id = typeof round.id === "string" ? round.id : "?";
    if (round.pulled !== undefined) {
      if (round.state !== "pulled") {
        // Pulled earlier, but the close did not finish: retry it (and nothing else).
        const closed = closeRound({ vaultRoot: options.vaultRoot, round, run: options.run });
        if (!closed.ok) notices.push(`pablo: notes pull: ${id}: the round is still not closed (${closed.message})`);
        else notices.push(`pablo: notes pull: ${id}: closed the round's PR and deleted its round/ branches`);
      }
      skipped.push({ round: id, reason: "pulled", message: `pablo: notes pull: ${id} was already pulled into ${round.pulled.branch}` });
      continue;
    }
    const result = pullRound(options, repo, round);
    if (result.ok) {
      pulled.push(result.pulled);
      notices.push(...result.notices);
    } else {
      skipped.push({ round: id, reason: result.reason, message: `pablo: notes pull: ${id}: ${result.message}` });
    }
  }
  const code = skipped.some((s) => s.reason === "error") ? 1 : skipped.some((s) => s.reason === "refused") ? 2 : 0;
  return { code, pulled, skipped, notices };
}

/** Where a round stands: `open` (the reader has not submitted), `submitted` (waiting for `notes pull`), `pulled`. */
export type RoundStatus = "open" | "submitted" | "pulled";

export interface RoundListing {
  readonly id: string;
  readonly reader: string;
  readonly chapters: readonly number[];
  readonly pr: number;
  readonly prUrl: string;
  readonly status: RoundStatus;
  /** For `pulled`: whether the PR is closed and the branches are gone; else undefined. */
  readonly closed?: boolean;
  readonly createdAt: string;
}

export type RoundListOutcome = { readonly ok: true; readonly rounds: readonly RoundListing[]; readonly notices: readonly string[] };

/**
 * `pablo share --list` (AGT-1588): the work's rounds with where each stands. A pulled round is known from its record
 * (no API call); any other is asked of GitHub: a submitted review from its reader means `submitted`. When GitHub cannot
 * be asked the round is listed as `open` with a notice.
 */
export function listRoundStatus(options: { readonly vaultRoot: string; readonly slug: string; readonly run: Runner }): RoundListOutcome {
  const notices: string[] = [];
  const rounds: RoundListing[] = [];
  for (const round of listRounds(options.vaultRoot).filter((r) => r.project === options.slug)) {
    const base = { id: round.id, reader: round.reader, chapters: (round.chapters ?? []).map((c) => c.number), pr: round.pr, prUrl: round.prUrl, createdAt: round.createdAt };
    if (round.pulled !== undefined || round.state === "pulled") {
      rounds.push({ ...base, status: "pulled", closed: round.state === "pulled" });
      continue;
    }
    let status: RoundStatus = "open";
    const problem = roundProblem(round);
    if (problem !== undefined) notices.push(`pablo: share --list: ${round.id}: the round record cannot be used (${problem})`);
    else {
      const reviews = ghList(options.run, `repos/${round.repo}/pulls/${round.pr}/reviews`);
      if (typeof reviews === "string") notices.push(`pablo: share --list: ${round.id}: ${reviews}`);
      else if (reviews.filter(isRecord).some((r) => sameLogin(loginOf(r), round.github) && typeof r["state"] === "string" && SUBMITTED.has(r["state"]))) status = "submitted";
    }
    rounds.push({ ...base, status });
  }
  return { ok: true, rounds, notices };
}
