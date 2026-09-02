/**
 * The block scanner: enough markdown structure for structural selection over a
 * manuscript (chapters, scenes, paragraphs), and nothing more. pandoc and the
 * renderer handle the rest; this only needs to answer "what unit is this span
 * inside".
 *
 * Blocks tile the text — the first starts at 0, the last ends at `text.length`,
 * and each begins where the previous ended — with `blank` blocks absorbing the
 * newlines and empty lines between content. That invariant is what lets a
 * structural selection be built by unioning block spans.
 */

import type { Block } from "./types";

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t].*)?$/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FRONTMATTER_OPEN = /^---[ \t]*$/;
const FRONTMATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;

interface Line {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

function scanLines(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    lines.push({ start, end, text: text.slice(start, end).replace(/\r$/, "") });
    if (newline === -1) return lines;
    start = newline + 1;
  }
}

function isBlank(line: Line): boolean {
  return line.text.trim() === "";
}

function headingBlock(line: Line): Block | null {
  const match = ATX_HEADING.exec(line.text);
  const hashes = match?.[1];
  if (hashes === undefined) return null;

  let contentStart = line.text.length - line.text.trimStart().length + hashes.length;
  while (contentStart < line.text.length && /[ \t]/.test(line.text.slice(contentStart, contentStart + 1))) {
    contentStart += 1;
  }
  let contentEnd = line.text.length;
  while (contentEnd > contentStart && /[ \t]/.test(line.text.slice(contentEnd - 1, contentEnd))) {
    contentEnd -= 1;
  }

  return {
    kind: "heading",
    span: { start: line.start, end: line.end },
    level: hashes.length,
    content: { start: line.start + contentStart, end: line.start + contentEnd },
  };
}

/** Fill the gaps between content blocks so the result tiles `text`. */
function tile(text: string, content: readonly Block[]): Block[] {
  const blocks: Block[] = [];
  let cursor = 0;
  for (const block of content) {
    if (block.span.start > cursor) {
      blocks.push({ kind: "blank", span: { start: cursor, end: block.span.start } });
    }
    blocks.push(block);
    cursor = block.span.end;
  }
  if (cursor < text.length) {
    blocks.push({ kind: "blank", span: { start: cursor, end: text.length } });
  }
  return blocks;
}

export function scanBlocks(text: string): Block[] {
  const lines = scanLines(text);
  const content: Block[] = [];
  let index = 0;

  const first = lines[0];
  if (first !== undefined && FRONTMATTER_OPEN.test(first.text)) {
    const close = lines.findIndex((line, at) => at > 0 && FRONTMATTER_CLOSE.test(line.text));
    const closing = close === -1 ? undefined : lines[close];
    if (closing !== undefined) {
      content.push({ kind: "frontmatter", span: { start: first.start, end: closing.end } });
      index = close + 1;
    }
  }

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    index += 1;

    if (isBlank(line)) continue;

    if (THEMATIC_BREAK.test(line.text)) {
      content.push({ kind: "sceneBreak", span: { start: line.start, end: line.end } });
      continue;
    }

    const heading = headingBlock(line);
    if (heading !== null) {
      content.push(heading);
      continue;
    }

    let end = line.end;
    while (index < lines.length) {
      const next = lines[index];
      if (next === undefined) break;
      if (isBlank(next) || THEMATIC_BREAK.test(next.text) || ATX_HEADING.test(next.text)) break;
      end = next.end;
      index += 1;
    }
    content.push({ kind: "paragraph", span: { start: line.start, end } });
  }

  return tile(text, content);
}
