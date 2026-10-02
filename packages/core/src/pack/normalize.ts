/**
 * The normalization stage: a pure function every model output passes through
 * before it becomes a proposal.
 *
 * This is not house style imposed on the author. It is the four things local
 * models do that `style/prose.md` forbids outright, fixed mechanically so the
 * author never spends a review round on them: em-dashes, en-dashes, curly
 * quotes, and trailing whitespace. `bin/draft-chapter` did the same four
 * substitutions inline; here they are testable, idempotent, and applied in one
 * place.
 *
 * Everything else `prose.md` asks for (do not restate the brief, do not
 * editorialize the ending) is a judgement a regex cannot make and lives in the
 * pack's craft rules instead.
 */

import type { Proposal } from "../providers/types";

/** Character classes, as source fragments, so each rule reads as one replacement. */
const EM_DASH = "[\u2014\u2015]";
const EN_DASH = "\u2013";

/**
 * Applies the mechanical rules from `style/prose.md`:
 *
 * - em-dash to a comma ("No em-dashes anywhere; use a comma, a period, or parentheses")
 * - en-dash to "to" ('Year ranges: "1920 to 1933", not "1920-1933"')
 * - curly quotes and apostrophes to straight ('Straight quotes ("like this"), never curly')
 * - trailing whitespace stripped from every line, and from the text
 *
 * Idempotent: `normalizeOutput(normalizeOutput(x)) === normalizeOutput(x)`.
 */
export function normalizeOutput(text: string): string {
  return (
    text
      // A dash opening a line (a dialogue dash) has no comma to become.
      .replace(new RegExp(`^[ \\t]*${EM_DASH}[ \\t]*`, "gm"), "")
      .replace(new RegExp(`[ \\t]*${EM_DASH}[ \\t]*`, "g"), ", ")
      .replace(new RegExp(`[ \\t]*${EN_DASH}[ \\t]*`, "g"), " to ")
      .replace(/[“”„‟]/g, '"')
      .replace(/[‘’‚‛]/g, "'")
      // A dash that stood where punctuation already was leaves a seam; close it.
      .replace(/,\s*,/g, ",")
      .replace(/[ \t]+([,.;:!?])/g, "$1")
      .replace(/,([.;:!?])/g, "$1")
      .replace(/[ \t]+$/gm, "")
      .trim()
  );
}

/** The same rules over every variant of a proposal, on its way to the review surface. */
export function normalizeProposal(proposal: Proposal): Proposal {
  const [first, ...rest] = proposal.variants.map(normalizeOutput);
  return { ...proposal, variants: [first ?? "", ...rest] };
}

/**
 * Undoes a model wrapping its whole revise answer in quotation marks, and the doubled terminal punctuation the
 * wrapping tends to leave (`"He left."` plus a stray `.`). Unwraps only when the WHOLE answer is one matching pair
 * with no further quote of that family inside: a passage that opens and closes on dialogue but quotes something
 * within itself is returned untouched. String surgery, never a judgement about which quotes are real (it was the
 * editor's `normalizeCandidate`, AGT-1521, moved here so the screen and the CLI share it).
 */
export function normalizeCandidate(raw: string): string {
  const text = raw.trim();
  if (text.length < 2) return text;
  const open = text.charAt(0);
  const straight = open === '"';
  if (!straight && open !== "\u201c") return text;
  const tail = /[.!?]*$/.exec(text)?.[0] ?? "";
  const body = text.slice(0, text.length - tail.length);
  if (body.length < 2) return text;
  const close = body.charAt(body.length - 1);
  if (close !== (straight ? '"' : "\u201d")) return text;
  const inner = body.slice(1, -1);
  const quoted = straight ? inner.includes('"') : inner.includes("\u201c") || inner.includes("\u201d");
  return quoted ? text : inner;
}
