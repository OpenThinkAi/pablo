// `v e` in place (AGT-2167, D-18/D-23): the editing pane's pure parts. The unit's file as the buffer (buffer.ts) holds
// it, back to the file on save, the rows the pane draws (the visible cursor, each `check` hit's box under its line) and a
// keypress as an edit. No Ink, no React: edit-pane-view.tsx draws what this returns and dispatches what it decides.
//
// The buffer holds the body, never the frontmatter: a `sentences` unit (a chapter, a story) one paragraph per line with a
// blank line between paragraphs; a `lines` unit (a radio script, a narrated reading) and a `screenplay` (Fountain) line
// for line, as stored. Loading and saving are AGT-2168's storage round-trip (edit-save.ts: `loadForEdit`, `saveEdited`):
// the frontmatter kept byte for byte, only changed paragraphs re-split. `saveText` is the one place the pane calls it.

import { splitManuscript } from "@openthink/pablo-core";
import { loadForEdit, saveEdited } from "./edit-save";
import type { Storage } from "./book";
import { TextBuffer, type Pos } from "./buffer";
import { tokenOf, type InkKey } from "./chord";
import { commentBox, type BoxPart } from "./comment-box";
import { hitComment, type CheckHit } from "./hits";
import { paragraphSpan, scrollTop, type Modes } from "./edit-modes";
import { visible } from "./sanitize";
import { matchesOnLine } from "./search";
import type { EditPaneText } from "./state";

/** What the screen asks the layer above for (the CLI's `screenEditPane`, passed in; this package cannot import it). */
/** `unmerged` (AGT-2173): commits an earlier session left on the branch that main does not have yet; the pane resumes them. */
export type PaneOpenResult = { readonly ok: true; readonly branch: string; readonly text: string; readonly unmerged?: number } | { readonly ok: false; readonly message: string };
export type PaneSaveResult = { readonly ok: true; readonly branch: string; readonly lines: readonly string[] } | { readonly ok: false; readonly message: string };
export interface PaneSession {
  /** Makes (or reuses: one per work) the `edit/` branch and its worktree, and reads the project-relative `file` there. */
  open(file: string): Promise<PaneOpenResult>;
  /** Writes `text` as the file on `branch` and commits it as the author (Ctrl+S, and the idle autosave: never main). */
  save(file: string, branch: string, text: string): Promise<PaneSaveResult>;
  /** The pane closed: a branch `open` made that never got a commit goes again. */
  close(branch: string): Promise<void>;
}

/** The model's opaque `EditPaneText` (`dirty`, and `empty` when the body is blank): the buffer, the file as last opened or saved, and how it is stored. */
export interface EditText extends EditPaneText {
  readonly buffer: TextBuffer;
  readonly raw: string;
  readonly storage: Storage;
  /** Where select mode's selection started (AGT-2169, modal.ts); null outside select mode. */
  readonly anchor?: Pos | null;
  /** The last search (AGT-2172, search.ts): its matches are highlighted and `n`/`N` step through them. */
  readonly search?: { readonly query: string } | null;
  /** A one-line prompt being typed (`/` or `R`); it takes every key until Enter or Esc. */
  readonly prompt?: { readonly kind: "search" | "find" | "with"; readonly text: string; readonly find?: string } | null;
  /** What the last search or replace did, for the title ("2 replacements", "no match"); any other edit of the text clears it. */
  readonly note?: string | null;
}

/** A file split for the pane: the frontmatter and the blank lines after it (`head`, kept byte for byte), then the body. */
interface Parts { readonly head: string; readonly headLines: number; readonly body: string }

function partsOf(raw: string): Parts {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  let start = 0;
  if (lines[0]?.replace(/^﻿/, "").trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (close > 0) start = close + 1;
  }
  while (start < lines.length - 1 && lines[start]!.trim() === "") start++;
  const body = lines.slice(start);
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  return { head: lines.slice(0, start).map((l) => `${l}\n`).join(""), headLines: start, body: body.join("\n") };
}

const asStorage = (storage: string): Storage => (storage === "lines" || storage === "screenplay" ? storage : "sentences");

/** The file `edited` (the buffer's text) saves as over `raw` (the file as opened): AGT-2168's `saveEdited`. */
export function saveText(raw: string, edited: string, storage: string): string {
  return saveEdited(raw, edited, asStorage(storage));
}

/**
 * The body lines `edited` reads as when every paragraph is split (`splitManuscript`, a block at a time): the text the
 * `check` hits are found in, so each can be placed under its paragraph. For each such line, the buffer row it comes from: a prose block's sentences belong to its last row (its paragraph), a block
 * that is not prose maps line to line, the blank line between blocks to the block before it.
 */
function storedRows(edited: string, storage: Storage): { stored: string[]; rowOf: number[] } {
  const rows = edited.split("\n");
  if (storage !== "sentences") return { stored: rows, rowOf: rows.map((_, i) => i) };
  const stored: string[] = [];
  const rowOf: number[] = [];
  let r = 0;
  while (r < rows.length) {
    if (/^[ \t]*$/.test(rows[r]!)) { r++; continue; }
    const first = r;
    while (r < rows.length && !/^[ \t]*$/.test(rows[r]!)) r++;
    const block = rows.slice(first, r).join("\n").trim();
    const out = splitManuscript(block);
    if (stored.length > 0) { stored.push(""); rowOf.push(rowOf[rowOf.length - 1]!); }
    const lines = out.split("\n");
    const prose = out !== block;
    lines.forEach((line, k) => { stored.push(line); rowOf.push(prose ? r - 1 : Math.min(first + k, r - 1)); });
  }
  return { stored, rowOf };
}

/** The pane's text for a file as opened: the body in the buffer, the cursor on the row that holds file line `line` (1-based, frontmatter counted). */
export function openText(raw: string, storage: string, line: number): EditText {
  const s = asStorage(storage);
  const { headLines } = partsOf(raw);
  const buffer = new TextBuffer(loadForEdit(raw, s).text);
  const { rowOf } = storedRows(buffer.text(), s);
  const at = line - 1 - headLines;
  const row = rowOf.length === 0 ? 0 : rowOf[Math.max(0, Math.min(at, rowOf.length - 1))]!;
  buffer.cursor = { row, col: 0 };
  return { buffer, raw, storage: s, dirty: false, empty: blankText(buffer), mode: "normal", anchor: null };
}

/** `t` with its buffer copied and `op` applied to the copy; the state's own text is never changed. */
export function apply(t: EditText, op: (b: TextBuffer) => void): EditText {
  const buffer = t.buffer.clone();
  op(buffer);
  return { ...t, buffer, dirty: buffer.dirty, empty: blankText(buffer), note: null };
}

/** A body with nothing but whitespace: saving it would leave the file its frontmatter alone, so the pane asks first. */
const blankText = (b: TextBuffer) => b.lines.every((l) => l.trim() === "");

/** After a save: `edited` (the buffer's text that was saved) is the clean state and `raw` the file it became. */
export function savedEdit(edited: string, raw: string): (t: EditPaneText) => EditPaneText {
  return (t) => ({ ...apply(t as EditText, (b) => b.saved(edited)), raw });
}

/**
 * A keypress in the pane as an edit of its text, or null for a key the pane does not use. Ctrl+S and Esc are the
 * view's (a save, a close); everything else is here: arrows, Home/End, paging, Backspace, Enter, Ctrl+Z/Ctrl+Y, text.
 * `width` and `height` are the pane's, for moves by display row.
 */
export function paneKey(input: string, key: InkKey, width: number, height: number): ((t: EditPaneText) => EditPaneText) | null {
  const op = keyOp(input, key, width, height);
  return op ? (t) => apply(t as EditText, op) : null;
}

function keyOp(input: string, key: InkKey, width: number, height: number): ((b: TextBuffer) => void) | null {
  const token = tokenOf(input, key);
  const times = (n: number, f: (b: TextBuffer) => void) => (b: TextBuffer) => { for (let i = 0; i < n; i++) f(b); };
  switch (token) {
    case "left": return (b) => b.left();
    case "right": return (b) => b.right();
    case "up": return (b) => b.up(width);
    case "down": return (b) => b.down(width);
    case "home": return (b) => b.home(width);
    case "end": return (b) => b.end(width);
    case "pgup": return times(Math.max(1, height - 1), (b) => b.up(width));
    case "pgdn": return times(Math.max(1, height - 1), (b) => b.down(width));
    // Ink reads the Backspace key (\x7f) as `delete` on most terminals; both are backspace here, as in chord.ts.
    case "backspace": return (b) => b.backspace();
    case "enter": return (b) => b.insert("\n");
    case "space": return (b) => b.insert(" ");
    case "ctrl-z": return (b) => { b.undo(); };
    case "ctrl-y": return (b) => { b.redo(); };
  }
  if (key.ctrl || key.meta || key.escape || input === "") return null;
  // A single character is its own token; a paste is several characters and no token. Anything else named is not text.
  if (token !== null && token !== input) return null;
  return (b) => b.insert(input);
}

/** The check hits on the text as it would save, by the buffer row each sits under. */
export function paneHits(t: EditText, file: string, checks: ((file: string, text: string) => readonly CheckHit[]) | undefined): Map<number, CheckHit[]> {
  const under = new Map<number, CheckHit[]>();
  if (!checks) return under;
  const { head, headLines } = partsOf(t.raw);
  const { stored, rowOf } = storedRows(t.buffer.text(), t.storage);
  const last = Math.max(0, t.buffer.lines.length - 1);
  for (const hit of checks(file, `${head}${stored.join("\n")}\n`)) {
    const at = hit.line - 1 - headLines;
    const row = rowOf.length === 0 ? 0 : at < 0 ? 0 : rowOf[Math.min(at, rowOf.length - 1)] ?? last;
    under.set(row, [...(under.get(row) ?? []), hit]);
  }
  return under;
}

/** A row the pane draws: a display row of the text (the cursor's split around the character it is on), or a hit's box row. */
export type PaneRow =
  | { readonly kind: "text"; readonly text: string; readonly cursor?: { readonly before: string; readonly at: string; readonly after: string }; readonly parts?: readonly TextPart[]; readonly dim?: true }
  | { readonly kind: "box"; readonly part: BoxPart; readonly text: string; readonly head?: string; readonly tag?: string; readonly color: string; readonly dim?: true };

/** How the pane is scrolled and which modes (edit-modes.ts) shape it. `top` is the first display row of the last draw. */
export interface PaneLook extends Partial<Modes> { readonly top?: number }

/** A run of a display row inside or around select mode's selection (AGT-2169): `sel` drawn as selected, `cursor` as the cursor. */
export interface TextPart { readonly text: string; readonly sel?: boolean; readonly cursor?: boolean; /** A search match (AGT-2172). */ readonly match?: boolean }

const INDENT = 2;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Text as the pane shows it: a tab one space, any other control character its visible stand-in. */
const shown = (s: string) => visible(s.replace(/\t/g, " "));

/**
 * Select mode's selection on line `r` (AGT-2169): `[start, end)` offsets from the anchor to the cursor, the character
 * at each end included as Helix does; an `end` past the line's length takes in its end. Null off the selection.
 */
function selectedCols(t: EditText, r: number): readonly [number, number] | null {
  if (t.mode !== "select" || !t.anchor) return null;
  const b = t.buffer;
  const row = Math.min(t.anchor.row, b.lines.length - 1);
  const a = { row, col: Math.min(t.anchor.col, b.lines[row]!.length) };
  const c = b.cursor;
  const [from, to] = a.row < c.row || (a.row === c.row && a.col <= c.col) ? [a, c] : [c, a];
  if (r < from.row || r > to.row) return null;
  const line = b.lines[r]!;
  return [r === from.row ? from.col : 0, r === to.row ? graphemeEnd(line, to.col) : line.length + 1];
}

/** The offset after the grapheme at `col` in `line` (one past the end at the end: the line's end is a cell too). */
function graphemeEnd(line: string, col: number): number {
  if (col >= line.length) return line.length + 1;
  const next = graphemes.segment(line.slice(col))[Symbol.iterator]().next();
  return col + (next.done ? 1 : next.value.segment.length);
}

/** The display row `[start, end)` of `line` cut into runs by `sel` and the cursor at `cursor` (null: not on this row). */
function selectedParts(line: string, start: number, end: number, cursor: number | null, sel: readonly [number, number], matches: readonly { readonly start: number; readonly end: number }[] = []): TextPart[] {
  const cells: { text: string; sel: boolean; cursor: boolean; match: boolean }[] = [];
  for (const { segment, index } of graphemes.segment(line.slice(start, end))) {
    const at = start + index;
    cells.push({ text: segment, sel: at >= sel[0] && at < sel[1], cursor: at === cursor, match: matches.some((m) => at >= m.start && at < m.end) });
  }
  // The cursor past the row's last character is a cell of its own, as in the rows without a selection.
  if (cursor !== null && cursor >= end) cells.push({ text: " ", sel: end >= sel[0] && end < sel[1], cursor: true, match: false });
  const parts: TextPart[] = [];
  for (const c of cells) {
    const last = parts[parts.length - 1];
    if (last && !c.cursor && !last.cursor && !!last.sel === c.sel && !!last.match === c.match) parts[parts.length - 1] = { ...last, text: last.text + c.text };
    else parts.push({ text: c.text, ...(c.sel ? { sel: true } : {}), ...(c.match ? { match: true } : {}), ...(c.cursor ? { cursor: true } : {}) });
  }
  return parts.map((p) => ({ ...p, text: shown(p.text) }));
}

/**
 * The `height` rows the pane shows at `width`, and the scroll they were drawn at: every display row of the buffer, each
 * hit's box under its paragraph, scrolled so the cursor's row is on screen (`scrollTop`: from `look.top`, counted in
 * these rows, boxes included; centred in typewriter mode). Pure: the caller keeps the returned `top` for the next draw.
 * Focus mode marks every row outside the cursor's paragraph (its boxes too) `dim`.
 */
export function paneView(t: EditText, width: number, height: number, hits: ReadonlyMap<number, readonly CheckHit[]>, look: PaneLook = {}): { rows: PaneRow[]; top: number } {
  const b = t.buffer;
  const all: PaneRow[] = [];
  const source: number[] = [];
  let cursorAt = 0;
  for (let r = 0; r < b.lines.length; r++) {
    const line = b.lines[r]!;
    const segs = b.segments(r, width);
    const sel = selectedCols(t, r);
    const found = t.search ? matchesOnLine(line, t.search.query) : [];
    segs.forEach((seg, i) => {
      const text = line.slice(seg.start, seg.end);
      const here = r === b.cursor.row && b.cursor.col >= seg.start && (b.cursor.col < seg.end || i === segs.length - 1);
      source.push(r);
      const matched = found.some((m) => m.start < seg.end && m.end > seg.start);
      if ((sel && sel[0] <= seg.end && sel[1] > seg.start) || matched) {
        if (here) cursorAt = all.length;
        return void all.push({ kind: "text", text: shown(text), parts: selectedParts(line, seg.start, seg.end, here ? b.cursor.col : null, sel ?? [0, 0], found) });
      }
      if (!here) return void all.push({ kind: "text", text: shown(text) });
      cursorAt = all.length;
      const off = b.cursor.col - seg.start;
      const next = graphemes.segment(text.slice(off))[Symbol.iterator]().next();
      const at = next.done ? "" : next.value.segment;
      all.push({ kind: "text", text: shown(text), cursor: { before: shown(text.slice(0, off)), at: at === "" ? " " : shown(at), after: shown(text.slice(off + at.length)) } });
    });
    for (const hit of hits.get(r) ?? []) {
      const c = hitComment(hit);
      for (const box of commentBox(c, Math.max(5, width - INDENT))) {
        source.push(r);
        all.push({ kind: "box", part: box.part, text: `${" ".repeat(INDENT)}${box.text}`, ...(box.head !== undefined ? { head: `${" ".repeat(INDENT)}${box.head}` } : {}), ...(box.tag ? { tag: box.tag } : {}), color: c.color ?? "gray" });
      }
    }
  }
  const focused = look.focus === true ? paragraphSpan(b.lines, b.cursor.row) : null;
  const marked = focused ? all.map((row, i): PaneRow => (source[i]! >= focused.first && source[i]! <= focused.last ? row : { ...row, dim: true })) : all;
  const h = Math.max(1, height);
  const top = scrollTop(look.top ?? b.top, cursorAt, h, marked.length, look.typewriter === true);
  const rows: PaneRow[] = [];
  for (let i = top; i < top + h; i++) rows.push(marked[i] ?? { kind: "text", text: "" });
  // Normal scrolling stops at the last row, so a short document never shows blank padding; typewriter pads on purpose.
  const shownRows = look.typewriter === true ? rows : marked.slice(top, top + h);
  return { rows: shownRows, top };
}

/** `paneView`'s rows alone, scrolled from the buffer's own `top` (read, never written). */
export const paneRows = (t: EditText, width: number, height: number, hits: ReadonlyMap<number, readonly CheckHit[]>, look: PaneLook = {}): PaneRow[] => paneView(t, width, height, hits, look).rows;
