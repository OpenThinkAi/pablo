/**
 * Rendering a parsed document back to markdown. Delimiters are rebuilt from
 * each mark's kind rather than copied out of the source, so a round-trip proves
 * the model actually captured the markup — and anything the parser refused to
 * treat as a mark passes through as the literal text it always was.
 */

import type { Span } from "../document";
import type { Mark, MarkupDocument } from "./types";

const DELIMITERS: Record<Mark["kind"], readonly [string, string]> = {
  addition: ["{++", "++}"],
  deletion: ["{--", "--}"],
  substitution: ["{~~", "~~}"],
  note: ["{>>", "<<}"],
  highlight: ["{==", "==}"],
};

function within(outer: Span, inner: Span): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

function renderRange(text: string, marks: readonly Mark[], range: Span): string {
  let out = "";
  let cursor = range.start;
  for (const mark of marks) {
    out += text.slice(cursor, mark.span.start) + renderMark(text, mark);
    cursor = mark.span.end;
  }
  return out + text.slice(cursor, range.end);
}

function renderMark(text: string, mark: Mark): string {
  const [open, close] = DELIMITERS[mark.kind];
  const body = renderRange(
    text,
    mark.children.filter((child) => within(mark.body, child.span)),
    mark.body,
  );
  if (mark.replacement === undefined) return open + body + close;

  const replacement = mark.replacement;
  const proposed = renderRange(
    text,
    mark.children.filter((child) => within(replacement, child.span)),
    replacement,
  );
  return open + body + "~>" + proposed + close;
}

/** Render a parsed document back to markdown. `serialize(parse(x)) === x`. */
export function serialize(model: MarkupDocument): string {
  return renderRange(model.text, model.marks, { start: 0, end: model.text.length });
}
