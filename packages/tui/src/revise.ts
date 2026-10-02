// `a r` (AGT-1544), the parts that are not the model: the seam the layer above passes in and a keypress while a revise
// is open as an action. The state is state.ts's `revise` (phase, instruction, candidate); what the content area shows is
// `reviseContent` there. This package does not import the CLI: cli.ts passes a `Reviser` (screen-revise.ts) to runScreen.

import { tokenOf, type InkKey } from "./chord";
import { clean } from "./sanitize";
import type { Action, Revise } from "./state";

/** The selected sentences of a document, and the instruction to revise them by. `stored` is 0-based and inclusive. */
export interface ReviseRequest {
  readonly file: string;
  readonly sentences: readonly string[];
  readonly stored: { readonly from: number; readonly to: number };
  readonly instruction: string;
}
/** What a revise came to: the candidate and the receipt it carries, or why there is none. */
export type ReviseResult =
  | { readonly ok: true; readonly candidate: string; readonly receipt: string; readonly model: string; readonly lines: readonly string[] }
  | { readonly ok: false; readonly message: string };
export interface TakeRequest extends ReviseRequest {
  /** The candidate as the author left it, and as the model gave it (a difference is an edit the commit records). */
  readonly candidate: string;
  readonly offered: string;
  readonly receipt: string;
  readonly model: string;
}
/** What taking came to: the branch it made (review mode opens on it) and the lines for the content area, or why not. */
export type TakeResult =
  | { readonly ok: true; readonly branch: string; readonly lines: readonly string[] }
  | { readonly ok: false; readonly message: string };

/** `revise` runs the model (the candidate so far streams to `partial`); `take` commits the candidate, edited or not, on a `revise/` branch. */
export interface Reviser {
  revise(request: ReviseRequest, partial: (text: string) => void): Promise<ReviseResult>;
  take(request: TakeRequest): Promise<TakeResult>;
}

/**
 * A keypress while a revise is open. Typing goes to the instruction (`ask`) or the candidate (`edit`); Enter runs or
 * takes; Esc cancels (the model's answer to a cancelled revise is ignored). While the model runs or the commit is made
 * only Esc means anything. Ctrl-N puts a paragraph break in the candidate.
 */
export function reviseAction(revise: Revise, input: string, key: InkKey): Action | null {
  const token = tokenOf(input, key);
  if (token === "esc") return { type: "escape" };
  if (revise.phase !== "ask" && revise.phase !== "edit") return null;
  switch (token) {
    case "enter": return revise.phase === "ask" ? { type: "revise.run" } : { type: "revise.take" };
    case "backspace": return { type: "revise.backspace" };
    case "left": return { type: "revise.left" };
    case "right": return { type: "revise.right" };
    case "ctrl-n": return revise.phase === "edit" ? { type: "revise.type", text: "\n\n" } : null;
    default: break;
  }
  if (key.ctrl || key.meta || key.tab || input === "") return null;
  // A key that is a name (shift-down, home) or an escape sequence Ink did not recognise is not text.
  if (token !== null && token !== "space" && token !== input) return null;
  if (/^[[O][0-9;]*[A-Za-z~]$/.test(input) || input.includes("\x1b")) return null;
  const text = clean(input).replace(/[\r\n]+/g, " ");
  return text ? { type: "revise.type", text } : null;
}
