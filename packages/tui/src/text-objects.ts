// Sentence and paragraph motions and text objects for the editing pane (AGT-2170, D-18). Pure, like modal.ts, which
// registers these tables: a motion moves a buffer's cursor and nothing else; a text object is a range, and picking one
// leaves select mode with the anchor at the range's start and the cursor on its last character (select mode includes
// both ends, as Helix does).
//
// The buffer's rows are paragraphs when a prose file is stored a sentence a line (the pane joins them, edit-pane.ts), or
// plain lines otherwise; blank rows separate blocks either way. A sentence is whatever core's `splitSentences` makes of
// a row, so the editor agrees with what storage will write back. Offsets are mapped back through the whitespace
// collapse that function does, so a row with doubled spaces still selects the right span.

import { splitSentences } from "@openthink/pablo-core";
import type { Pos, TextBuffer } from "./buffer";
import type { EditText } from "./edit-pane";
import { apply } from "./edit-pane";

type Lines = readonly string[];
/** An inclusive range: `from` is the first character, `to` the start of the last one. */
export interface Range { readonly from: Pos; readonly to: Pos }
export type TextObject = (lines: Lines, at: Pos) => Range | null;
type Move = (b: TextBuffer, c: { readonly width: number; readonly height: number }) => void;

const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const isBlank = (l: string) => /^\s*$/.test(l);

/** The start of the last grapheme of `line` before offset `end` (exclusive); `end` itself for an empty prefix. */
function lastBefore(line: string, end: number): number {
  let last = 0;
  for (const { index } of seg.segment(line.slice(0, end))) last = index;
  return last;
}
const range = (row: number, from: number, endExcl: number, lines: Lines): Range | null =>
  endExcl > from ? { from: { row, col: from }, to: { row, col: lastBefore(lines[row]!, endExcl) } } : null;

// ---------------------------------------------------------------- sentences

/** Each sentence of `line` as `[start, end)` offsets in the line as written. */
export function sentenceSpans(line: string): [number, number][] {
  // The line with whitespace runs collapsed (as splitSentences does), and where each of its characters came from.
  let norm = "";
  const origin: number[] = [];
  let i = 0;
  while (i < line.length && /\s/.test(line[i]!)) i++;
  for (; i < line.length; i++) {
    if (/\s/.test(line[i]!)) {
      let j = i;
      while (j < line.length && /\s/.test(line[j]!)) j++;
      if (j < line.length) { norm += " "; origin.push(i); }
      i = j - 1;
    } else { norm += line[i]; origin.push(i); }
  }
  const spans: [number, number][] = [];
  let at = 0;
  for (const s of splitSentences(line)) {
    const start = norm.indexOf(s, at);
    if (start < 0) continue;
    const end = start + s.length;
    spans.push([origin[start]!, origin[end - 1]! + 1]);
    at = end;
  }
  return spans;
}

/** The sentence holding `col` (the one before it when `col` falls in the space between two), with its index. */
function sentenceAt(spans: readonly [number, number][], col: number): number {
  let k = 0;
  spans.forEach(([s], i) => { if (s <= col) k = i; });
  return k;
}

/** `(`/`)` helpers: the start of the sentence after `from`, or null at the end of the document. */
export function sentenceNext(lines: Lines, from: Pos): Pos | null {
  const spans = sentenceSpans(lines[from.row]!);
  const later = spans.find(([s]) => s > from.col);
  if (later) return { row: from.row, col: later[0] };
  for (let r = from.row + 1; r < lines.length; r++) {
    const first = sentenceSpans(lines[r]!)[0];
    if (first) return { row: r, col: first[0] };
  }
  return null;
}

/** The start of the sentence holding `from` if the cursor is past it, else of the one before; null at the document's start. */
export function sentencePrev(lines: Lines, from: Pos): Pos | null {
  const spans = sentenceSpans(lines[from.row]!);
  const here = spans.filter(([s]) => s < from.col).pop();
  if (here) return { row: from.row, col: here[0] };
  for (let r = from.row - 1; r >= 0; r--) {
    const last = sentenceSpans(lines[r]!).pop();
    if (last) return { row: r, col: last[0] };
  }
  return null;
}

// ---------------------------------------------------------------- paragraphs

/** The first and last rows of the block of like rows (all blank, or all not) holding `row`. */
function blockAt(lines: Lines, row: number): [number, number] {
  const blank = isBlank(lines[row]!);
  let a = row, z = row;
  while (a > 0 && isBlank(lines[a - 1]!) === blank) a--;
  while (z < lines.length - 1 && isBlank(lines[z + 1]!) === blank) z++;
  return [a, z];
}

/** The start of the next paragraph (block of non-blank rows); the end of the last one when there is none. */
export function paragraphNext(lines: Lines, from: Pos): Pos {
  let r = from.row;
  if (!isBlank(lines[r]!)) r = blockAt(lines, r)[1] + 1;
  while (r < lines.length && isBlank(lines[r]!)) r++;
  if (r < lines.length) return { row: r, col: 0 };
  const last = lines.length - 1;
  return { row: last, col: lastBefore(lines[last]!, lines[last]!.length) };
}

/** The start of this paragraph if the cursor is past it, else of the one before; the document's start when there is none. */
export function paragraphPrev(lines: Lines, from: Pos): Pos {
  let r = from.row;
  if (!isBlank(lines[r]!)) {
    const [a] = blockAt(lines, r);
    if (a < r || from.col > 0) return { row: a, col: 0 };
    r = a - 1;
  }
  while (r >= 0 && isBlank(lines[r]!)) r--;
  if (r < 0) return { row: 0, col: 0 };
  return { row: blockAt(lines, r)[0], col: 0 };
}

// ---------------------------------------------------------------- the objects

type Cls = "space" | "word" | "punct";
const classOf = (g: string): Cls => (/^\s/u.test(g) ? "space" : /^[\p{L}\p{N}\p{M}_]/u.test(g) ? "word" : "punct");

/** `iw`: the run of one kind of character (letters and digits, punctuation, or space) under the cursor; `aw` adds the space after a word (before it at the line's end). */
function wordObject(around: boolean): TextObject {
  return (lines, at) => {
    const line = lines[at.row]!;
    const gs = [...seg.segment(line)].map((s) => ({ start: s.index, end: s.index + s.segment.length, cls: classOf(s.segment) }));
    if (gs.length === 0) return null;
    let k = gs.findIndex((g) => g.end > at.col);
    if (k < 0) k = gs.length - 1;
    let a = k, z = k;
    while (a > 0 && gs[a - 1]!.cls === gs[k]!.cls) a--;
    while (z < gs.length - 1 && gs[z + 1]!.cls === gs[k]!.cls) z++;
    if (around && gs[k]!.cls !== "space") {
      if (z < gs.length - 1 && gs[z + 1]!.cls === "space") z++;
      else if (a > 0 && gs[a - 1]!.cls === "space") a--;
    }
    return range(at.row, gs[a]!.start, gs[z]!.end, lines);
  };
}

/** `is`: the sentence under the cursor; `as` adds the space after it (before it for the last sentence of the row). */
function sentenceObject(around: boolean): TextObject {
  return (lines, at) => {
    const line = lines[at.row]!;
    const spans = sentenceSpans(line);
    if (spans.length === 0) return null;
    const k = sentenceAt(spans, at.col);
    let [s, e] = spans[k]!;
    if (around) {
      if (k < spans.length - 1) e = spans[k + 1]![0];
      else if (k > 0) s = spans[k - 1]![1];
    }
    return range(at.row, s, e, lines);
  };
}

/** `ip`: the block of non-blank rows holding the cursor (the blank rows, on one); `ap` adds the blank rows after it (before it, at the end). */
function paragraphObject(around: boolean): TextObject {
  return (lines, at) => {
    let [a, z] = blockAt(lines, at.row);
    if (around) {
      if (z < lines.length - 1) z = blockAt(lines, z + 1)[1];
      else if (a > 0) a = blockAt(lines, a - 1)[0];
    }
    const last = lines[z]!;
    return { from: { row: a, col: 0 }, to: { row: z, col: lastBefore(last, last.length) } };
  };
}

/** The offsets of each double-quoted span in `line`: straight quotes pair up in order, curly ones nest. */
function quotePairs(line: string): [number, number][] {
  const pairs: [number, number][] = [];
  let straight: number | null = null;
  const curly: number[] = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') { if (straight === null) straight = i; else { pairs.push([straight, i]); straight = null; } }
    else if (c === "“") curly.push(i);
    else if (c === "”" && curly.length) pairs.push([curly.pop()!, i]);
  }
  return pairs.sort((a, b) => a[0] - b[0]);
}

/** `i"`/`a"`: the quote pair around the cursor on its row (else the next pair after it); `a"` takes the quote marks too. Empty quotes select nothing. */
function quoteObject(around: boolean): TextObject {
  return (lines, at) => {
    const line = lines[at.row]!;
    const pairs = quotePairs(line);
    const inside = pairs.filter(([o, c]) => o <= at.col && at.col <= c).sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]));
    const pair = inside[0] ?? pairs.find(([o]) => o > at.col);
    if (!pair) return null;
    return around ? range(at.row, pair[0], pair[1] + 1, lines) : range(at.row, pair[0] + 1, pair[1], lines);
  };
}

/** `i(`/`a(`: the innermost parentheses around the cursor, across rows; `a(` takes the parentheses too. */
function parenObject(around: boolean): TextObject {
  return (lines, at) => {
    // Walk back to the unmatched "(", then forward to its ")".
    let depth = 0;
    let open: Pos | null = null;
    scan: for (let r = at.row; r >= 0; r--) {
      const line = lines[r]!;
      for (let i = r === at.row ? at.col : line.length - 1; i >= 0; i--) {
        const c = line[i]!;
        if (c === ")" && !(r === at.row && i === at.col)) depth++;
        else if (c === "(") { if (depth === 0) { open = { row: r, col: i }; break scan; } depth--; }
      }
    }
    if (!open) return null;
    depth = 0;
    let close: Pos | null = null;
    scan: for (let r = open.row; r < lines.length; r++) {
      const line = lines[r]!;
      for (let i = r === open.row ? open.col + 1 : 0; i < line.length; i++) {
        const c = line[i]!;
        if (c === "(") depth++;
        else if (c === ")") { if (depth === 0) { close = { row: r, col: i }; break scan; } depth--; }
      }
    }
    if (!close) return null;
    if (around) return { from: open, to: close };
    // Inside: from the character after "(" to the one before ")", across rows.
    const from = open.col + 1 < lines[open.row]!.length ? { row: open.row, col: open.col + 1 } : { row: open.row + 1, col: 0 };
    const to = close.col > 0 ? { row: close.row, col: lastBefore(lines[close.row]!, close.col) } : { row: close.row - 1, col: lastBefore(lines[close.row - 1] ?? "", (lines[close.row - 1] ?? "").length) };
    const ordered = from.row < to.row || (from.row === to.row && from.col <= to.col);
    return ordered && from.row <= close.row ? { from, to } : null;
  };
}

/** The text objects, by the id of the key row that picks each (`i` or `a`, then the object's key, in select mode). */
export const TEXT_OBJECTS: Readonly<Record<string, TextObject>> = {
  "editor.inner_word": wordObject(false),
  "editor.around_word": wordObject(true),
  "editor.inner_sentence": sentenceObject(false),
  "editor.around_sentence": sentenceObject(true),
  "editor.inner_paragraph": paragraphObject(false),
  "editor.around_paragraph": paragraphObject(true),
  "editor.inner_quote": quoteObject(false),
  "editor.around_quote": quoteObject(true),
  "editor.inner_paren": parenObject(false),
  "editor.around_paren": parenObject(true),
};

/** Picks the object: select mode, the anchor at its start and the cursor on its last character; unchanged when there is none here. */
export function selectObject(id: string): ((t: EditText) => EditText) | null {
  const obj = TEXT_OBJECTS[id];
  if (!obj) return null;
  return (t) => {
    const r = obj(t.buffer.lines, t.buffer.cursor);
    if (!r) return t;
    return { ...apply(t, (b) => { b.cursor = r.to; }), mode: "select", anchor: r.from };
  };
}

// ---------------------------------------------------------------- the motions

/** The motions, by the id of the key row that runs them: `(` `)` by sentence, `{` `}` by paragraph. */
export const TEXT_MOTIONS: Readonly<Record<string, Move>> = {
  "editor.sentence_next": (b) => { const p = sentenceNext(b.lines, b.cursor); if (p) b.cursor = p; },
  "editor.sentence_prev": (b) => { const p = sentencePrev(b.lines, b.cursor); if (p) b.cursor = p; },
  "editor.paragraph_next": (b) => { b.cursor = paragraphNext(b.lines, b.cursor); },
  "editor.paragraph_prev": (b) => { b.cursor = paragraphPrev(b.lines, b.cursor); },
};
