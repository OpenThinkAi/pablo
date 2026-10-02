// What the main pane shows for a selected rail row, pure: the file's text with its frontmatter hidden, sanitised,
// paragraphs joined and wrapped to the pane's width. A chapter is stored one sentence per line (the screen doc's
// "The manuscript in git"); Markdown reads consecutive lines as one paragraph, so the pane must too, and a chapter
// reads the same before and after the sentence-per-line split. The model (state.ts) only learns how many display
// lines there are; the text and the wrapping stay here and in the Ink layer.
//
// Row ids (the book-mode rail, AGT-1526 book.ts, owns the rows; this is the id -> file map the main pane reads):
//   premise              bible/overview.md
//   bible                the bible's files, one after another (overview, places, timeline, characters/)
//   acts, beats, chapters  outline/chapters.md (the chapters group shows the outline)
//   chapter:N            chapters/NN-*.md (`ch1`, `ch-1` and `chapter-1` are read the same)
//   any other id         a path relative to the project, if it names a file in it

import { joinSentences, splitSentences } from "@openthink/pablo-core";
import { wrapText } from "./layout";
import { clean } from "./sanitize";

/** A document for the main pane: a heading for it, and its text with the frontmatter already removed or never present. */
export interface MainDoc {
  readonly title: string;
  readonly text: string;
  /** The project-relative path when the document is one file the checks can scan (a chapter); `text` is then that file's raw contents. */
  readonly file?: string;
  /** The project-relative path of the one file the text is, when `v e` can open it (it exists and the document is not a blend of files). */
  readonly editable?: string;
}

/** Where a row id's text lives, relative to the project: one file, a chapter by number, the bible's files, or any path. */
export type Source = { readonly kind: "file"; readonly file: string } | { readonly kind: "chapter"; readonly number: number } | { readonly kind: "bible" } | { readonly kind: "path"; readonly path: string };

const CHAPTER_ID = /^(?:chapter|ch)[:\- ]?(\d+)$/i;

/** The source of the document a rail row id names. */
export function sourceOf(id: string): Source {
  const chapter = CHAPTER_ID.exec(id);
  if (chapter) return { kind: "chapter", number: Number(chapter[1]) };
  switch (id) {
    case "premise": return { kind: "file", file: "bible/overview.md" };
    case "acts": case "beats": case "chapters": return { kind: "file", file: "outline/chapters.md" };
    case "bible": return { kind: "bible" };
    default: return { kind: "path", path: id };
  }
}

/** `text` without a leading `---` frontmatter block; text with no closed block is returned whole. */
export function stripFrontmatter(text: string): string {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return text;
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  return close < 0 ? text : lines.slice(close + 1).join("\n").replace(/^\s*\n/, "");
}

/** A line that is Markdown structure, not a sentence of prose: a table row, a fence, or an indented block. It is drawn as it is. */
const structural = (line: string) => /^(\||```|~~~|\s)/.test(line);

/** A block of plain prose, as `joinManuscript` reads it: no line opens like Markdown structure. */
const proseBlock = (lines: readonly string[]) => !lines.some((line) => /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|---+\s*$|\*\*\*+\s*$)/.test(line));

/** A stretch of one display line that belongs to a sentence: `[start, end)` in the line's text, `sentence` an index into `DisplayDoc.sentences`. */
export interface Mark { readonly start: number; readonly end: number; readonly sentence: number }
/**
 * A sentence of the document as the core splitter sees it (a prose paragraph, joined, split): the display lines it
 * covers (`first`..`last`, inclusive) and the stored lines it came from (`from`..`to`, 0-based inclusive, counted in the
 * file as stored, frontmatter included). A stored line holding two sentences is two sentences here, both pointing at it.
 */
export interface PaneSentence { readonly first: number; readonly last: number; readonly text: string; readonly stored: { readonly from: number; readonly to: number } }

/** The display lines of a document, where each of the file's own lines lands among them, and its selectable sentences. */
export interface DisplayDoc {
  readonly lines: string[];
  /** Per display line, the sentences on it (empty for blank lines, headings, lists, tables and fences: only prose is sentences). */
  readonly marks: readonly (readonly Mark[])[];
  readonly sentences: readonly PaneSentence[];
  /** File line number (1-based, frontmatter counted) to the index of the display line on which that file line's text ends. */
  readonly anchors: ReadonlyMap<number, number>;
}

/**
 * The display lines of `text` at `width` columns: control characters stripped, frontmatter hidden, each run of
 * consecutive non-blank lines joined into one paragraph and wrapped on word breaks, a blank line between paragraphs.
 * Headings, lists, tables and fences keep their own lines (joinManuscript leaves them alone). Alongside, the anchors:
 * a finding on line 12 of the file (checkFile's numbering) belongs under the display line where line 12's sentence
 * ends, even though the sentence lines were joined and wrapped to get there.
 */
export function displayDoc(text: string, width: number): DisplayDoc {
  const w = Math.max(1, width);
  const source = clean(text).replace(/\t/g, "  ").split("\n");
  const close = source[0]?.trim() === "---" ? source.findIndex((l, i) => i > 0 && l.trim() === "---") : -1;
  const first = close < 0 ? 0 : close + 1;
  const blocks: { n: number; text: string }[][] = [];
  let run: { n: number; text: string }[] = [];
  for (let i = first; i < source.length; i++) {
    if (source[i]!.trim() === "") { if (run.length) blocks.push(run); run = []; } else run.push({ n: i + 1, text: source[i]! });
  }
  if (run.length) blocks.push(run);

  const lines: string[] = [];
  const marks: Mark[][] = [];
  const sentences: PaneSentence[] = [];
  const anchors = new Map<number, number>();
  blocks.forEach((block, b) => {
    if (b > 0) lines.push("");
    const mark = () => { while (marks.length < lines.length) marks.push([]); };
    const texts = block.map((l) => l.text);
    const wrapped = (t: string) => (structural(t) ? [t] : wrapText(t, w));
    if (proseBlock(texts)) {
      const paragraph = joinSentences(texts);
      const start = lines.length;
      const wrappedLines = structural(paragraph) ? [paragraph] : wrapText(paragraph, w);
      lines.push(...wrappedLines);
      mark();
      markSentences(block, paragraph, wrappedLines, start, marks, sentences);
      // Greedy wrapping is prefix-stable: the rows a prefix of the paragraph takes end where that prefix ends.
      block.forEach((l, k) => anchors.set(l.n, start + (structural(paragraph) ? 0 : wrapText(joinSentences(texts.slice(0, k + 1)), w).length - 1)));
    } else {
      block.forEach((l) => { lines.push(...wrapped(l.text)); anchors.set(l.n, lines.length - 1); });
    }
  });
  while (marks.length < lines.length) marks.push([]);
  return { lines, anchors, marks, sentences };
}

/**
 * Marks the sentences of one prose paragraph on its wrapped display lines (the first of which is display line `start`)
 * and maps each back to the stored lines it came from. A sentence is a run of words: the stored lines and the sentences
 * are both word ranges of the joined paragraph, and wrapping only drops the spaces it breaks at.
 */
function markSentences(block: readonly { n: number; text: string }[], paragraph: string, wrapped: readonly string[], start: number, marks: Mark[][], out: PaneSentence[]): void {
  const words = paragraph.split(" ");
  const starts: number[] = [];
  let pos = 0;
  for (const word of words) { starts.push(pos); pos += word.length + 1; }
  const charEnd = (i: number) => starts[i]! + words[i]!.length;
  const count = (t: string) => t.split(" ").length;
  const lineRanges: [number, number][] = [];
  let used = 0;
  for (const l of block) { const n = count(joinSentences([l.text])); lineRanges.push([used, used + n]); used += n; }
  const spans: { from: number; to: number; text: string }[] = [];
  used = 0;
  for (const text of splitSentences(paragraph)) { const n = count(text); spans.push({ from: used, to: used + n, text }); used += n; }
  const base = out.length;
  const first = spans.map(() => -1), last = spans.map(() => -1);
  let cursor = 0;
  wrapped.forEach((text, n) => {
    while (paragraph[cursor] === " ") cursor++;
    const lineStart = cursor;
    cursor += text.length;
    spans.forEach((sp, k) => {
      const s = starts[sp.from]!, e = charEnd(sp.to - 1);
      if (s >= cursor || e <= lineStart) return;
      marks[start + n]!.push({ start: Math.max(s, lineStart) - lineStart, end: Math.min(e, cursor) - lineStart, sentence: base + k });
      if (first[k]! < 0) first[k] = start + n;
      last[k] = start + n;
    });
  });
  spans.forEach((sp, k) => {
    const from = lineRanges.findIndex(([, b]) => b > sp.from);
    let to = lineRanges.length - 1;
    while (to > 0 && lineRanges[to]![0] >= sp.to) to--;
    out.push({ first: first[k]!, last: last[k]!, text: sp.text, stored: { from: block[from]!.n - 1, to: block[to]!.n - 1 } });
  });
}

/** The display lines of `text` at `width` columns (see `displayDoc`). */
export const displayLines = (text: string, width: number): string[] => displayDoc(text, width).lines;

/**
 * The line of the file (1-based, frontmatter counted) `v e` opens the editor at for the main pane's `cursor`: the first
 * file line whose sentence ends at or after the display line the cursor is on, so a sentence wrapped over three rows is
 * one line whichever row the cursor is on. `rows` is the pane's text and box rows in order (a hit's box is not a line
 * of the file: the cursor on one counts as the line above it). 1 when the file has no line there.
 */
export function fileLineAt(text: string, width: number, rows: readonly { readonly kind: string }[], cursor: number): number {
  const { anchors } = displayDoc(text, width);
  let display = -1;
  for (let i = 0; i <= Math.min(cursor, rows.length - 1); i++) if (rows[i]!.kind === "text") display++;
  const at = Math.max(display, 0);
  const found = [...anchors.entries()].filter(([, row]) => row >= at).map(([n]) => n).sort((a, b) => a - b)[0];
  return found ?? Math.max(1, ...anchors.keys());
}
