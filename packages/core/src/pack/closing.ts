/**
 * The closing lines of the prompts the pack module composes. The pack owns
 * them so that `pack.prompt` prices the exact text that goes over the wire;
 * every adapter (or, for `prose`, the caller sending `pack.prompt` whole)
 * imports the line for its path from here.
 */
export const TOOL_EDIT_CLOSING =
  "Call propose_edit once, with the complete replacement passage as the replacement argument." +
  " Do not write the passage in your reply, and do not explain what you changed.";

export const CRITICMARKUP_EDIT_CLOSING = [
  "Answer with CriticMarkup and nothing else: no preamble, no explanation, no code fence.",
  "Mark every change against the passage above and leave anything you are not changing exactly as it is:",
  "",
  "{~~old text~>new text~~}   replace",
  "{++added text++}           insert",
  "{--removed text--}         delete",
  "",
  "To rewrite the whole passage, wrap the whole of it in one substitution:",
  "{~~<the passage above, unchanged>~><your replacement>~~}",
  "",
  "Never nest a substitution inside a substitution, and never write ~> anywhere",
  "except between the two halves of one substitution.",
].join("\n");

/**
 * `prose`'s closing directive (AGT-1241): the whole pack is sent through
 * `complete()`, the same as drafting, so this is the last thing in the
 * prompt rather than a line an adapter appends.
 */
export const PROSE_CLOSING =
  "Write the piece now, in the voice above. No preamble, no markup, no commentary" +
  " — the finished text, and nothing else.";

/**
 * `prose`'s revise-loop closing (AGT-1244): selected instead of `PROSE_CLOSING`
 * whenever the pack carries a `draft` and an `instruction`. It asks for the
 * whole rewritten piece, never a diff or just the changed part — pablo has no
 * patch/diff format for prose, and a partial answer would leave the caller to
 * reconstruct the full piece itself.
 */
export const PROSE_REVISE_CLOSING =
  "Write the complete rewritten piece now, in the voice above, applying the instruction" +
  " to the previous text. The whole piece, not a diff and not only the changed part" +
  " — no preamble, no markup, no commentary.";
