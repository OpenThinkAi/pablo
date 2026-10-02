// Finishing a review (AGT-1540): the author's decisions reach `main`. Accepted changes merge, rejected ones never do,
// and the after-write steps run on the merge. The screen cannot import this package, so cli.ts passes `screenFinisher`
// in through runScreen's options (like `screenWriter`).
//
// How "only the accepted changes" is built: the rejected lines are reverted by a commit on the branch itself (the file
// text a rejected edit touched goes back to what `main` had when the branch left it), then the branch merges whole
// through `mergeChanges` (AGT-1536's merge + after-write steps, any change branch). Why a revert commit and not a
// patch applied to `main`: the merge is then the ordinary `mergeBranch` path, its conflict handling and its
// after-write steps are reused unchanged, and a failure at any point leaves `main` untouched with the branch (and its
// revert commit) still there to retry. What it costs: the rejected sentences stay in the branch's history reachable
// from the merge commit's second parent; they are not in any file on `main`.
//
// What is rejected arrives as line references (the stitcher's `removedLines` / `addedLines` of each rejected edit:
// removed lines by old line number, added by new), never as edit ids, so this layer holds for any stitcher.

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createProviders, loadConfig, parseDiff } from "@openthink/pablo-core";
import type { Adapter, FileDiff, Intent, LineRef } from "@openthink/pablo-core";
import { branchDiff, branchIsEmpty, commitAs, deleteBranch, ensureWorktree, fileAt, mergeBaseOf, repoRoot } from "./branch";
import { readMarker } from "./marker";
import { mergeChanges } from "./novel/merge";
import type { MergeDraftOptions } from "./novel/merge";
import type { Ritual } from "./novel/rituals";

/** A path from the diff must name a file inside the work directory: relative, no `..`, no `.git`, no symlink out. */
export function insideDir(root: string, path: string): string | undefined {
  if (path === "" || isAbsolute(path) || path.split(/[\\/]/).some((seg) => seg === ".." || seg === ".git")) return undefined;
  const full = resolve(root, path);
  if (relative(root, full).startsWith("..")) return undefined;
  // A symlink on the way (or the file itself) must not lead out of the tree.
  let at = full;
  while (!existsSync(at) && at !== root) at = dirname(at);
  const real = realpathSync(at);
  const realRoot = realpathSync(root);
  return real === realRoot || real.startsWith(realRoot + sep) ? full : undefined;
}

const toLines = (text: string): { lines: string[]; eol: boolean } => {
  const lines = text.split("\n");
  const eol = lines[lines.length - 1] === "";
  if (eol) lines.pop();
  return { lines, eol };
};

/**
 * The file's text with the rejected lines undone, walking its diff hunks: an unchanged line stays; an added line stays
 * unless it is rejected (`added`, new line numbers); a removed line is put back when it is rejected (`removed`, old
 * numbers) and stays gone otherwise. Lines outside every hunk are the current text, untouched. Returns undefined when
 * the text no longer matches the diff (the file changed since the diff was taken): nothing is then written.
 */
export function revertLines(
  file: FileDiff,
  current: string | undefined,
  base: string | undefined,
  rejected: { readonly removed: ReadonlySet<number>; readonly added: ReadonlySet<number> },
): string | undefined {
  const cur = toLines(current ?? "");
  const old = toLines(base ?? "");
  const out: string[] = [];
  let at = 0; // next line of the current text (0-based) not yet copied
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.t === "-") {
        if (old.lines[l.o! - 1] !== l.text) return undefined;
        if (rejected.removed.has(l.o!)) out.push(l.text);
        continue;
      }
      const n = l.n!;
      if (n - 1 < at || cur.lines[n - 1] !== l.text) return undefined;
      while (at < n - 1) out.push(cur.lines[at++]!);
      at = n;
      if (l.t === "+" && rejected.added.has(n)) continue;
      out.push(l.text);
    }
  }
  while (at < cur.lines.length) out.push(cur.lines[at++]!);
  const eol = file.status === "deleted" ? old.eol : cur.eol;
  return out.length === 0 ? "" : out.join("\n") + (eol ? "\n" : "");
}

/** What was rejected: the removed lines of the rejected edits (old numbering) and their added lines (new numbering). */
export interface Rejected { readonly removed: readonly LineRef[]; readonly added: readonly LineRef[] }

const REVIEWER = { name: "pablo", email: "pablo@localhost" };

export type RevertResult = { readonly ok: true; readonly files: number } | { readonly ok: false; readonly notice: string };

/**
 * Commits on `branch` (in its worktree) the undoing of the rejected lines. Nothing is written unless every file can be
 * reverted; a reference outside the branch's diff, or a path that leaves the work directory, refuses the whole thing.
 */
export function revertRejected(repo: string, slug: string, branch: string, rejected: Rejected, env: Record<string, string | undefined> = process.env): RevertResult {
  const wt = ensureWorktree(repo, slug, branch, env);
  if (!wt.ok) return wt;
  const worktree = wt.path as string;
  const base = mergeBaseOf(repo, branch);
  if (!base.ok) return base;
  const diff = branchDiff(repo, branch);
  if (!diff.ok) return diff;
  const files = parseDiff(diff.text);

  const perFile = new Map<string, { removed: Set<number>; added: Set<number> }>();
  const removedKey = new Set<string>();
  const addedKey = new Set<string>();
  for (const f of files) for (const h of f.hunks) for (const l of h.lines) {
    if (l.t === "-") removedKey.add(`${f.path}\0${l.o}`);
    else if (l.t === "+") addedKey.add(`${f.path}\0${l.n}`);
  }
  for (const [list, side, known] of [[rejected.removed, "removed", removedKey], [rejected.added, "added", addedKey]] as const)
    for (const r of list) {
      if (insideDir(worktree, r.path) === undefined) return { ok: false, notice: `pablo: finish: "${r.path}" is not a path inside the project` };
      if (!known.has(`${r.path}\0${r.line}`)) return { ok: false, notice: `pablo: finish: ${r.path}:${r.line} is not a ${side} line of ${branch}` };
      const e = perFile.get(r.path) ?? { removed: new Set<number>(), added: new Set<number>() };
      e[side].add(r.line);
      perFile.set(r.path, e);
    }

  const writes: { path: string; full: string; text: string; drop: boolean }[] = [];
  for (const f of files) {
    const sel = perFile.get(f.path);
    if (!sel || f.binary) continue;
    const full = insideDir(worktree, f.path);
    if (full === undefined) return { ok: false, notice: `pablo: finish: "${f.path}" is not a path inside the project` };
    const current = f.status === "deleted" || !existsSync(full) ? undefined : readFileSync(full, "utf8");
    const baseText = f.status === "added" ? undefined : fileAt(repo, base.sha, f.oldPath ?? f.path);
    const text = revertLines(f, current, baseText, sel);
    if (text === undefined) return { ok: false, notice: `pablo: finish: ${f.path} no longer matches the changes under review` };
    writes.push({ path: f.path, full, text, drop: text === "" && baseText === undefined });
  }
  if (writes.length === 0) return { ok: true, files: 0 };
  for (const w of writes) {
    if (w.drop) rmSync(w.full, { force: true });
    else {
      mkdirSync(dirname(w.full), { recursive: true });
      writeFileSync(w.full, w.text);
    }
  }
  const n = rejected.removed.length + rejected.added.length;
  const committed = commitAs(worktree, { message: `review: reject ${n} changed line${n === 1 ? "" : "s"}`, author: REVIEWER, paths: writes.map((w) => w.path) });
  return committed.ok ? { ok: true, files: writes.length } : committed;
}

export type FinishResult =
  | { readonly ok: true; readonly merged: boolean; readonly commit?: string; readonly rituals: readonly Ritual[]; readonly notices: readonly string[] }
  | { readonly ok: false; readonly notice: string };

/**
 * Finishes the review of `branch`: reverts what was rejected, merges the rest into `main` and runs the after-write
 * steps, then deletes the branch and its worktree. When nothing is left after the revert (everything rejected) the
 * branch is discarded without a merge. A failure before the merge leaves `main` as it was and the branch in place.
 */
export async function finishReview(projectPath: string, branch: string, rejected: Rejected, opts: MergeDraftOptions): Promise<FinishResult> {
  const repo = repoRoot(projectPath);
  if (repo === undefined) return { ok: false, notice: `pablo: finish: ${projectPath} is not in a git repository` };
  const env = opts.env ?? process.env;
  if (rejected.removed.length + rejected.added.length > 0) {
    const reverted = revertRejected(repo, opts.slug, branch, rejected, env);
    if (!reverted.ok) return reverted;
  }
  if (branchIsEmpty(repo, branch)) {
    const removed = deleteBranch(repo, opts.slug, branch, { force: true, env });
    return { ok: true, merged: false, rituals: [], notices: removed.ok ? [] : [removed.notice] };
  }
  const merged = await mergeChanges(projectPath, branch, opts);
  if (!merged.ok) return merged;
  return { ok: true, merged: true, commit: merged.sha, rituals: merged.rituals, notices: merged.notices };
}

/** What the screen gets back: lines to show, or the reason the review did not finish. */
export type ScreenFinishResult = { readonly ok: true; readonly lines: readonly string[] } | { readonly ok: false; readonly message: string };
export type ScreenFinisher = (branch: string, rejected: Rejected) => Promise<ScreenFinishResult>;

/** The intent continuity extraction routes under: same as `merge`'s. */
const CONTINUITY_INTENT: Intent = { name: "continuity", kind: "extraction" };

export function screenFinisher(projectPath: string, deps: { env?: Record<string, string | undefined>; extractor?: Adapter; now?: () => Date } = {}): ScreenFinisher {
  return async (branch, rejected) => {
    const marker = readMarker(projectPath);
    if (!marker.ok) return { ok: false, message: marker.message };
    let extractor = deps.extractor;
    if (extractor === undefined) {
      try {
        const providers = createProviders(loadConfig());
        extractor = providers.adapter(providers.route(CONTINUITY_INTENT));
      } catch {
        extractor = undefined; // continuity is then skipped ("no extraction adapter"); the merge still lands
      }
    }
    let result: FinishResult;
    try {
      result = await finishReview(projectPath, branch, rejected, { slug: marker.marker.slug, ...(deps.env ? { env: deps.env } : {}), ...(extractor ? { extractor } : {}), ...(deps.now ? { now: deps.now } : {}) });
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    if (!result.ok) return { ok: false, message: result.notice };
    const lines = result.merged ? [`merged ${branch} into main (${(result.commit ?? "").slice(0, 7)})`] : [`nothing accepted: discarded ${branch}`];
    for (const r of result.rituals) lines.push(`${r.name}: ${r.status}${r.detail ? ` — ${r.detail}` : ""}`);
    lines.push(...result.notices);
    return { ok: true, lines };
  };
}
