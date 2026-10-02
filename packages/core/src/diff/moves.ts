// Paragraphs that moved unchanged. Prose is one sentence per line, so a paragraph
// is a run of consecutive non-blank lines; a removed paragraph whose lines match an
// added paragraph exactly is a move, not an edit.

import type { FileDiff } from "./parse";

export type MoveEnd = {
  path: string;
  /** First line number on this side (old numbering for `from`, new for `to`). */
  start: number;
  /** Number of lines in the paragraph. */
  count: number;
};

export type Move = {
  /** Where the paragraph was removed (old line numbers). */
  from: MoveEnd;
  /** Where it was added (new line numbers). */
  to: MoveEnd;
  lines: string[];
};

type Block = { path: string; start: number; lines: string[] };

/** Maximal runs of same-sign, non-blank changed lines, within one hunk. */
function blocks(files: readonly FileDiff[], sign: "+" | "-"): Block[] {
  const out: Block[] = [];
  for (const f of files)
    for (const h of f.hunks) {
      let cur: Block | undefined;
      for (const l of h.lines) {
        const num = sign === "+" ? l.n : l.o;
        if (l.t === sign && l.text.trim() !== "" && num !== null) {
          if (!cur) {
            cur = { path: f.path, start: num, lines: [] };
            out.push(cur);
          }
          cur.lines.push(l.text);
        } else cur = undefined;
      }
    }
  return out;
}

/** Pairs each removed paragraph with an identical added one, first-come, in diff order. */
export function detectMoves(files: readonly FileDiff[]): Move[] {
  const added = new Map<string, Block[]>();
  for (const b of blocks(files, "+")) {
    const key = b.lines.join("\n");
    added.set(key, [...(added.get(key) ?? []), b]);
  }
  const moves: Move[] = [];
  for (const r of blocks(files, "-")) {
    const a = added.get(r.lines.join("\n"))?.shift();
    if (!a) continue;
    const count = r.lines.length;
    moves.push({
      from: { path: r.path, start: r.start, count },
      to: { path: a.path, start: a.start, count },
      lines: r.lines,
    });
  }
  return moves;
}
