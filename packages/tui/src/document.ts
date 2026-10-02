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

import { joinManuscript } from "@openthink/pablo-core";
import { wrapText } from "./layout";
import { clean } from "./sanitize";

/** A document for the main pane: a heading for it, and its text with the frontmatter already removed or never present. */
export interface MainDoc { readonly title: string; readonly text: string }

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

/**
 * The display lines of `text` at `width` columns: control characters stripped, frontmatter hidden, each run of
 * consecutive non-blank lines joined into one paragraph and wrapped on word breaks, a blank line between paragraphs.
 * Headings, lists, tables and fences keep their own lines (joinManuscript leaves them alone).
 */
export function displayLines(text: string, width: number): string[] {
  const body = joinManuscript(stripFrontmatter(clean(text)).replace(/\t/g, "  "));
  if (body === "") return [];
  return body.split("\n").flatMap((line) => (line === "" || structural(line) ? [line] : wrapText(line, Math.max(1, width))));
}
