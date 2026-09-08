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
 * The body offset of a paragraph's first character: the blocks are rendered
 * from `splitParagraphs(body)` in order, so this is just the sum of every
 * preceding paragraph's length plus one `PARAGRAPH_SEPARATOR` per gap. Exact
 * and DOM-free — the mapping `selectionToBodyOffsets` builds its answer from.
 */
function paragraphStartOffset(paragraphs: readonly string[], paragraphIndex: number): number {
  let offset = 0;
  for (let i = 0; i < paragraphIndex; i++) {
    offset += (paragraphs[i]?.length ?? 0) + PARAGRAPH_SEPARATOR.length;
  }
  return offset;
}

/**
 * Converts a selection anchored inside one paragraph's contentEditable block
 * and ending inside another (the same block, for a selection that never
 * leaves one paragraph) into the absolute `{start, end}` pair into the full
 * joined body that `mutate("revise", ...)` needs. `startParagraphIndex`/
 * `endParagraphIndex` are 0-based, in `splitParagraphs(body)` order;
 * `startInParagraph`/`endInParagraph` are offsets into each of those
 * paragraphs' own text. Each endpoint is resolved to a body offset via
 * `paragraphStartOffset` independently, so the two endpoints can land in
 * different blocks — the paragraph separators between them fall out of the
 * same index arithmetic and end up included in the returned span, which is
 * what makes `body.slice(start, end)` include the `"\n\n"`s between the
 * selected paragraphs.
 *
 * Returns `undefined` for an empty selection (the two endpoints resolve to
 * the same body offset) or an out-of-range paragraph index, rather than
 * throwing — callers treat either as "no selection".
 */
export function selectionToBodyOffsets(
  paragraphs: readonly string[],
  startParagraphIndex: number,
  startInParagraph: number,
  endParagraphIndex: number,
  endInParagraph: number,
): BodyOffsets | undefined {
  if (startParagraphIndex < 0 || startParagraphIndex >= paragraphs.length) return undefined;
  if (endParagraphIndex < 0 || endParagraphIndex >= paragraphs.length) return undefined;

  const startAbs = paragraphStartOffset(paragraphs, startParagraphIndex) + startInParagraph;
  const endAbs = paragraphStartOffset(paragraphs, endParagraphIndex) + endInParagraph;

  if (startAbs === endAbs) return undefined;

  return { start: Math.min(startAbs, endAbs), end: Math.max(startAbs, endAbs) };
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

/**
 * What `savedText` (the dirty-flag baseline) should become after one save
 * attempt: `attempted` on success, unchanged `previous` on failure. Only a
 * *confirmed* save may mark the view clean — a caller that sets `savedText`
 * before the host answers (e.g. resetting local state right before an
 * async `save`) leaves `dirty` false during the request, so a failure has
 * no way back to a retryable state (`Save` reads `!dirty` and stays
 * disabled with the edit still on screen). Route every `savedText` update
 * through this function instead of setting it ad hoc.
 */
export function nextSavedText(previous: string, attempted: string, ok: boolean): string {
  return ok ? attempted : previous;
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

const STRAIGHT_DOUBLE_QUOTE = '"';
const CURLY_OPEN_QUOTE = "“"; // “
const CURLY_CLOSE_QUOTE = "”"; // ”

function isOpeningQuote(char: string | undefined): boolean {
  return char === STRAIGHT_DOUBLE_QUOTE || char === CURLY_OPEN_QUOTE;
}

function isClosingQuote(char: string | undefined): boolean {
  return char === STRAIGHT_DOUBLE_QUOTE || char === CURLY_CLOSE_QUOTE;
}

/** Whether `close` is the correct closing mark for `open` — a curly open must meet a curly close, never a straight one, and vice versa. */
function isMatchingPair(open: string, close: string): boolean {
  if (open === STRAIGHT_DOUBLE_QUOTE) return close === STRAIGHT_DOUBLE_QUOTE;
  if (open === CURLY_OPEN_QUOTE) return close === CURLY_CLOSE_QUOTE;
  return false;
}

/** Whether `text` contains another quote from the same family as `open` — the signal that a passage quotes its own dialogue rather than being wrapped by one. */
function containsQuoteOfSameFamily(text: string, open: string): boolean {
  if (open === STRAIGHT_DOUBLE_QUOTE) return text.includes(STRAIGHT_DOUBLE_QUOTE);
  return text.includes(CURLY_OPEN_QUOTE) || text.includes(CURLY_CLOSE_QUOTE);
}

/**
 * Undoes the model wrapping its whole answer in quotation marks, and the
 * duplicated terminal punctuation that wrapping tends to leave behind (a
 * sentence that already ends in "." picks up a second, stray one once a
 * closing quote sits between the two).
 *
 * The rule is "unwrap only when the WHOLE string is wrapped in one pair":
 * `raw` must open with a quote, and — once any stray trailing `.`/`!`/`?`
 * characters are set aside — close with the matching quote, with no further
 * quote of that family anywhere in between. A passage that legitimately
 * opens and closes with dialogue quotes but also quotes something *inside*
 * itself fails that last check and is returned untouched: this is string
 * surgery only, never a judgement call about which quotes are "real".
 */
export function normalizeCandidate(raw: string): string {
  if (raw.length < 2) return raw;

  const open = raw.charAt(0);
  if (!isOpeningQuote(open)) return raw;

  const trailingPunctuation = raw.match(/[.!?]*$/)?.[0] ?? "";
  const withoutTrailingPunctuation = raw.slice(0, raw.length - trailingPunctuation.length);
  if (withoutTrailingPunctuation.length < 2) return raw;

  const close = withoutTrailingPunctuation.charAt(withoutTrailingPunctuation.length - 1);
  if (!isClosingQuote(close) || !isMatchingPair(open, close)) return raw;

  const inner = withoutTrailingPunctuation.slice(1, -1);
  if (containsQuoteOfSameFamily(inner, open)) return raw;

  return inner;
}
