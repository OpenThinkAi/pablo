/**
 * The conformance check for provider output. Every adapter has two structured
 * paths — a native tool call and CriticMarkup as text — and both have to pass
 * this before the bake-off will keep them.
 *
 * It is the parser's own well-formedness plus the two failures that only matter
 * for a model's answer: prose that carries no proposal at all, and a stray `~>`,
 * which is what a mangled substitution looks like when a small model loses a
 * delimiter.
 */

import { flattenMarks, parse } from "./parse";
import type { Mark, Violation } from "./types";

export type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly Violation[] };

const SEPARATOR = "~>";

/** Where a `~>` belongs: separating a substitution, or inside a note, which is free prose. */
function isArrowLegal(marks: readonly Mark[]): (at: number) => boolean {
  const all = flattenMarks(marks);
  const separators = new Set(
    all.flatMap((mark) => (mark.replacement === undefined ? [] : [mark.body.end])),
  );
  const notes = all.filter((mark) => mark.kind === "note").map((mark) => mark.body);

  return (at) => separators.has(at) || notes.some((body) => at >= body.start && at < body.end);
}

export function validateProposal(text: string): ValidationResult {
  const model = parse(text);
  const violations = [...model.violations];

  if (model.marks.length === 0) {
    violations.push({ position: 0, message: "no CriticMarkup marks: the answer proposes nothing" });
  }

  const legal = isArrowLegal(model.marks);
  for (let at = text.indexOf(SEPARATOR); at !== -1; at = text.indexOf(SEPARATOR, at + 1)) {
    if (legal(at)) continue;
    violations.push({ position: at, message: "~> outside a substitution" });
  }

  if (violations.length === 0) return { ok: true };
  violations.sort((a, b) => a.position - b.position);
  return { ok: false, violations };
}
