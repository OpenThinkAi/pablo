// `c` in a review (AGT-1581), the parts that are not the model: a keypress while a comment is being typed as an action.
// The state is state.ts's `commenting` (the branch, the change's path and line, the buffer); what the content area shows
// is `commentContent` there. Saving is the layer above's: cli.ts passes a `CommentSaver` (screen.tsx) that writes the
// comment store, and this package never imports the CLI.

import { tokenOf, type InkKey } from "./chord";
import { clean } from "./sanitize";
import type { Action } from "./state";

/**
 * A keypress while a comment is open. Typing goes to the one-line buffer, Backspace deletes, Esc cancels. Enter is not
 * an action: saving needs the buffer and the layer above, so the app tells it by `isSubmit` and saves.
 */
export function commentAction(input: string, key: InkKey): Action | null {
  const token = tokenOf(input, key);
  if (token === "esc") return { type: "escape" };
  if (token === "backspace") return { type: "comment.backspace" };
  if (token === "enter") return null;
  if (key.ctrl || key.meta || key.tab || input === "") return null;
  // A key that is a name (shift-down, home) or an escape sequence Ink did not recognise is not text.
  if (token !== null && token !== "space" && token !== input) return null;
  if (/^[[O][0-9;]*[A-Za-z~]$/.test(input) || input.includes("\x1b")) return null;
  const text = clean(input).replace(/[\r\n]+/g, " ");
  return text ? { type: "comment.type", text } : null;
}

/** Whether a keypress is Enter, which saves the comment. */
export const isSubmit = (input: string, key: InkKey): boolean => tokenOf(input, key) === "enter";
