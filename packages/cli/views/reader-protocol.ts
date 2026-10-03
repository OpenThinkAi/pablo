/**
 * The reader window's wire contract (AGT-1586): what pablo hands the view as `data`, and the two
 * mutations the view may call (`saveDraft`, `submit`). Types only, plus `parseDraft`, the check the host
 * runs on whatever the window posts back. The view holds no git or GitHub logic: it renders `ReaderData`
 * and posts a `ReviewDraft`; everything that maps paragraphs to sentence lines (core `review-map`) and
 * everything that talks to GitHub (`submit.ts`) runs on pablo's side.
 */

import type { ReaderMark, ReviewDraft, Tag } from "@openthink/pablo-core";

export type { ReaderMark, ReviewDraft, Tag };

/** One paragraph as the reader reads it; `prose` is false for a heading, a scene break or a list. */
export interface ViewParagraph {
  readonly text: string;
  readonly prose: boolean;
}

export interface ViewChapter {
  /** The chapter's path in the reading repo; marks name it. */
  readonly path: string;
  readonly number: number;
  readonly title: string;
  readonly paragraphs: readonly ViewParagraph[];
}

/** What a sent round shows: the review's link and when. */
export interface ViewSent {
  readonly reviewUrl: string;
  readonly sentAt: string;
}

/** The view's `data`. */
export interface ReaderData {
  readonly round: { readonly ref: string; readonly title: string; readonly sender: string; readonly id: string };
  readonly chapters: readonly ViewChapter[];
  /** Marks restored from the last session (`<id>.marks.json`); empty for a fresh round. */
  readonly draft: ReviewDraft;
  /** Set once the round is submitted: the view is read-only. */
  readonly sent?: ViewSent;
}

/** `saveDraft` and `submit` answer with this; the view shows `message` in plain words. */
export type HostAnswer = { readonly ok: true; readonly sent?: ViewSent } | { readonly ok: false; readonly message: string };

const MAX_MARKS = 2000;
const MAX_TEXT = 20_000;

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${what} is not an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string, required: boolean): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string") throw new Error(`${what} is not text`);
  if (value.length > MAX_TEXT) throw new Error(`${what} is too long`);
  return value;
}

function tag(value: unknown): { tag?: Tag } {
  if (value === undefined) return {};
  if (value === "fix" || value === "keep") return { tag: value };
  throw new Error("a tag is neither fix nor keep");
}

function position(value: unknown, what: string): { paragraph: number; offset: number } {
  const p = record(value, what);
  const { paragraph, offset } = p;
  if (typeof paragraph !== "number" || !Number.isInteger(paragraph) || paragraph < 0 || typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    throw new Error(`${what} is not a place in the chapter`);
  }
  return { paragraph, offset };
}

function selection(value: unknown): { start: { paragraph: number; offset: number }; end: { paragraph: number; offset: number } } {
  const s = record(value, "a selection");
  return { start: position(s.start, "a selection's start"), end: position(s.end, "a selection's end") };
}

/**
 * The marks a window posted, validated and rebuilt field by field (nothing else survives): throws an
 * `Error` whose message the host passes back. Whether the marks fit the chapters is the host's next check
 * (`resolveReview`); this one is only the shape.
 */
export function parseDraft(value: unknown): ReviewDraft {
  const draft = record(value, "the draft");
  const summary = text(draft.summary, "the summary", true);
  if (!Array.isArray(draft.marks)) throw new Error("the marks are not a list");
  if (draft.marks.length > MAX_MARKS) throw new Error("there are too many marks");
  const marks = draft.marks.map((raw, i): ReaderMark => {
    const m = record(raw, `mark ${i + 1}`);
    const path = text(m.path, "a mark's chapter", true);
    switch (m.kind) {
      case "comment":
        return { kind: "comment", path, selection: selection(m.selection), ...tag(m.tag), body: text(m.body, "a comment", true) };
      case "suggestion": {
        const note = text(m.note, "a suggestion's note", false);
        return {
          kind: "suggestion",
          path,
          selection: selection(m.selection),
          replacement: text(m.replacement, "a suggestion", true),
          ...tag(m.tag),
          ...(note === "" ? {} : { note }),
        };
      }
      case "chapter":
        return { kind: "chapter", path, ...tag(m.tag), body: text(m.body, "a chapter comment", true) };
      default:
        throw new Error(`mark ${i + 1} is not a comment, a suggestion or a chapter comment`);
    }
  });
  return { summary, marks };
}
