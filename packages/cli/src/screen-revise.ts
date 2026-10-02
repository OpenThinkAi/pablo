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
import type { Adapter } from "@openthink/pablo-core";
import { branchExists, commitAs, createBranch, deleteBranch, repoRoot } from "./branch";
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
export interface ScreenReviseRequest extends ScreenSelection { readonly instruction: string }
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

export function screenReviser(vaultRoot: string, projectPath: string, deps: ScreenReviserDeps = {}): ScreenReviser {
  const env = deps.env ?? process.env;

  return {
    async revise(request, partial) {
      const full = insideDir(projectPath, request.file);
      if (full === undefined) return { ok: false, message: NO_FILE };
      let raw: string;
      try { raw = readFileSync(full, "utf8"); } catch { return { ok: false, message: NO_FILE }; }
      const located = locateSelection(raw, request.sentences, request.stored);
      if (located === undefined) return { ok: false, message: "The chapter has changed since it was opened; reopen it and select again." };
      const base = frontmatterLength(raw);
      if (located.start < base) return { ok: false, message: "Select sentences of the chapter's text, not its frontmatter." };
      const outcome = await withWriteLock(() => reviseCore(
        { file: request.file, passage: undefined, start: located.start - base, end: located.end - base, instruction: request.instruction, dryRun: false /* send the pack to the model; the file is never written either way */ },
        { vaultRoot, projectPath, env },
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
