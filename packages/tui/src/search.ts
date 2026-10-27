// Search and replace in the editing pane (AGT-2172, D-18). `/` types a query on a one-line prompt in the pane and jumps to
// the next match; `n` and `N` step forward and back through the matches (wrapping round), all of which are highlighted;
// `R` asks what to find and what to put in its place, and replaces it across the selection (select mode) or the whole unit
// as ONE undo step. Pure, like modal.ts: a prompt key becomes the actions to dispatch, the rows' ids become edits of the
// pane's text. The query is literal text, matched within a line (a paragraph); it ignores case unless it has a capital.

import type { Pos, TextBuffer } from "./buffer";
import { tokenOf, type InkKey } from "./chord";
import { apply, type EditText } from "./edit-pane";
import type { Action, EditPaneText } from "./state";

/** A match: `[start, end)` in line `row`, on grapheme boundaries. */
export interface Match { readonly row: number; readonly start: number; readonly end: number }

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The matches of `query` in `line`: every non-overlapping one, none for an empty query. */
export function matchesOnLine(line: string, query: string): { start: number; end: number }[] {
  if (query === "" || line === "") return [];
  const re = new RegExp(escapeRe(query), /\p{Lu}/u.test(query) ? "gu" : "giu");
  const bounds = new Set<number>([line.length]);
  for (const { index } of segmenter.segment(line)) bounds.add(index);
  const out: { start: number; end: number }[] = [];
  for (const m of line.matchAll(re)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (bounds.has(start) && bounds.has(end)) out.push({ start, end });
  }
  return out;
}

/** Every match in the buffer, in order. */
export function findMatches(lines: readonly string[], query: string): Match[] {
  const out: Match[] = [];
  lines.forEach((line, row) => { for (const m of matchesOnLine(line, query)) out.push({ row, ...m }); });
  return out;
}

const before = (a: Pos, b: Pos) => a.row < b.row || (a.row === b.row && a.col < b.col);

/** The first match after `from` (or the last one before it, `dir` -1), wrapping round the unit; null when there are none. */
export function stepMatch(lines: readonly string[], query: string, from: Pos, dir: 1 | -1): Match | null {
  const all = findMatches(lines, query);
  if (all.length === 0) return null;
  const at = (m: Match): Pos => ({ row: m.row, col: m.start });
  if (dir === 1) return all.find((m) => before(from, at(m))) ?? all[0]!;
  return [...all].reverse().find((m) => before(at(m), from)) ?? all[all.length - 1]!;
}

/** Select mode's selection as the range of positions it covers: the anchor to the cursor, the cursor's character included. */
export function selectionBounds(b: TextBuffer, anchor: Pos): { from: Pos; to: Pos } {
  const row = Math.min(anchor.row, b.lines.length - 1);
  const a = { row, col: Math.min(anchor.col, b.lines[row]!.length) };
  const c = b.cursor;
  const [from, last] = before(c, a) ? [c, a] : [a, c];
  const line = b.lines[last.row]!;
  const next = segmenter.segment(line.slice(last.col))[Symbol.iterator]().next();
  return { from, to: { row: last.row, col: last.col + (next.done ? 0 : next.value.segment.length) } };
}

/** The matches `find` has inside the selection (select mode) or, with none, the whole unit. */
function replaceable(t: EditText, find: string): Match[] {
  const all = findMatches(t.buffer.lines, find);
  if (t.mode !== "select" || !t.anchor) return all;
  const { from, to } = selectionBounds(t.buffer, t.anchor);
  return all.filter((m) => !before({ row: m.row, col: m.start }, from) && !before(to, { row: m.row, col: m.end }));
}

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------- the rows' ids to what they do

const withPrompt = (t: EditText, prompt: EditText["prompt"]): EditText => ({ ...t, prompt });

/** Jump to the next or previous match of the last search, extending the selection in select mode (the anchor stays). */
function step(dir: 1 | -1): (t: EditPaneText) => EditPaneText {
  return (p) => {
    const t = p as EditText;
    const q = t.search?.query;
    if (!q) return { ...t, note: "no search yet: / starts one" };
    const m = stepMatch(t.buffer.lines, q, t.buffer.cursor, dir);
    if (!m) return { ...t, note: `no match for ${q}` };
    return { ...apply(t, (b) => { b.cursor = { row: m.row, col: m.start }; }), note: null };
  };
}

/** The search and replace keys, by the id of the row that runs them. */
export const SEARCH_KEYS: Readonly<Record<string, (t: EditPaneText) => EditPaneText>> = {
  "editor.search": (t) => withPrompt(t as EditText, { kind: "search", text: "" }),
  "editor.search_next": step(1),
  "editor.search_prev": step(-1),
  "editor.search_replace": (t) => withPrompt(t as EditText, { kind: "find", text: "" }),
};

// ---------------------------------------------------------------- the prompt

/** The prompt's label and what is typed, as the pane draws its line. */
export function promptLine(p: NonNullable<EditText["prompt"]>): string {
  if (p.kind === "search") return `/${p.text}`;
  if (p.kind === "find") return `replace: ${p.text}`;
  return `replace ${p.find} with: ${p.text}`;
}

/** The title's note on the search: the query with where the cursor is among its matches, or what the last replace did. */
export function searchStatus(t: EditText): string {
  if (t.note) return t.note;
  const q = t.search?.query;
  if (!q) return "";
  const all = findMatches(t.buffer.lines, q);
  if (all.length === 0) return `/${q} no match`;
  const c = t.buffer.cursor;
  const i = all.findIndex((m) => m.row === c.row && m.start === c.col);
  return `/${q} ${i < 0 ? "" : `${i + 1}/`}${all.length}`;
}

/** Enter on the search prompt: remember the query and go to its first match after the cursor (an empty query clears the search). */
function submitSearch(t: EditText, query: string): EditText {
  const closed = withPrompt(t, null);
  if (query === "") return { ...closed, search: null, note: null };
  const next = { ...closed, search: { query } };
  const m = stepMatch(t.buffer.lines, query, t.buffer.cursor, 1);
  if (!m) return { ...next, note: `no match for ${query}` };
  return { ...apply(next, (b) => { b.cursor = { row: m.row, col: m.start }; }), note: null };
}

/** Enter on the replacement prompt: replace every match of `find` in the selection or the unit, as one undo step. */
function submitReplace(t: EditText, find: string, text: string): EditText {
  const closed = { ...withPrompt(t, null), mode: "normal" as const, anchor: null };
  const matches = replaceable(t, find);
  if (matches.length === 0) return { ...closed, search: { query: find }, note: `no match for ${find}` };
  const done = apply(closed, (b) => {
    // One undo step (TextBuffer.group), from the end of each line backwards so earlier offsets stay true.
    b.group(() => {
      for (const m of [...matches].reverse()) b.deleteRange({ row: m.row, col: m.start }, { row: m.row, col: m.end }), b.insert(text);
      b.cursor = { row: matches[0]!.row, col: matches[0]!.start };
    });
  });
  return { ...done, search: { query: find }, note: `${plural(matches.length, "replacement")}` };
}

const typed = (input: string, key: InkKey): string | null => {
  if (key.ctrl || key.meta || key.escape || input === "") return null;
  const token = tokenOf(input, key);
  return token === null || token === input ? input.replace(/[\r\n]+/g, " ") : null;
};

/**
 * A keypress while a prompt is up, as the actions to dispatch; null when none is (the key is the mode's). The prompt takes
 * every key: text types, Backspace erases, Enter goes on (a search; a replace first asks for the replacement), Esc cancels.
 */
export function promptKey(text: EditPaneText | null | undefined, input: string, key: InkKey): Action[] | null {
  const prompt = (text as EditText | null | undefined)?.prompt;
  if (!prompt) return null;
  const edit = (f: (t: EditText) => EditText): Action[] => [{ type: "pane.edit", edit: (t) => f(t as EditText) }];
  const token = tokenOf(input, key);
  if (token === "esc") return edit((t) => withPrompt(t, null));
  if (token === "enter") {
    return edit((t) => {
      const p = t.prompt;
      if (!p) return t;
      if (p.kind === "search") return submitSearch(t, p.text);
      if (p.kind === "find") {
        const find = p.text === "" ? t.search?.query ?? "" : p.text;
        return find === "" ? withPrompt(t, null) : withPrompt(t, { kind: "with", text: "", find });
      }
      return submitReplace(t, p.find ?? "", p.text);
    });
  }
  if (token === "backspace") return edit((t) => (t.prompt ? withPrompt(t, { ...t.prompt, text: [...t.prompt.text].slice(0, -1).join("") }) : t));
  const s = token === "space" ? " " : typed(input, key);
  return s === null ? [] : edit((t) => (t.prompt ? withPrompt(t, { ...t.prompt, text: t.prompt.text + s }) : t));
}
