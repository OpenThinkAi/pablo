// The compose view's pure parts (AGT-1566): the seam the layer above passes in, the conversation as drawn lines, the
// view's geometry, and a keypress in the view as an action. The state is state.ts's `compose`; the drawing is
// compose-view.tsx. Nothing here knows Ink.
//
// The tui does not depend on the Agent SDK. The harness lives in the cli package (packages/cli/src/harness); the cli
// passes a `Composer` to `runScreen`, the way it passes the project. A turn is `send(message)`: a stream of
// `ComposeEvent`s ending at the turn's result. Tests give the screen a fake `Composer`; nothing here starts a session.

import { tokenOf, type InkKey } from "./chord";
import { STATUS_H, FOOTER_H, wrapText } from "./layout";
import { clean } from "./sanitize";
import type { Action, ComposeEntry, ComposeEvent, Measure } from "./state";

/**
 * One conversation with pablo, kept for as long as the screen is open. The session behind it is the seam's business:
 * `send` starts it on the first message, and each later message continues it. A turn's stream ends at its result (or
 * throws; the screen shows the reason as an error entry and the next message tries again). `close` ends the session
 * when the screen closes.
 */
export interface Composer {
  send(message: string): AsyncIterable<ComposeEvent>;
  /** The author's answer to a `question` event's card (by its id); the turn's stream carries on. */
  answer?(id: string, text: string): void;
  close?(): void;
}

// ---------------------------------------------------------------- the conversation as lines

export type LineStyle = "author" | "pablo" | "tool" | "result" | "error" | "question" | "dim" | "blank";
export interface ComposeLine { readonly text: string; readonly style: LineStyle }

const PREVIEW = 200;
const flat = (text: string) => clean(text).replace(/\s+/g, " ").trim();
const cut = (text: string, width: number) => { const chars = [...text]; return chars.length > width ? `${chars.slice(0, Math.max(0, width - 1)).join("")}…` : text; };

/** `text` wrapped to `width` with `first` before the first row and the same width of spaces before the rest. */
function hanging(text: string, width: number, first: string, style: LineStyle): ComposeLine[] {
  const rows = wrapText(clean(text), Math.max(1, width - first.length));
  return rows.map((row, i) => ({ text: (i === 0 ? first : " ".repeat(first.length)) + row, style }));
}

/** One entry as lines at `width` columns. */
export function entryLines(entry: ComposeEntry, width: number): ComposeLine[] {
  switch (entry.kind) {
    case "author": return [...hanging(entry.text, width, "› ", "author"), { text: "", style: "blank" }];
    case "pablo": return [...hanging(entry.text, width, "", "pablo"), { text: "", style: "blank" }];
    case "error": return [...hanging(entry.text, width, "✗ ", "error"), { text: "", style: "blank" }];
    case "tool": {
      const input = entry.input === undefined || entry.input === null ? "" : ` ${JSON.stringify(entry.input)}`;
      const lines: ComposeLine[] = [{ text: cut(`  → ${flat(entry.tool)}${flat(input) ? ` ${flat(input)}` : ""}`, width), style: "tool" }];
      if (entry.result) lines.push({ text: cut(`  ${entry.result.isError ? "✗" : "←"} ${flat(entry.result.text).slice(0, PREVIEW)}`, width), style: entry.result.isError ? "error" : "result" });
      return lines;
    }
    case "question": {
      const lines = hanging(entry.question, width, "? ", "question");
      entry.options?.forEach((option, i) => lines.push(...hanging(option, width, `   ${i + 1}. `, "question")));
      if (entry.why) lines.push(...hanging(entry.why, width, "   why: ", "dim"));
      lines.push(entry.answer === undefined ? { text: "   waiting for your answer", style: "dim" } : { text: cut(`   → ${flat(entry.answer)}`, width), style: "author" });
      return [...lines, { text: "", style: "blank" }];
    }
  }
}

export const composeLines = (entries: readonly ComposeEntry[], width: number): ComposeLine[] => entries.flatMap((e) => entryLines(e, width));

// ---------------------------------------------------------------- geometry

/** The heading row, the activity row and the input box (border, one line, border) around the conversation's lines. */
const HEADING_H = 1, ACTIVITY_H = 1, INPUT_H = 3;

export interface ComposeLayout {
  /** Rows the conversation's lines show, and how wide they are. */
  readonly rows: number; readonly inner: number;
  /** The input box's inner width (border and padding off). */
  readonly inputInner: number;
}

export function composeLayout(cols: number, rows: number): ComposeLayout {
  return { rows: Math.max(1, rows - STATUS_H - FOOTER_H - HEADING_H - ACTIVITY_H - INPUT_H), inner: Math.max(1, cols - 2), inputInner: Math.max(1, cols - 6) };
}

/** What the layout tells the model about the conversation at this size. */
export function composeMeasure(layout: ComposeLayout, entries: readonly ComposeEntry[]): Measure {
  return { compose: { visible: layout.rows, lines: composeLines(entries, layout.inner).length } };
}

/** The lines on screen: the newest `rows` lines, or the ones `offset` further back. */
export function visibleLines(lines: readonly ComposeLine[], rows: number, offset: number): ComposeLine[] {
  const end = Math.max(0, lines.length - offset);
  return lines.slice(Math.max(0, end - rows), end);
}

/** The tail of the input that fits `width` with room for the cursor. */
export const inputTail = (input: string, width: number): string => [...clean(input)].slice(-Math.max(1, width - 1)).join("");

// ---------------------------------------------------------------- keys

/**
 * A keypress in the compose view as an action, or null. Typing goes into the input (a paste arrives as one chunk,
 * its line breaks made spaces: the box is one line); Enter sends; the arrows and paging scroll the conversation; Esc
 * leaves. The prefix keys and `q` are text here, not commands.
 */
export function composeAction(input: string, key: InkKey): Action | null {
  const token = tokenOf(input, key);
  switch (token) {
    case "esc": return { type: "escape" };
    case "enter": return { type: "compose.submit" };
    case "backspace": return { type: "compose.backspace" };
    case "up": return { type: "compose.up" };
    case "down": return { type: "compose.down" };
    case "pgup": return { type: "compose.page_up" };
    case "pgdn": return { type: "compose.page_down" };
    default: break;
  }
  if (key.ctrl || key.meta || key.tab || input === "") return null;
  // A key that is a name (shift-down, home) or an escape sequence Ink did not recognise is not text.
  if (token !== null && token !== "space" && token !== input) return null;
  if (/^[[O][0-9;]*[A-Za-z~]$/.test(input) || input.includes("\x1b")) return null;
  const text = clean(input).replace(/\s+/g, " ");
  return text ? { type: "compose.type", text } : null;
}
