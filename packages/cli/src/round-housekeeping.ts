/**
 * Round housekeeping (AGT-1588): once a round's review is pulled into the vault (`notes pull`, AGT-1587) the round is
 * over. Its PR is closed (never merged: the chapters are already in the vault) with a short comment, both `round/`
 * branches are deleted from the reading repo, and the vault's record moves to state `pulled`. Design:
 * `pm project show ai-terminal --doc readers` ("What Matt does").
 *
 * Every `gh` call goes through the injected `Runner` (share.ts). Each step is safe to repeat: a PR that is already
 * closed and a branch that is already gone count as done, so a half-finished close is simply retried by the next
 * `notes pull`; the record only becomes `pulled` once everything is done.
 */

import { markRoundClosed, READING_ORG } from "./share";
import type { RoundRecord, Runner, RunResult } from "./share";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** What closing a round did. */
export type CloseOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

const describe = (r: RunResult): string => (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split("\n").slice(0, 3).join(" / ");

/** A `gh` answer that means the thing is already as wanted (already closed, branch already gone). */
const alreadyDone = (r: RunResult): boolean => /already closed|reference does not exist|not found|HTTP 404|HTTP 422/i.test(`${r.stderr}\n${r.stdout}`);

/**
 * Closes the round's PR with a comment, deletes `round/<id>` and `round/<id>-base` from the reading repo, and marks the
 * vault record `pulled`. The branch names are rebuilt from the round id and the repo from the project, never taken from
 * the record, so a damaged record cannot aim a delete at another ref or repo. Never throws.
 */
export function closeRound(options: { readonly vaultRoot: string; readonly round: RoundRecord; readonly run: Runner }): CloseOutcome {
  const { round, run } = options;
  if (typeof round.id !== "string" || !SLUG.test(round.id) || typeof round.project !== "string" || !SLUG.test(round.project)) {
    return { ok: false, message: "the round record has no usable id or project" };
  }
  if (!Number.isInteger(round.pr) || round.pr < 1) return { ok: false, message: "the round record has no PR number" };
  const repo = `${READING_ORG}/${round.project}-reading`;
  if (round.repo !== repo) return { ok: false, message: `the round record names ${JSON.stringify(round.repo)}, not ${repo}` };

  const closed = run("gh", ["pr", "close", String(round.pr), "--repo", repo, "--comment", `Notes pulled into the vault; closing this round (${round.id}). Thank you.`]);
  if (closed.code !== 0 && !alreadyDone(closed)) return { ok: false, message: `cannot close ${repo}#${round.pr} (${describe(closed)})` };

  for (const branch of [`round/${round.id}`, `round/${round.id}-base`]) {
    const deleted = run("gh", ["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${branch}`]);
    if (deleted.code !== 0 && !alreadyDone(deleted)) return { ok: false, message: `closed ${repo}#${round.pr} but cannot delete ${branch} (${describe(deleted)})` };
  }
  if (!markRoundClosed(options.vaultRoot, round.id)) return { ok: false, message: `closed ${repo}#${round.pr} but cannot update the round record` };
  return { ok: true };
}
