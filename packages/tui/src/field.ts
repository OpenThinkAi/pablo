/**
 * The one text-entry surface in a tool that is not a text editor.
 *
 * pablo has no insert mode over the manuscript. It has a **field**: a box that
 * opens for one answer — an instruction to the model (AC1) or the replacement
 * for a span typed by hand (AC2) — and closes. The manuscript is never typed
 * into directly, which is the binding decision this module keeps honest.
 *
 * It is deliberately tiny. There is no undo, no selection, no word motion and
 * no search: anything that wants those wants `$EDITOR`, which is a key away
 * (AC4). Everything here is pure, so the field is tested without a terminal.
 */

export type FieldKind = "prompt" | "manual";

export interface Field {
  readonly kind: FieldKind;
  /** The line above the box. */
  readonly title: string;
  /** The line below it: which keys do what. */
  readonly hint: string;
  readonly value: string;
  /** Caret position, a UTF-16 code unit index into `value`. */
  readonly cursor: number;
  /** A prompt is one line and `enter` sends it; a manual edit is many. */
  readonly multiline: boolean;
}

export function openField(kind: FieldKind, value: string): Field {
  return kind === "prompt"
    ? {
        kind,
        title: "prompt the model on the selection",
        hint: "enter sends  ·  esc cancels",
        value,
        cursor: value.length,
        multiline: false,
      }
    : {
        kind,
        title: "manual edit — your text replaces the selection, with no markup",
        hint: "ctrl+s saves  ·  enter is a new line  ·  esc cancels",
        value,
        cursor: value.length,
        multiline: true,
      };
}

export function insertInto(field: Field, text: string): Field {
  const value = field.value.slice(0, field.cursor) + text + field.value.slice(field.cursor);
  return { ...field, value, cursor: field.cursor + text.length };
}

export function backspace(field: Field): Field {
  if (field.cursor === 0) return field;
  const value = field.value.slice(0, field.cursor - 1) + field.value.slice(field.cursor);
  return { ...field, value, cursor: field.cursor - 1 };
}

export function deleteForward(field: Field): Field {
  if (field.cursor >= field.value.length) return field;
  return { ...field, value: field.value.slice(0, field.cursor) + field.value.slice(field.cursor + 1) };
}

export function moveCaret(field: Field, by: -1 | 1): Field {
  const cursor = Math.max(0, Math.min(field.value.length, field.cursor + by));
  return cursor === field.cursor ? field : { ...field, cursor };
}

/** Start and end of the line the caret is on: `home` and `end` inside the field. */
export function toLineEdge(field: Field, edge: "start" | "end"): Field {
  const before = field.value.lastIndexOf("\n", Math.max(0, field.cursor - 1)) + 1;
  const after = field.value.indexOf("\n", field.cursor);
  const cursor = edge === "start" ? before : after === -1 ? field.value.length : after;
  return { ...field, cursor };
}

/**
 * The field's text as display rows, wrapped to `width`, with the caret shown as
 * a reverse-video cell. Rendering is `chrome.ts`'s job; this is the wrapping
 * and the caret arithmetic, which is what a test wants to assert on.
 */
export function fieldRows(field: Field, width: number): { rows: string[]; caret: { row: number; column: number } } {
  const usable = Math.max(1, width);
  const rows: string[] = [];
  let caret = { row: 0, column: 0 };

  let consumed = 0;
  for (const line of field.value.split("\n")) {
    const wrapped = wrap(line, usable);
    for (const [index, piece] of wrapped.entries()) {
      const start = consumed + wrapped.slice(0, index).reduce((total, part) => total + part.length, 0);
      if (field.cursor >= start && field.cursor <= start + piece.length) {
        caret = { row: rows.length, column: field.cursor - start };
      }
      rows.push(piece);
    }
    // The newline itself is one character, and the caret can sit on it.
    consumed += line.length + 1;
  }

  return { rows, caret };
}

/** Hard wrap: a field is for an instruction or a paragraph, not for prose layout. */
function wrap(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const pieces: string[] = [];
  for (let at = 0; at < line.length; at += width) pieces.push(line.slice(at, at + width));
  return pieces;
}
