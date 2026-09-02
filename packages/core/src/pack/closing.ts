/**
 * The closing lines of the two span-edit prompts. The pack owns them so that
 * `pack.prompt` prices the exact text that goes over the wire; every adapter
 * that composes a span-edit prompt imports the line for its path from here.
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
