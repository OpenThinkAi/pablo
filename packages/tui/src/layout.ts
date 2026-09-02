/**
 * The manuscript layout: a parsed document plus a viewport in, the styled rows
 * of exactly that viewport out.
 *
 * **Only the visible window is laid out.** The viewport is anchored to a block
 * index and a wrapped-line offset inside that block, never to an absolute line
 * number, because computing an absolute line number means wrapping the whole
 * file. Scrolling wraps one block; drawing a frame wraps the handful of blocks
 * the screen shows. A 500-page manuscript therefore costs the same per frame as
 * a one-page one, which is what AC1 asks for. `LayoutStats` reports the work
 * done so a test can assert that rather than time it.
 *
 * Marks are rendered from the mark **tree**, not from a flat list: a mark's
 * style applies to its body, its delimiters are never drawn, and a mark nested
 * inside another paints over its parent's style. Marks legitimately cross block
 * boundaries, so every paint is clipped to the block being laid out and a mark
 * that starts three paragraphs above still colours its tail here.
 *
 * Every offset is a UTF-16 code unit index into `MarkupDocument.text`, the same
 * currency the core's spans use, so a row can be mapped back to a selection.
 */

import type { Block, Mark, MarkKind, MarkupDocument, Span } from "@openthink/pablo-core";
import { CARET_GLYPH, type StyleName } from "./theme";

/** A styled run inside one display row. */
export interface Segment {
  readonly text: string;
  readonly style: StyleName;
  /**
   * Source offset of this segment's first character. `-1` marks a synthetic
   * glyph (the zero-width caret) that stands for no text in the file.
   */
  readonly start: number;
  /** Whether the selection covers this run; drawn as reverse video. */
  readonly selected: boolean;
}

/** One row of the viewport. */
export interface DisplayLine {
  readonly segments: readonly Segment[];
  /** The source range this row covers, for mapping rows back to offsets. */
  readonly span: Span;
  readonly blockIndex: number;
}

/** Where the top of the viewport sits: a block, and a wrapped line inside it. */
export interface Anchor {
  readonly blockIndex: number;
  readonly line: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly anchor: Anchor;
  /** The current selection, drawn as an overlay (and as a caret when zero-width). */
  readonly selection: Span;
}

/** What laying out one frame actually touched. The virtualization proof. */
export interface LayoutStats {
  blocksWrapped: number;
  charactersWrapped: number;
}

/** A row before the selection overlay is applied. */
export interface Row {
  readonly segments: readonly Omit<Segment, "selected">[];
  readonly span: Span;
}

interface Run {
  readonly text: string;
  readonly style: StyleName;
  readonly start: number;
}

const BODY_STYLE: Readonly<Record<MarkKind, StyleName>> = {
  addition: "addition",
  deletion: "deletion",
  substitution: "substitutionOld",
  note: "note",
  highlight: "highlight",
};

function baseStyle(block: Block): StyleName {
  switch (block.kind) {
    case "heading":
      return "heading";
    case "frontmatter":
      return "frontmatter";
    case "sceneBreak":
      return "sceneBreak";
    default:
      return "prose";
  }
}

/**
 * The source range a block contributes to the view. A heading shows its title
 * and not its hashes; everything else shows all of itself.
 */
function paintedRange(block: Block): Span {
  return block.kind === "heading" && block.content !== undefined ? block.content : block.span;
}

/**
 * The top-level marks overlapping `clip`, found by binary search. Top-level
 * marks are disjoint and in document order, so their ends increase, which is
 * what makes the search legal.
 */
function marksOverlapping(marks: readonly Mark[], clip: Span): readonly Mark[] {
  let low = 0;
  let high = marks.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const mark = marks[mid];
    if (mark !== undefined && mark.span.end <= clip.start) low = mid + 1;
    else high = mid;
  }

  let end = low;
  while (end < marks.length) {
    const mark = marks[end];
    if (mark === undefined || mark.span.start >= clip.end) break;
    end += 1;
  }
  return marks.slice(low, end);
}

function pushRun(out: Run[], text: string, from: number, to: number, style: StyleName, clip: Span): void {
  const start = Math.max(from, clip.start);
  const end = Math.min(to, clip.end);
  if (end <= start) return;
  out.push({ text: text.slice(start, end), style, start });
}

function within(outer: Span, inner: Span): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

/** Paint `range` in `style`, letting the marks inside it paint over the top. */
function paint(
  text: string,
  range: Span,
  marks: readonly Mark[],
  style: StyleName,
  clip: Span,
  out: Run[],
): void {
  let cursor = range.start;
  for (const mark of marks) {
    if (mark.span.end <= range.start || mark.span.start >= range.end) continue;
    pushRun(out, text, cursor, mark.span.start, style, clip);
    paintMark(text, mark, clip, out);
    cursor = mark.span.end;
  }
  pushRun(out, text, cursor, range.end, style, clip);
}

/**
 * One mark. The delimiters (`{++`, `++}`, and a substitution's `~>`) are the
 * ranges this function never pushes: the raw syntax is structure, not prose,
 * and AC2 says it is never shown.
 */
function paintMark(text: string, mark: Mark, clip: Span, out: Run[]): void {
  if (mark.kind === "substitution") {
    const old = mark.body;
    paint(
      text,
      old,
      mark.children.filter((child) => within(old, child.span)),
      "substitutionOld",
      clip,
      out,
    );
    const fresh = mark.replacement;
    if (fresh === undefined) return;
    paint(
      text,
      fresh,
      mark.children.filter((child) => within(fresh, child.span)),
      "substitutionNew",
      clip,
      out,
    );
    return;
  }

  paint(text, mark.body, mark.children, BODY_STYLE[mark.kind], clip, out);
}

/** The styled runs of one block, delimiters removed, marks painted. */
export function blockRuns(model: MarkupDocument, block: Block): Run[] {
  const clip = paintedRange(block);
  const runs: Run[] = [];
  paint(model.text, clip, marksOverlapping(model.marks, clip), baseStyle(block), clip, runs);
  return runs;
}

/** Words, runs of spaces, and newlines — the units word wrapping moves around. */
const TOKENS = /\n|[^\S\n]+|\S+/g;

function tokenize(text: string): string[] {
  return text.match(TOKENS) ?? [];
}

/**
 * Break `at` back to a code-point boundary so a hard-split long word never
 * leaves half a surrogate pair on a row.
 */
function safeBreak(text: string, at: number): number {
  const code = text.charCodeAt(at - 1);
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

/**
 * Wrap runs to `width` columns.
 *
 * A newline inside a paragraph is a soft break in markdown, so it wraps as a
 * space; inside frontmatter, where the lines are the content, it is hard. Width
 * is counted in UTF-16 code units: correct for the Latin prose this is built
 * for, and one column off per East Asian wide character until there is a reason
 * to pay for grapheme measurement.
 */
function wrapRuns(runs: readonly Run[], width: number, hardBreaks: boolean, fallback: number): Row[] {
  const columns = Math.max(1, width);
  const rows: Row[] = [];
  let segments: Omit<Segment, "selected">[] = [];
  let column = 0;
  let lineStart = -1;
  let lineEnd = fallback;

  const flush = (): void => {
    rows.push({
      segments,
      span: { start: lineStart === -1 ? lineEnd : lineStart, end: lineEnd },
    });
    segments = [];
    column = 0;
    lineStart = -1;
  };

  const append = (text: string, style: StyleName, start: number): void => {
    const previous = segments[segments.length - 1];
    if (previous !== undefined && previous.style === style && previous.start + previous.text.length === start) {
      segments[segments.length - 1] = { text: previous.text + text, style, start: previous.start };
    } else {
      segments.push({ text, style, start });
    }
    if (lineStart === -1) lineStart = start;
    lineEnd = start + text.length;
    column += text.length;
  };

  for (const run of runs) {
    let offset = run.start;
    for (const token of tokenize(run.text)) {
      const at = offset;
      offset += token.length;

      if (token === "\n") {
        lineEnd = at + 1;
        if (hardBreaks) flush();
        else if (column > 0 && column < columns) append(" ", run.style, at);
        continue;
      }

      if (/^\s/.test(token)) {
        if (column === 0) {
          lineEnd = at + token.length;
          continue;
        }
        if (column + token.length > columns) flush();
        else append(token, run.style, at);
        continue;
      }

      if (column > 0 && column + token.length > columns) flush();

      // A word longer than the screen is split rather than allowed to overflow;
      // `column` is 0 here, because anything that did not fit already flushed.
      let rest = token;
      let restStart = at;
      while (rest.length > columns) {
        const cut = safeBreak(rest, columns);
        if (cut <= 0) break;
        append(rest.slice(0, cut), run.style, restStart);
        flush();
        rest = rest.slice(cut);
        restStart += cut;
      }
      if (rest.length > 0) append(rest, run.style, restStart);
    }
  }

  if (segments.length > 0 || rows.length === 0) flush();
  return rows;
}

/**
 * A gap between two content blocks is worth one blank row per empty line: the
 * newline that ends the preceding block is not itself a row.
 */
function blankRows(block: Block, text: string): Row[] {
  let newlines = 0;
  for (let at = block.span.start; at < block.span.end; at += 1) {
    if (text.charCodeAt(at) === 10) newlines += 1;
  }
  const count = Math.max(0, newlines - 1);
  return Array.from({ length: count }, () => ({ segments: [], span: block.span }));
}

/** Rows for one block, unwrapped by the selection. */
export function blockRows(model: MarkupDocument, blockIndex: number, width: number): Row[] {
  const block = model.blocks[blockIndex];
  if (block === undefined) return [];
  if (block.kind === "blank") return blankRows(block, model.text);
  return wrapRuns(blockRuns(model, block), width, block.kind === "frontmatter", block.span.start);
}

/**
 * A memo of wrapped blocks, so scrolling a screen does not re-wrap what is
 * already on it. Bound to one `(model, width)` pair and dropped whole when
 * either changes — a reload or a resize invalidates every offset anyway.
 */
export interface LineCache {
  rows(model: MarkupDocument, blockIndex: number, width: number): Row[];
}

const CACHE_LIMIT = 512;

export function createLineCache(): LineCache {
  let key: MarkupDocument | null = null;
  let columns = -1;
  let rows = new Map<number, Row[]>();

  return {
    rows(model, blockIndex, width) {
      if (model !== key || width !== columns) {
        key = model;
        columns = width;
        rows = new Map();
      }
      const hit = rows.get(blockIndex);
      if (hit !== undefined) return hit;
      const fresh = blockRows(model, blockIndex, width);
      if (rows.size >= CACHE_LIMIT) rows.clear();
      rows.set(blockIndex, fresh);
      return fresh;
    },
  };
}

function rowsFor(
  model: MarkupDocument,
  blockIndex: number,
  width: number,
  cache: LineCache | undefined,
  stats: LayoutStats | undefined,
): Row[] {
  if (stats !== undefined) {
    const block = model.blocks[blockIndex];
    stats.blocksWrapped += 1;
    stats.charactersWrapped += block === undefined ? 0 : block.span.end - block.span.start;
  }
  return cache === undefined ? blockRows(model, blockIndex, width) : cache.rows(model, blockIndex, width);
}

/** How many rows a block occupies at this width. */
export function blockRowCount(
  model: MarkupDocument,
  blockIndex: number,
  width: number,
  cache?: LineCache,
): number {
  return rowsFor(model, blockIndex, width, cache, undefined).length;
}

/** The block containing `offset`, by binary search over the tiling. */
export function blockIndexAt(model: MarkupDocument, offset: number): number {
  const blocks = model.blocks;
  let low = 0;
  let high = blocks.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >>> 1;
    const block = blocks[mid];
    if (block !== undefined && block.span.start <= offset) low = mid;
    else high = mid - 1;
  }
  return Math.max(0, low);
}

/** The wrapped line inside `blockIndex` that holds `offset`. */
export function rowIndexAt(
  model: MarkupDocument,
  blockIndex: number,
  offset: number,
  width: number,
  cache?: LineCache,
): number {
  const rows = rowsFor(model, blockIndex, width, cache, undefined);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row !== undefined && offset <= row.span.end) return index;
  }
  return Math.max(0, rows.length - 1);
}

function overlay(row: Row, blockIndex: number, selection: Span): DisplayLine {
  const segments: Segment[] = [];
  for (const segment of row.segments) {
    const start = segment.start;
    const end = start + segment.text.length;
    const from = Math.max(selection.start, start);
    const to = Math.min(selection.end, end);
    if (to <= from) {
      segments.push({ ...segment, selected: false });
      continue;
    }
    if (from > start) {
      segments.push({ ...segment, text: segment.text.slice(0, from - start), selected: false });
    }
    segments.push({
      text: segment.text.slice(from - start, to - start),
      style: segment.style,
      start: from,
      selected: true,
    });
    if (to < end) {
      segments.push({
        text: segment.text.slice(to - start),
        style: segment.style,
        start: to,
        selected: false,
      });
    }
  }
  return { segments, span: row.span, blockIndex };
}

/** Splice the caret glyph into the first row that reaches `offset`. */
function withCaret(lines: DisplayLine[], offset: number): DisplayLine[] {
  const caret: Segment = { text: CARET_GLYPH, style: "caret", start: -1, selected: false };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || offset > line.span.end) continue;

    const segments: Segment[] = [];
    let placed = false;
    for (const segment of line.segments) {
      if (!placed && offset <= segment.start) {
        segments.push(caret);
        placed = true;
      }
      if (!placed && offset < segment.start + segment.text.length) {
        const at = offset - segment.start;
        segments.push({ ...segment, text: segment.text.slice(0, at) });
        segments.push(caret);
        segments.push({ ...segment, text: segment.text.slice(at), start: offset });
        placed = true;
        continue;
      }
      segments.push(segment);
    }
    if (!placed) segments.push(caret);

    lines[index] = { ...line, segments };
    return lines;
  }
  return lines;
}

/**
 * The rows of one frame: at most `height` of them, starting at the anchor.
 *
 * The loop stops the moment the screen is full, so the cost is the visible
 * window and not the file.
 */
export function layoutWindow(
  model: MarkupDocument,
  view: Viewport,
  cache?: LineCache,
  stats?: LayoutStats,
): DisplayLine[] {
  const lines: DisplayLine[] = [];
  const start = Math.min(Math.max(0, view.anchor.blockIndex), Math.max(0, model.blocks.length - 1));

  for (let index = start; index < model.blocks.length && lines.length < view.height; index += 1) {
    const rows = rowsFor(model, index, view.width, cache, stats);
    const skip = index === start ? Math.max(0, view.anchor.line) : 0;
    for (let row = skip; row < rows.length && lines.length < view.height; row += 1) {
      const candidate = rows[row];
      if (candidate !== undefined) lines.push(overlay(candidate, index, view.selection));
    }
  }

  return view.selection.start === view.selection.end ? withCaret(lines, view.selection.start) : lines;
}
