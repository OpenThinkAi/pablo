/**
 * The reader's Submit (AGT-1585): the marks a reader made on a round, posted as
 * ONE GitHub pull-request review pinned to the commit they read. Design:
 * `pm project show ai-terminal --doc readers` ("How it maps to GitHub").
 *
 * Transport (decided here; the reason is GitHub's API, not taste). The mapping
 * (`toReviewPayload`, core) yields line/range comments and file-level comments
 * (the chapter comments). REST's create-review `comments[]` rejects
 * `subject_type: "file"`, and the single-comment REST endpoint would post each
 * file comment outside the review. So:
 *
 *  - No chapter comments: ONE call, `POST /repos/{o}/{r}/pulls/{n}/reviews`
 *    with `event: "COMMENT"`, `commit_id`, `body` and every line comment.
 *  - With chapter comments: the same POST WITHOUT `event` (GitHub keeps the
 *    review PENDING); each file comment is added to that pending review through
 *    GraphQL `addPullRequestReviewThread(subjectType: FILE)`; then
 *    `POST …/reviews/{id}/events` with `event: "COMMENT"` submits it. To Matt it
 *    is one review either way, and nothing is visible to him until the submit.
 *  - A failure after the pending review exists deletes it (`DELETE …/reviews/{id}`),
 *    so nothing is half-posted; if that clean-up fails too, the message says so.
 *
 * Local state, in `dir` (the reader's round cache; AGT-1583 shares it):
 * `<id>.marks.json` is written BEFORE anything is posted, so a failure (or a
 * crash) never loses the marks; `<id>.sent.json` is written after the review is
 * submitted and makes a second submit for the round refuse. (A crash in the
 * instant between GitHub accepting the submit and that write is the one case
 * the record cannot see.)
 *
 * Every `gh` call is an argument array plus a JSON body on stdin, handed to the
 * injected `Runner` (share.ts); tests assert the exact bodies with a fake.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { partitionComments, toReviewPayload } from "@openthink/pablo-core";
import type { Chapters, ReviewDraft } from "@openthink/pablo-core";
import type { RunResult, Runner } from "./share";

/** What Submit needs to know of a round (a subset of `RoundRecord`, plus the commit the reader fetched). */
export interface SubmitRound {
  /** `<reader>-<date>`: names the local files. */
  readonly id: string;
  /** `<org>/<repo>`. */
  readonly repo: string;
  readonly pr: number;
  /** The PR head commit the reader read (full 40-hex sha): the review is pinned to it. */
  readonly commit: string;
}

export interface SubmitOptions {
  readonly round: SubmitRound;
  /** Each chapter's stored text at `round.commit`, by path (the mapping needs it to resolve selections to lines). */
  readonly chapters: Chapters;
  readonly draft: ReviewDraft;
  /** Where the round's local files live. */
  readonly dir: string;
  readonly run: Runner;
  readonly now?: () => Date;
}

export interface SentRecord {
  readonly id: string;
  readonly repo: string;
  readonly pr: number;
  readonly commit: string;
  readonly reviewId: number;
  readonly reviewUrl: string;
  readonly sentAt: string;
}

export type SubmitOutcome =
  | { readonly ok: true; readonly sent: SentRecord }
  | { readonly ok: false; readonly code: 1 | 2; readonly message: string };

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const ROUND_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `$XDG_STATE_HOME/pablo/rounds` (default `~/.local/state/pablo/rounds`): the reader's round cache. */
export function readerRoundsDir(env: Record<string, string | undefined> = process.env): string {
  const state = env.XDG_STATE_HOME && env.XDG_STATE_HOME !== "" ? env.XDG_STATE_HOME : join(homedir(), ".local", "state");
  return join(state, "pablo", "rounds");
}

export const marksPath = (dir: string, id: string): string => join(dir, `${id}.marks.json`);
export const sentPath = (dir: string, id: string): string => join(dir, `${id}.sent.json`);

/** The round's sent record, or undefined when it has not been submitted. */
export function readSent(dir: string, id: string): SentRecord | undefined {
  if (!ROUND_ID.test(id)) return undefined;
  try {
    return JSON.parse(readFileSync(sentPath(dir, id), "utf8")) as SentRecord;
  } catch {
    return undefined;
  }
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

const refuse = (message: string): SubmitOutcome => ({ ok: false, code: 2, message });
const fail = (message: string): SubmitOutcome => ({ ok: false, code: 1, message });

/** A plain-language reason for a failed `gh` call. */
export function explain(result: RunResult): string {
  const raw = (result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`).split("\n").slice(0, 3).join(" / ");
  const http = /HTTP (\d{3})/.exec(raw)?.[1];
  if (http === "401" || /gh auth login|authentication/i.test(raw)) return `GitHub did not accept your login; run "gh auth login" and submit again (${raw})`;
  if (http === "403" || http === "404") return `GitHub says you cannot review this round; check you still have access to the reading repo (${raw})`;
  if (http === "422") return `GitHub rejected part of the review, a comment on a line it cannot find or a review that is already submitted (${raw})`;
  if (/could not resolve host|timeout|timed out|connection|network|dial tcp/i.test(raw)) return `could not reach GitHub; check your connection (${raw})`;
  return raw;
}

const json = (value: unknown): string => JSON.stringify(value);

const ADD_THREAD = `mutation($input: AddPullRequestReviewThreadInput!) {
  addPullRequestReviewThread(input: $input) { thread { id } }
}`;

/**
 * Posts the round's marks as one review (see the file comment). Refuses a round already sent, a round
 * with nothing to send, and marks that do not map onto the chapters; any failure leaves the marks in
 * `<dir>/<id>.marks.json` and reports why in plain words.
 */
export function submitReview(options: SubmitOptions): SubmitOutcome {
  const { round, dir, run } = options;
  if (!ROUND_ID.test(round.id)) return refuse(`pablo: submit: "${round.id}" is not a round id`);
  if (!REPO.test(round.repo) || !Number.isInteger(round.pr) || round.pr < 1) {
    return refuse(`pablo: submit: the round names ${round.repo}#${round.pr}, which is not a pull request`);
  }
  if (!SHA.test(round.commit)) return refuse("pablo: submit: the round has no pinned commit (a full 40-character sha) to review");

  const already = readSent(dir, round.id);
  if (already !== undefined || existsSync(sentPath(dir, round.id))) {
    return refuse(`pablo: submit: round ${round.id} was already sent${already ? ` (${already.reviewUrl})` : ""}; one round is one review`);
  }

  // The marks reach disk first: nothing below can lose them.
  mkdirSync(dir, { recursive: true });
  writeAtomic(marksPath(dir, round.id), `${JSON.stringify(options.draft, null, 2)}\n`);

  let payload;
  try {
    payload = toReviewPayload(options.chapters, options.draft);
  } catch (error) {
    return refuse(`pablo: submit: your marks could not be placed on the chapters (${(error as Error).message}); they are saved, nothing was sent`);
  }
  if (payload.body.trim() === "" && payload.comments.length === 0) return refuse("pablo: submit: there is nothing to send; add a comment or a summary first");

  const { line, file } = partitionComments(payload);
  const where = `repos/${round.repo}/pulls/${round.pr}/reviews`;
  const gh = (args: string[], body: unknown): RunResult => run("gh", ["api", "-H", "Accept: application/vnd.github+json", ...args, "--input", "-"], { input: json(body) });
  const couldNot = (what: string, result: RunResult): SubmitOutcome =>
    fail(`pablo: submit: ${what}: ${explain(result)}. Your marks are saved; nothing was sent. Submit again when it is fixed.`);

  let created: RunResult;
  if (file.length === 0) {
    created = gh(["--method", "POST", where], { commit_id: round.commit, body: payload.body, event: "COMMENT", comments: line });
  } else {
    created = gh(["--method", "POST", where], { commit_id: round.commit, body: payload.body, comments: line });
  }
  if (created.code !== 0) return couldNot("GitHub did not accept the review", created);
  let review: { id?: unknown; node_id?: unknown; html_url?: unknown };
  try {
    review = JSON.parse(created.stdout) as typeof review;
  } catch {
    return fail("pablo: submit: GitHub answered, but not with a review I can read; check the PR before submitting again. Your marks are saved.");
  }
  if (typeof review.id !== "number" || typeof review.node_id !== "string") {
    return fail("pablo: submit: GitHub's answer had no review id; check the PR before submitting again. Your marks are saved.");
  }
  const reviewId = review.id;
  let reviewUrl = typeof review.html_url === "string" ? review.html_url : "";

  if (file.length > 0) {
    // Everything from here deletes the pending review on failure: nothing is left half-posted.
    const abandon = (what: string, result: RunResult): SubmitOutcome => {
      const removed = run("gh", ["api", "--method", "DELETE", `${where}/${reviewId}`]);
      const tail =
        removed.code === 0
          ? "Nothing was sent."
          : `The unsent draft review (#${reviewId}) could not be removed (${explain(removed)}); delete it on the PR's "Files changed" tab.`;
      return fail(`pablo: submit: ${what}: ${explain(result)}. Your marks are saved. ${tail}`);
    };
    for (const comment of file) {
      const threaded = gh(["graphql"], {
        query: ADD_THREAD,
        variables: { input: { pullRequestReviewId: review.node_id, path: comment.path, body: comment.body, subjectType: "FILE" } },
      });
      if (threaded.code !== 0) return abandon(`GitHub did not accept the note on ${comment.path}`, threaded);
      if (/"errors"\s*:/.test(threaded.stdout)) return abandon(`GitHub did not accept the note on ${comment.path}`, { ...threaded, stderr: threaded.stdout });
    }
    const submitted = gh(["--method", "POST", `${where}/${reviewId}/events`], { event: "COMMENT", body: payload.body });
    if (submitted.code !== 0) return abandon("GitHub did not accept the submit", submitted);
    try {
      const url = (JSON.parse(submitted.stdout) as { html_url?: unknown }).html_url;
      if (typeof url === "string") reviewUrl = url;
    } catch {
      // The submit succeeded; the URL is a nicety.
    }
  }

  const sent: SentRecord = {
    id: round.id,
    repo: round.repo,
    pr: round.pr,
    commit: round.commit,
    reviewId,
    reviewUrl,
    sentAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  try {
    writeAtomic(sentPath(dir, round.id), `${JSON.stringify(sent, null, 2)}\n`);
  } catch (error) {
    return fail(`pablo: submit: the review was sent (${reviewUrl}) but I could not record it here (${(error as Error).message}); do not submit again`);
  }
  return { ok: true, sent };
}
