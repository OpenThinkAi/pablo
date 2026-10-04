/**
 * The reader view's pure logic (AGT-1586): no DOM, no React, no IO, so it is tested directly
 * (`test/reader-logic.test.ts`). The view (`reader.tsx`) only measures the DOM (a selection becomes a
 * `Position` pair) and calls these. Positions and selections are core's (`review-map`): `offset` is UTF-16
 * code units into a paragraph's text as pablo sent it, a selection is half-open `[start, end)`.
 */

import type { ReaderMark, ReviewDraft, Tag } from "./reader-protocol";

export interface Position {
  readonly paragraph: number;
  readonly offset: number;
}
export interface Selection {
  readonly start: Position;
  readonly end: Position;
}

// --- the draft ------------------------------------------------------------------------------------------

export type Action =
  | { readonly type: "add"; readonly mark: ReaderMark }
  | { readonly type: "update"; readonly index: number; readonly patch: { readonly body?: string; readonly replacement?: string; readonly tag?: Tag | null } }
  | { readonly type: "remove"; readonly index: number }
  | { readonly type: "chapterNote"; readonly path: string; readonly body: string; readonly tag?: Tag }
  | { readonly type: "summary"; readonly summary: string };

/** A new array with `mark` replaced by `patch` applied (a `null` tag removes the tag). */
function patched(mark: ReaderMark, patch: Extract<Action, { type: "update" }>["patch"]): ReaderMark {
  const { tag: _tag, ...rest } = mark as ReaderMark & { tag?: Tag };
  const tag = patch.tag === undefined ? (mark as { tag?: Tag }).tag : (patch.tag ?? undefined);
  const withTag = tag === undefined ? rest : { ...rest, tag };
  if (mark.kind === "suggestion") return { ...withTag, ...(patch.replacement === undefined ? {} : { replacement: patch.replacement }) } as ReaderMark;
  return { ...withTag, ...(patch.body === undefined ? {} : { body: patch.body }) } as ReaderMark;
}

export function draftReducer(draft: ReviewDraft, action: Action): ReviewDraft {
  switch (action.type) {
    case "add":
      return { ...draft, marks: [...draft.marks, action.mark] };
    case "update":
      return { ...draft, marks: draft.marks.map((m, i) => (i === action.index ? patched(m, action.patch) : m)) };
    case "remove":
      return { ...draft, marks: draft.marks.filter((_, i) => i !== action.index) };
    case "summary":
      return { ...draft, summary: action.summary };
    case "chapterNote": {
      const at = draft.marks.findIndex((m) => m.kind === "chapter" && m.path === action.path);
      if (action.body.trim() === "") return at < 0 ? draft : { ...draft, marks: draft.marks.filter((_, i) => i !== at) };
      const note: ReaderMark = { kind: "chapter", path: action.path, ...(action.tag === undefined ? {} : { tag: action.tag }), body: action.body };
      return at < 0 ? { ...draft, marks: [...draft.marks, note] } : { ...draft, marks: draft.marks.map((m, i) => (i === at ? note : m)) };
    }
  }
}

/** The marks of one chapter with their index in the draft (the index is what `update`/`remove` take). */
export function marksOf(draft: ReviewDraft, path: string): { index: number; mark: ReaderMark }[] {
  const found: { index: number; mark: ReaderMark }[] = [];
  draft.marks.forEach((mark, index) => {
    if (mark.path === path) found.push({ index, mark });
  });
  return found;
}

/** The chapter's whole-chapter note, if the reader wrote one. */
export function chapterNote(draft: ReviewDraft, path: string): { index: number; body: string; tag?: Tag } | undefined {
  for (const { index, mark } of marksOf(draft, path)) if (mark.kind === "chapter") return { index, body: mark.body, ...(mark.tag === undefined ? {} : { tag: mark.tag }) };
  return undefined;
}

/** Something to send: a summary, or at least one mark. */
export function canSubmit(draft: ReviewDraft): boolean {
  return draft.summary.trim() !== "" || draft.marks.length > 0;
}

// --- selections -----------------------------------------------------------------------------------------

export const comparePositions = (a: Position, b: Position): number => a.paragraph - b.paragraph || a.offset - b.offset;

/** The selection with its ends in reading order. */
export function ordered(a: Position, b: Position): Selection {
  return comparePositions(a, b) <= 0 ? { start: a, end: b } : { start: b, end: a };
}

/** True for a caret (nothing selected). */
export const isCaret = (s: Selection): boolean => comparePositions(s.start, s.end) === 0;

/** Two spans overlap when they share a character; two insertion points at one place also collide. */
export function overlaps(a: Selection, b: Selection): boolean {
  if (isCaret(a) && isCaret(b)) return comparePositions(a.start, b.start) === 0;
  return comparePositions(a.start, b.end) < 0 && comparePositions(b.start, a.end) < 0;
}

/** The part of `selection` inside paragraph `paragraph` (of text length `length`), or undefined when it misses it. */
export function sliceIn(selection: Selection, paragraph: number, length: number): { from: number; to: number } | undefined {
  if (paragraph < selection.start.paragraph || paragraph > selection.end.paragraph) return undefined;
  const clamp = (n: number): number => Math.max(0, Math.min(length, n));
  return {
    from: clamp(paragraph === selection.start.paragraph ? selection.start.offset : 0),
    to: clamp(paragraph === selection.end.paragraph ? selection.end.offset : length),
  };
}

/** The text a selection covers, paragraphs joined by a blank line. */
export function selectedText(paragraphs: readonly { readonly text: string }[], selection: Selection): string {
  const parts: string[] = [];
  paragraphs.forEach((p, i) => {
    const slice = sliceIn(selection, i, p.text.length);
    if (slice !== undefined && slice.to > slice.from) parts.push(p.text.slice(slice.from, slice.to));
  });
  return parts.join("\n\n");
}

// --- free edits -----------------------------------------------------------------------------------------

/**
 * What changed between a paragraph as sent and as the reader left it: the span of `original` that was
 * replaced and what replaced it (common prefix and suffix trimmed). Undefined when nothing changed. Typing
 * into the text is recorded exactly like a strike plus a replacement.
 */
export function diffEdit(original: string, edited: string): { start: number; end: number; replacement: string } | undefined {
  if (original === edited) return undefined;
  let start = 0;
  const max = Math.min(original.length, edited.length);
  while (start < max && original[start] === edited[start]) start++;
  let tail = 0;
  while (tail < max - start && original[original.length - 1 - tail] === edited[edited.length - 1 - tail]) tail++;
  return { start, end: original.length - tail, replacement: edited.slice(start, edited.length - tail) };
}

/** A free edit of paragraph `paragraph` as a suggestion mark; undefined when the text is unchanged. */
export function editMark(path: string, paragraph: number, original: string, edited: string): ReaderMark | undefined {
  const change = diffEdit(original, edited);
  if (change === undefined) return undefined;
  return {
    kind: "suggestion",
    path,
    selection: { start: { paragraph, offset: change.start }, end: { paragraph, offset: change.end } },
    replacement: change.replacement,
  };
}

/** The first suggestion in the chapter that `selection` collides with, if any (marks that are comments never collide). */
export function collidingSuggestion(draft: ReviewDraft, path: string, selection: Selection): number | undefined {
  for (const { index, mark } of marksOf(draft, path)) if (mark.kind === "suggestion" && overlaps(mark.selection, selection)) return index;
  return undefined;
}

// --- showing marks inline -------------------------------------------------------------------------------

export interface Segment {
  readonly text: string;
  /** Draft indexes of the comments covering this stretch. */
  readonly comments: readonly number[];
  /** Draft indexes of the suggestions striking this stretch. */
  readonly suggestions: readonly number[];
  /** Comments that start here: the view numbers them. */
  readonly starts: readonly number[];
  /** Replacement texts shown beside this stretch, where a suggestion ends. */
  readonly ghosts: readonly { readonly index: number; readonly text: string }[];
  /** The tag of the first comment covering this stretch, for its colour. */
  readonly tag?: Tag;
}

/**
 * A paragraph cut into stretches by the marks that touch it. The stretches' text joins back to `text`
 * exactly (the view relies on it: a selection is measured against the rendered text), and a suggestion's
 * replacement is a `ghost` the view draws with CSS, never as text in the paragraph.
 */
export function segments(text: string, paragraph: number, marks: readonly { index: number; mark: ReaderMark }[]): Segment[] {
  type Cover = { index: number; from: number; to: number; mark: ReaderMark & { selection: Selection } };
  const covers: Cover[] = [];
  for (const { index, mark } of marks) {
    if (mark.kind === "chapter") continue;
    const slice = sliceIn(mark.selection, paragraph, text.length);
    if (slice !== undefined) covers.push({ index, ...slice, mark });
  }
  const cuts = new Set<number>([0, text.length]);
  for (const c of covers) {
    cuts.add(c.from);
    cuts.add(c.to);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: { a: number; b: number }[] = [];
  for (let i = 0; i + 1 < points.length; i++) out.push({ a: points[i] as number, b: points[i + 1] as number });
  if (out.length === 0) out.push({ a: 0, b: 0 });

  return out.map(({ a, b }, k): Segment => {
    const inside = covers.filter((c) => c.from < c.to && c.from <= a && b <= c.to);
    const comments = inside.filter((c) => c.mark.kind === "comment");
    const ghosts = covers
      .filter((c) => c.mark.kind === "suggestion" && c.mark.selection.end.paragraph === paragraph && (c.to === 0 ? k === 0 : c.to === b))
      .map((c) => ({ index: c.index, text: (c.mark as { replacement: string }).replacement }));
    const tag = (comments.find((c) => (c.mark as { tag?: Tag }).tag !== undefined)?.mark as { tag?: Tag } | undefined)?.tag;
    return {
      text: text.slice(a, b),
      comments: comments.map((c) => c.index),
      suggestions: inside.filter((c) => c.mark.kind === "suggestion").map((c) => c.index),
      starts: comments.filter((c) => c.from === a && c.mark.selection.start.paragraph === paragraph).map((c) => c.index),
      ghosts,
      ...(tag === undefined ? {} : { tag }),
    };
  });
}

// --- labels ---------------------------------------------------------------------------------------------

/** `Chapter 3`, or the file's own title when pablo found one. */
export const chapterLabel = (chapter: { number: number; title: string }): string => (chapter.title.trim() !== "" ? chapter.title : chapter.number > 0 ? `Chapter ${chapter.number}` : "Chapter");

/** A quote for the marks list: the first `max` characters of `text`, collapsed to one line. */
export function excerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The count line under the Submit button. */
export function describeDraft(draft: ReviewDraft): string {
  const n = draft.marks.length;
  return n === 0 ? "No marks yet" : `${n} ${n === 1 ? "mark" : "marks"}`;
}

// --- the window's layout (AGT-1599) ---------------------------------------------------------------------
// Pure, so the view only measures the window and applies what these return. Sizes are CSS px at 16px/rem.

const REM = 16;
const NAV_PX = 12 * REM;
const SIDE_PX = 16 * REM;
const GAP_PX = 1.5 * REM;
const SHELL_PAD_PX = 1.5 * REM;
/** The marks panel moves under the chapter below this window width. */
export const STACK_BELOW_PX = 1100;
/** The chapter is never squeezed below this (about 40rem); the marks panel drops under it first. */
export const MIN_PAGE_PX = 40 * REM;
export const MAX_PAGE_PX = 46 * REM;

export interface ReaderLayout {
  /** A chapter list column: only for a round with more than one chapter. */
  readonly showNav: boolean;
  /** Marks panel (and chapter list) go above/below the page instead of beside it. */
  readonly stacked: boolean;
  /** Very narrow window: tighter paper padding. */
  readonly compact: boolean;
  /** CSS `grid-template-columns` for the shell. No track exists for a column that is not shown. */
  readonly columns: string;
  /** The width the page column gets, in px. */
  readonly pagePx: number;
}

export function readerLayout(windowWidth: number, chapterCount: number): ReaderLayout {
  const showNav = chapterCount > 1;
  const inner = windowWidth - 2 * SHELL_PAD_PX;
  const beside = inner - SIDE_PX - GAP_PX - (showNav ? NAV_PX + GAP_PX : 0);
  const stacked = windowWidth < STACK_BELOW_PX || beside < MIN_PAGE_PX;
  const compact = windowWidth < MIN_PAGE_PX;
  if (stacked) return { showNav, stacked, compact, columns: `minmax(0, ${MAX_PAGE_PX / REM}rem)`, pagePx: Math.max(0, Math.min(MAX_PAGE_PX, inner)) };
  return { showNav, stacked, compact, columns: `${showNav ? `${NAV_PX / REM}rem ` : ""}minmax(0, ${MAX_PAGE_PX / REM}rem) ${SIDE_PX / REM}rem`, pagePx: Math.min(MAX_PAGE_PX, beside) };
}

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}
export interface PopoverPlace {
  /** Document coordinates (viewport + scroll), so the box scrolls with the text instead of floating over it. */
  readonly left: number;
  readonly top: number;
  /** When set, `top` is the box's bottom edge (the view shifts it up by its own height). */
  readonly above: boolean;
}

export const POPOVER_SIZE = { width: 20 * REM, height: 18 * REM } as const;

/**
 * Where the comment/suggest box goes for a selection `rect` (viewport coordinates): just below it, or just above
 * when below would run off the window and above has more room. Never overlaps `rect`. Horizontally it follows the
 * selection's left edge, kept inside the window.
 */
export function popoverPlacement(
  rect: Rect,
  viewport: { readonly width: number; readonly height: number },
  scroll: { readonly x: number; readonly y: number } = { x: 0, y: 0 },
  size: { readonly width: number; readonly height: number } = POPOVER_SIZE,
  gap = 8,
): PopoverPlace {
  const width = Math.min(size.width, Math.max(0, viewport.width - 2 * gap));
  const left = Math.max(gap, Math.min(rect.left, viewport.width - width - gap)) + scroll.x;
  const roomBelow = viewport.height - rect.bottom - gap;
  const roomAbove = rect.top - gap;
  const above = roomBelow < size.height && roomAbove > roomBelow;
  return above ? { left, top: rect.top - gap + scroll.y, above } : { left, top: rect.bottom + gap + scroll.y, above };
}
