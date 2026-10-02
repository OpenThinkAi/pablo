/**
 * A compose session's plan branch (AGT-1557). Planning writes from one
 * session (facts, research notes, proposals) are reviewed together, so they
 * all commit to one `plan/<date>-<short-id>` branch, created from `main` by
 * the branch layer on the session's first write and authored as pablo.
 * Design: the `ai-terminal` pm doc `harness`, tools `record_fact`,
 * `research`, `propose`.
 *
 * The session holds no git state beyond its branch name and worktree path;
 * a git failure is a returned notice, as everywhere in the branch layer.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { type Author, type BranchResult, commitAs, createBranch } from "./branch";

type Env = Record<string, string | undefined>;

/** Planning commits are authored as pablo, never as the model that planned. */
export const PABLO_AUTHOR: Author = { name: "pablo", email: "pablo@localhost" };

export interface PlanSession {
  readonly repo: string;
  readonly slug: string;
  readonly env: Env;
  /** `plan/<date>-<short-id>`, fixed at session start; the branch exists only after the first write. */
  readonly branch: string;
  /** Set by the first planning write. */
  worktree?: string;
}

export interface PlanSessionOptions {
  env?: Env;
  /** The short id in the branch name; default is three random bytes in hex. Injectable for tests. */
  id?: string;
  /** The date in the branch name (YYYY-MM-DD); default today. */
  date?: string;
}

/** A session starts with a branch name and no branch: nothing is created until the first write. */
export function startPlanSession(repo: string, slug: string, opts: PlanSessionOptions = {}): PlanSession {
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const id = opts.id ?? randomBytes(3).toString("hex");
  return { repo, slug, env: opts.env ?? process.env, branch: `plan/${date}-${id}` };
}

export interface PlanWrite {
  /** Path relative to the vault root, e.g. `bible/facts.md` or `research/grapes.md`. */
  path: string;
  content: string;
  /** Commit message: what the write is ("record fact: ..."). */
  message: string;
}

/**
 * One planning write: creates the session's branch on the first call, writes
 * the file into the branch's worktree, and commits it as pablo. Every later
 * call in the session lands on the same branch. Never touches the vault's own
 * working tree.
 */
export function planWrite(session: PlanSession, write: PlanWrite): BranchResult {
  if (isAbsolute(write.path) || relative(".", write.path).startsWith("..") || write.path === "") {
    return { ok: false, notice: `pablo: plan: "${write.path}" is outside the vault` };
  }
  if (!session.worktree) {
    const created = createBranch(session.repo, session.slug, session.branch, session.env);
    if (!created.ok) return created;
    session.worktree = created.path;
  }
  const worktree = session.worktree as string;
  const rel = write.path;
  try {
    const abs = join(worktree, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, write.content);
  } catch (err) {
    return { ok: false, notice: `pablo: plan write failed: ${(err as Error).message}` };
  }
  return commitAs(worktree, { message: write.message, author: PABLO_AUTHOR, paths: [rel] });
}
