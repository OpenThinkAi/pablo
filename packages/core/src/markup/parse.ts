/**
 * The CriticMarkup parser. It is hand-written and deliberately small: it is the
 * conformance check every provider's structured output has to pass, so it has
 * to be exactly as strict as the format and no stricter.
 *
 * Malformed markup never throws. An unterminated, mismatched, or separator-less
 * mark is dropped to literal text and reported as a `Violation` with a
 * position, so the surrounding prose still parses and still round-trips.
 */

import { scanBlocks } from "./blocks";
import type { Mark, MarkKind, MarkupDocument, Violation } from "./types";

const OPENERS: ReadonlyArray<readonly [string, MarkKind]> = [
  ["{++", "addition"],
  ["{--", "deletion"],
  ["{~~", "substitution"],
  ["{>>", "note"],
  ["{==", "highlight"],
];

const CLOSERS: ReadonlyArray<readonly [string, MarkKind]> = [
  ["++}", "addition"],
  ["--}", "deletion"],
  ["~~}", "substitution"],
  ["<<}", "note"],
  ["==}", "highlight"],
];

/** The delimiter length shared by every opener and closer. */
const DELIMITER = 3;

const SEPARATOR = "~>";

interface Frame {
  readonly kind: MarkKind;
  readonly start: number;
  readonly children: Mark[];
}

function kindAt(table: ReadonlyArray<readonly [string, MarkKind]>, text: string, at: number): MarkKind | null {
  const token = text.slice(at, at + DELIMITER);
  for (const [candidate, kind] of table) {
    if (candidate === token) return kind;
  }
  return null;
}

/** The `~>` of a substitution, skipping over any nested mark that contains one. */
function separatorIndex(text: string, start: number, end: number, children: readonly Mark[]): number {
  let at = start;
  let child = 0;
  while (at + SEPARATOR.length <= end) {
    const nested = children[child];
    if (nested !== undefined && nested.span.start === at) {
      at = nested.span.end;
      child += 1;
      continue;
    }
    if (text.startsWith(SEPARATOR, at)) return at;
    at += 1;
  }
  return -1;
}

export function parse(text: string): MarkupDocument {
  const roots: Mark[] = [];
  const frames: Frame[] = [];
  const violations: Violation[] = [];

  const siblings = (): Mark[] => frames[frames.length - 1]?.children ?? roots;

  /** Turn a closed frame into a mark, or drop it and keep the marks nested inside. */
  const close = (frame: Frame, closerStart: number): void => {
    const span = { start: frame.start, end: closerStart + DELIMITER };
    const body = { start: frame.start + DELIMITER, end: closerStart };

    if (frame.kind === "substitution") {
      const separator = separatorIndex(text, body.start, body.end, frame.children);
      if (separator === -1) {
        violations.push({ position: frame.start, message: "substitution is missing its ~> separator" });
        siblings().push(...frame.children);
        return;
      }
      siblings().push({
        kind: "substitution",
        span,
        body: { start: body.start, end: separator },
        replacement: { start: separator + SEPARATOR.length, end: body.end },
        children: frame.children,
      });
      return;
    }

    siblings().push({ kind: frame.kind, span, body, children: frame.children });
  };

  /** Drop every frame opened after `depth`; whatever they contain belongs to their parent. */
  const abandonAbove = (depth: number): void => {
    while (frames.length > depth + 1) {
      const dead = frames.pop();
      if (dead === undefined) return;
      violations.push({ position: dead.start, message: `unterminated ${dead.kind} mark` });
      siblings().push(...dead.children);
    }
  };

  let at = 0;
  while (at < text.length) {
    const opener = kindAt(OPENERS, text, at);
    if (opener !== null) {
      frames.push({ kind: opener, start: at, children: [] });
      at += DELIMITER;
      continue;
    }

    const closer = kindAt(CLOSERS, text, at);
    if (closer === null) {
      at += 1;
      continue;
    }

    let depth = frames.length - 1;
    while (depth >= 0 && frames[depth]?.kind !== closer) depth -= 1;

    if (depth === -1) {
      violations.push({ position: at, message: `unmatched ${closer} closer` });
      at += DELIMITER;
      continue;
    }

    abandonAbove(depth);
    const frame = frames.pop();
    if (frame !== undefined) close(frame, at);
    at += DELIMITER;
  }

  abandonAbove(-1);

  violations.sort((a, b) => a.position - b.position);
  return { text, blocks: scanBlocks(text), marks: roots, violations };
}

/** Every mark in document order, outer before inner. */
export function flattenMarks(marks: readonly Mark[]): Mark[] {
  return marks.flatMap((mark) => [mark, ...flattenMarks(mark.children)]);
}
