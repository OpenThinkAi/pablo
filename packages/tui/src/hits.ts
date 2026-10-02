// `check` hits in the main pane, pure: the rows of a document with each hit's box under its line, what a hit says
// when it is opened, and the `g f` / `g F` walk from hit to hit. The hits come from the layer above (pablo-cli's
// `checkFile`, passed in as data): this package never imports the CLI, so a hit is described here by the fields the
// screen reads. The box itself is comment-box.ts, shared with review mode.

import { commentBox, type BoxPart, type Comment } from "./comment-box";
import { displayDoc, type Mark, type PaneSentence } from "./document";

/** One `check` finding. `line` counts from 1 in the file, frontmatter included (checkFile's numbering). */
export interface CheckHit {
  readonly line: number;
  readonly rule: string;
  readonly excerpt: string;
  /** Which stock name matched, when the rule is `stock-name`. */
  readonly detail?: string;
}

/** What each mechanical rule looks for, in the words the content area uses. */
const RULES: Readonly<Record<string, string>> = {
  "em-dash": "an em-dash (—)",
  "en-dash": "an en-dash (–)",
  "curly-quote": "a curly quote (“ ” ‘ ’); manuscripts keep straight quotes, the compiler curls them",
  "dash-year-range": "a year range with a dash (1929-1931)",
  foreshadow: "a foreshadowing phrase (little did she, it would be years before, in that moment, ...)",
  "stock-name": "a stock fiction name the style guide bans",
  "flagged-line": "a line the style guide flags, matched word for word",
};

const ruleText = (hit: CheckHit) => RULES[hit.rule] ?? hit.rule;

/** The short comment a hit shows on its line: `▲ tells · em-dash`, the flagged line or name as the body. */
export function hitComment(hit: CheckHit): Comment {
  return {
    title: `▲ tells · ${hit.rule}`,
    ...(hit.detail !== undefined ? { tag: `(${hit.detail})` } : {}),
    body: hit.detail !== undefined ? `"${hit.detail}" appears in this line` : hit.excerpt,
    color: "yellow",
  };
}

/** What `→` opens in the content area for a hit: the rule, the pattern it flagged, and the line. */
export function hitDetail(hit: CheckHit): { title: string; body: string } {
  const pattern = hit.rule === "stock-name" ? `name: ${hit.detail ?? ""}` : hit.rule === "flagged-line" ? `flagged line: ${hit.excerpt}` : `pattern: ${ruleText(hit)}`;
  return { title: `check · ${hit.rule} · line ${hit.line}`, body: `rule: ${hit.rule}\n${pattern}\nline ${hit.line}: ${hit.excerpt}` };
}

/** A row of the main pane: a line of the document, or one of the three rows of a hit's box (`hit` indexes the hits given). */
export type MainRow =
  | { readonly kind: "text"; readonly text: string; /** The sentences on this line, when it is prose (document.ts); a box row is never one. */ readonly marks?: readonly Mark[] }
  | { readonly kind: "box"; readonly hit: number; readonly part: BoxPart; readonly text: string; readonly head?: string; readonly tag?: string; readonly color: string };

export const textRows = (lines: readonly string[]): MainRow[] => lines.map((text) => ({ kind: "text", text }));

/** Indent of a box under its line, so it reads as belonging to the line above. */
const INDENT = 2;

/**
 * The document's rows at `width` columns with each hit's box under the line it is on. A hit on a line the display
 * does not show (the frontmatter, a blank line) goes under the nearest line before it, or the first line. Hits on
 * one line stack in the order given.
 */
export const mainRows = (text: string, width: number, hits: readonly CheckHit[]): MainRow[] => mainPane(text, width, hits).rows;

/** The rows (`mainRows`) and the document's sentences with their spans in those rows, so a box between two lines of a sentence is inside its span, never a sentence of its own. */
export function mainPane(text: string, width: number, hits: readonly CheckHit[]): { rows: MainRow[]; sentences: PaneSentence[] } {
  const { lines, anchors, marks, sentences } = displayDoc(text, width);
  const textRow: number[] = [];
  const withMarks = (line: string, row: number): MainRow => ({ kind: "text", text: line, ...(marks[row]?.length ? { marks: marks[row]! } : {}) });
  const respan = (): PaneSentence[] => sentences.map((x) => ({ ...x, first: textRow[x.first]!, last: textRow[x.last]! }));
  if (hits.length === 0) { const rows = lines.map(withMarks); rows.forEach((_, i) => textRow.push(i)); return { rows, sentences: respan() }; }
  const anchored = [...anchors.keys()].sort((a, b) => a - b);
  const under = new Map<number, number[]>();
  hits.forEach((hit, i) => {
    const at = anchored.filter((n) => n <= hit.line).pop() ?? anchored[0];
    const row = at === undefined ? lines.length - 1 : anchors.get(at)!;
    under.set(row, [...(under.get(row) ?? []), i]);
  });
  const rows: MainRow[] = [];
  lines.forEach((line, row) => {
    textRow[row] = rows.length;
    rows.push(withMarks(line, row));
    for (const i of under.get(row) ?? []) {
      const c = hitComment(hits[i]!);
      for (const b of commentBox(c, Math.max(5, width - INDENT))) {
        rows.push({ kind: "box", hit: i, part: b.part, text: `${" ".repeat(INDENT)}${b.text}`, ...(b.head !== undefined ? { head: `${" ".repeat(INDENT)}${b.head}` } : {}), ...(b.tag ? { tag: b.tag } : {}), color: c.color ?? "gray" });
      }
    }
  });
  return { rows, sentences: respan() };
}

/** The index of the hit the cursor is on: on one of its box rows, or on the line it sits under. */
export function hitAt(rows: readonly MainRow[], cursor: number): number | undefined {
  const row = rows[cursor];
  if (row?.kind === "box") return row.hit;
  const next = rows[cursor + 1];
  return row?.kind === "text" && next?.kind === "box" ? next.hit : undefined;
}

/** The row each hit's box starts on, in reading order. */
export const hitRows = (rows: readonly MainRow[]): number[] => rows.flatMap((r, i) => (r.kind === "box" && r.part === "top" ? [i] : []));

/**
 * `g f` / `g F`: the row of the next (or previous) hit's box after the cursor, wrapping round at either end; undefined
 * when there are no hits. From inside a box, the next hit is the one after that box.
 */
export function nextHitRow(rows: readonly MainRow[], cursor: number, dir: 1 | -1): number | undefined {
  const spots = hitRows(rows);
  if (spots.length === 0) return undefined;
  const inside = rows[cursor]?.kind === "box" ? spots.filter((s) => s <= cursor).pop() : undefined;
  const from = inside ?? cursor;
  return dir > 0 ? spots.find((s) => s > from) ?? spots[0] : [...spots].reverse().find((s) => s < from) ?? spots[spots.length - 1];
}
