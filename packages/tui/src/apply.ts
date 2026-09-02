/**
 * Applying a span verb to the document — the half of AGT-1204 that changes
 * bytes.
 *
 * **Invariant 1: the model has no write tool. The model proposes; the app
 * applies.** Every function here is called by the app, in response to a key the
 * author pressed, and the one that touches the filesystem is at the bottom of
 * the file and takes a `Document` the caller already built. A provider adapter
 * never reaches this module.
 *
 * Two kinds of change, and the difference is the whole review model:
 *
 * - **A proposal** (`proposalEdit`) lands as CriticMarkup — the model's own
 *   marks when it answered with them, `{~~old~>new~~}` or `{++new++}` around a
 *   plain answer when it did not — and waits. Nothing is applied; AGT-1205 owns
 *   accept and reject.
 * - **An author edit** (`manualEdit`, `cutEdit`, `moveEdit`) replaces the text
 *   outright, because the vault's git history is where the author's own edits
 *   are recorded. Tracking them is Word's most-hated feature for a reason.
 *
 * Every function returns a new `Document` and every offset in it is a UTF-16
 * code unit into that new text, so a caller re-reads and re-parses rather than
 * carrying old offsets across a write.
 */

import { writeFileSync } from "node:fs";
import {
  insertAt,
  replaceSpan,
  selectionText,
  validateProposal,
  type Document,
  type Span,
  type Violation,
} from "@openthink/pablo-core";

/** A change that could not be made, with the reason to put on the status line. */
export interface EditRefusal {
  readonly ok: false;
  readonly reason: string;
}

export interface EditResult {
  readonly ok: true;
  readonly doc: Document;
  /** Where the changed text now sits, for the selection after the write. */
  readonly span: Span;
}

export type Edit = EditResult | EditRefusal;

/**
 * The CriticMarkup a proposal becomes.
 *
 * A zero-width span is an addition and a span with text is a substitution; that
 * is the only branch, and it is why the zero-width selection needed no separate
 * verb.
 */
export function markFor(original: string, replacement: string): string {
  return original === "" ? `{++${replacement}++}` : `{~~${original}~>${replacement}~~}`;
}

/**
 * A model's answer, written into the document as CriticMarkup.
 *
 * The `prompt` verb asks the pack for the CriticMarkup path
 * (`SpanEditInputs.output: "text"`, AGT-1202), so the answer *is* the proposal:
 * the passage with the model's changes marked in it, which is finer-grained
 * than one substitution over the whole span and is what AGT-1205's per-hunk
 * review wants. `validateProposal` is the gate on it, run on the raw answer
 * before anything writes — the parser is the conformance test for every
 * provider's structured output, and a stray `~>` or an unbalanced `~~}` in the
 * model's prose would corrupt everything after it in the file.
 *
 * The one accommodation is for a model that ignores the instruction and answers
 * with plain prose, which a 31B local model does: an answer with no marks at
 * all is not a failure, it is a replacement, and the app wraps it in the one
 * substitution the author asked for. Any *other* violation is refused.
 */
export function proposalEdit(doc: Document, span: Span, answer: string): Edit {
  const trimmed = answer.trim();
  if (trimmed === "") return { ok: false, reason: "the model returned nothing to propose" };

  const original = selectionText(doc, span);
  const direct = validateProposal(trimmed);
  const mark = direct.ok ? trimmed : markFor(original, trimmed);

  if (!direct.ok) {
    // Wrapping only rescues "the model wrote prose". A malformed mark stays
    // malformed inside a substitution, so it is checked again.
    if (!direct.violations.every(isMissingMarks)) return refusal(direct.violations);
    const wrapped = validateProposal(mark);
    if (!wrapped.ok) return refusal(wrapped.violations);
  }

  const next = span.start === span.end ? insertAt(doc, span, mark) : replaceSpan(doc, span, mark);
  return { ok: true, doc: next, span: { start: span.start, end: span.start + mark.length } };
}

/** The violation `validateProposal` raises for an answer that carries no marks at all. */
function isMissingMarks(violation: Violation): boolean {
  return violation.message.startsWith("no CriticMarkup marks");
}

function refusal(violations: readonly Violation[]): EditRefusal {
  const first = violations[0];
  return {
    ok: false,
    reason: `the model's answer is not usable CriticMarkup: ${first?.message ?? "malformed"}`,
  };
}

/** The author's own text over the span. No markup: git is the record (AC2). */
export function manualEdit(doc: Document, span: Span, text: string): Edit {
  const next = replaceSpan(doc, span, text);
  return { ok: true, doc: next, span: { start: span.start, end: span.start + text.length } };
}

/**
 * Remove the span (AC3).
 *
 * Cutting a whole paragraph leaves the blank line from each side of it behind,
 * so the seam is closed to one blank line. That is the only whitespace pablo
 * touches on the author's behalf, and it is confined to the join.
 */
export function cutEdit(doc: Document, span: Span): Edit {
  if (span.start === span.end) return { ok: false, reason: "nothing is selected to cut" };
  const removed = replaceSpan(doc, span, "");
  const closed = closeSeam(removed.text, span.start);
  return {
    ok: true,
    doc: { path: doc.path, text: closed.text },
    span: { start: closed.at, end: closed.at },
  };
}

/**
 * Cut the span and put it back at `to` (AC3): one write, not two, so the file
 * is never on disk in the half-moved state.
 *
 * `asBlock` says the moved text is a structural unit (a paragraph, a scene) and
 * has to land as one: a blank line on each side of it, taken from the seam it
 * left rather than added to what is already there. A sentence or a character
 * range splices in exactly as it was cut.
 */
export function moveEdit(doc: Document, span: Span, to: number, asBlock: boolean): Edit {
  if (span.start === span.end) return { ok: false, reason: "nothing is selected to move" };
  if (to > span.start && to < span.end) {
    return { ok: false, reason: "that boundary is inside the selection; pick one outside it" };
  }

  const moved = selectionText(doc, span);
  const cut = cutEdit(doc, span);
  if (!cut.ok) return cut;

  // The cut shortened the text before `to` by everything it removed, seam
  // included, so a boundary after the span walks back by the same amount. One
  // before it keeps its offset, unless it sat inside the blank lines the seam
  // swallowed, in which case the seam is where it now is.
  const removed = doc.text.length - cut.doc.text.length;
  const at =
    to <= span.start
      ? Math.min(to, cut.span.start)
      : Math.max(0, Math.min(to - removed, cut.doc.text.length));

  return asBlock ? spliceBlock(cut.doc, at, moved) : { ...manualEdit(cut.doc, { start: at, end: at }, moved) };
}

/**
 * Put `text` in at `at` as its own block: exactly one blank line between it and
 * whatever is on each side, and the file's final newline kept.
 */
function spliceBlock(doc: Document, at: number, text: string): Edit {
  const endsWithNewline = doc.text.endsWith("\n");
  const left = doc.text.slice(0, at).replace(/[ \t\n]+$/, "");
  const right = doc.text.slice(at).replace(/^[ \t\n]+/, "");
  const body = text.trim();

  const before = left === "" ? "" : `${left}\n\n`;
  const after = right === "" ? (endsWithNewline ? "\n" : "") : `\n\n${right}`;
  const start = before.length;

  return {
    ok: true,
    doc: { path: doc.path, text: before + body + after },
    span: { start, end: start + body.length },
  };
}

/** Collapse a run of three or more newlines around `at` to one blank line. */
function closeSeam(text: string, at: number): { text: string; at: number } {
  let start = at;
  while (start > 0 && text.charAt(start - 1) === "\n") start -= 1;
  let end = at;
  while (end < text.length && text.charAt(end) === "\n") end += 1;

  const run = end - start;
  if (run < 3) return { text, at };
  // One blank line between what is now adjacent — but nothing is adjacent at
  // the top of the file, and the end of the file wants its final newline and
  // not a trailing blank line.
  const keep = start === 0 ? "" : end >= text.length ? "\n" : "\n\n";
  return { text: text.slice(0, start) + keep + text.slice(end), at: start + keep.length };
}

/**
 * The write. The only function in pablo that changes a manuscript on disk, so
 * that "the app applies" is one call site and not a habit.
 */
export function writeDocument(doc: Document): void {
  writeFileSync(doc.path, doc.text, "utf8");
}

/** 1-based line of `offset`, for handing a cursor position to `$EDITOR` (AC4). */
export function lineOf(text: string, offset: number): number {
  const at = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  for (let index = 0; index < at; index += 1) {
    if (text.charAt(index) === "\n") line += 1;
  }
  return line;
}
