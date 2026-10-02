// One place that strips terminal control characters from text that did not come from the human at this
// keyboard: a manuscript file, a model's reply, a reader's note. It runs at each boundary, before
// the text is stored or rendered, so nothing downstream can be made to rewrite the screen, set the window
// title, or hide text with an escape sequence. Newline and tab are kept; everything else in C0 and C1 goes.

// Whole sequences first, so their payload does not survive as plain text: OSC (ESC ] … BEL|ST), the string
// controls DCS/SOS/PM/APC (… ST), CSI (ESC [ params final), then any other two-character ESC sequence.
// An unterminated string sequence is cut at the end of its line rather than eating the rest of the text.
/* eslint-disable no-control-regex */
const SEQUENCES = new RegExp([
  "(?:\\x1b\\]|\\x9d)[^\\x07\\x1b\\x9c\\n]*(?:\\x07|\\x1b\\\\|\\x9c)?",
  "(?:\\x1b[PX^_]|[\\x90\\x98\\x9e\\x9f])[^\\x1b\\x9c\\n]*(?:\\x1b\\\\|\\x9c)?",
  "(?:\\x1b\\[|\\x9b)[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]?",
  "\\x1b[\\x20-\\x7e]?",
].join("|"), "g");
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/* eslint-enable no-control-regex */

export const clean = (s: string): string => s.replace(SEQUENCES, "").replace(CONTROLS, "");

/** Does this string carry anything `clean` would remove? For values that must be refused, not quietly changed. */
export const isClean = (s: string): boolean => clean(s) === s;

/**
 * Manuscript text and file paths are shown as they are, but never as live escape codes: each control character becomes
 * a visible stand-in (ESC is ␛, the other C0 their control picture, DEL ␡, a C1 its `\xNN`), so the author sees that
 * something odd is in the file instead of it silently vanishing. Render-time only: models and files keep the raw text.
 */
export const visible = (s: string): string =>
  s.replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, (c) => { // tab is left to the caller, which widens it
    const n = c.charCodeAt(0);
    return n < 0x20 ? String.fromCharCode(0x2400 + n) : n === 0x7f ? "␡" : `\\x${n.toString(16)}`;
  });

/**
 * Invisible characters that can split a word or a tag so it no longer reads as one to a regex but still does to a model:
 * zero-width and direction marks, line and paragraph separators, word joiners and invisible operators, the BOM, the bidi
 * embeddings and isolates, the tag characters, and any other format character (Cf). They carry nothing a reader can see.
 */
const INVISIBLE = /[\u200B-\u200F\u2028\u2029\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}\p{Cf}]/gu;

/** `s` without the invisible characters, for text a model reads as data; everything visible is kept as written. */
export const stripInvisible = (s: string): string => s.replace(INVISIBLE, "");
