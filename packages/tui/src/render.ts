import { StyledText, reverse, stringToStyledText, type TextChunk } from "@opentui/core";
import { selectionText, type Document, type Span } from "@openthink/pablo-core";

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
