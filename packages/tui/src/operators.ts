// The editing pane's operators, registers and undo (AGT-2171, D-18), Helix-style: `d c y p P x r` act on select mode's
// selection, or on the character under the cursor in normal mode; `"` names the register the next yank, delete or paste
// uses (the default register `"` when none is named); `u` undoes and `U` redoes. Pure, like modal.ts: each is an edit of
// the pane's text, by the id of the key row (keys.ts) that runs it.
//
// Every operator is one undo step (the buffer's `group`). `c` opens a group that the insert session it starts keeps open,
// so the deletion and what is typed after it undo together; modal.ts closes it when the session ends.
//
// `r` and `"` wait for one more key, the character to replace with or the register's name: the row presses a pending
// prefix of its own (the model's, so Esc cancels it as it does `g`), and `pendingChar` takes the next key.

import type { Pos, TextBuffer } from "./buffer";
import { tokenOf, type InkKey } from "./chord";
import { apply, type EditText } from "./edit-pane";
import type { Action, EditPaneText, Pending } from "./state";

/** The register yanks, deletes and pastes use when none is named, as in Helix. */
export const DEFAULT_REGISTER = '"';

/** The pending prefixes that take one character next, with what the key panel says it is for. */
export const CHAR_PENDING: Readonly<Record<string, string>> = { replace: "character to replace with", register: "register name" };

/** The pane's text with what the operators keep: the registers' contents, and the register named for the next operator. */
export interface OpText extends EditText {
  readonly registers?: Readonly<Record<string, string>>;
  readonly register?: string | null;
}

/** The register the next operator uses: the one named with `"`, else the default. */
const registerOf = (t: OpText): string => t.register ?? DEFAULT_REGISTER;

/** `t` with `text` stored in its named (or the default) register, and the name used up. */
function store(t: OpText, text: string): OpText {
  return { ...t, registers: { ...t.registers, [registerOf(t)]: text }, register: null };
}

/**
 * What an operator acts on: in select mode the selection, anchor to cursor with the character at each end included; in
 * normal mode the character under the cursor. `[from, to)`, in document order; a line's end counts as its line break.
 */
export function selectionOf(t: EditText): { readonly from: Pos; readonly to: Pos } {
  const b = t.buffer;
  const c = b.cursor;
  if (t.mode !== "select" || !t.anchor) return { from: c, to: b.charEnd(c) };
  const a = b.clampPos(t.anchor);
  const [from, last] = a.row < c.row || (a.row === c.row && a.col <= c.col) ? [a, c] : [c, a];
  return { from, to: b.charEnd(last) };
}

type Op = (t: OpText) => OpText;

/** Cuts what the operator acts on into the register, as one undo step; `open` leaves a group open for the insert session after it. */
function cut(t: OpText, open: boolean): OpText {
  const { from, to } = selectionOf(t);
  let gone = "";
  const next = apply(t, (b) => {
    if (open) b.beginGroup();
    gone = b.group(() => b.deleteRange(from, to));
  }) as OpText;
  return gone ? store(next, gone) : { ...next, register: null };
}

/** Pastes the register at `at` (computed on the buffer), the cursor ending on the last character pasted; back to normal mode. */
function paste(t: OpText, at: (b: TextBuffer, from: Pos, to: Pos) => Pos): OpText {
  const text = t.registers?.[registerOf(t)] ?? "";
  const { from, to } = selectionOf(t);
  const next = text ? (apply(t, (b) => b.group(() => { b.cursor = at(b, from, to); b.insert(text); b.left(); })) as OpText) : t;
  return { ...next, mode: "normal", anchor: null, register: null };
}

/**
 * Where `p` pastes: after the selection's last character (the one under the cursor in normal mode). When that character
 * is a line break, `to` is the next line's start; the paste goes before the break instead, at its line's end.
 */
const after = (b: TextBuffer, from: Pos, to: Pos): Pos =>
  to.col === 0 && to.row > from.row ? { row: to.row - 1, col: b.lines[to.row - 1]!.length } : to;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Replaces every character of the selection (or the one under the cursor) with `ch`; line breaks stay. */
export function replaceWith(ch: string): (t: EditPaneText) => EditPaneText {
  return (t0) => {
    const t = t0 as OpText;
    const { from, to } = selectionOf(t);
    const was = t.buffer.slice(from, to);
    const now = was.split("\n").map((line) => [...graphemes.segment(line)].map(() => ch).join("")).join("\n");
    if (now === was) return t;
    const cursor = t.buffer.cursor;
    return apply(t, (b) => b.group(() => { b.deleteRange(from, to); b.insert(now); b.cursor = cursor; }));
  };
}

/** Names the register the next yank, delete or paste uses. */
export const nameRegister = (name: string) => (t: EditPaneText): EditPaneText => ({ ...(t as OpText), register: name }) as OpText;

/** The operators, by the id of the key row that runs them. */
export const OPERATORS: Readonly<Record<string, Op>> = {
  "editor.delete": (t) => ({ ...cut(t, false), mode: "normal", anchor: null }),
  "editor.delete_char": (t) => ({ ...cut(t, false), mode: "normal", anchor: null }),
  // The group `c` opens stays open for the insert session; leaving insert mode (modal.ts) closes it.
  "editor.change": (t) => ({ ...cut(t, true), mode: "insert", anchor: null }),
  "editor.yank": (t) => {
    const { from, to } = selectionOf(t);
    const text = t.buffer.slice(from, to);
    return text ? store(t, text) : { ...t, register: null };
  },
  "editor.paste": (t) => paste(t, after),
  "editor.paste_before": (t) => paste(t, (_b, from) => from),
  "editor.undo": (t) => ({ ...(apply(t, (b) => { b.undo(); }) as OpText), register: null }),
  "editor.redo": (t) => ({ ...(apply(t, (b) => { b.redo(); }) as OpText), register: null }),
};

/**
 * The next key while `r` or `"` waits for one: the actions it makes (the edit, and the pending prefix cleared), or null
 * when nothing is waiting. A key that is not one character only cancels the wait.
 */
export function pendingChar(pending: Pending | null, input: string, key: InkKey): Action[] | null {
  if (!pending || !(pending.prefix in CHAR_PENDING)) return null;
  const token = tokenOf(input, key);
  const ch = token === "space" ? " " : token !== null && token === input && [...graphemes.segment(input)].length === 1 ? input : null;
  if (ch === null) return [{ type: "prefix.clear" }];
  const edit = pending.prefix === "replace" ? replaceWith(ch) : nameRegister(ch);
  return [{ type: "pane.edit", edit }, { type: "prefix.clear" }];
}
