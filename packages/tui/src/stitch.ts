// The stitcher (screen doc, "Changes are branches"): turns a branch's sentence-line hunks into edits a writer can
// read. Rules only, behind one function so a smarter grouping can replace it later without touching the screen:
//   - changed lines with nothing unchanged between them are one edit, however many sentences ("adjacent changed
//     sentences shown as one edit");
//   - inside a changed edit, the words that differ are marked, so a one-word fix does not read as two whole sentences;
//   - a paragraph that moved unchanged (core's detectMoves) is one move, not a deletion plus an addition.
// Pure: parsed diff in, edits out. Text is not sanitised here; review.ts cleans the diff text before it gets this far.

import type { FileDiff, Move } from "@openthink/pablo-core";

/** A stretch of a line; `hl` marks the words that differ from the other side of the edit. */
export interface Seg { readonly text: string; readonly hl: boolean }
/** One line of an edit: removed (`-`), added (`+`), unchanged context (` `) or moved (`~`). */
export interface EditLine { readonly sign: "-" | "+" | " " | "~"; readonly segs: readonly Seg[] }

export interface Edit {
  /** `edit:<n>`, in diff order: the rail row's id. */
  readonly id: string;
  readonly path: string;
  readonly kind: "change" | "add" | "remove" | "move";
  /** The first line in the new text (the old text for a removal) the edit is at. */
  readonly line: number;
  readonly rows: readonly EditLine[];
  readonly added: number;
  readonly removed: number;
  /** For a move: where the paragraph came from. */
  readonly from?: { readonly path: string; readonly line: number };
}

const plain = (text: string): Seg[] => [{ text, hl: false }];
const key = (path: string, n: number) => `${path}\0${n}`;

/** Merges neighbouring segments that share a highlight, so a run of changed words is one segment. */
const merge = (segs: Seg[]): Seg[] => {
  const out: Seg[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.hl === s.hl) out[out.length - 1] = { text: last.text + s.text, hl: s.hl };
    else out.push(s);
  }
  return out;
};

/** Too many words on both sides and the word diff costs more than it shows; the lines are then shown whole. */
const WORD_LIMIT = 250_000;

/**
 * Marks the words that differ between the removed and the added lines of one edit: the longest common run of words is
 * left plain, every other word is highlighted. Whitespace is never highlighted. Returns one segment list per line.
 */
export function markWords(removed: readonly string[], added: readonly string[]): { removed: Seg[][]; added: Seg[][] } {
  const tokens = (lines: readonly string[]) => lines.map((l) => l.split(/(\s+)/).filter((t) => t !== ""));
  const a = tokens(removed), b = tokens(added);
  const wordsOf = (ls: string[][]) => ls.flatMap((l, line) => l.flatMap((t, at) => (/^\s+$/.test(t) ? [] : [{ t, line, at }])));
  const wa = wordsOf(a), wb = wordsOf(b);
  const whole = () => ({ removed: removed.map(plain), added: added.map(plain) });
  if (wa.length * wb.length > WORD_LIMIT) return whole();
  // Longest common subsequence of words, then walked back to learn which words of each side are in it.
  const w = wb.length + 1;
  const dp = new Uint32Array((wa.length + 1) * w);
  for (let i = wa.length - 1; i >= 0; i--)
    for (let j = wb.length - 1; j >= 0; j--)
      dp[i * w + j] = wa[i]!.t === wb[j]!.t ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
  const keptA = new Set<number>(), keptB = new Set<number>();
  for (let i = 0, j = 0; i < wa.length && j < wb.length; ) {
    if (wa[i]!.t === wb[j]!.t) { keptA.add(i); keptB.add(j); i++; j++; }
    else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
    else j++;
  }
  const build = (ls: string[][], ws: { t: string; line: number; at: number }[], kept: Set<number>): Seg[][] => {
    const changed = new Set(ws.flatMap((x, idx) => (kept.has(idx) ? [] : [`${x.line}:${x.at}`])));
    return ls.map((l, line) => {
      const marked = l.map((t, at) => ({ text: t, hl: changed.has(`${line}:${at}`) }));
      // A space between two marked words is marked too, so a changed phrase reads as one stretch.
      marked.forEach((m, at) => { if (/^\s+$/.test(m.text) && marked[at - 1]?.hl && changed.has(`${line}:${at + 1}`)) m.hl = true; });
      return merge(marked);
    });
  };
  return { removed: build(a, wa, keptA), added: build(b, wb, keptB) };
}

/** The edits of a parsed diff, in diff order. */
export function stitch(files: readonly FileDiff[], moves: readonly Move[] = []): Edit[] {
  const movedFrom = new Set<string>();
  const movedTo = new Map<string, Move>();
  const movedToAll = new Set<string>();
  for (const m of moves) {
    for (let i = 0; i < m.from.count; i++) movedFrom.add(key(m.from.path, m.from.start + i));
    for (let i = 0; i < m.to.count; i++) movedToAll.add(key(m.to.path, m.to.start + i));
    movedTo.set(key(m.to.path, m.to.start), m);
  }
  const edits: Edit[] = [];
  const push = (e: Omit<Edit, "id">) => edits.push({ id: `edit:${edits.length}`, ...e });

  for (const f of files) {
    if (f.binary) {
      push({ path: f.path, kind: "change", line: 1, rows: [{ sign: " ", segs: plain("(binary file changed)") }], added: 0, removed: 0 });
      continue;
    }
    for (const h of f.hunks) {
      const ls = h.lines;
      let i = 0;
      while (i < ls.length) {
        const l = ls[i]!;
        if (l.t === " ") { i++; continue; }
        // A moved paragraph: one edit at where it arrived; where it left says nothing on its own.
        if (l.t === "-" && movedFrom.has(key(f.path, l.o!))) { i++; continue; }
        if (l.t === "+" && movedToAll.has(key(f.path, l.n!))) {
          const m = movedTo.get(key(f.path, l.n!));
          if (m) push({ path: f.path, kind: "move", line: l.n!, rows: m.lines.map((text) => ({ sign: "~" as const, segs: plain(text) })), added: 0, removed: 0, from: { path: m.from.path, line: m.from.start } });
          i++;
          continue;
        }
        // A run of changed lines, up to the next unchanged line or moved paragraph.
        const start = i;
        const removed: string[] = [], added: string[] = [];
        for (; i < ls.length && ls[i]!.t !== " "; i++) {
          const c = ls[i]!;
          if (c.t === "-" ? movedFrom.has(key(f.path, c.o!)) : movedToAll.has(key(f.path, c.n!))) break;
          if (c.t === "-") removed.push(c.text); else added.push(c.text);
        }
        const before = ls[start - 1], after = ls[i];
        // Where it sits in the new text: the first added line, or for a removal the line the removal leaves behind.
        const firstAdded = ls.slice(start, i).find((c) => c.t === "+");
        const line = firstAdded?.n ?? (before?.t === " " ? before.n! + 1 : after?.n ?? h.newStart);
        const both = removed.length > 0 && added.length > 0 ? markWords(removed, added) : undefined;
        const rows: EditLine[] = [];
        if (before?.t === " ") rows.push({ sign: " ", segs: plain(before.text) });
        removed.forEach((t, k) => rows.push({ sign: "-", segs: both ? both.removed[k]! : plain(t) }));
        added.forEach((t, k) => rows.push({ sign: "+", segs: both ? both.added[k]! : plain(t) }));
        if (after?.t === " ") rows.push({ sign: " ", segs: plain(after.text) });
        push({ path: f.path, kind: both ? "change" : added.length ? "add" : "remove", line, rows, added: added.length, removed: removed.length });
      }
    }
  }
  return edits;
}
