import {
  StyledText,
  createTextAttributes,
  parseColor,
  reverse,
  stringToStyledText,
  type RGBA,
  type TextChunk,
} from "@opentui/core";
import { selectionText, type Document, type Span } from "@openthink/pablo-core";
import type { DisplayLine, Segment } from "./layout";
import { THEME } from "./theme";

/**
 * Everything in this package may touch the terminal; nothing in
 * `@openthink/pablo-core` may. This module is the seam: it takes the core's
 * document and span model and produces opentui chunks.
 *
 * It stays a pure function of (document, span) so the renderer is testable
 * without a TTY, and so a renderer swap later touches only this package.
 */

function plain(text: string): TextChunk[] {
  return text.length === 0 ? [] : stringToStyledText(text).chunks;
}

/** The document's text with the selected span drawn in reverse video. */
export function styledSelection(doc: Document, span: Span): StyledText {
  const selected = selectionText(doc, span);

  return new StyledText([
    ...plain(doc.text.slice(0, span.start)),
    ...(selected.length === 0 ? [] : [reverse(selected)]),
    ...plain(doc.text.slice(span.end)),
  ]);
}

const REVERSE = createTextAttributes({ reverse: true });
const colors = new Map<string, RGBA>();

function color(hex: string): RGBA {
  const cached = colors.get(hex);
  if (cached !== undefined) return cached;
  const parsed = parseColor(hex);
  colors.set(hex, parsed);
  return parsed;
}

/** One laid-out segment as an opentui chunk. The selection is an attribute, not a colour. */
export function styledSegment(segment: Segment): TextChunk {
  const style = THEME[segment.style];
  const chunk: TextChunk = {
    __isChunk: true,
    text: segment.text,
    attributes: segment.selected ? style.attributes | REVERSE : style.attributes,
  };
  if (style.fg !== undefined) chunk.fg = color(style.fg);
  if (style.bg !== undefined) chunk.bg = color(style.bg);
  return chunk;
}

export function styledSegments(segments: readonly Segment[]): StyledText {
  return new StyledText(segments.map(styledSegment));
}

/** A frame: the laid-out rows, joined by the newlines the wrap implies. */
export function styledLines(lines: readonly DisplayLine[]): StyledText {
  const chunks: TextChunk[] = [];
  lines.forEach((line, index) => {
    if (index > 0) chunks.push({ __isChunk: true, text: "\n" });
    for (const segment of line.segments) chunks.push(styledSegment(segment));
  });
  return new StyledText(chunks);
}

/** The plain text of a frame — what the reader sees, for tests and for `--print`. */
export function frameText(lines: readonly DisplayLine[]): string {
  return lines.map((line) => line.segments.map((segment) => segment.text).join("")).join("\n");
}
