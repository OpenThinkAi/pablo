// A comment as a short box under the line it is about, pure. Copied from prview's finding box (tui.tsx `boxTop`,
// layout.ts `boxLines`) and adapted: the box is drawn as three plain rows of text (a top border carrying the header, the
// claim, a bottom border) so the main pane can window and move a cursor over them like any other row. `check` hits use
// it now (hits.ts); review mode's critic comments are the next user, so nothing here knows what a check is.

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

/**
 * The three rows of `c` in a box `width` columns wide. The header is cut with … when it does not fit and the tag is
 * dropped first; the body is one line, cut the same way. Text is sanitised: a comment may carry model or file text.
 */
export function commentBox(c: Comment, width: number): BoxRow[] {
  const w = Math.max(BOX_MIN, width);
  const room = w - 5;
  const title = oneLine(c.title);
  const tag = c.tag ? ` ${oneLine(c.tag)}` : "";
  const fits = cols(title) + cols(tag) <= room;
  const t = fits ? title : cut(title, room);
  const g = fits ? tag : "";
  const head = `╭ ${t}`;
  const top = `${head}${g} ${"─".repeat(Math.max(0, w - cols(head) - cols(g) - 2))}╮`;
  const body = cut(oneLine(c.body), w - 4);
  return [
    { part: "top", text: top, head, tag: g },
    { part: "body", text: `│ ${body}${" ".repeat(Math.max(0, w - 4 - cols(body)))} │` },
    { part: "bottom", text: `╰${"─".repeat(w - 2)}╯` },
  ];
}
