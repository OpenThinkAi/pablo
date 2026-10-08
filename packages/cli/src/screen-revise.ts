// `a r` on the screen (AGT-1544): revises the selected sentences and, when the author takes the candidate, commits it on
// a `revise/<short-id>` branch. The tui cannot import this package, so cli.ts passes `screenReviser` in through
// runScreen's options (like `screenWriter`). Two steps, because the author edits the candidate between them:
//
//   revise  `reviseCore` over the selected lines as an offset span; nothing is written, partial text streams out
//   take    the (possibly edited) candidate replaces those stored lines, split one sentence per line, committed on a
//           new branch from `main`; the screen then opens review mode on it
//
// The selection arrives as the sentences' text plus the stored line range they came from (AGT-1543). A stored line
// can hold more than the selected sentences (a chapter not yet split, or a selection that stops mid-line), so the
// span is trimmed to the selected sentences and the rest of those lines is kept around the replacement.

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { splitManuscript } from "@openthink/pablo-core";
import type { Adapter, ReaderNote } from "@openthink/pablo-core";
import { branchExists, commitAs, createBranch, deleteBranch, ensureWorktree, repoRoot } from "./branch";
import { readComments, writeComments } from "./comments";
import { readMarker } from "./marker";
import { reviseCore, frontmatterLength } from "./revise";
import { insideDir } from "./review-finish";
import { slugify } from "./write";
import { withWriteLock } from "./verbs";

/** What the screen hands over: the file (project-relative), the selected sentences, and the stored lines they span. */
export interface ScreenSelection {
  readonly file: string;
  readonly sentences: readonly string[];
  readonly stored: { readonly from: number; readonly to: number };
}
export interface ScreenReviseRequest extends ScreenSelection {
  readonly instruction: string;
  /**
   * In a review (AGT-1642): the review branch the revise reads from and the candidate is committed on, in its own
   * worktree; `file` is then repo-relative, as the branch's diff names it. Absent: `file` is project-relative on `main`.
   */
  readonly branch?: string;
  /** The reader's comment the revise answers: its own section of Gemma's pack, ahead of the author's direction. */
  readonly note?: ReaderNote;
}
export type ScreenReviseResult =
  | { readonly ok: true; readonly candidate: string; readonly receipt: string; readonly model: string; readonly lines: readonly string[] }
  | { readonly ok: false; readonly message: string };

export interface ScreenTakeRequest extends ScreenReviseRequest {
  /** The candidate as the author left it. */
  readonly candidate: string;
  /** The candidate as the model gave it: a difference means the author edited it, and the commit says so. */
  readonly offered: string;
  readonly receipt: string;
  readonly model: string;
}
export type ScreenTakeResult =
  | { readonly ok: true; readonly branch: string; readonly lines: readonly string[] }
  | { readonly ok: false; readonly message: string };

export interface ScreenReviser {
  revise(request: ScreenReviseRequest, partial: (text: string) => void): Promise<ScreenReviseResult>;
  take(request: ScreenTakeRequest): Promise<ScreenTakeResult>;
}

export interface ScreenReviserDeps {
  readonly adapter?: Adapter | undefined;
  readonly env?: Record<string, string | undefined>;
}

/** The selection as offsets into the raw file text, and what the first and last stored lines keep around it. */
export interface Located {
  /** Offsets into the file as stored (frontmatter included). */
  readonly start: number;
  readonly end: number;
  /** The text on the first line before the selection, and on the last line after it. */
  readonly prefix: string;
  readonly suffix: string;
}

/**
 * Finds the selected sentences inside the stored lines `from`..`to` (0-based, inclusive) of `raw`. The first sentence is
 * looked for on the first line and the last on the last line; when either is not there (a sentence the stored lines
 * split differently) the span is the whole lines, which is wider but never wrong. Undefined when the lines are not in
 * the file at all: it changed since the screen read it.
 */
export function locateSelection(raw: string, sentences: readonly string[], stored: { readonly from: number; readonly to: number }): Located | undefined {
  const lines = raw.split("\n");
  if (stored.from < 0 || stored.to < stored.from || stored.to >= lines.length || sentences.length === 0) return undefined;
  const first = lines[stored.from]!, last = lines[stored.to]!;
  const starts: number[] = [];
  let at = 0;
  for (const line of lines) { starts.push(at); at += line.length + 1; }
  const head = sentences[0]!, tail = sentences[sentences.length - 1]!;
  const from = first.indexOf(head);
  const tailAt = last.lastIndexOf(tail);
  const sameLine = stored.from === stored.to;
  const found = from >= 0 && tailAt >= 0 && (!sameLine || tailAt + tail.length > from);
  if (!found) {
    return { start: starts[stored.from]!, end: starts[stored.to]! + last.length, prefix: "", suffix: "" };
  }
  const endInLast = tailAt + tail.length;
  return { start: starts[stored.from]! + from, end: starts[stored.to]! + endInLast, prefix: first.slice(0, from), suffix: last.slice(endInLast) };
}

/** The replacement as stored lines: the text kept before and after the selection around the candidate, one sentence per line. */
export function replacementLines(candidate: string, located: Pick<Located, "prefix" | "suffix">): string[] {
  const joined = [located.prefix.trim(), candidate.trim(), located.suffix.trim()].filter((part) => part !== "").join(" ");
  return splitManuscript(joined).split("\n");
}

const NO_FILE = "Open a chapter to revise its sentences.";

/** Where a review branch's copy of a repo-relative `file` is: the work's directory in the branch's worktree, and the file relative to it. */
interface OnBranch { readonly repo: string; readonly slug: string; readonly worktree: string; readonly project: string; readonly file: string; readonly inRepo: string }

function onBranch(projectPath: string, branch: string, file: string, env: Record<string, string | undefined>): OnBranch | string {
  const marker = readMarker(projectPath);
  if (!marker.ok) return marker.message;
  const repo = repoRoot(projectPath);
  if (repo === undefined) return `pablo: revise needs ${projectPath} inside a git repository`;
  const tree = ensureWorktree(repo, marker.marker.slug, branch, env);
  if (!tree.ok) return tree.notice;
  const projectInRepo = relative(realpathSync(repo), realpathSync(projectPath));
  const projectFile = relative(projectInRepo, file);
  const project = join(tree.path as string, projectInRepo);
  if (projectFile.startsWith("..") || insideDir(project, projectFile) === undefined) return NO_FILE;
  return { repo, slug: marker.marker.slug, worktree: tree.path as string, project, file: projectFile, inRepo: file };
}

/**
 * The branch's stored comments on `file` after lines `from`..`to` (0-based) became `added` lines: those below move by
 * the difference, those on the replaced lines go to its last new line, so every other comment stays on its sentence.
 */
export function shiftComments<C extends { readonly path: string; readonly line?: number; readonly startLine?: number }>(comments: readonly C[], file: string, from: number, to: number, added: number): C[] {
  const delta = added - (to - from + 1);
  const move = (line: number) => (line - 1 > to ? line + delta : line - 1 >= from ? from + Math.max(1, added) : line);
  return comments.map((c) => {
    if (c.path !== file || c.line === undefined) return c;
    return { ...c, line: move(c.line), ...(c.startLine !== undefined ? { startLine: Math.min(move(c.startLine), move(c.line)) } : {}) };
  });
}

export function screenReviser(vaultRoot: string, projectPath: string, deps: ScreenReviserDeps = {}): ScreenReviser {
  const env = deps.env ?? process.env;

  return {
    async revise(request, partial) {
      // In a review the text is the branch's, read in its worktree; on the book it is the work's own file on `main`.
      const where = request.branch === undefined ? undefined : onBranch(projectPath, request.branch, request.file, env);
      if (typeof where === "string") return { ok: false, message: where };
      const project = where?.project ?? projectPath;
      const file = where?.file ?? request.file;
      const full = insideDir(project, file);
      if (full === undefined) return { ok: false, message: NO_FILE };
      let raw: string;
      try { raw = readFileSync(full, "utf8"); } catch { return { ok: false, message: NO_FILE }; }
      const located = locateSelection(raw, request.sentences, request.stored);
      if (located === undefined) return { ok: false, message: "The chapter has changed since it was opened; reopen it and select again." };
      const base = frontmatterLength(raw);
      if (located.start < base) return { ok: false, message: "Select sentences of the chapter's text, not its frontmatter." };
      const outcome = await withWriteLock(() => reviseCore(
        { file, passage: undefined, start: located.start - base, end: located.end - base, instruction: request.instruction, dryRun: false /* send the pack to the model; the file is never written either way */, ...(request.note ? { readerNote: request.note } : {}) },
        { vaultRoot, projectPath: project, env },
        // The progress lines go nowhere: the screen shows the candidate as it streams (`onCandidate`) and the receipt at the end.
        { adapter: deps.adapter, stderr: { write: () => {} }, onCandidate: partial },
      ));
      const body = outcome.body;
      if (!body.ok) return { ok: false, message: body.message };
      if (!("candidate" in body)) return { ok: false, message: "pablo: revise returned no candidate" };
      const r = body.receipt;
      return {
        ok: true,
        candidate: body.candidate,
        receipt: r.prompt_hash,
        model: r.model,
        lines: [`${r.model}: read ${r.tokensRead} tokens, wrote ${r.tokensWritten} (${r.words} words) in ${(r.wallMs / 1000).toFixed(1)}s`, `receipt ${r.prompt_hash.slice(0, 12)}`],
      };
    },

    async take(request) {
      const candidate = request.candidate.trim();
      if (candidate === "") return { ok: false, message: "The candidate is empty; nothing to take." };
      if (request.branch !== undefined) return takeOnBranch(projectPath, request, candidate, env);
      if (insideDir(projectPath, request.file) === undefined) return { ok: false, message: NO_FILE };
      const marker = readMarker(projectPath);
      if (!marker.ok) return { ok: false, message: marker.message };
      const repo = repoRoot(projectPath);
      if (repo === undefined) return { ok: false, message: `pablo: revise needs ${projectPath} inside a git repository` };
      const slug = marker.marker.slug;
      const short = request.receipt.slice(0, 7) || "revise";
      let branch = `revise/${short}`;
      for (let v = 2; branchExists(repo, branch); v++) branch = `revise/${short}-v${v}`;

      const created = createBranch(repo, slug, branch, env);
      if (!created.ok) return { ok: false, message: created.notice };
      const discard = () => { deleteBranch(repo, slug, branch, { force: true, env }); };

      const projectInRepo = relative(realpathSync(repo), realpathSync(projectPath));
      const inRepo = join(projectInRepo, request.file);
      // `path` is always a string when `ok`: createBranch sets it before returning { ok: true }.
      const worktreePath = created.path as string;
      const worktreeFile = join(worktreePath, inRepo);
      let raw: string;
      try { raw = readFileSync(worktreeFile, "utf8"); } catch { discard(); return { ok: false, message: NO_FILE }; }
      // The branch is cut from `main`'s committed text; those lines must be what the revise was run on.
      const located = locateSelection(raw, request.sentences, request.stored);
      const lines = raw.split("\n");
      const range = (text: string) => text.split("\n").slice(request.stored.from, request.stored.to + 1).join("\n");
      let live = "";
      try { live = readFileSync(insideDir(projectPath, request.file)!, "utf8"); } catch { /* compared below */ }
      if (located === undefined || range(raw) !== range(live)) {
        discard();
        return { ok: false, message: "The chapter on main no longer has those sentences; reopen it and select again." };
      }
      lines.splice(request.stored.from, request.stored.to - request.stored.from + 1, ...replacementLines(candidate, located));
      writeFileSync(worktreeFile, lines.join("\n"));

      const edited = candidate !== request.offered.trim();
      const instruction = request.instruction.replace(/\s+/g, " ").trim();
      const author = edited ? marker.marker.author : request.model;
      const committed = commitAs(worktreePath, {
        message: `${slug}: revise ${request.file}${edited ? " (edited)" : ""}\n\n${instruction}`,
        author: { name: author, email: `${slugify(author) || "author"}@pablo.local` },
        receipt: request.receipt,
        paths: [inRepo],
      });
      if (!committed.ok) {
        discard();
        return { ok: false, message: committed.notice };
      }
      return { ok: true, branch, lines: [`revised ${request.file} on ${branch}`, `authored as ${author}${edited ? " (you edited the candidate)" : ""}`, `receipt ${request.receipt.slice(0, 12)}`] };
    },
  };
}

/**
 * `take` in a review (AGT-1642): the candidate replaces the selected lines on the review branch itself, in its
 * worktree, as one more commit; the branch's other comments move with the lines. The review then reads the branch again
 * and the revision is one more change to accept or reject.
 */
async function takeOnBranch(projectPath: string, request: ScreenTakeRequest, candidate: string, env: Record<string, string | undefined>): Promise<ScreenTakeResult> {
  const branch = request.branch as string;
  const where = onBranch(projectPath, branch, request.file, env);
  if (typeof where === "string") return { ok: false, message: where };
  const full = join(where.worktree, where.inRepo);
  let raw: string;
  try { raw = readFileSync(full, "utf8"); } catch { return { ok: false, message: NO_FILE }; }
  const located = locateSelection(raw, request.sentences, request.stored);
  if (located === undefined) return { ok: false, message: `${branch} no longer has those sentences; reopen the review and try again.` };
  const lines = raw.split("\n");
  const added = replacementLines(candidate, located);
  lines.splice(request.stored.from, request.stored.to - request.stored.from + 1, ...added);
  writeFileSync(full, lines.join("\n"));

  const marker = readMarker(projectPath);
  const edited = candidate !== request.offered.trim();
  const author = edited && marker.ok ? marker.marker.author : request.model;
  const instruction = request.instruction.replace(/\s+/g, " ").trim();
  const answering = request.note ? `\n\nIn answer to ${request.note.reader}: "${request.note.comment.replace(/\s+/g, " ").trim()}"` : "";
  const committed = commitAs(where.worktree, {
    message: `${where.slug}: revise ${where.file}${edited ? " (edited)" : ""}\n\n${instruction}${answering}`,
    author: { name: author, email: `${slugify(author) || "author"}@pablo.local` },
    receipt: request.receipt,
    paths: [where.inRepo],
  });
  if (!committed.ok) {
    // Leave the branch as it was: the file goes back to its committed text.
    writeFileSync(full, raw);
    return { ok: false, message: committed.notice };
  }
  writeComments(projectPath, branch, shiftComments(readComments(projectPath, branch), where.inRepo, request.stored.from, request.stored.to, added.length));
  return { ok: true, branch, lines: [`revised ${where.file} on ${branch}`, `authored as ${author}${edited ? " (you edited the candidate)" : ""}`, `receipt ${request.receipt.slice(0, 12)}`] };
}

// ---------------------------------------------------------------------------
// `revise_passage` (AGT-1563): the harness's revise. Same two steps as `a r`, run back to back with no author to edit
// the candidate in between: the passage is located and revised on the local model, and the candidate is committed on a
// `revise/<id>` branch authored as the model. The result names the branch and the receipt; the candidate never goes back
// to the harness (it reads the branch through `read` when it wants the prose).
// ---------------------------------------------------------------------------

export interface RevisePassageRequest {
  readonly file: string;
  readonly passage: string;
  readonly instruction: string;
}
export type RevisePassageResult =
  | { readonly ok: true; readonly branch: string; readonly path: string; readonly receipt: Record<string, unknown> }
  | { readonly ok: false; readonly code: number; readonly message: string };

export async function revisePassage(vaultRoot: string, projectPath: string, request: RevisePassageRequest, deps: ScreenReviserDeps = {}): Promise<RevisePassageResult> {
  const env = deps.env ?? process.env;
  const fail = (code: number, message: string): RevisePassageResult => ({ ok: false, code, message });
  const full = insideDir(projectPath, request.file);
  if (full === undefined) return fail(2, `pablo: revise_passage file must be inside the project (${request.file})`);
  let raw: string;
  try { raw = readFileSync(full, "utf8"); } catch { return fail(2, `pablo: cannot read ${request.file}`); }

  const outcome = await withWriteLock(() => reviseCore(
    { file: request.file, passage: request.passage, start: undefined, end: undefined, instruction: request.instruction, dryRun: false },
    { vaultRoot, projectPath, env },
    { adapter: deps.adapter, stderr: { write: () => {} } },
  ));
  const body = outcome.body;
  if (!body.ok) return fail(outcome.exitCode || body.code, body.message);
  if (!("candidate" in body)) return fail(1, "pablo: revise returned no candidate");

  // The span is in the frontmatter-stripped body; the stored lines it covers are what `take` replaces.
  const base = frontmatterLength(raw);
  const start = base + body.span.start, end = base + body.span.end;
  const stored = { from: raw.slice(0, start).split("\n").length - 1, to: raw.slice(0, end).split("\n").length - 1 };
  const sentences = raw.slice(start, end).split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const r = body.receipt;
  const taken = await screenReviser(vaultRoot, projectPath, deps).take({
    file: request.file, sentences, stored, instruction: request.instruction,
    candidate: body.candidate, offered: body.candidate, receipt: r.prompt_hash, model: r.model,
  });
  if (!taken.ok) return fail(1, taken.message);
  return { ok: true, branch: taken.branch, path: request.file, receipt: { ...r } };
}
