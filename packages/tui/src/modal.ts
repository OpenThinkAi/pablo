// The editing pane's modes (AGT-2169, D-18): Helix-style normal, insert and select, and the motions that move the cursor.
// Pure, like edit-pane.ts: a keypress, in the pane's mode with the model's pending prefix, becomes the actions to
// dispatch. Normal and select mode resolve keys through the same rows as the rest of the screen (keys.ts, the `editor.*`
// rows, through chord.ts's `resolve`), so the key panel lists them and the author's `keys` config rebinds them; insert
// mode types (edit-pane.ts's `paneKey`). Esc is never a row: it backs out a mode at a time, and in normal mode closes.
//
// A motion moves a buffer's cursor and nothing else, so the operators and text objects built on this (AGT-2170..2172)
// can run one and take the range between the cursor before and after it. In select mode the cursor moves and the
// anchor stays: the selection is everything between them, both ends' characters included.

import type { Pos, TextBuffer } from "./buffer";
import { resolve, tokenOf, type InkKey } from "./chord";
import { apply, paneKey, type EditText } from "./edit-pane";
import type { Keymap } from "./keys";
import type { Action, EditMode, EditPaneText, Pending } from "./state";

/** The mode as the pane's title shows it, as Helix's status line does. */
export const MODE_TAG: Readonly<Record<EditMode, string>> = { normal: "NOR", insert: "INS", select: "SEL" };

export const modeOf = (t: EditPaneText | null | undefined): EditMode => t?.mode ?? "normal";

/** What a motion needs from the pane: its text width, for moves by display row. */
export interface MotionContext { readonly width: number; readonly height: number }
export type Motion = (b: TextBuffer, c: MotionContext) => void;

// ---------------------------------------------------------------- words

/** A grapheme's class for word motions: a run of one class is a word (letters and digits, or punctuation); space between. */
const Cls = { Space: 0, Word: 1, Punct: 2 } as const;
type Cls = (typeof Cls)[keyof typeof Cls];
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const classOf = (g: string): Cls => (/^\s/u.test(g) ? Cls.Space : /^[\p{L}\p{N}\p{M}_]/u.test(g) ? Cls.Word : Cls.Punct);

interface G { readonly start: number; readonly cls: Cls }
/** The document as word motions walk it: each line's graphemes, then its end (a space, as a newline is). */
class Walker {
  private cache = new Map<number, G[]>();
  constructor(private readonly lines: readonly string[]) {}
  private gs(row: number): G[] {
    let g = this.cache.get(row);
    if (!g) {
      g = [...segmenter.segment(this.lines[row]!)].map(({ segment, index }) => ({ start: index, cls: classOf(segment) }));
      this.cache.set(row, g);
    }
    return g;
  }
  /** A position: line `row`, grapheme `i` (its length: the line's end). */
  at(p: Pos): { row: number; i: number } {
    const gs = this.gs(p.row);
    const i = gs.findIndex((g) => g.start >= p.col);
    return { row: p.row, i: i < 0 ? gs.length : gs[i]!.start === p.col ? i : Math.max(0, i - 1) };
  }
  pos(w: { row: number; i: number }): Pos {
    const gs = this.gs(w.row);
    return { row: w.row, col: w.i < gs.length ? gs[w.i]!.start : this.lines[w.row]!.length };
  }
  cls(w: { row: number; i: number }): Cls { return this.gs(w.row)[w.i]?.cls ?? Cls.Space; }
  next(w: { row: number; i: number }): { row: number; i: number } | null {
    if (w.i < this.gs(w.row).length) return { row: w.row, i: w.i + 1 };
    return w.row < this.lines.length - 1 ? { row: w.row + 1, i: 0 } : null;
  }
  prev(w: { row: number; i: number }): { row: number; i: number } | null {
    if (w.i > 0) return { row: w.row, i: w.i - 1 };
    return w.row > 0 ? { row: w.row - 1, i: this.gs(w.row - 1).length } : null;
  }
}

/** The start of the next word: past the rest of this one, then past the space (line ends included) after it. */
export function wordNext(lines: readonly string[], from: Pos): Pos {
  const d = new Walker(lines);
  let w = d.at(from);
  const c = d.cls(w);
  let n: ReturnType<Walker["next"]>;
  if (c !== Cls.Space) while ((n = d.next(w)) && d.cls(n) === c) w = n;
  while ((n = d.next(w))) { w = n; if (d.cls(w) !== Cls.Space) break; }
  return d.pos(w);
}

/** The last character of the word: of this one if the cursor is not already on its end, else of the next. */
export function wordEnd(lines: readonly string[], from: Pos): Pos {
  const d = new Walker(lines);
  let w = d.at(from);
  let n = d.next(w);
  if (!n) return d.pos(w);
  w = n;
  while (d.cls(w) === Cls.Space && (n = d.next(w))) w = n;
  const c = d.cls(w);
  while ((n = d.next(w)) && d.cls(n) === c && c !== Cls.Space) w = n;
  return d.pos(w);
}

/** The start of the word: of this one if the cursor is not already on its start, else of the previous. */
export function wordPrev(lines: readonly string[], from: Pos): Pos {
  const d = new Walker(lines);
  let w = d.at(from);
  let p = d.prev(w);
  if (!p) return d.pos(w);
  w = p;
  while (d.cls(w) === Cls.Space && (p = d.prev(w))) w = p;
  const c = d.cls(w);
  while ((p = d.prev(w)) && d.cls(p) === c && c !== Cls.Space) w = p;
  return d.pos(w);
}

/** The start of the last grapheme of `line` (0 on an empty one): where `$` puts the cursor. */
function lastChar(line: string): number {
  let last = 0;
  for (const { index } of segmenter.segment(line)) last = index;
  return last;
}

// ---------------------------------------------------------------- the rows' ids to what they do

/** The motions, by the id of the key row that runs them. */
export const MOTIONS: Readonly<Record<string, Motion>> = {
  "editor.left": (b) => b.left(),
  "editor.right": (b) => b.right(),
  "editor.up": (b, c) => b.up(c.width),
  "editor.down": (b, c) => b.down(c.width),
  "editor.word_next": (b) => { b.cursor = wordNext(b.lines, b.cursor); },
  "editor.word_prev": (b) => { b.cursor = wordPrev(b.lines, b.cursor); },
  "editor.word_end": (b) => { b.cursor = wordEnd(b.lines, b.cursor); },
  "editor.line_start": (b) => { b.cursor = { row: b.cursor.row, col: 0 }; },
  "editor.line_end": (b) => { b.cursor = { row: b.cursor.row, col: lastChar(b.lines[b.cursor.row]!) }; },
  "editor.top": (b) => { b.cursor = { row: 0, col: 0 }; },
  "editor.bottom": (b) => { b.cursor = { row: b.lines.length - 1, col: 0 }; },
};

type Edit = (t: EditPaneText) => EditPaneText;
const toMode = (t: EditText, mode: EditMode, anchor: Pos | null = null): EditText => ({ ...t, mode, anchor });

/** The keys that change mode, by row id: each a whole edit of the pane's text (the buffer copied as `paneKey` does). */
export const MODE_KEYS: Readonly<Record<string, (t: EditText) => EditText>> = {
  "editor.insert": (t) => toMode(t, "insert"),
  "editor.append": (t) => toMode(apply(t, (b) => { if (b.cursor.col < b.lines[b.cursor.row]!.length) b.right(); }), "insert"),
  "editor.open_below": (t) => toMode(apply(t, (b) => { b.cursor = { row: b.cursor.row, col: b.lines[b.cursor.row]!.length }; b.insert("\n"); }), "insert"),
  "editor.select": (t) => (modeOf(t) === "select" ? toMode(t, "normal") : toMode(t, "select", t.buffer.cursor)),
};

/** The edit a row id makes, or null for an id that is not the pane's. */
export function modalEdit(id: string, c: MotionContext): Edit | null {
  const motion = MOTIONS[id];
  if (motion) return (t) => apply(t as EditText, (b) => motion(b, c));
  const mode = MODE_KEYS[id];
  return mode ? (t) => mode(t as EditText) : null;
}

/** Back to normal mode from insert or select (the selection goes). */
export const toNormal: Edit = (t) => toMode(t as EditText, "normal");

/** Keys normal and select mode still take from `paneKey` when no row has them: paging, and undo and redo. */
const PASSED = new Set(["pgup", "pgdn", "ctrl-z", "ctrl-y"]);

/**
 * A keypress in the pane, in its mode, as the actions to dispatch; `close` for Esc in normal mode (the view closes the
 * pane, as Esc did before modes). Ctrl+S is the view's and never reaches here. A pending prefix (`g`) is the model's,
 * as on the rest of the screen.
 */
export function modalKey(mode: EditMode, pending: Pending | null, input: string, key: InkKey, km: Keymap, c: MotionContext): Action[] | "close" {
  const token = tokenOf(input, key);
  if (token === "esc") {
    if (pending) return [{ type: "prefix.clear" }];
    return mode === "normal" ? "close" : [{ type: "pane.edit", edit: toNormal }];
  }
  if (mode === "insert") {
    const edit = paneKey(input, key, c.width, c.height);
    return edit ? [{ type: "pane.edit", edit }] : [];
  }
  if (token === null) return pending ? [{ type: "prefix.clear" }] : [];
  const resolved = resolve({ state: mode }, pending, token, km);
  if (resolved.length === 0 && !pending && PASSED.has(token)) {
    const edit = paneKey(input, key, c.width, c.height);
    return edit ? [{ type: "pane.edit", edit }] : [];
  }
  const out: Action[] = [];
  for (const d of resolved) {
    if (d.type !== "command") { out.push(d); continue; }
    const edit = modalEdit(d.id, c);
    if (edit) out.push({ type: "pane.edit", edit });
  }
  return out;
}
