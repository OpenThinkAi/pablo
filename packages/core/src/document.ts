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

/**
 * Finds `quoted` in `body`, ignoring differences in whitespace runs: any run
 * of spaces, tabs and newlines on one side matches any run of them on the
 * other, so a passage the author pasted back with a reflowed hard wrap still
 * finds its home. Everything else must match exactly.
 *
 * `ok: true` only when there is exactly one match, and the returned `span` is
 * in `body`'s own UTF-16 offsets (the original text, not the whitespace the
 * caller quoted) — so `selectionText({path, text: body}, span)` reproduces
 * the exact substring `locatePassage` found. Zero or more than one match
 * returns the count instead, for the caller to explain to the author. An
 * empty or whitespace-only `quoted` is never a location — it would match
 * everywhere — so it always reports `matches: 0`.
 */
export function locatePassage(body: string, quoted: string): { ok: true; span: Span } | { ok: false; matches: number } {
  if (quoted.trim() === "") {
    return { ok: false, matches: 0 };
  }

  const pattern = new RegExp(toWhitespaceInsensitivePattern(quoted), "g");
  const matches = [...body.matchAll(pattern)];

  if (matches.length !== 1) {
    return { ok: false, matches: matches.length };
  }

  const match = matches[0];
  if (match === undefined || match.index === undefined) {
    return { ok: false, matches: matches.length };
  }
  return { ok: true, span: { start: match.index, end: match.index + match[0].length } };
}

/** Escapes every regex metacharacter and turns each whitespace run into `\s+`. */
function toWhitespaceInsensitivePattern(text: string): string {
  return text
    .split(/(\s+)/)
    .map((chunk) => (chunk !== "" && /^\s+$/.test(chunk) ? "\\s+" : escapeRegExp(chunk)))
    .join("");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
