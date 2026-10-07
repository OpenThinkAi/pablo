// `a v r` (AGT-1594), the parts that are not the model: a keypress while a voice rule is being typed as an action. The
// state is state.ts's `voiceRule`; what the content area shows is `voiceRuleContent` there. Writing is the layer above's:
// the app hands the text to the voicer on Enter (`isSubmit`), and this package never imports the CLI.

import { commentAction } from "./comment-input";
import { tokenOf, type InkKey } from "./chord";
import type { Action } from "./state";

/** Typing goes to the one-line buffer, Backspace deletes, Tab changes the target, Esc cancels. Enter is the app's. */
export function voiceRuleAction(input: string, key: InkKey): Action | null {
  if (tokenOf(input, key) === "tab") return { type: "voice.rule_target" };
  const a = commentAction(input, key); // the same one-line text rules as a comment
  if (a === null) return null;
  if (a.type === "comment.type") return { type: "voice.rule_type", text: a.text };
  if (a.type === "comment.backspace") return { type: "voice.rule_backspace" };
  return a;
}
