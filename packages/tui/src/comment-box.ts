// A comment as a short box under the line it is about, pure. Copied from prview's finding box (tui.tsx `boxTop`,
// layout.ts `boxLines`) and adapted: the box is drawn as three plain rows of text (a top border carrying the header, the
// claim, a bottom border) so the main pane can window and move a cursor over them like any other row. `check` hits use
// it (hits.ts) and so does review mode, for a comment from any source (review.ts, AGT-1580: the one box component), so
// nothing here knows what a check or a source is.

import { clean } from "./sanitize";

/** What a box shows: a header for the top border, an optional dim tag after it, one line of body, and a colour. */
export interface Comment {
  readonly title: string;
  readonly tag?: string;
  readonly body: string;
  readonly color?: string;
}

export type BoxPart = "top" | "body" | "bottom";
/** One row of a box, already padded to the box's width; `head`/`tag` split the top border so the tag can be dimmed. */
export interface BoxRow { readonly part: BoxPart; readonly text: string; readonly head?: string; readonly tag?: string }

/** The box's narrowest width: a corner, a space, one character, a space, a corner. */
export const BOX_MIN = 5;

const cols = (s: string) => [...s].length;
const cut = (s: string, n: number) => (cols(s) <= n ? s : n <= 0 ? "" : `${[...s].slice(0, Math.max(0, n - 1)).join("")}…`);
const oneLine = (s: string) => clean(s).replace(/\s+/g, " ").trim();

/** Greedy word wrap to `n` columns; a word longer than a row is cut across rows. Empty text is one empty row. */
function wrapWords(text: string, n: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (let word of text.split(" ").filter((x) => x !== "")) {
    while (cols(word) > n) {
      if (cur !== "") { out.push(cur); cur = ""; }
      out.push([...word].slice(0, n).join(""));
      word = [...word].slice(n).join("");
    }
    if (cur === "") cur = word;
    else if (cols(cur) + 1 + cols(word) <= n) cur += ` ${word}`;
    else { out.push(cur); cur = word; }
  }
  return cur === "" && out.length > 0 ? out : [...out, cur];
}

/** Options for `commentBox`. */
export interface BoxOptions {
  /** How many rows the body may take (default 1: cut with …). Review mode passes Infinity: a reader's note is read whole. */
  readonly maxLines?: number;
}

/**
 * The three rows of `c` in a box `width` columns wide. The header is cut with … when it does not fit and the tag is
 * dropped first; the body is one line unless `maxLines` allows more, wrapped on words and cut with … at the last row. Text is sanitised: a comment may carry model or file text.
 */
export function commentBox(c: Comment, width: number, opts: BoxOptions = {}): BoxRow[] {
  const w = Math.max(BOX_MIN, width);
  const room = w - 5;
  const title = oneLine(c.title);
  const tag = c.tag ? ` ${oneLine(c.tag)}` : "";
  const fits = cols(title) + cols(tag) <= room;
  const t = fits ? title : cut(title, room);
  const g = fits ? tag : "";
  const head = `╭ ${t}`;
  const top = `${head}${g} ${"─".repeat(Math.max(0, w - cols(head) - cols(g) - 2))}╮`;
  const max = Math.max(1, opts.maxLines ?? 1);
  const text = oneLine(c.body);
  let lines = max === 1 ? [cut(text, w - 4)] : wrapWords(text, w - 4);
  if (lines.length > max) lines = [...lines.slice(0, max - 1), cut(`${lines[max - 1]!} ${lines.slice(max).join(" ")}`, w - 4)];
  return [
    { part: "top", text: top, head, tag: g },
    ...lines.map((body): BoxRow => ({ part: "body", text: `│ ${body}${" ".repeat(Math.max(0, w - 4 - cols(body)))} │` })),
    { part: "bottom", text: `╰${"─".repeat(w - 2)}╯` },
  ];
}
