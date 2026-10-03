import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inParagraph } from "@openthink/pablo-core";
import type { ReviewDraft } from "@openthink/pablo-core";
import type { RunOptions, RunResult, Runner } from "../src/share";
import { explain, marksPath, readSent, readerRoundsDir, sentPath, submitReview } from "../src/submit";
import type { SubmitRound } from "../src/submit";

/**
 * AGT-1585: the reader's Submit. `gh` is a fake that records every call (args and stdin body) and
 * answers from a script; nothing reaches GitHub.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "pablo-submit-test-"));
  dirs.push(d);
  return d;
};

const PATH = "novels/ice-house/chapters/03-the-thaw.md";
const CHAPTER = "---\nchapter: 3\n---\n\nIce gave way by March.\nThe river rose.\n";
// File lines: 1 ---, 2 chapter, 3 ---, 4 blank, 5 "Ice gave way by March.", 6 "The river rose."
const SHA = "a".repeat(40);
const ROUND: SubmitRound = { id: "atara-2026-10-02", repo: "OpenThinkAi/ice-house-reading", pr: 7, commit: SHA };

const LINES_ONLY: ReviewDraft = {
  summary: "Loved it.",
  marks: [
    { kind: "comment", path: PATH, selection: inParagraph(0, 0, 4), tag: "keep", body: "the opening" },
    { kind: "suggestion", path: PATH, selection: inParagraph(0, 23, 38), replacement: "The river climbed." },
  ],
};
const WITH_FILE: ReviewDraft = { ...LINES_ONLY, marks: [...LINES_ONLY.marks, { kind: "chapter", path: PATH, tag: "fix", body: "slow middle" }] };

interface Call {
  command: string;
  args: readonly string[];
  body: unknown;
}

function fake(answers: (call: Call, n: number) => Partial<RunResult>): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = (command, args, options?: RunOptions) => {
    const call: Call = { command, args, body: options?.input === undefined ? undefined : JSON.parse(options.input) };
    calls.push(call);
    return { code: 0, stdout: "{}", stderr: "", ...answers(call, calls.length - 1) };
  };
  return { run, calls };
}

const REVIEW = JSON.stringify({ id: 99, node_id: "PRR_node", html_url: "https://github.com/OpenThinkAi/ice-house-reading/pull/7#pullrequestreview-99" });

function submit(draft: ReviewDraft, run: Runner, dir: string) {
  return submitReview({ round: ROUND, chapters: { [PATH]: CHAPTER }, draft, dir, run, now: () => new Date("2026-10-02T12:00:00Z") });
}

test("line comments only: ONE create-review call, event COMMENT, pinned commit, exact body", () => {
  const dir = tmp();
  const { run, calls } = fake(() => ({ stdout: REVIEW }));
  const out = submit(LINES_ONLY, run, dir);
  expect(out.ok).toBe(true);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.command).toBe("gh");
  expect(calls[0]?.args).toEqual(["api", "-H", "Accept: application/vnd.github+json", "--method", "POST", "repos/OpenThinkAi/ice-house-reading/pulls/7/reviews", "--input", "-"]);
  expect(calls[0]?.body).toEqual({
    commit_id: SHA,
    body: "Loved it.",
    event: "COMMENT",
    comments: [
      { path: PATH, line: 5, side: "RIGHT", body: "**[keep]** the opening" },
      { path: PATH, line: 6, side: "RIGHT", body: "```suggestion\nThe river climbed.\n```" },
    ],
  });
});

test("success records the round as sent, keeps the marks, and a second submit is refused", () => {
  const dir = tmp();
  const { run, calls } = fake(() => ({ stdout: REVIEW }));
  const out = submit(LINES_ONLY, run, dir);
  if (!out.ok) throw new Error(out.message);
  expect(out.sent).toEqual({
    id: ROUND.id,
    repo: ROUND.repo,
    pr: 7,
    commit: SHA,
    reviewId: 99,
    reviewUrl: "https://github.com/OpenThinkAi/ice-house-reading/pull/7#pullrequestreview-99",
    sentAt: "2026-10-02T12:00:00.000Z",
  });
  expect(readSent(dir, ROUND.id)).toEqual(out.sent);
  expect(JSON.parse(readFileSync(marksPath(dir, ROUND.id), "utf8"))).toEqual(LINES_ONLY);
  const again = submit(LINES_ONLY, run, dir);
  expect(again.ok).toBe(false);
  if (!again.ok) {
    expect(again.code).toBe(2);
    expect(again.message).toContain("already sent");
  }
  expect(calls).toHaveLength(1); // the refusal made no call
});

test("a chapter comment: pending review, GraphQL FILE thread on it, then submit; exact bodies", () => {
  const dir = tmp();
  const { run, calls } = fake((call) => {
    if (call.args.includes("graphql")) return { stdout: '{"data":{"addPullRequestReviewThread":{"thread":{"id":"T1"}}}}' };
    if (call.args.some((a) => a.endsWith("/events"))) return { stdout: JSON.stringify({ html_url: "https://github.com/x/y/pull/7#pullrequestreview-99" }) };
    return { stdout: REVIEW };
  });
  const out = submit(WITH_FILE, run, dir);
  expect(out.ok).toBe(true);
  expect(calls).toHaveLength(3);
  const base = ["api", "-H", "Accept: application/vnd.github+json"];
  // 1. pending review: no `event`, so GitHub keeps it pending; only line comments in comments[].
  expect(calls[0]?.args).toEqual([...base, "--method", "POST", "repos/OpenThinkAi/ice-house-reading/pulls/7/reviews", "--input", "-"]);
  expect(calls[0]?.body).toEqual({
    commit_id: SHA,
    body: "Loved it.",
    comments: [
      { path: PATH, line: 5, side: "RIGHT", body: "**[keep]** the opening" },
      { path: PATH, line: 6, side: "RIGHT", body: "```suggestion\nThe river climbed.\n```" },
    ],
  });
  expect(calls[0]?.body).not.toHaveProperty("event");
  // 2. the file-level comment as a GraphQL thread on that same pending review.
  expect(calls[1]?.args).toEqual([...base, "graphql", "--input", "-"]);
  const gql = calls[1]?.body as { query: string; variables: unknown };
  expect(gql.query).toContain("addPullRequestReviewThread");
  expect(gql.variables).toEqual({ input: { pullRequestReviewId: "PRR_node", path: PATH, body: "**[fix]** slow middle", subjectType: "FILE" } });
  // 3. submit it.
  expect(calls[2]?.args).toEqual([...base, "--method", "POST", "repos/OpenThinkAi/ice-house-reading/pulls/7/reviews/99/events", "--input", "-"]);
  expect(calls[2]?.body).toEqual({ event: "COMMENT", body: "Loved it." });
  expect(readSent(dir, ROUND.id)?.reviewUrl).toBe("https://github.com/x/y/pull/7#pullrequestreview-99");
});

test("a rejected line: marks stay saved, plain message, nothing recorded as sent", () => {
  const dir = tmp();
  const { run } = fake(() => ({ code: 1, stderr: "gh: Unprocessable Entity (HTTP 422)\n{line must be part of the diff}" }));
  const out = submit(LINES_ONLY, run, dir);
  expect(out.ok).toBe(false);
  if (!out.ok) {
    expect(out.code).toBe(1);
    expect(out.message).toContain("rejected part of the review");
    expect(out.message).toContain("saved");
    expect(out.message).toContain("nothing was sent");
  }
  expect(JSON.parse(readFileSync(marksPath(dir, ROUND.id), "utf8"))).toEqual(LINES_ONLY);
  expect(existsSync(sentPath(dir, ROUND.id))).toBe(false);
  // The reader can fix it and try again.
  const retry = fake(() => ({ stdout: REVIEW }));
  expect(submit(LINES_ONLY, retry.run, dir).ok).toBe(true);
});

test("a failed file thread deletes the pending review: nothing half-posted", () => {
  const dir = tmp();
  const { run, calls } = fake((call) => {
    if (call.args.includes("graphql")) return { code: 1, stderr: "HTTP 403" };
    return { stdout: REVIEW };
  });
  const out = submit(WITH_FILE, run, dir);
  expect(out.ok).toBe(false);
  if (!out.ok) expect(out.message).toContain("Nothing was sent.");
  expect(calls).toHaveLength(3);
  expect(calls[2]?.args).toEqual(["api", "--method", "DELETE", "repos/OpenThinkAi/ice-house-reading/pulls/7/reviews/99"]);
  expect(existsSync(sentPath(dir, ROUND.id))).toBe(false);
  expect(existsSync(marksPath(dir, ROUND.id))).toBe(true);
});

test("a GraphQL answer with errors counts as failure; a failed clean-up says so", () => {
  const dir = tmp();
  const { run } = fake((call) => {
    if (call.args.includes("graphql")) return { stdout: '{"errors":[{"message":"Could not resolve to a node"}]}' };
    if (call.args.includes("DELETE")) return { code: 1, stderr: "HTTP 500" };
    return { stdout: REVIEW };
  });
  const out = submit(WITH_FILE, run, dir);
  expect(out.ok).toBe(false);
  if (!out.ok) {
    expect(out.message).toContain("could not be removed");
    expect(out.message).toContain("#99");
  }
  expect(existsSync(sentPath(dir, ROUND.id))).toBe(false);
});

test("refusals make no gh call: unmappable marks, an empty round, a bad commit, a bad repo", () => {
  const dir = tmp();
  const { run, calls } = fake(() => ({ stdout: REVIEW }));
  const stray: ReviewDraft = { summary: "", marks: [{ kind: "chapter", path: "novels/other/chapters/01-x.md", body: "?" }] };
  const a = submit(stray, run, dir);
  expect(a.ok === false && a.message).toContain("not a chapter of this round");
  const b = submit({ summary: " ", marks: [] }, run, dir);
  expect(b.ok === false && b.message).toContain("nothing to send");
  const c = submitReview({ round: { ...ROUND, commit: "main" }, chapters: {}, draft: LINES_ONLY, dir, run });
  expect(c.ok === false && c.message).toContain("pinned commit");
  const d = submitReview({ round: { ...ROUND, repo: "a/b; rm -rf" }, chapters: {}, draft: LINES_ONLY, dir, run });
  expect(d.ok).toBe(false);
  expect(calls).toHaveLength(0);
});

test("explain gives plain reasons; readerRoundsDir follows XDG_STATE_HOME", () => {
  const res = (stderr: string): RunResult => ({ code: 1, stdout: "", stderr });
  expect(explain(res("HTTP 401: Bad credentials"))).toContain("gh auth login");
  expect(explain(res("HTTP 404: Not Found"))).toContain("cannot review");
  expect(explain(res("dial tcp: lookup api.github.com: no such host"))).toContain("connection");
  expect(readerRoundsDir({ XDG_STATE_HOME: "/s" })).toBe("/s/pablo/rounds");
});
