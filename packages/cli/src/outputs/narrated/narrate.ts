/**
 * Prose into a narration script, and the check that holds a script to its
 * prose (AGT-2137, D-7). Pure: no files, no model.
 *
 * `narrateProse` turns a source unit's body (one sentence per line,
 * paragraphs split by a blank line) into a `lines` script the radio side
 * reads (`script.py`): a `CAST:` line, then one `NARRATOR:` line per
 * paragraph. With `characters`, a paragraph whose quoted dialogue names its
 * speaker (a character the bible knows, named in the paragraph's narration)
 * is split at the quotes: the narration stays `NARRATOR:`, each quote becomes
 * a `<SPEAKER>:` line without its quotation marks. A paragraph whose speaker
 * cannot be named stays the narrator's, whole. Either way the words are the
 * source's, in order, unchanged: only line breaks, speaker labels and the
 * dialogue's quotation marks are added or removed.
 *
 * `narrationDrift` is the check: the script's words (labels, the `CAST:` line
 * and quotation marks aside) against the prose's, the first place they part.
 */

import { bodyParagraphs } from "../../publish";
import type { NarratedVoices } from "./units";

/** The narrator's role name in the script. */
export const NARRATOR = "NARRATOR";

/** `script.py`'s `LINE`: a speaker in capitals, a colon, the words. */
const LINE = /^([A-Z][A-Z .'\-]{0,30}):\s*(.*)$/;

/** Quotation marks that open or close dialogue. Single quotes are left alone: they are apostrophes far more often. */
const DOUBLE_QUOTES = /["“”]/g;

/** Capitalised words that are never a speaker's name, though a characters file may start a sentence with them. */
const NOT_SPEAKERS = new Set(
  "A An And As At But By For From He Her Hers His I If In It Its Me My No Not Of On Or Our She So That The Their Them Then There These They This Those To We What When Where Who With You Your Name Born Role Person Stop Family Act Chapter Part Notes Decisions Whether One Two Three Mr Mrs Ms Miss Dr Sir Madam".split(" "),
);

interface Segment {
  readonly quote: boolean;
  readonly text: string;
}

/** A paragraph split at its double quotes: narration and quotes alternate. A quote left open runs to the paragraph's end. */
function segments(paragraph: string): Segment[] {
  const out: Segment[] = [];
  let quote = false;
  let current = "";
  for (const char of paragraph) {
    const opens = !quote && (char === '"' || char === "“");
    const closes = quote && (char === '"' || char === "”");
    if (opens || closes) {
      out.push({ quote, text: current });
      current = "";
      quote = !quote;
      continue;
    }
    current += char;
  }
  out.push({ quote, text: current });
  return out.filter((s) => s.text.trim() !== "");
}

/** The first known character named in the paragraph's narration, as its role name (upper case), or undefined. */
function speakerOf(parts: readonly Segment[], names: ReadonlySet<string>): string | undefined {
  // The narration after the first quote ("...," said Ines) names the speaker more often than the narration before it.
  const first = parts.findIndex((s) => s.quote);
  const order = [...parts.slice(first + 1), ...parts.slice(0, first)].filter((s) => !s.quote);
  for (const part of order) {
    for (const word of part.text.match(/[A-Z][a-z]+/g) ?? []) if (names.has(word)) return word.toUpperCase();
  }
  return undefined;
}

/** The script lines for one paragraph. */
function paragraphLines(paragraph: string, voices: NarratedVoices, names: ReadonlySet<string>): { lines: string[]; speaker?: string } {
  const whole = { lines: [`${NARRATOR}: ${paragraph}`] };
  if (voices !== "characters") return whole;
  const parts = segments(paragraph);
  if (!parts.some((s) => s.quote)) return whole;
  const speaker = speakerOf(parts, names);
  if (speaker === undefined) return whole;
  const lines: { role: string; text: string }[] = [];
  for (const part of parts) {
    const text = part.text.trim();
    // Punctuation on its own ("—", ".") is no line to speak: it stays with the line before it, so no word is lost.
    if (!/[\p{L}\p{N}]/u.test(text) && lines.length > 0) {
      const last = lines[lines.length - 1] as { role: string; text: string };
      last.text = `${last.text} ${text}`;
      continue;
    }
    lines.push({ role: part.quote ? speaker : NARRATOR, text });
  }
  return { lines: lines.map((l) => `${l.role}: ${l.text}`), speaker };
}

/**
 * The character names a work's bible knows, for `--voices characters`: every
 * capitalised word in `bible/characters/` (the texts given) that stands where
 * a name stands: at the start of a list item, heading or table cell, or
 * inside a sentence, never only at a sentence's start (so "Runs the scale
 * house." gives no "Runs"), and that is not a pronoun, article or table
 * heading. ASCII names only: a speaker label must match the script reader's
 * `LINE`. A heuristic: a speaker it cannot name leaves the paragraph with the
 * narrator, which changes no word.
 */
export function characterNames(texts: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const text of texts) {
    for (const line of text.split("\n")) {
      for (const match of line.matchAll(/\b[A-Z][a-z]+\b/g)) {
        const word = match[0];
        if (NOT_SPEAKERS.has(word)) continue;
        // What comes before it on the line, list, heading, table and emphasis markup aside.
        const before = line.slice(0, match.index).replace(/[\s*_#|>()[\]-]+$/, "").replace(/^[\s*_#|>-]+$/, "");
        if (before !== "" && /[.!?:]$/.test(before)) continue;
        names.add(word);
      }
    }
  }
  return names;
}

/** The `CAST:` line: the narrator, then each character given lines, in order of first line. */
function castLine(speakers: readonly string[]): string {
  const roles = [`${NARRATOR}="the narrator, reading the prose"`, ...speakers.map((s) => `${s}="${s.charAt(0)}${s.slice(1).toLowerCase()}, speaking their dialogue"`)];
  return `CAST: ${roles.join(", ")}`;
}

/** A source unit's body as a narration script. `names` is `characterNames`' set (only read with `characters`). */
export function narrateProse(body: string, voices: NarratedVoices, names: ReadonlySet<string> = new Set()): string {
  const speakers: string[] = [];
  const blocks: string[] = [];
  for (const paragraph of bodyParagraphs(body)) {
    const { lines, speaker } = paragraphLines(paragraph, voices, names);
    if (speaker !== undefined && !speakers.includes(speaker)) speakers.push(speaker);
    blocks.push(lines.join("\n"));
  }
  return [castLine(speakers), "", blocks.join("\n\n")].join("\n");
}

/** One word of a text as the check compares it: double quotation marks count as spaces. */
const wordsOf = (text: string): string[] => text.replace(DOUBLE_QUOTES, " ").split(/\s+/).filter((w) => w !== "");

/** Where a script's words part from its source's: the script line (1-based, in the text given) and what differs. */
export interface Drift {
  readonly line: number;
  readonly excerpt: string;
  readonly detail: string;
}

/** How many lines the frontmatter takes (0 when there is none). */
function frontmatterLines(lines: readonly string[]): number {
  if ((lines[0] ?? "").trim() !== "---") return 0;
  for (let i = 1; i < lines.length; i += 1) if ((lines[i] ?? "").trim() === "---") return i + 1;
  return 0;
}

/**
 * The first place `script` (a narrated unit's text, frontmatter allowed)
 * says other words than `sourceBody` (the source unit's prose), or undefined
 * when every word matches in order.
 */
export function narrationDrift(sourceBody: string, script: string): Drift | undefined {
  const expected = wordsOf(bodyParagraphs(sourceBody).join(" "));
  const lines = script.split("\n");
  let at = 0;
  let lastLine = 0;
  for (let i = frontmatterLines(lines); i < lines.length; i += 1) {
    const raw = (lines[i] ?? "").trim();
    if (raw === "" || raw.toUpperCase().startsWith("CAST:")) continue;
    lastLine = i + 1;
    const spoken = LINE.exec(raw);
    for (const word of wordsOf(spoken === null ? raw : (spoken[2] ?? ""))) {
      const want = expected[at];
      if (want === undefined) return { line: i + 1, excerpt: raw, detail: `"${word}" is not in the source` };
      if (want !== word) return { line: i + 1, excerpt: raw, detail: `"${word}" where the source has "${want}"` };
      at += 1;
    }
  }
  if (at < expected.length) {
    const left = expected.length - at;
    return { line: Math.max(lastLine, 1), excerpt: (lines[lastLine - 1] ?? "").trim(), detail: `${left} word${left === 1 ? "" : "s"} of the source missing, from "${expected[at]}"` };
  }
  return undefined;
}
