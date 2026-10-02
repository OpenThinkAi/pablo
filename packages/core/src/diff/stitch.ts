// The stitcher (screen doc, "Changes are branches"): turns a branch's sentence-line hunks into edits a writer can
// read. Rules only, behind one interface (`Stitcher`) so a smarter grouping, learned from which edits Matt accepts, can
// replace it later without touching the screen or the accept/reject layer. The rules:
//   - changed lines with nothing unchanged between them are one edit, however many sentences ("adjacent changed
//     sentences shown as one edit");
//   - inside a changed edit the words that differ are marked, so a one-word fix does not read as two whole sentences.
//     Punctuation is its own token; a lone short word left in common between changes is folded into the change, and a
//     sentence that is mostly new is shown whole rather than speckled with marks;
//   - a paragraph that moved unchanged (`detectMoves`) is one move, not a deletion plus an addition. A paragraph that
//     moved and was touched on the way (a pure removal and a pure addition elsewhere that share most of their words)
//     is a move too, its changed sentences marked. The blank line a move leaves behind or brings along is the move's.
// Every changed line of the diff belongs to exactly one edit (`removedLines` / `addedLines`), so accepting or rejecting
// an edit is accepting or rejecting exactly those lines. Pure: parsed diff in, edits out; text is not sanitised here.

import { detectMoves, type Move } from "./moves";
import type { DiffLine, FileDiff } from "./parse";

/** A stretch of a line; `hl` marks the words that differ from the other side of the edit. */
export interface Seg { readonly text: string; readonly hl: boolean }
/** One line of an edit: removed (`-`), added (`+`), unchanged context (` `) or moved unchanged (`~`). */
export interface EditLine { readonly sign: "-" | "+" | " " | "~"; readonly segs: readonly Seg[] }
/** A line of a file: old numbering for a removed line, new numbering for an added one. */
export interface LineRef { readonly path: string; readonly line: number }

export interface Edit {
  /** `edit:<n>`, in diff order: the rail row's id. */
  readonly id: string;
  readonly path: string;
  readonly kind: "change" | "add" | "remove" | "move";
  /** The first line in the new text (the old text for a removal) the edit is at. */
  readonly line: number;
  readonly rows: readonly EditLine[];
  /** The `+` and `-` rows shown: sentences the edit puts in and takes out. A move's unchanged sentences count in neither. */
  readonly added: number;
  readonly removed: number;
  /** For a move: where the paragraph came from. */
  readonly from?: { readonly path: string; readonly line: number };
  /** The diff's removed lines this edit owns, by old line number (a move's are in `from.path`). */
  readonly removedLines: readonly LineRef[];
  /** The diff's added lines this edit owns, by new line number. */
  readonly addedLines: readonly LineRef[];
}

/** What any stitcher is: a parsed diff in, the edits out, every changed line in exactly one edit. */
export type Stitcher = (files: readonly FileDiff[]) => Edit[];

const plain = (text: string): Seg[] => [{ text, hl: false }];
const key = (path: string, n: number) => `${path}\0${n}`;
const isSpace = (t: string) => /^\s+$/.test(t);
const isWord = (t: string) => /[\p{L}\p{N}]/u.test(t);

/** Too many tokens on both sides and a diff costs more than it shows; the lines are then shown whole. */
const WORD_LIMIT = 250_000;
/** A line keeping less than this share of its words is mostly new: it is shown whole, without marks. */
const MOSTLY_NEW = 1 / 3;
/** A lone word in common no longer than this, with changes either side, is folded into the change. */
const SHORT_WORD = 3;
/** How alike a removed and an added paragraph must be (shared tokens, Dice) to read as one paragraph moved. */
const MOVE_ALIKE = 0.6;
/** A paragraph needs this many words before likeness alone makes it a move. */
const MOVE_MIN_WORDS = 4;

/** Words (with inner apostrophes), runs of whitespace, and each other character on its own. Joins back to the line. */
export function tokenize(line: string): string[] {
  return line.match(/\s+|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu) ?? [];
}

/** Index pairs of a longest common subsequence of `a` and `b`, in order. */
function lcs<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean): [number, number][] {
  const w = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i * w + j] = eq(a[i]!, b[j]!) ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (eq(a[i]!, b[j]!)) { pairs.push([i, j]); i++; j++; }
    else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
    else j++;
  }
  return pairs;
}

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

type Tok = { readonly t: string; readonly line: number; readonly at: number };

/**
 * Marks the tokens that differ between the removed and the added lines of one edit: the longest common run of tokens
 * is left plain, every other word or punctuation mark is highlighted; whitespace only between two marked tokens.
 * Returns one segment list per line, whose text joins back to that line.
 */
export function markWords(removed: readonly string[], added: readonly string[]): { removed: Seg[][]; added: Seg[][] } {
  const a = removed.map(tokenize), b = added.map(tokenize);
  const toks = (ls: string[][]): Tok[] => ls.flatMap((l, line) => l.flatMap((t, at) => (isSpace(t) ? [] : [{ t, line, at }])));
  const ta = toks(a), tb = toks(b);
  if (ta.length * tb.length > WORD_LIMIT) return { removed: removed.map(plain), added: added.map(plain) };
  const pairs = lcs(ta, tb, (x, y) => x.t === y.t);
  const keptA = new Set(pairs.map(([i]) => i)), keptB = new Set(pairs.map(([, j]) => j));
  // A lone short word kept between changes on both sides ("the", "a", a comma) is coincidence, not a shared phrase.
  const lone = (ts: Tok[], kept: Set<number>, i: number) => {
    const prev = ts[i - 1], next = ts[i + 1];
    return !kept.has(i - 1) && !kept.has(i + 1) && prev?.line === ts[i]!.line && next?.line === ts[i]!.line && ts[i]!.t.length <= SHORT_WORD;
  };
  for (const [i, j] of pairs) if (lone(ta, keptA, i) && lone(tb, keptB, j)) { keptA.delete(i); keptB.delete(j); }
  const build = (ls: string[][], ts: Tok[], kept: Set<number>): Seg[][] => {
    const changed = new Set<string>();
    const words = new Map<number, { all: number; kept: number }>();
    ts.forEach((x, idx) => {
      if (!kept.has(idx)) changed.add(`${x.line}:${x.at}`);
      if (!isWord(x.t)) return;
      const c = words.get(x.line) ?? { all: 0, kept: 0 };
      words.set(x.line, { all: c.all + 1, kept: c.kept + (kept.has(idx) ? 1 : 0) });
    });
    return ls.map((l, line) => {
      const c = words.get(line);
      // Mostly new: marks across nearly every word say less than the sign column already does.
      if (!c || c.kept < c.all * MOSTLY_NEW) return l.length === 0 ? [] : plain(l.join(""));
      const marked = l.map((t, at) => ({ text: t, hl: changed.has(`${line}:${at}`) }));
      // A space between two marked tokens is marked too, so a changed phrase reads as one stretch.
      marked.forEach((m, at) => { if (isSpace(m.text) && marked[at - 1]?.hl && marked[at + 1]?.hl) m.hl = true; });
      return merge(marked);
    });
  };
  return { removed: build(a, ta, keptA), added: build(b, tb, keptB) };
}

/** The rows of a removed and an added stretch shown against each other: plain when one side is empty. */
function changeRows(removed: readonly string[], added: readonly string[]): EditLine[] {
  const both = removed.length > 0 && added.length > 0 ? markWords(removed, added) : undefined;
  return [
    ...removed.map((t, k) => ({ sign: "-" as const, segs: both ? both.removed[k]! : plain(t) })),
    ...added.map((t, k) => ({ sign: "+" as const, segs: both ? both.added[k]! : plain(t) })),
  ];
}

/** A paragraph that moved: its sentences in their new order, unchanged ones as `~`, changed ones marked. */
function moveRows(from: readonly string[], to: readonly string[]): EditLine[] {
  const rows: EditLine[] = [];
  let i = 0, j = 0;
  for (const [pi, pj] of [...lcs(from, to, (x, y) => x === y), [from.length, to.length] as [number, number]]) {
    rows.push(...changeRows(from.slice(i, pi), to.slice(j, pj)));
    if (pj < to.length) rows.push({ sign: "~", segs: plain(to[pj]!) });
    i = pi + 1; j = pj + 1;
  }
  return rows;
}

/** A paragraph of a pure removal or addition: where the ends of a paragraph that moved and was touched are looked for. */
type Block = { path: string; start: number; lines: string[] };

/** The changed runs (between unchanged lines) that are all one sign, split into paragraphs at blank lines. */
function pureBlocks(files: readonly FileDiff[], sign: "+" | "-", taken: Set<string>): Block[] {
  const out: Block[] = [];
  for (const f of files)
    for (const h of f.hunks) {
      const runs: DiffLine[][] = [[]];
      for (const l of h.lines) if (l.t === " ") runs.push([]); else runs[runs.length - 1]!.push(l);
      for (const run of runs) {
        if (run.length === 0 || run.some((l) => l.t !== sign)) continue;
        let cur: Block | undefined;
        for (const l of run) {
          const n = (sign === "+" ? l.n : l.o)!; // an added line always has a new number, a removed one an old
          if (l.text.trim() === "" || taken.has(key(f.path, n))) { cur = undefined; continue; }
          if (!cur) out.push((cur = { path: f.path, start: n, lines: [] }));
          cur.lines.push(l.text);
        }
      }
    }
  return out;
}

/** Removed and added paragraphs, neither an exact move, alike enough to be one paragraph moved and touched. Best first. */
function nearMoves(files: readonly FileDiff[], exact: readonly Move[]): Move[] {
  const takenFrom = new Set<string>(), takenTo = new Set<string>();
  for (const m of exact) for (let k = 0; k < m.from.count; k++) { takenFrom.add(key(m.from.path, m.from.start + k)); takenTo.add(key(m.to.path, m.to.start + k)); }
  const toks = (b: Block) => b.lines.flatMap(tokenize).filter((t) => !isSpace(t));
  const words = (ts: string[]) => ts.filter(isWord).length;
  const gone = pureBlocks(files, "-", takenFrom).map((b) => ({ b, ts: toks(b) })).filter((x) => words(x.ts) >= MOVE_MIN_WORDS);
  const came = pureBlocks(files, "+", takenTo).map((b) => ({ b, ts: toks(b) })).filter((x) => words(x.ts) >= MOVE_MIN_WORDS);
  const candidates: { r: number; a: number; score: number }[] = [];
  gone.forEach((r, ri) => came.forEach((a, ai) => {
    if (r.ts.length * a.ts.length > WORD_LIMIT) return;
    const score = (2 * lcs(r.ts, a.ts, (x, y) => x === y).length) / (r.ts.length + a.ts.length);
    if (score >= MOVE_ALIKE) candidates.push({ r: ri, a: ai, score });
  }));
  candidates.sort((x, y) => y.score - x.score || x.r - y.r || x.a - y.a);
  const usedR = new Set<number>(), usedA = new Set<number>(), out: Move[] = [];
  for (const c of candidates) {
    if (usedR.has(c.r) || usedA.has(c.a)) continue;
    usedR.add(c.r); usedA.add(c.a);
    const r = gone[c.r]!.b, a = came[c.a]!.b;
    out.push({ from: { path: r.path, start: r.start, count: r.lines.length }, to: { path: a.path, start: a.start, count: a.lines.length }, lines: a.lines });
  }
  return out;
}

/** A move being assembled: blank lines next to either end join it as the diff is walked. */
type MoveEdit = { from: Move["from"]; to: Move["to"]; rows: EditLine[]; removedLines: LineRef[]; addedLines: LineRef[] };

/**
 * The edits of a parsed diff, in diff order. `moves` are the paragraphs known to have moved unchanged (by default core's
 * `detectMoves`); paragraphs that moved and were touched are found here.
 */
export function stitch(files: readonly FileDiff[], moves: readonly Move[] = detectMoves(files)): Edit[] {
  // The removed side's text, read back off the diff (a near move's `lines` are the side it arrived as).
  const oldText = (path: string, start: number, count: number) =>
    files.filter((f) => f.path === path).flatMap((f) => f.hunks.flatMap((h) => h.lines))
      .filter((l) => l.t === "-" && l.o! >= start && l.o! < start + count).map((l) => l.text);
  const movedFrom = new Map<string, MoveEdit>(), movedTo = new Map<string, MoveEdit>(), arrives = new Map<string, MoveEdit>();
  const record = (m: Move, rows: EditLine[]) => {
    const e: MoveEdit = { from: m.from, to: m.to, rows, removedLines: [], addedLines: [] };
    for (let k = 0; k < m.from.count; k++) { movedFrom.set(key(m.from.path, m.from.start + k), e); e.removedLines.push({ path: m.from.path, line: m.from.start + k }); }
    for (let k = 0; k < m.to.count; k++) { movedTo.set(key(m.to.path, m.to.start + k), e); e.addedLines.push({ path: m.to.path, line: m.to.start + k }); }
    arrives.set(key(m.to.path, m.to.start), e);
  };
  for (const m of moves) record(m, m.lines.map((text) => ({ sign: "~", segs: plain(text) })));
  for (const m of nearMoves(files, moves)) record(m, moveRows(oldText(m.from.path, m.from.start, m.from.count), m.lines));

  const edits: Edit[] = [];
  const push = (e: Omit<Edit, "id">) => edits.push({ id: `edit:${edits.length}`, ...e });
  const moveOf = (path: string, l: DiffLine | undefined) =>
    l?.t === "-" ? movedFrom.get(key(path, l.o!)) : l?.t === "+" ? movedTo.get(key(path, l.n!)) : undefined;

  for (const f of files) {
    if (f.binary) {
      push({ path: f.path, kind: "change", line: 1, rows: [{ sign: " ", segs: plain("(binary file changed)") }], added: 0, removed: 0, removedLines: [], addedLines: [] });
      continue;
    }
    for (const h of f.hunks) {
      const ls = h.lines;
      let i = 0;
      while (i < ls.length) {
        const l = ls[i]!;
        if (l.t === " ") { i++; continue; }
        // A moved paragraph is one edit, placed where it arrived; where it left says nothing on its own.
        const m = moveOf(f.path, l);
        if (m) {
          if (l.t === "+" && arrives.get(key(f.path, l.n!)) === m) {
            const changed = (s: EditLine["sign"]) => m.rows.filter((r) => r.sign === s).length;
            // The edit holds the move's line lists, so blank lines met later in the walk still join it.
            push({ path: f.path, kind: "move", line: l.n!, rows: m.rows, added: changed("+"), removed: changed("-"), from: { path: m.from.path, line: m.from.start }, removedLines: m.removedLines, addedLines: m.addedLines });
          }
          i++;
          continue;
        }
        // A run of changed lines, up to the next unchanged line or moved paragraph.
        let start = i;
        while (i < ls.length && ls[i]!.t !== " " && !moveOf(f.path, ls[i])) i++;
        let end = i;
        const before = ls[start - 1], after = ls[i];
        // Blank lines at an end of the run that touches a move are the paragraph break the move left or brought along.
        const ref = (c: DiffLine): LineRef => ({ path: f.path, line: (c.t === "-" ? c.o : c.n)! });
        const give = (m: MoveEdit, c: DiffLine) => (c.t === "-" ? m.removedLines : m.addedLines).push(ref(c));
        const blank = (c: DiffLine | undefined) => c !== undefined && c.text.trim() === "";
        const movedBefore = moveOf(f.path, before), movedAfter = moveOf(f.path, after);
        if (movedBefore) while (start < end && blank(ls[start])) give(movedBefore, ls[start++]!);
        if (movedAfter) while (end > start && blank(ls[end - 1])) give(movedAfter, ls[--end]!);
        if (start === end) continue;
        const run = ls.slice(start, end);
        const removed = run.filter((c) => c.t === "-"), added = run.filter((c) => c.t === "+");
        const removedLines = removed.map(ref), addedLines = added.map(ref);
        // Where it sits in the new text: the first added line, or for a removal the line the removal leaves behind.
        const line = added[0]?.n ?? (before?.t === " " ? before.n! + 1 : after?.n ?? h.newStart);
        const rows: EditLine[] = [];
        if (before?.t === " ") rows.push({ sign: " ", segs: plain(before.text) });
        rows.push(...changeRows(removed.map((c) => c.text), added.map((c) => c.text)));
        if (after?.t === " ") rows.push({ sign: " ", segs: plain(after.text) });
        const kind = removed.length > 0 && added.length > 0 ? "change" : added.length ? "add" : "remove";
        push({ path: f.path, kind, line, rows, added: added.length, removed: removed.length, removedLines, addedLines });
      }
    }
  }
  // A move's blank lines joined it out of line order.
  for (const m of new Set(movedFrom.values())) { m.removedLines.sort(byLine); m.addedLines.sort(byLine); }
  return edits;
}

const byLine = (x: LineRef, y: LineRef) => (x.path === y.path ? x.line - y.line : x.path < y.path ? -1 : 1);
