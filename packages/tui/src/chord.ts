// From a keypress to actions: the terminal's bytes (or Ink's reading of them) to a key token, then a token, in a key
// state, with or without a prefix pending, to what happens. Pure, so every chord is tested without a screen:
//
//   a prefix, then its second key            `g e`, `v z`, `a p`
//   g, digits, g (or Enter)                   `g 120 g`: that line of the document
//
// The number closes on the prefix key it opened with (the g prefix's digits are not remappable, so that is always g);
// Enter does the same. A bare `g g` is go.top. Any key that is not one of the prefix's second keys cancels the prefix
// and does nothing else. Esc is always the model's `escape`, which cancels a pending prefix first and then backs out
// of whatever is open. Copied from prview's chord.ts and adapted.
//
// The pending prefix lives in the model (state.ts); this reads it and answers with the actions to dispatch.

import { isPrefix, keysOf, prefixesOf, prefixRows, rowsOf, DEFAULT_KEYMAP, type Do, type KeyState, type Keymap } from "./keys";
import type { Pending } from "./state";

/** The actions one key causes, in order; empty when it means nothing here. */
export function resolve(ks: KeyState, pending: Pending | null, token: string, km: Keymap = DEFAULT_KEYMAP): Do[] {
  if (token === "esc") return [{ type: "escape" }];
  if (pending?.digits !== undefined) {
    if (/^[0-9]$/.test(token)) return [{ type: "prefix.digit", digit: token }];
    if (token === "backspace") return [{ type: "prefix.backspace" }];
    if ((token === "enter" || token === pending.prefix) && pending.digits) return [{ type: "main.goto", line: parseInt(pending.digits, 10) }, { type: "prefix.clear" }];
    return [{ type: "prefix.clear" }];
  }
  if (pending) {
    if (!isPrefix(pending.prefix)) return [{ type: "prefix.clear" }];
    const rows = prefixRows(ks, pending.prefix, km);
    if (pending.prefix === "g" && /^[0-9]$/.test(token) && rows.some((r) => r.id === "go.line")) return [{ type: "prefix.digit", digit: token }];
    const hit = rows.find((r) => r.do && keysOf(r).includes(token));
    return hit?.do ? [hit.do, { type: "prefix.clear" }] : [{ type: "prefix.clear" }];
  }
  const hit = rowsOf(ks, km).find((r) => r.do && keysOf(r).includes(token));
  if (hit?.do) return [hit.do];
  if (isPrefix(token) && prefixesOf(ks, km).includes(token)) return [{ type: "prefix.press", prefix: token }];
  return [];
}

// ---------------------------------------------------------------- the terminal's keys

/** What Ink hands a key handler about the key, the fields read here. */
export type InkKey = {
  upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; pageUp?: boolean; pageDown?: boolean;
  home?: boolean; end?: boolean; return?: boolean; escape?: boolean; ctrl?: boolean; shift?: boolean; tab?: boolean;
  backspace?: boolean; delete?: boolean; meta?: boolean;
};

const ARROW: Record<string, string> = { A: "up", B: "down", C: "right", D: "left" };

/**
 * A raw escape sequence to its token: the plain arrows (CSI and SS3), shift-arrows as xterm sends them
 * (`\x1b[1;2A`..`D`) and as rxvt does (`\x1b[a`..`d`), shift-Tab, paging, Home and End. Null for anything else.
 */
export function parseSequence(seq: string): string | null {
  let m: RegExpMatchArray | null;
  if ((m = seq.match(/^\x1b[[O]([ABCD])$/))) return ARROW[m[1]!]!;
  if ((m = seq.match(/^\x1b\[1;(\d+)([ABCD])$/))) return (((Number(m[1]) - 1) & 1) ? "shift-" : "") + ARROW[m[2]!]!;
  if ((m = seq.match(/^\x1b\[([abcd])$/))) return "shift-" + ARROW[m[1]!.toUpperCase()]!;
  if (seq === "\x1b[Z") return "shift-tab";
  if (seq === "\x1b[5~") return "pgup";
  if (seq === "\x1b[6~") return "pgdn";
  if (seq === "\x1b[H" || seq === "\x1b[1~" || seq === "\x1bOH") return "home";
  if (seq === "\x1b[F" || seq === "\x1b[4~" || seq === "\x1bOF") return "end";
  return null;
}

/** Ink's reading of a key to a token, or null for one that means nothing here (a bare modifier, an unknown sequence). */
export function tokenOf(input: string, key: InkKey): string | null {
  const arrow = key.upArrow ? "up" : key.downArrow ? "down" : key.leftArrow ? "left" : key.rightArrow ? "right" : null;
  if (arrow) return key.shift ? `shift-${arrow}` : arrow;
  if (key.tab) return key.shift ? "shift-tab" : "tab";
  if (key.return) return "enter";
  if (key.escape && !input) return "esc";
  if (key.pageUp) return "pgup";
  if (key.pageDown) return "pgdn";
  if (key.home) return "home";
  if (key.end) return "end";
  if (key.backspace || key.delete) return "backspace";
  if (key.ctrl && /^[a-z]$/.test(input)) return `ctrl-${input}`;
  if (input === " ") return "space";
  // One raw control character, as a paste or a split chunk delivers it.
  const RAW: Record<string, string> = { "\r": "enter", "\n": "enter", "\t": "tab", "\x7f": "backspace", "\b": "backspace", "\x1b": "esc" };
  if (RAW[input]) return RAW[input]!;
  if (/^[\x01-\x1a]$/.test(input)) return `ctrl-${String.fromCharCode(input.charCodeAt(0) + 96)}`;
  // A sequence Ink did not recognise reaches here with its ESC stripped ("[1;2B"): read it ourselves.
  if (/^[[O][0-9;]*[A-Za-z~]$/.test(input)) return parseSequence("\x1b" + input);
  if ([...input].length === 1 && !key.ctrl && !key.meta) return input;
  if (key.escape) return "esc";
  return null;
}
