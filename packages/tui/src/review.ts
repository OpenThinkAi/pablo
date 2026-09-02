/**
 * The proposal queue: reviewing what the model proposed, one hunk at a time.
 *
 * **This module is where Invariant 1 stops being a slogan.** The model has no
 * write tool; it answers in CriticMarkup, `apply.ts` writes that markup into the
 * file, and the marks sit there — visible, reversible, unapplied — until the
 * author decides. *Resolving* a mark into plain prose happens here and nowhere
 * else in pablo, which is exactly what
 * `packages/tui/test/write-path.test.ts` asserts mechanically (AC6): the review
 * module is the only caller of `resolveMark` / `resolveAll`, and the only one
 * that hands the writer text with the marks taken out of it.
 *
 * Everything here is **pure**. A function takes a `Document` and a `Mark` and
 * returns the `Edit` the app would make; the write, the re-read, and the git
 * commit are the view's, because those are the parts that touch the world. That
 * is the same split every verb in `apply.ts` already has, and it is what lets
 * the accept/reject/edit decisions be tested without a terminal, without a
 * model, and without a repository.
 *
 * Two things about offsets, because they are the way this goes wrong:
 *
 * - **Every write invalidates every offset.** A `Mark` addresses the exact text
 *   it was parsed from, so the queue is re-derived from a fresh parse after each
 *   accept rather than carried across one. `ViewState.applied()` does the
 *   re-read; `reviewQueue` does the re-derive.
 * - **`resolveMark` resolves one hunk.** Markup nested inside the text it keeps
 *   stays verbatim, so accepting an outer substitution decides that substitution
 *   and leaves the proposals inside it pending. `resolveAll` is for the
 *   accept-all / reject-all batch and nothing else.
 */

import {
  flattenMarks,
  parse,
  replaceSpan,
  resolveAll,
  resolveMark,
  type Decision,
  type Document,
  type Mark,
  type MarkKind,
  type MarkupDocument,
  type Span,
} from "@openthink/pablo-core";
import type { Edit } from "./apply";

/**
 * The pending marks in document order, outer before inner (AC1).
 *
 * Every kind is in the queue, not only the three change forms: a note and a
 * highlight are pending decisions about the manuscript too, and resolving one
 * is how it leaves the file. What differs by kind is what accept and reject
 * *mean*, and `resolveMark` already knows that.
 */
export function reviewQueue(model: MarkupDocument): readonly Mark[] {
  return flattenMarks(model.marks);
}

/** The mark at `index`, or `undefined` when the queue is shorter than that. */
export function hunkAt(model: MarkupDocument, index: number): Mark | undefined {
  return reviewQueue(model)[index];
}

/** How the panel names a hunk. */
export const KIND_LABELS: Readonly<Record<MarkKind, string>> = {
  addition: "addition",
  deletion: "deletion",
  substitution: "substitution",
  note: "note",
  highlight: "highlight",
};

/**
 * The text the mark proposes, or `undefined` where it proposes none.
 *
 * A substitution proposes its replacement and an addition proposes its body. A
 * deletion proposes the *absence* of its body, and a note and a highlight
 * propose no prose at all, so there is nothing for the `edit` verb to open on
 * those three — accept and reject are the whole of the decision.
 */
export function proposedText(text: string, mark: Mark): string | undefined {
  if (mark.kind === "substitution" && mark.replacement !== undefined) {
    return text.slice(mark.replacement.start, mark.replacement.end);
  }
  if (mark.kind === "addition") return text.slice(mark.body.start, mark.body.end);
  return undefined;
}

/** The text the mark would replace, or the note's own words for a note. */
export function originalText(text: string, mark: Mark): string {
  return text.slice(mark.body.start, mark.body.end);
}

/** The mark exactly as it sits in the file, delimiters included. */
export function markText(text: string, mark: Mark): string {
  return text.slice(mark.span.start, mark.span.end);
}

/**
 * Where the resolved text ends up.
 *
 * A resolution replaces the whole mark, so the new span starts where the mark
 * did and is as long as the mark was plus however much the document grew or
 * shrank. Derived from the two lengths rather than re-rendered, because the
 * resolution is `resolveMark`'s to define and duplicating it here is how the
 * two would drift.
 */
function landedSpan(before: Document, after: Document, mark: Mark): Span {
  const width = mark.span.end - mark.span.start + (after.text.length - before.text.length);
  return { start: mark.span.start, end: mark.span.start + Math.max(0, width) };
}

/** AC2: accept this hunk — the proposal becomes the text. */
export function acceptHunk(doc: Document, mark: Mark): Edit {
  return resolved(doc, mark, "accept");
}

/** AC2: reject this hunk — the original text is what stays. */
export function rejectHunk(doc: Document, mark: Mark): Edit {
  return resolved(doc, mark, "reject");
}

function resolved(doc: Document, mark: Mark, decision: Decision): Edit {
  if (mark.span.end > doc.text.length) {
    return { ok: false, reason: "that proposal is no longer in the file" };
  }
  const next = resolveMark(doc, mark, decision);
  return { ok: true, doc: next, span: landedSpan(doc, next, mark) };
}

/**
 * AC2: accept the author's own version of the proposal.
 *
 * The text replaces the whole mark, delimiters and original alike, which is
 * what makes this an accept rather than a second proposal — "revise it, don't
 * defend it", without a second model round.
 *
 * It is refused when the typed text carries CriticMarkup of its own. What goes
 * in here is the *resolved* text, and a mark smuggled through the field would
 * put an undecided proposal into the file by way of the accept path, which is
 * the one thing the review surface exists to prevent.
 */
export function acceptEdited(doc: Document, span: Span, text: string): Edit {
  if (span.end > doc.text.length) {
    return { ok: false, reason: "that proposal is no longer in the file" };
  }
  if (parse(text).marks.length > 0) {
    return { ok: false, reason: "an accepted edit is plain prose, not CriticMarkup — remove the marks" };
  }
  return { ok: true, doc: replaceSpan(doc, span, text), span: { start: span.start, end: span.start + text.length } };
}

/**
 * AC2: the batch. Every pending mark, nested ones included, resolved the same
 * way in one write and — for an accept — one commit.
 *
 * `focus` is where the selection lands afterwards, because there is no single
 * hunk left to put it on and dropping the author at the top of the file after
 * accepting everything would lose their place.
 */
export function resolveEveryMark(doc: Document, decision: Decision, focus: number): Edit {
  const marks = reviewQueue(parse(doc.text));
  if (marks.length === 0) return { ok: false, reason: "there are no proposals in this file" };
  const next = resolveAll(doc, decision);
  const at = Math.max(0, Math.min(focus, next.text.length));
  return { ok: true, doc: next, span: { start: at, end: at } };
}

// --------------------------------------------------------------- commits (AC3)

/**
 * The trailer that marks a commit as an accept, and the fields that go with it.
 *
 * Prefixed rather than free prose because AC4 reads them back: `revert` finds
 * the commit that produced a paragraph by parsing these, so their names are a
 * format and not a wording choice. They are `key: value` lines in the body, the
 * shape git itself uses for trailers, so `git log --format=%(trailers)` and a
 * human reader both get on with them.
 */
export const ACCEPT_TRAILER = "pablo-accept";
export const REVERT_TRAILER = "pablo-revert";

/** What the commit message says about the run that produced the hunk (AC3, AC5). */
export interface AcceptFacts {
  /** Repo-relative path, for the trailer; the subject uses the base name. */
  readonly relPath: string;
  readonly fileName: string;
  readonly intent: string;
  readonly provider: string;
  readonly model: string;
  /** From the receipt, when there is one (AC5). */
  readonly promptHash: string | undefined;
  /** The mark's span before the write. */
  readonly before: Span;
  /** Where the resolved text landed. */
  readonly after: Span;
  /** How many hunks this commit resolved: 1 for a hunk, n for a batch. */
  readonly hunks: number;
  /** True when the author edited the proposal before accepting it. */
  readonly edited: boolean;
}

/** Said in the message and in the panel when no receipt names the run. */
export const UNKNOWN = "unknown";

function span(value: Span): string {
  return `${value.start}-${value.end}`;
}

/**
 * The commit message for an accept (AC3).
 *
 * The subject names the file and the intent, which is what a `git log --oneline`
 * over a chapter should read as. The body carries the machine-readable half:
 * the provider and model that produced the text, the prompt hash that
 * identifies the exact request in `.pablo/receipts.jsonl` (AC5), and the two
 * spans `revert` needs (AC4).
 */
export function acceptCommitMessage(facts: AcceptFacts): string {
  const what = facts.hunks === 1 ? "a proposal" : `${facts.hunks} proposals`;
  const subject = `pablo: accept ${what} (${facts.intent}) in ${facts.fileName}`;

  const body = [
    facts.edited
      ? "Accepted through pablo's review queue, with the proposed text edited by the author first."
      : "Accepted through pablo's review queue. The app applied it; the model never wrote to the file.",
    "",
    `${ACCEPT_TRAILER}: ${facts.relPath}`,
    `pablo-span-before: ${span(facts.before)}`,
    `pablo-span-after: ${span(facts.after)}`,
    `pablo-intent: ${facts.intent}`,
    `pablo-provider: ${facts.provider}`,
    `pablo-model: ${facts.model}`,
    `pablo-prompt-hash: ${facts.promptHash ?? UNKNOWN}`,
    `pablo-hunks: ${facts.hunks}`,
  ];
  if (facts.edited) body.push("pablo-edited: true");

  return `${subject}\n\n${body.join("\n")}\n`;
}

/**
 * The commit message for a revert (AC4).
 *
 * It deliberately carries no `pablo-accept:` trailer, so reverting twice walks
 * back through two accepts instead of finding its own commit and standing still.
 */
export function revertCommitMessage(relPath: string, fileName: string, sha: string, at: Span): string {
  return (
    `pablo: revert a paragraph in ${fileName} to before ${sha.slice(0, 8)}\n\n` +
    "Span-level undo through pablo's review queue: the paragraph is restored to " +
    "the text it had before the accept named below.\n\n" +
    `${REVERT_TRAILER}: ${relPath}\n` +
    `pablo-reverted: ${sha}\n` +
    `pablo-span: ${span(at)}\n`
  );
}

// ---------------------------------------------------------------- revert (AC4)

/** What `parseAcceptRecord` finds in a commit message. */
export interface AcceptRecord {
  readonly relPath: string;
  readonly before: Span | undefined;
  readonly after: Span | undefined;
  readonly hunks: number;
}

function trailer(message: string, key: string): string | undefined {
  for (const line of message.split("\n")) {
    const at = line.indexOf(":");
    if (at === -1) continue;
    if (line.slice(0, at).trim() !== key) continue;
    return line.slice(at + 1).trim();
  }
  return undefined;
}

function parseSpan(value: string | undefined): Span | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)-(\d+)$/.exec(value.trim());
  if (match === null) return undefined;
  return { start: Number(match[1]), end: Number(match[2]) };
}

/** The accept trailers of a commit message, or `undefined` if it is not an accept. */
export function parseAcceptRecord(message: string): AcceptRecord | undefined {
  const relPath = trailer(message, ACCEPT_TRAILER);
  if (relPath === undefined || relPath === "") return undefined;
  const hunks = Number(trailer(message, "pablo-hunks") ?? "1");
  return {
    relPath,
    before: parseSpan(trailer(message, "pablo-span-before")),
    after: parseSpan(trailer(message, "pablo-span-after")),
    hunks: Number.isFinite(hunks) && hunks > 0 ? hunks : 1,
  };
}

interface ContentBlock {
  readonly span: Span;
  readonly text: string;
}

/** The blocks that carry prose: what a "paragraph" means to `revert`. */
function contentBlocks(text: string): ContentBlock[] {
  return parse(text)
    .blocks.filter((block) => block.kind !== "blank")
    .map((block) => ({ span: block.span, text: text.slice(block.span.start, block.span.end) }));
}

/**
 * The index of the block in `blocks` that is `paragraph`, preferring the one
 * the commit says it changed.
 *
 * Identity is character-for-character equality, not position: paragraphs move
 * every time anything above them changes, so an index would be wrong by the
 * second commit. The recorded span only breaks the tie when a chapter repeats
 * a paragraph word for word.
 */
function blockIndexOf(blocks: readonly ContentBlock[], paragraph: string, at: Span | undefined): number {
  const matches = blocks.flatMap((block, index) => (block.text === paragraph ? [index] : []));
  if (matches.length === 0) return -1;
  if (at !== undefined) {
    const covering = matches.find((index) => {
      const block = blocks[index];
      return block !== undefined && block.span.start <= at.start && at.start < block.span.end;
    });
    if (covering !== undefined) return covering;
  }
  return matches[0] ?? -1;
}

export interface RevertPlan {
  readonly ok: true;
  readonly doc: Document;
  /** Where the restored paragraph now sits. */
  readonly span: Span;
  /** The accept being undone. */
  readonly sha: string;
  readonly restored: string;
}

export interface RevertRefusal {
  readonly ok: false;
  readonly reason: string;
}

/**
 * AC4: the paragraph's text from before the most recent accepted proposal on it.
 *
 * The rule, and every part of it is load-bearing:
 *
 * > Walk the file's commits newest first. A commit qualifies when it carries a
 * > `pablo-accept:` trailer **and**, in that commit's version of the file, the
 * > block covering its recorded `pablo-span-after` is character-for-character
 * > the paragraph under the cursor. The restored text is the block at the same
 * > content-block index in that commit's **parent** — the file as it was before
 * > the accept ran.
 *
 * Text equality is what makes "the most recent accepted proposal *on it*"
 * decidable: the newest accept whose result is still on screen is the one that
 * produced what the author is looking at, and an accept on some other paragraph
 * never matches. Offsets alone could not do this, because every commit shifts
 * them.
 *
 * Index alignment across the parent is refused when the two versions have
 * different block counts — an accept that added or removed a whole paragraph —
 * because there is then no honest answer to "which block was this one", and a
 * wrong guess would splice the wrong prose into the manuscript.
 */
export function planRevert(
  doc: Document,
  paragraph: Span,
  reader: { log(): readonly { sha: string; message: string }[]; show(ref: string): string | undefined },
): RevertPlan | RevertRefusal {
  const current = doc.text.slice(paragraph.start, paragraph.end);
  if (current.trim() === "") {
    return { ok: false, reason: "there is no paragraph under the cursor to revert" };
  }

  let sawAccept = false;
  for (const commit of reader.log()) {
    const record = parseAcceptRecord(commit.message);
    if (record === undefined) continue;
    sawAccept = true;

    const child = reader.show(commit.sha);
    const parent = reader.show(`${commit.sha}^`);
    if (child === undefined || parent === undefined) continue;

    const childBlocks = contentBlocks(child);
    const parentBlocks = contentBlocks(parent);
    const index = blockIndexOf(childBlocks, current, record.after);
    if (index === -1) continue;
    if (childBlocks.length !== parentBlocks.length) {
      return {
        ok: false,
        reason: `${commit.sha.slice(0, 8)} added or removed a paragraph, so there is no one paragraph to restore`,
      };
    }

    const prior = parentBlocks[index];
    if (prior === undefined) continue;
    if (prior.text === current) continue;

    return {
      ok: true,
      doc: replaceSpan(doc, paragraph, prior.text),
      span: { start: paragraph.start, end: paragraph.start + prior.text.length },
      sha: commit.sha,
      restored: prior.text,
    };
  }

  return {
    ok: false,
    reason: sawAccept
      ? "no accepted proposal in this file's history produced this paragraph"
      : "nothing has been accepted in this file yet",
  };
}
