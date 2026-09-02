/**
 * The document and span model every other part of pablo is written against.
 *
 * Selection is the only noun in this product: a change is always an operation
 * on a span of a document, never a cursor position in an editable buffer. This
 * module is deliberately free of any terminal, rendering, or I/O concern — see
 * the TTY-free contract in this package's README section of CLAUDE.md.
 */

/**
 * A half-open range `[start, end)` of UTF-16 code units into a document's text.
 *
 * Half-open so that an empty span (`start === end`) is a legal insertion point
 * and `end - start` is the length, which is what every span operation wants.
 */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** A markdown file from the writing vault, read into memory. */
export interface Document {
  /** Absolute path the text was read from; the app writes accepted changes back here. */
  readonly path: string;
  readonly text: string;
}

/** Whether `span` addresses a real range of `doc` — the precondition of every span operation. */
export function isWithin(doc: Document, span: Span): boolean {
  return (
    Number.isInteger(span.start) &&
    Number.isInteger(span.end) &&
    span.start >= 0 &&
    span.start <= span.end &&
    span.end <= doc.text.length
  );
}

/** The text a span selects. Throws when the span does not address `doc`. */
export function selectionText(doc: Document, span: Span): string {
  if (!isWithin(doc, span)) {
    throw new RangeError(
      `pablo: span [${span.start}, ${span.end}) does not address ${doc.path} (${doc.text.length} characters)`,
    );
  }
  return doc.text.slice(span.start, span.end);
}
