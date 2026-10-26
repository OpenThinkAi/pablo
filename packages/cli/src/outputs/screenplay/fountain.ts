/**
 * Fountain, read without a dependency (AGT-2132): enough of the format
 * (https://fountain.io/syntax) to lint a drafted scene and to summarise one
 * for the next scene's pack. pablo's own frontmatter (`---` ... `---`) sits
 * above the Fountain body in a unit file; it is skipped here and stripped on
 * publish.
 *
 * The elements read: scene headings (`INT.`, `EXT.`, `EST.`, `INT./EXT.`,
 * `I/E`, or forced with a leading `.`), character cues (a line in capitals
 * after a blank line with dialogue directly under it, or forced with `@`),
 * parentheticals, dialogue, transitions (`... TO:` in capitals, or forced
 * with `>`), action, and the parts Fountain never prints (sections `#`,
 * synopses `=`, notes `[[ ]]`, the boneyard `/* *\/`, page breaks `===`).
 */

import type { Hit } from "../../check";

/** A scene heading Fountain recognises without forcing. */
const HEADING = /^(?:INT\.?\/EXT|INT|EXT|EST|I\/E)[. ]/i;
/** A forced scene heading: one leading `.`, not an ellipsis. */
const FORCED_HEADING = /^\.[A-Za-z0-9]/;
/** A transition: capitals ending in `TO:`, or forced with `>` (and not centered `> <`). */
const TRANSITION = /^[A-Z0-9 .'\-]+TO:$/;
const FORCED_TRANSITION = /^>(?!.*<\s*$)/;
/** A character cue: capitals (an extension such as `(V.O.)` or `(CONT'D)` may follow), optionally `^` for dual dialogue. */
const CUE = /^([A-Z0-9][A-Z0-9 .'\-]*?)\s*(\([^)]*\))?\s*\^?$/;
const FORCED_CUE = /^@(\S.*?)\s*(\([^)]*\))?\s*\^?$/;
const PARENTHETICAL = /^\(.*\)$/;
/** A speaker, a colon, the words: a radio or stage-play line, which Fountain reads as action. */
const COLON_DIALOGUE = /^([A-Z][A-Z0-9 .'\-]{0,30}):\s*\S/;
/** A Markdown code fence: never Fountain. */
const FENCE = /^(```|~~~)/;
/** Lines Fountain never prints: sections, synopses, page breaks, one-line notes. */
const UNPRINTED = /^(#|=(?!==)|===+\s*$|\[\[.*\]\]\s*$)/;

const EXCERPT_MAX = 120;

/** How many leading lines pablo's frontmatter takes (0 when there is none, or the fence is unclosed). */
export function frontmatterLineCount(lines: readonly string[]): number {
  if ((lines[0] ?? "").replace(/^﻿/, "").trim() !== "---") return 0;
  for (let i = 1; i < lines.length; i += 1) if ((lines[i] ?? "").trim() === "---") return i + 1;
  return 0;
}

export function isSceneHeading(line: string): boolean {
  const t = line.trim();
  return HEADING.test(t) || FORCED_HEADING.test(t);
}

export function isTransition(line: string): boolean {
  const t = line.trim();
  return TRANSITION.test(t) || FORCED_TRANSITION.test(t);
}

/**
 * The speaker a line names when it reads as a character cue on its own (blank
 * line before it is the caller's business), else undefined. Capitals only,
 * at most four words, never a heading or a transition, and not ending like a
 * sentence (`BANG!` is shouted action, not a speaker).
 */
export function cueName(line: string): string | undefined {
  const t = line.trim();
  const forced = FORCED_CUE.exec(t);
  if (forced) return (forced[1] ?? "").trim();
  if (isSceneHeading(t) || isTransition(t) || !/[A-Z]/.test(t)) return undefined;
  const m = CUE.exec(t);
  if (!m) return undefined;
  const name = (m[1] ?? "").trim();
  if (name === "" || /[.!?]$/.test(name) || name.split(/\s+/).length > 4) return undefined;
  return name;
}

const excerpt = (line: string): string => {
  const t = line.trim();
  return t.length <= EXCERPT_MAX ? t : t.slice(0, EXCERPT_MAX);
};

/** One printed line of the body: its 1-based line number in the file, and its text. Boneyard and unprinted lines are blank. */
interface BodyLine {
  readonly number: number;
  readonly text: string;
}

/** The body's lines with the boneyard and unprinted lines blanked, plus where an unclosed boneyard opens. */
function printedLines(text: string): { lines: BodyLine[]; unclosedBoneyard?: BodyLine } {
  const all = text.split(/\r?\n/);
  const skip = frontmatterLineCount(all);
  const lines: BodyLine[] = [];
  let openAt: BodyLine | undefined;
  for (let i = skip; i < all.length; i += 1) {
    const raw = all[i] ?? "";
    const number = i + 1;
    let visible = raw;
    if (openAt !== undefined) {
      const close = raw.indexOf("*/");
      if (close < 0) {
        lines.push({ number, text: "" });
        continue;
      }
      visible = raw.slice(close + 2);
      openAt = undefined;
    }
    // Inline `/* ... */` removed; an opening with no close on the line starts the boneyard.
    visible = visible.replace(/\/\*[\s\S]*?\*\//g, "");
    const open = visible.indexOf("/*");
    if (open >= 0) {
      openAt = { number, text: raw };
      visible = visible.slice(0, open);
    }
    lines.push({ number, text: UNPRINTED.test(visible.trim()) ? "" : visible });
  }
  return openAt === undefined ? { lines } : { lines, unclosedBoneyard: openAt };
}

/**
 * The Fountain lint (AGT-2132): what makes a drafted scene malformed, each a
 * `Hit` on the file's own line numbers (frontmatter counted, `checkFile`'s
 * numbering), in line order:
 *
 *   fountain-no-heading           the scene does not open with a scene heading
 *   fountain-heading-spacing      a scene heading without a blank line before and after (Fountain reads it as action)
 *   fountain-cue-no-dialogue      a character cue with no dialogue under it
 *   fountain-stray-parenthetical  a parenthetical outside a dialogue block
 *   fountain-colon-dialogue       `NAME: words` (a radio or stage-play line); the cue goes on its own line
 *   fountain-markdown             a Markdown code fence
 *   fountain-unclosed-boneyard    a `/*` never closed, which hides the rest of the scene
 *
 * Pure.
 */
export function lintFountain(text: string, path: string): Hit[] {
  const { lines, unclosedBoneyard } = printedLines(text);
  const hits: Hit[] = [];
  const hit = (line: BodyLine, rule: string): void => {
    hits.push({ path, line: line.number, rule, excerpt: excerpt(line.text) });
  };
  const blank = (i: number): boolean => i < 0 || i >= lines.length || (lines[i]?.text.trim() ?? "") === "";

  const speakers = new Set<string>();
  lines.forEach((l, i) => {
    const name = blank(i - 1) && !blank(i + 1) ? cueName(l.text) : undefined;
    if (name !== undefined) speakers.add(name);
  });

  const first = lines.find((l) => l.text.trim() !== "");
  if (first !== undefined && !isSceneHeading(first.text)) hit(first, "fountain-no-heading");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as BodyLine;
    const t = line.text.trim();
    if (t === "") continue;
    if (FENCE.test(t)) {
      hit(line, "fountain-markdown");
      continue;
    }
    if (isSceneHeading(t)) {
      if (!blank(i - 1) || !blank(i + 1)) hit(line, "fountain-heading-spacing");
      continue;
    }
    if (isTransition(t)) continue;
    if (blank(i - 1)) {
      if (PARENTHETICAL.test(t)) {
        hit(line, "fountain-stray-parenthetical");
        continue;
      }
      const name = cueName(t);
      // A lone line in capitals is action to Fountain (`SILENCE`); it is a cue gone wrong when it is forced, carries an
      // extension, or names someone who speaks elsewhere in the scene.
      if (name !== undefined && blank(i + 1) && (t.startsWith("@") || /\)\s*\^?$/.test(t) || speakers.has(name))) {
        hit(line, "fountain-cue-no-dialogue");
        continue;
      }
    }
    if (COLON_DIALOGUE.test(t)) hit(line, "fountain-colon-dialogue");
  }

  if (unclosedBoneyard !== undefined) hit(unclosedBoneyard, "fountain-unclosed-boneyard");
  return hits.sort((a, b) => a.line - b.line);
}

/** One printed element of a scene, for a summary: a heading, a transition, action, or a speech. */
export type FountainElement =
  | { readonly kind: "heading" | "transition" | "action"; readonly text: string }
  | { readonly kind: "dialogue"; readonly speaker: string; readonly text: string };

/** The scene's printed elements in order (parentheticals and unprinted parts left out). Pure. */
export function fountainElements(text: string): FountainElement[] {
  const blocks: string[][] = [];
  let run: string[] = [];
  for (const { text: line } of printedLines(text).lines) {
    if (line.trim() === "") {
      if (run.length > 0) blocks.push(run);
      run = [];
    } else run.push(line.trim());
  }
  if (run.length > 0) blocks.push(run);

  const out: FountainElement[] = [];
  for (const block of blocks) {
    const head = block[0] as string;
    if (block.length === 1 && isSceneHeading(head)) out.push({ kind: "heading", text: head.replace(/^\./, "") });
    else if (block.length === 1 && isTransition(head)) out.push({ kind: "transition", text: head.replace(/^>\s*/, "") });
    else if (block.length > 1 && cueName(head) !== undefined) {
      const words = block.slice(1).filter((l) => !PARENTHETICAL.test(l)).join(" ");
      if (words !== "") out.push({ kind: "dialogue", speaker: cueName(head) as string, text: words });
    } else out.push({ kind: "action", text: block.join(" ").replace(/^!/, "") });
  }
  return out;
}
