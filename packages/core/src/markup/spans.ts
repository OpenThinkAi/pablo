/**
 * The span verbs. Selection is the only noun in pablo, so every change to a
 * document is one of these: replace a span, insert at a zero-width one, or
 * resolve a mark. Each returns a new `Document`; nothing here touches disk.
 *
 * `expand` and `shrink` walk the structural ladder
 * character → sentence → paragraph → scene → chapter, which is what makes
 * tag-then-batch fast enough to do during a read-through. Both are clamped so
 * that a structural selection never cuts a mark in half — a span that split
 * `{~~a~>b~~}` would produce broken markup the moment it was replaced.
 */

import type { Document, Span } from "../document";
import { isWithin } from "../document";
import { parse } from "./parse";
import type { Block, Mark, MarkupDocument } from "./types";

/** What the author decided about a proposal. */
export type Decision = "accept" | "reject";

export type Granularity = "character" | "sentence" | "paragraph" | "scene" | "chapter";

export interface Selection {
  readonly span: Span;
  readonly granularity: Granularity;
}

const WIDER: Record<Granularity, Granularity> = {
  character: "sentence",
  sentence: "paragraph",
  paragraph: "scene",
  scene: "chapter",
  chapter: "chapter",
};

const NARROWER: Record<Granularity, Granularity> = {
  chapter: "scene",
  scene: "paragraph",
  paragraph: "sentence",
  sentence: "character",
  character: "character",
};

/** Titles and honorifics whose period does not end a sentence in prose. */
const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "st",
  "jr",
  "sr",
  "prof",
  "rev",
  "capt",
  "col",
  "gen",
  "lt",
  "sgt",
  "vs",
  "etc",
]);

const TERMINATORS = ".!?";
const TRAILING_PUNCTUATION = "\"'”’)]}»";

export function replaceSpan(doc: Document, span: Span, replacement: string): Document {
  if (!isWithin(doc, span)) {
    throw new RangeError(
      `pablo: span [${span.start}, ${span.end}) does not address ${doc.path} (${doc.text.length} characters)`,
    );
  }
  return { path: doc.path, text: doc.text.slice(0, span.start) + replacement + doc.text.slice(span.end) };
}

/** Insert at a zero-width selection — the gesture for drafting into a boundary. */
export function insertAt(doc: Document, at: Span, text: string): Document {
  if (at.start !== at.end) {
    throw new RangeError(`pablo: insertAt needs a zero-width span, got [${at.start}, ${at.end})`);
  }
  return replaceSpan(doc, at, text);
}

type Render = (range: Span, children: readonly Mark[]) => string;

function contains(outer: Span, inner: Span): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

/**
 * What a mark becomes once the author decides on it.
 *
 * A note carries no prose, so resolving one discards it either way; a highlight
 * marks a pending intent's target, so resolving one keeps the prose and drops
 * the delimiters. Only the three change forms differ by decision.
 */
function resolvedText(text: string, mark: Mark, decision: Decision, render: Render): string {
  const accepted = decision === "accept";
  switch (mark.kind) {
    case "addition":
      return accepted ? render(mark.body, mark.children) : "";
    case "deletion":
      return accepted ? "" : render(mark.body, mark.children);
    case "substitution": {
      const range = accepted && mark.replacement !== undefined ? mark.replacement : mark.body;
      return render(
        range,
        mark.children.filter((child) => contains(range, child.span)),
      );
    }
    case "note":
      return "";
    case "highlight":
      return render(mark.body, mark.children);
  }
}

/**
 * Resolve one mark. Markup nested inside the retained text is kept verbatim:
 * accepting a hunk decides that hunk, not the separate proposals inside it.
 */
export function resolveMark(doc: Document, mark: Mark, decision: Decision): Document {
  const literal: Render = (range) => doc.text.slice(range.start, range.end);
  return replaceSpan(doc, mark.span, resolvedText(doc.text, mark, decision, literal));
}

function resolveRange(text: string, range: Span, marks: readonly Mark[], decision: Decision): string {
  const render: Render = (inner, children) => resolveRange(text, inner, children, decision);
  let out = "";
  let cursor = range.start;
  for (const mark of marks) {
    out += text.slice(cursor, mark.span.start) + resolvedText(text, mark, decision, render);
    cursor = mark.span.end;
  }
  return out + text.slice(cursor, range.end);
}

/** Resolve every mark, nested ones included: the plain text of the document. */
export function resolveAll(doc: Document, decision: Decision): Document {
  const model = parse(doc.text);
  return {
    path: doc.path,
    text: resolveRange(doc.text, { start: 0, end: doc.text.length }, model.marks, decision),
  };
}

function trim(text: string, span: Span): Span {
  let { start, end } = span;
  while (start < end && /\s/.test(text.slice(start, start + 1))) start += 1;
  while (end > start && /\s/.test(text.slice(end - 1, end))) end -= 1;
  return { start, end };
}

function union(spans: readonly Span[]): Span | null {
  const first = spans[0];
  const last = spans[spans.length - 1];
  if (first === undefined || last === undefined) return null;
  return { start: first.start, end: last.end };
}

/** A zero-width selection overlaps only the unit it sits strictly inside. */
function overlaps(unit: Span, selection: Span): boolean {
  if (selection.start === selection.end) {
    return selection.start > unit.start && selection.start < unit.end;
  }
  return selection.start < unit.end && unit.start < selection.end;
}

function contentBlocks(model: MarkupDocument): Block[] {
  return model.blocks.filter((block) => block.kind !== "blank");
}

/** The shallowest heading level in the file — what this manuscript calls a chapter. */
function chapterLevel(model: MarkupDocument): number | null {
  let level: number | null = null;
  for (const block of model.blocks) {
    if (block.kind !== "heading" || block.level === undefined) continue;
    level = level === null ? block.level : Math.min(level, block.level);
  }
  return level;
}

/** A chapter includes its own heading; text before the first heading is its own unit. */
function chapterUnits(model: MarkupDocument): Span[] {
  const blocks = contentBlocks(model);
  const level = chapterLevel(model);
  if (level === null) {
    const whole = union(blocks.map((block) => block.span));
    return whole === null ? [] : [whole];
  }

  const units: Span[] = [];
  let current: Span[] = [];
  for (const block of blocks) {
    if (block.kind === "heading" && block.level === level && current.length > 0) {
      const span = union(current);
      if (span !== null) units.push(span);
      current = [];
    }
    current.push(block.span);
  }
  const last = union(current);
  if (last !== null) units.push(last);
  return units;
}

/**
 * A scene is a run of prose between two boundaries. The boundaries themselves —
 * scene-break rules, chapter headings, frontmatter — belong to no scene.
 */
function sceneUnits(model: MarkupDocument): Span[] {
  const level = chapterLevel(model);
  const units: Span[] = [];
  let current: Span[] = [];

  const flush = (): void => {
    const span = union(current);
    if (span !== null) units.push(span);
    current = [];
  };

  for (const block of contentBlocks(model)) {
    const boundary =
      block.kind === "sceneBreak" ||
      block.kind === "frontmatter" ||
      (block.kind === "heading" && block.level === level);
    if (boundary) flush();
    else current.push(block.span);
  }
  flush();
  return units;
}

function isAbbreviation(text: string, period: number): boolean {
  let start = period;
  while (start > 0 && /[A-Za-z]/.test(text.slice(start - 1, start))) start -= 1;
  const word = text.slice(start, period);
  return word.length === 1 || ABBREVIATIONS.has(word.toLowerCase());
}

/**
 * Sentences inside one paragraph. A boundary never falls inside a mark, so a
 * proposal that rewrites two sentences stays a single unit.
 */
function sentenceUnits(model: MarkupDocument, range: Span): Span[] {
  const text = model.text;
  const marks = model.marks.filter((mark) => mark.span.start < range.end && range.start < mark.span.end);
  const units: Span[] = [];

  const push = (span: Span): void => {
    const unit = trim(text, span);
    if (unit.end > unit.start) units.push(unit);
  };

  let start = range.start;
  let at = range.start;
  while (at < range.end) {
    const mark = marks.find((candidate) => at >= candidate.span.start && at < candidate.span.end);
    if (mark !== undefined) {
      at = Math.min(mark.span.end, range.end);
      continue;
    }

    const char = text.slice(at, at + 1);
    if (!TERMINATORS.includes(char)) {
      at += 1;
      continue;
    }

    let end = at + 1;
    while (end < range.end && TERMINATORS.includes(text.slice(end, end + 1))) end += 1;
    while (end < range.end && TRAILING_PUNCTUATION.includes(text.slice(end, end + 1))) end += 1;

    const ends = end >= range.end || /\s/.test(text.slice(end, end + 1));
    if (ends && !(char === "." && isAbbreviation(text, at))) {
      push({ start, end });
      start = end;
    }
    at = end;
  }
  push({ start, end: range.end });
  return units;
}

function unitsFor(model: MarkupDocument, granularity: Granularity, selection: Span): Span[] {
  switch (granularity) {
    case "chapter":
      return chapterUnits(model);
    case "scene":
      return sceneUnits(model);
    case "paragraph":
      return contentBlocks(model).map((block) => block.span);
    case "sentence": {
      const paragraphs = contentBlocks(model).map((block) => block.span);
      const covering = paragraphs.filter((paragraph) => overlaps(paragraph, selection));
      const scope = covering.length > 0 ? covering : nearest(paragraphs, selection);
      return scope.flatMap((paragraph) => sentenceUnits(model, paragraph));
    }
    case "character":
      return [];
  }
}

function nearest(units: readonly Span[], selection: Span): Span[] {
  let best: Span | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const unit of units) {
    const gap =
      selection.start < unit.start ? unit.start - selection.start : Math.max(0, selection.start - unit.end);
    if (gap < distance) {
      best = unit;
      distance = gap;
    }
  }
  return best === null ? [] : [best];
}

/** Grow a span so it never partially covers a mark. Top-level marks are disjoint. */
function snapToMarks(model: MarkupDocument, span: Span): Span {
  let { start, end } = span;
  for (const mark of model.marks) {
    if (mark.span.start >= end || start >= mark.span.end) continue;
    start = Math.min(start, mark.span.start);
    end = Math.max(end, mark.span.end);
  }
  return { start, end };
}

/**
 * One step up the ladder. Where the selection touches several units of the
 * wider granularity it takes all of them, and for a real selection it never
 * gives ground: the result contains the span it was given. A zero-width
 * selection sitting between two units becomes the nearer one outright — that is
 * the drafting gesture, and carrying the boundary along with it helps nobody.
 */
export function expand(model: MarkupDocument, selection: Selection): Selection {
  const granularity = WIDER[selection.granularity];
  if (granularity === selection.granularity) return selection;

  const units = unitsFor(model, granularity, selection.span);
  const covering = units.filter((unit) => overlaps(unit, selection.span));
  const chosen = union(covering.length > 0 ? covering : nearest(units, selection.span));
  if (chosen === null) return selection;

  const span =
    selection.span.start === selection.span.end
      ? chosen
      : {
          start: Math.min(chosen.start, selection.span.start),
          end: Math.max(chosen.end, selection.span.end),
        };
  return { span: snapToMarks(model, span), granularity };
}

/** One step down: the first unit of the narrower granularity the selection touches. */
export function shrink(model: MarkupDocument, selection: Selection): Selection {
  const granularity = NARROWER[selection.granularity];
  if (granularity === selection.granularity) return selection;
  if (granularity === "character") return { span: selection.span, granularity };

  const units = unitsFor(model, granularity, selection.span);
  const covering = units.filter((unit) => overlaps(unit, selection.span));
  const chosen = covering[0] ?? nearest(units, selection.span)[0];
  if (chosen === undefined) return selection;

  return { span: snapToMarks(model, chosen), granularity };
}
