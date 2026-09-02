/**
 * The CriticMarkup and block model. Proposals, notes, and pending intents all
 * live inline in the manuscript as CriticMarkup, so this model is what every
 * verb, renderer, and provider adapter is written against.
 *
 * Every offset here is a UTF-16 code unit index into `MarkupDocument.text`, the
 * exact bytes that were parsed. Nothing is normalized: `serialize(parse(x))` is
 * `x`, and the offsets stay valid against the file on disk.
 */

import type { Span } from "../document";

/** The five CriticMarkup forms. */
export type MarkKind = "addition" | "deletion" | "substitution" | "note" | "highlight";

/** A parsed CriticMarkup mark, anchored to the text it addresses. */
export interface Mark {
  readonly kind: MarkKind;
  /** The whole mark including its delimiters — the span a resolution replaces. */
  readonly span: Span;
  /** The content between the delimiters; for a substitution, the original text. */
  readonly body: Span;
  /** A substitution's proposed text, after the `~>` separator. Absent on every other kind. */
  readonly replacement?: Span;
  /** Marks nested inside this one, in document order. */
  readonly children: readonly Mark[];
}

/**
 * Block kinds pablo distinguishes. `blank` covers the whitespace between two
 * content blocks (including the newline that ends the preceding one), which is
 * what lets the blocks tile the text with no gaps.
 */
export type BlockKind = "frontmatter" | "heading" | "paragraph" | "sceneBreak" | "blank";

/** A structural unit of the file. Blocks tile the text: no gaps, no overlap. */
export interface Block {
  readonly kind: BlockKind;
  readonly span: Span;
  /** ATX depth, 1-6. Headings only. */
  readonly level?: number;
  /** The title text after the hashes. Headings only. */
  readonly content?: Span;
}

/** Something malformed in the markup, reported rather than thrown. */
export interface Violation {
  readonly position: number;
  readonly message: string;
}

/** A markdown file parsed into blocks and marks. */
export interface MarkupDocument {
  /** The text the offsets index into, byte for byte as it was parsed. */
  readonly text: string;
  readonly blocks: readonly Block[];
  /** Top-level marks in document order; nested ones hang off `Mark.children`. */
  readonly marks: readonly Mark[];
  /** Malformed markup, in position order. A file with violations still parses. */
  readonly violations: readonly Violation[];
}
