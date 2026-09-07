/**
 * Pure helpers for `editor.tsx` (AGT-1270), kept out of the view so they are
 * unit-testable without a DOM (`packages/cli/test/editor-view.test.ts`).
 *
 * No judgement lives here — no word-count *rules*, no tells logic, no git.
 * `countWords` is a display helper that mirrors the host's own algorithm
 * (`packages/cli/src/edit.ts`'s `countWords`) purely so the live count shown
 * while typing agrees with the number the host will return on save; the
 * host's own count is still the number of record.
 *
 * Paragraphs are the view's unit of editing (AC2: contentEditable blocks,
 * one per paragraph) and are joined back into the body pablo saves with
 * `PARAGRAPH_SEPARATOR` — a body that was never touched round-trips through
 * `splitParagraphs`/`joinParagraphs` byte-for-byte.
 */

/** A blank line — the same paragraph boundary the fixture chapters and the host's own text already use. */
export const PARAGRAPH_SEPARATOR = "\n\n";

/** Splits a body into paragraphs. `joinParagraphs(splitParagraphs(body)) === body` always. */
export function splitParagraphs(body: string): string[] {
  if (body === "") return [""];
  return body.split(PARAGRAPH_SEPARATOR);
}

/** The inverse of `splitParagraphs`. */
export function joinParagraphs(paragraphs: readonly string[]): string {
  return paragraphs.join(PARAGRAPH_SEPARATOR);
}

/**
 * Word count exactly matching the host's own algorithm (`edit.ts`): split on
 * runs of whitespace, drop empties. Kept identical on purpose — this is a
 * display mirror, not an independent count, so the view's live number while
 * typing never drifts from what a `save` will report back.
 */
export function countWords(body: string): number {
  return body.split(/\s+/).filter((word) => word !== "").length;
}

export interface BodyOffsets {
  readonly start: number;
  readonly end: number;
}

/**
 * Converts a selection made inside one paragraph's contentEditable block —
 * `paragraphIndex` (0-based, in `splitParagraphs(body)` order) plus the
 * start/end offsets into *that paragraph's own text* — into the absolute
 * `{start, end}` pair into the full joined body that `mutate("revise", ...)`
 * needs. Returns `undefined` for an empty selection (`startInParagraph ===
 * endInParagraph`) or an out-of-range paragraph index, rather than throwing —
 * callers treat either as "no selection".
 */
export function selectionToBodyOffsets(
  paragraphs: readonly string[],
  paragraphIndex: number,
  startInParagraph: number,
  endInParagraph: number,
): BodyOffsets | undefined {
  if (paragraphIndex < 0 || paragraphIndex >= paragraphs.length) return undefined;
  if (startInParagraph === endInParagraph) return undefined;

  const lo = Math.min(startInParagraph, endInParagraph);
  const hi = Math.max(startInParagraph, endInParagraph);

  let offset = 0;
  for (let i = 0; i < paragraphIndex; i++) {
    offset += (paragraphs[i]?.length ?? 0) + PARAGRAPH_SEPARATOR.length;
  }

  return { start: offset + lo, end: offset + hi };
}

/**
 * Applies a revise candidate to a body: replaces `[start, end)` with
 * `candidate`, exactly what `Take` does locally before its follow-up `save`.
 * Bounds are clamped rather than throwing — a stale selection against text
 * that changed underneath it degrades to the nearest valid span instead of
 * corrupting the body.
 */
export function applyCandidate(body: string, start: number, end: number, candidate: string): string {
  const lo = Math.max(0, Math.min(start, body.length));
  const hi = Math.max(lo, Math.min(end, body.length));
  return body.slice(0, lo) + candidate + body.slice(hi);
}

/**
 * Which paragraph (0-based) a `check` hit's 1-based `line` number falls in.
 * `line` is a line number into `body.split("\n")` (see `check.ts`'s
 * `checkFile`) — this walks the same paragraphs `splitParagraphs` produced,
 * counting each paragraph's own line count plus the one blank separator line
 * `PARAGRAPH_SEPARATOR` inserts between paragraphs, so it lands on exactly
 * the paragraph `checkFile` would have numbered that line inside. A `line`
 * past the body's end (stale hits against text that has since shrunk)
 * clamps to the last paragraph rather than returning nothing.
 */
export function paragraphIndexForLine(paragraphs: readonly string[], line: number): number {
  if (paragraphs.length === 0) return 0;

  let consumed = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    const lineCount = (paragraphs[i] ?? "").split("\n").length;
    const start = consumed + 1;
    const end = consumed + lineCount;
    if (line >= start && line <= end) return i;
    consumed = end + 1; // + the blank separator line between this paragraph and the next
  }

  return paragraphs.length - 1;
}

/** Groups hit indices by the paragraph they fall in, per `paragraphIndexForLine`. */
export function groupHitsByParagraph<H extends { readonly line: number }>(
  paragraphs: readonly string[],
  hits: readonly H[],
): ReadonlyMap<number, H[]> {
  const byParagraph = new Map<number, H[]>();
  for (const hit of hits) {
    const index = paragraphIndexForLine(paragraphs, hit.line);
    const existing = byParagraph.get(index);
    if (existing === undefined) byParagraph.set(index, [hit]);
    else existing.push(hit);
  }
  return byParagraph;
}
