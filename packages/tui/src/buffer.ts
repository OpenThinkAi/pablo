// pablo's own text buffer (D-23), pure: no Ink, no React, so an editor pane is only a view of it. Carried over from
// the AGT-2149 spike (prototype A) and made grapheme- and cell-aware: logical lines (one paragraph per line), a cursor
// that is a UTF-16 offset into its line but only ever moves by whole graphemes (`Intl.Segmenter`), word soft-wrap to
// the pane width measured in terminal cells (`string-width`, the measure Ink itself uses), a viewport that follows the
// cursor, and undo/redo by snapshot with typing coalesced into word-sized steps (or grouped into one: an insert session, an operator, AGT-2171).
//
// One cell is reserved at the right edge for the end-of-line cursor.

import stringWidth from "string-width";

export interface Pos { readonly row: number; readonly col: number }
/** One display row of a logical line: `[start, end)` in that line's text (UTF-16 offsets on grapheme boundaries). */
export interface Segment { readonly start: number; readonly end: number }
/** What the pane draws: the visible rows' text and where the cursor sits among them (`x` in cells). */
export interface View { readonly rows: readonly string[]; readonly cursor: { readonly x: number; readonly y: number }; readonly top: number; readonly total: number }

/** One user-perceived character: `[start, end)` in its line and the terminal cells it takes. */
interface Grapheme { readonly start: number; readonly end: number; readonly width: number; readonly space: boolean }

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** `line` as graphemes with their offsets and cell widths. */
function graphemesOf(line: string): Grapheme[] {
  const out: Grapheme[] = [];
  for (const { segment, index } of segmenter.segment(line)) {
    out.push({ start: index, end: index + segment.length, width: stringWidth(segment), space: segment === " " });
  }
  return out;
}

/** The cells `text` takes in a terminal. */
export function cellWidth(text: string): number { return stringWidth(text); }

/**
 * `line` soft-wrapped on spaces to rows of at most `width` cells (plus the one space a row breaks at, which may sit in
 * the reserved column); the space a row breaks at stays at the end of that row, so the segments cover the line with no
 * gaps (a cursor offset always lands in exactly one segment). A word wider than the row is broken between graphemes,
 * never inside one, and a row always takes at least one grapheme, so a wide character in a one-cell pane still moves on.
 */
export function wrapLine(line: string, width: number): Segment[] {
  return wrapGraphemes(line, graphemesOf(line), width);
}

function wrapGraphemes(line: string, gs: readonly Grapheme[], width: number): Segment[] {
  const w = Math.max(1, width);
  const out: Segment[] = [];
  // cum[i] = cells taken by graphemes [0, i).
  const cum = [0];
  for (const g of gs) cum.push(cum[cum.length - 1]! + g.width);
  let s = 0; // first grapheme of the current row
  // A lone grapheme wider than the row is the last row as it is (no empty row after it).
  while (cum[gs.length]! - cum[s]! > w && gs.length - s > 1) {
    // i: the first grapheme that does not fit on this row.
    let i = s;
    while (i < gs.length && cum[i + 1]! - cum[s]! <= w) i++;
    let e: number; // first grapheme of the next row
    if (gs[i]!.space) e = i + 1; // a break at the overflowing space keeps the space on this row
    else {
      let p = i - 1;
      while (p >= s && !gs[p]!.space) p--;
      e = p >= s ? p + 1 : Math.max(i, s + 1);
    }
    out.push({ start: gs[s]!.start, end: e < gs.length ? gs[e]!.start : line.length });
    s = e;
  }
  out.push({ start: s < gs.length ? gs[s]!.start : line.length, end: line.length });
  return out;
}

interface Snapshot { readonly lines: readonly string[]; readonly cursor: Pos }
type EditKind = "insert" | "delete" | null;

const CACHE_LIMIT = 4096;

export class TextBuffer {
  lines: string[];
  private at: Pos = { row: 0, col: 0 };
  /** The first visible display row; moved by `view` to keep the cursor on screen. */
  top = 0;
  dirty = false;
  /** The cell column vertical moves aim for, kept across a run of up/down. */
  private goal: number | null = null;
  private undos: Snapshot[] = [];
  private redos: Snapshot[] = [];
  private lastKind: EditKind = null;
  /** Open undo groups (AGT-2171): while one is open every edit joins one undo step, pushed at the group's first edit. */
  private groupDepth = 0;
  private groupStepped = false;
  private wrapCache = new Map<string, Segment[]>();
  private wrapWidth = -1;
  private graphemeCache = new Map<string, Grapheme[]>();
  /** The text as last saved (or opened): `dirty` is whether the buffer differs from it, so undoing back to it is clean. */
  private savedText: string;

  /** CRLF and lone CR line ends read as "\n", so no zero-width "\r" is left at the end of a line. */
  constructor(text: string) {
    this.lines = text.split(/\r\n?|\n/);
    this.savedText = this.text();
  }

  /** The cursor. Setting it is a move: the goal column of a run of up/down and the open undo step both end. */
  get cursor(): Pos { return this.at; }
  set cursor(to: Pos) { this.move(to); }

  /** A copy that edits independently: the screen's model swaps buffers rather than mutating the one it holds. */
  clone(): TextBuffer {
    const b = Object.create(TextBuffer.prototype) as TextBuffer;
    Object.assign(b, this);
    b.lines = [...this.lines];
    b.undos = [...this.undos];
    b.redos = [...this.redos];
    return b;
  }

  text(): string { return this.lines.join("\n"); }

  // --- editing -------------------------------------------------------------------------------------------------

  /** Inserts `s` at the cursor; "\n" in it splits the line. */
  insert(text: string): void {
    const s = text.replace(/\r\n?/g, "\n");
    if (!s) return;
    // A new undo step at the start of each word: typing "the cat" is two steps ("the ", "cat"), not seven.
    this.checkpoint("insert", !/^\s/.test(s) && /\s/.test(this.charBefore()));
    const { row, col } = this.cursor;
    const line = this.lines[row]!;
    const parts = (line.slice(0, col) + s + line.slice(col)).split("\n");
    const tailLen = line.length - col;
    this.lines.splice(row, 1, ...parts);
    const last = row + parts.length - 1;
    this.at = { row: last, col: this.lines[last]!.length - tailLen };
    this.edited();
  }

  /** Deletes the grapheme before the cursor, or joins the line to the previous one at its start. */
  backspace(): void {
    const { row, col } = this.cursor;
    if (row === 0 && col === 0) return;
    this.checkpoint("delete");
    if (col > 0) {
      const line = this.lines[row]!;
      const from = this.prevBoundary(row, col);
      this.lines[row] = line.slice(0, from) + line.slice(col);
      this.at = { row, col: from };
    } else {
      const prev = this.lines[row - 1]!;
      this.lines.splice(row - 1, 2, prev + this.lines[row]!);
      this.at = { row: row - 1, col: prev.length };
    }
    this.edited();
  }

  /** Deletes the grapheme under the cursor, or joins the next line at the end of this one. */
  deleteForward(): void {
    const { row, col } = this.cursor;
    const line = this.lines[row]!;
    if (col >= line.length && row >= this.lines.length - 1) return;
    this.checkpoint("delete");
    if (col < line.length) this.lines[row] = line.slice(0, col) + line.slice(this.nextBoundary(row, col));
    else this.lines.splice(row, 2, line + this.lines[row + 1]!);
    this.edited();
  }

  /** The text from `from` up to `to` (exclusive), in document order whichever way round they are given. */
  slice(from: Pos, to: Pos): string {
    const [a, b] = this.ordered(from, to);
    if (a.row === b.row) return this.lines[a.row]!.slice(a.col, b.col);
    return [this.lines[a.row]!.slice(a.col), ...this.lines.slice(a.row + 1, b.row), this.lines[b.row]!.slice(0, b.col)].join("\n");
  }

  /** Deletes from `from` up to `to` (exclusive) and puts the cursor where it began; returns the text it took. */
  deleteRange(from: Pos, to: Pos): string {
    const [a, b] = this.ordered(from, to);
    if (a.row === b.row && a.col === b.col) return "";
    const gone = this.slice(a, b);
    this.checkpoint("delete");
    this.lines.splice(a.row, b.row - a.row + 1, this.lines[a.row]!.slice(0, a.col) + this.lines[b.row]!.slice(b.col));
    this.at = a;
    this.edited();
    return gone;
  }

  /**
   * Where the character at `p` ends: after its grapheme, or at the start of the next line from a line's end (the line
   * break is a character too), or `p` itself at the end of the document.
   */
  charEnd(p: Pos): Pos {
    const { row, col } = this.clampPos(p);
    if (col < this.lines[row]!.length) return { row, col: this.nextBoundary(row, col) };
    return row < this.lines.length - 1 ? { row: row + 1, col: 0 } : { row, col };
  }

  /** `p` kept inside the document. */
  clampPos(p: Pos): Pos {
    const row = Math.max(0, Math.min(p.row, this.lines.length - 1));
    return { row, col: Math.max(0, Math.min(p.col, this.lines[row]!.length)) };
  }

  /**
   * Undo grouping (AGT-2171): every edit between `beginGroup` and its `endGroup` undoes as one step (an insert-mode
   * session, an operator, a replace-all). Groups nest; the step is the outermost one's. An undo, redo or save inside a
   * group ends the step it was building, so later edits in the group make a new one.
   */
  beginGroup(): void {
    if (this.groupDepth++ === 0) { this.groupStepped = false; this.lastKind = null; }
  }
  endGroup(): void {
    if (this.groupDepth === 0) return;
    if (--this.groupDepth === 0) this.lastKind = null;
  }
  /** Runs `edit` as one undo step. */
  group<T>(edit: () => T): T {
    this.beginGroup();
    try { return edit(); } finally { this.endGroup(); }
  }

  undo(): boolean { return this.swap(this.undos, this.redos); }
  redo(): boolean { return this.swap(this.redos, this.undos); }

  /**
   * Marks `text` (default: the buffer as it is) as what is saved: the next edit starts a fresh undo step, inside an open
   * group too (an autosave mid insert session), so undo can always come back to the saved text. A save that
   * finishes after more typing passes the text it wrote, so the buffer stays dirty with what came after.
   */
  saved(text: string = this.text()): void { this.savedText = text; this.dirty = this.text() !== text; this.lastKind = null; this.groupStepped = false; }

  // --- movement ------------------------------------------------------------------------------------------------

  /** One visible character left (a whole grapheme), wrapping to the end of the previous line. */
  left(): void {
    const { row, col } = this.cursor;
    this.move(col > 0 ? { row, col: this.prevBoundary(row, col) } : row > 0 ? { row: row - 1, col: this.lines[row - 1]!.length } : this.cursor);
  }
  /** One visible character right (a whole grapheme), wrapping to the start of the next line. */
  right(): void {
    const { row, col } = this.cursor;
    this.move(col < this.lines[row]!.length ? { row, col: this.nextBoundary(row, col) } : row < this.lines.length - 1 ? { row: row + 1, col: 0 } : this.cursor);
  }
  home(width: number): void { const seg = this.segmentAt(width); this.move({ row: this.cursor.row, col: seg.seg.start }); }
  end(width: number): void {
    const { seg, segs, index } = this.segmentAt(width);
    // On a wrapped row, the end is the last grapheme before the break (the break space belongs to the next position).
    this.move({ row: this.cursor.row, col: index === segs.length - 1 ? seg.end : Math.max(seg.start, this.prevBoundary(this.cursor.row, seg.end)) });
  }
  /** One display row up or down, keeping the cell column the cursor had before the run of vertical moves began. */
  up(width: number): void { this.vertical(width, -1); }
  down(width: number): void { this.vertical(width, 1); }

  // --- layout --------------------------------------------------------------------------------------------------

  /** The display rows of logical line `row` at `width` cells (cached by text, so only an edited line re-wraps). */
  segments(row: number, width: number): Segment[] {
    const w = Math.max(1, width - 1); // one cell kept free for the cursor at the end of a full row
    if (w !== this.wrapWidth) { this.wrapCache.clear(); this.wrapWidth = w; }
    const line = this.lines[row]!;
    let segs = this.wrapCache.get(line);
    if (!segs) {
      segs = wrapGraphemes(line, this.graphemes(row), w);
      if (this.wrapCache.size > CACHE_LIMIT) this.wrapCache.clear();
      this.wrapCache.set(line, segs);
    }
    return segs;
  }

  /** The cursor's display row (counted from the top of the document) and cell column. */
  visualCursor(width: number): { y: number; x: number } {
    let y = 0;
    for (let r = 0; r < this.cursor.row; r++) y += this.segments(r, width).length;
    const { seg, index } = this.segmentAt(width);
    return { y: y + index, x: stringWidth(this.lines[this.cursor.row]!.slice(seg.start, this.cursor.col)) };
  }

  /** The `height` display rows the pane shows at `width`, scrolled so the cursor is on one of them. */
  view(width: number, height: number): View {
    const cur = this.visualCursor(width);
    if (cur.y < this.top) this.top = cur.y;
    if (cur.y >= this.top + height) this.top = cur.y - height + 1;
    const rows: string[] = [];
    let y = 0;
    let total = 0;
    for (let r = 0; r < this.lines.length; r++) {
      const segs = this.segments(r, width);
      total += segs.length;
      if (y + segs.length <= this.top || rows.length >= height) { y += segs.length; continue; }
      for (const s of segs) {
        if (y >= this.top && rows.length < height) rows.push(this.lines[r]!.slice(s.start, s.end));
        y++;
      }
    }
    return { rows, cursor: { x: cur.x, y: cur.y - this.top }, top: this.top, total };
  }

  // --- internals -----------------------------------------------------------------------------------------------

  /** Line `row`'s graphemes (cached by text). */
  private graphemes(row: number): Grapheme[] {
    const line = this.lines[row]!;
    let gs = this.graphemeCache.get(line);
    if (!gs) {
      gs = graphemesOf(line);
      if (this.graphemeCache.size > CACHE_LIMIT) this.graphemeCache.clear();
      this.graphemeCache.set(line, gs);
    }
    return gs;
  }

  /** The grapheme boundary before offset `col` in line `row` (0 at the start). */
  private prevBoundary(row: number, col: number): number {
    let at = 0;
    for (const g of this.graphemes(row)) {
      if (g.start >= col) break;
      at = g.start;
    }
    return at;
  }

  /** The grapheme boundary after offset `col` in line `row` (the line's length at the end). */
  private nextBoundary(row: number, col: number): number {
    for (const g of this.graphemes(row)) if (g.end > col) return g.end;
    return this.lines[row]!.length;
  }

  private segmentAt(width: number): { seg: Segment; segs: Segment[]; index: number } {
    const segs = this.segments(this.cursor.row, width);
    const col = this.cursor.col;
    // An offset on a row boundary belongs to the next row, except at the end of the line.
    let index = segs.findIndex((s, i) => col >= s.start && (col < s.end || i === segs.length - 1));
    if (index < 0) index = segs.length - 1;
    return { seg: segs[index]!, segs, index };
  }

  private vertical(width: number, dir: 1 | -1): void {
    const { seg, segs, index } = this.segmentAt(width);
    const goal = this.goal ?? stringWidth(this.lines[this.cursor.row]!.slice(seg.start, this.cursor.col));
    let row = this.cursor.row;
    let target: { segs: Segment[]; index: number };
    if (index + dir >= 0 && index + dir < segs.length) target = { segs, index: index + dir };
    else {
      row += dir;
      if (row < 0 || row >= this.lines.length) return;
      const s = this.segments(row, width);
      target = { segs: s, index: dir > 0 ? 0 : s.length - 1 };
    }
    const t = target.segs[target.index]!;
    const last = target.index === target.segs.length - 1;
    // Walk the target row's graphemes while they fit in the goal; a wrapped row stops before its last grapheme
    // (the break), so the cursor never lands on the next row's start.
    const inRow = this.graphemes(row).filter((g) => g.start >= t.start && g.end <= t.end);
    const stops = last ? inRow.length : Math.max(0, inRow.length - 1);
    let col = t.start;
    let cells = 0;
    for (let i = 0; i < stops; i++) {
      const g = inRow[i]!;
      if (cells + g.width > goal) break;
      cells += g.width;
      col = g.end;
    }
    this.at = { row, col };
    this.goal = goal;
    this.lastKind = null;
  }

  private move(to: Pos): void {
    this.at = this.clampPos(to);
    this.goal = null;
    this.lastKind = null;
  }

  private charBefore(): string { return this.lines[this.cursor.row]!.charAt(this.cursor.col - 1); }

  private ordered(from: Pos, to: Pos): [Pos, Pos] {
    const a = this.clampPos(from), b = this.clampPos(to);
    return a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
  }

  private checkpoint(kind: Exclude<EditKind, null>, wordStart = false): void {
    const step = this.groupDepth > 0 ? !this.groupStepped : kind !== this.lastKind || wordStart;
    if (this.groupDepth > 0) this.groupStepped = true;
    if (step) {
      this.undos.push({ lines: [...this.lines], cursor: this.cursor });
      if (this.undos.length > 1000) this.undos.shift();
    }
    this.redos = [];
    this.lastKind = kind;
  }

  private edited(): void { this.dirty = true; this.goal = null; }

  private swap(from: Snapshot[], to: Snapshot[]): boolean {
    const snap = from.pop();
    if (!snap) return false;
    to.push({ lines: [...this.lines], cursor: this.cursor });
    this.lines = [...snap.lines];
    this.at = snap.cursor;
    this.lastKind = null;
    this.goal = null;
    this.groupStepped = false;
    this.dirty = this.text() !== this.savedText;
    return true;
  }
}
