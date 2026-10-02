// The selection as the screen draws and hands it on, pure. The model (state.ts) holds which sentences are selected as
// indexes; this turns those indexes, with the pane's sentences (document.ts `paneOf`), into the pieces of a line to
// highlight and the stored lines `a r` (revise) and `a v` (voice) act on.

import type { Mark, PaneSentence } from "./document";
import type { Pane } from "./state";
import { selectedRange } from "./state";

/** A run of one display line, and whether it is part of the selection. */
export interface Piece { readonly text: string; readonly selected: boolean }

/** `line` cut into pieces at the edges of the selected sentences (`first`..`last`, indexes of the pane's sentences), or whole when nothing in it is selected. */
export function piecesOf(line: { readonly text: string; readonly marks?: readonly Mark[] }, range: { readonly first: number; readonly last: number } | null): Piece[] {
  const marks = range ? (line.marks ?? []).filter((m) => m.sentence >= range.first && m.sentence <= range.last).sort((a, b) => a.start - b.start) : [];
  const out: Piece[] = [];
  let at = 0;
  for (const m of marks) {
    const start = Math.max(m.start, at), end = Math.min(m.end, line.text.length);
    if (end <= start) continue;
    if (start > at) out.push({ text: line.text.slice(at, start), selected: false });
    out.push({ text: line.text.slice(start, end), selected: true });
    at = end;
  }
  if (at < line.text.length || out.length === 0) out.push({ text: line.text.slice(at), selected: false });
  return out;
}

/** What a command acting on the selection is given: the sentences, and the stored lines they span (0-based, inclusive, in the file as stored). */
export interface Selected { readonly sentences: readonly string[]; readonly stored: { readonly from: number; readonly to: number } }

/** The selected sentences of the document `sentences` came from, or null with nothing selected. */
export function selectedOf(main: Pane, sentences: readonly PaneSentence[]): Selected | null {
  const range = selectedRange(main);
  const chosen = range ? sentences.slice(range.first, range.last + 1) : [];
  if (chosen.length === 0) return null;
  return { sentences: chosen.map((s) => s.text), stored: { from: Math.min(...chosen.map((s) => s.stored.from)), to: Math.max(...chosen.map((s) => s.stored.to)) } };
}
