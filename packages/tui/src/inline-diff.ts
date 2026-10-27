// AI revisions inline in the editing pane (AGT-2177, D-18): a pending `revise/` branch of the unit open in `v e` is
// shown where it applies, as the words that differ (core's stitcher, the same edits review mode shows), and each edit
// is accepted or rejected on its own. Accepting changes the pane's text, so it reaches the work's `edit/` branch through
// the pane's one save path (`saveText` -> the session's `save`, Ctrl+S or the autosave); rejecting changes nothing, so
// rejecting every edit leaves the edit branch as it was. The revise branch itself is never written.
//
// Pure, like edit-pane.ts: the CLI hands over git's diff of each revise branch for the file (`PaneSession.revisions`)
// and this applies its edits to the text the pane would save. An edit is applied a diff hunk at a time: the hunk as the
// text holds it now (context, the lines it removes, the edits of the same branch already accepted) is found in that text
// and swapped for the hunk with this edit taken too. A hunk the author has since changed is not found: that edit "no
// longer matches", and can only be rejected. An edit an earlier session accepted is found already applied and not shown.

import { parseDiff, type DiffLine, type FileDiff, type Hunk } from "@openthink/pablo-core";
import { apply, partsOf, saveText, type EditText, type PaneRow } from "./edit-pane";
import { loadForEdit } from "./edit-save";
import { visible } from "./sanitize";
import { stitch, type Edit, type Seg } from "./stitch";

/**
 * A pending revise branch for the unit: its name and git's diff of the unit's file since it left main. Declared again
 * (structurally the same) in packages/cli/src/edit-session.ts on purpose: the CLI loads this package lazily.
 */
export interface PaneRevision { readonly branch: string; readonly diff: string }

export type HunkState = "pending" | "accepted" | "rejected";
/** One edit of a revise branch, as the stitcher groups it, and what the author made of it. */
export interface AiHunk {
  /** `<branch>#edit:<n>`. */
  readonly id: string;
  readonly branch: string;
  readonly file: FileDiff;
  readonly edit: Edit;
  readonly state: HunkState;
}
/** The pane's AI changes (the title's `note` says why an accept did nothing). */
export interface AiDiffs { readonly hunks: readonly AiHunk[] }

/** A pending edit where the pane shows it: the buffer row it sits under, and false when it no longer matches the text. */
export interface Shown { readonly hunk: AiHunk; readonly row: number; readonly matches: boolean }

const strip = (s: string) => s.replace(/\r$/, "");

/** The edits of each revision's diff: binary files and edits with no lines of their own are left out. */
export function revisionHunks(revisions: readonly PaneRevision[]): AiHunk[] {
  const out: AiHunk[] = [];
  for (const rev of revisions) {
    for (const file of parseDiff(rev.diff)) {
      if (file.binary || file.status === "deleted") continue;
      for (const edit of stitch([file])) {
        if (edit.removedLines.length + edit.addedLines.length === 0) continue;
        out.push({ id: `${rev.branch}#${edit.id}`, branch: rev.branch, file, edit, state: "pending" });
      }
    }
  }
  return out;
}

/** Whether `h` owns diff line `l`: one of the lines its edit removes or adds. */
function owns(h: AiHunk, l: DiffLine): boolean {
  if (l.t === "-") return h.edit.removedLines.some((r) => r.line === l.o);
  if (l.t === "+") return h.edit.addedLines.some((r) => r.line === l.n);
  return false;
}

/** Whether diff line `l` is in the text once `taken` are applied: context always, a removed line unless taken, an added line only when taken. */
const kept = (l: DiffLine, taken: readonly AiHunk[]) => l.t === " " || (l.t === "-" ? !taken.some((h) => owns(h, l)) : taken.some((h) => owns(h, l)));
const side = (dh: Hunk, taken: readonly AiHunk[]) => dh.lines.filter((l) => kept(l, taken)).map((l) => strip(l.text));

/** Where `block` sits in `lines`, the place nearest `near` when it is there more than once; -1 when it is not there. */
function find(lines: readonly string[], block: readonly string[], near: number): number {
  if (block.length === 0) return Math.max(0, Math.min(near, lines.length));
  let best = -1;
  for (let i = 0; i + block.length <= lines.length; i++) {
    if (!block.every((b, k) => lines[i + k] === b)) continue;
    if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
  }
  return best;
}

interface Placed { readonly at: number; readonly from: readonly string[]; readonly to: readonly string[]; readonly anchor: number }

/**
 * Diff hunk `dh`'s part that `h` changes, found in `lines`: the whole hunk first, then only `h`'s own lines with one
 * line of context either side, then with none (when it removes something to find), so an author's edit to a nearby
 * context line does not strand it. Null when none is there.
 */
function placeIn(lines: readonly string[], dh: Hunk, h: AiHunk, peers: readonly AiHunk[]): Placed | null {
  const first = dh.lines.findIndex((l) => owns(h, l));
  let last = first;
  dh.lines.forEach((l, i) => { if (owns(h, l)) last = i; });
  const spans: [number, number][] = [[0, dh.lines.length], [Math.max(0, first - 1), Math.min(dh.lines.length, last + 2)], [first, last + 1]];
  for (const [s, e] of spans) {
    const part = dh.lines.slice(s, e);
    const from = part.filter((l) => kept(l, peers)).map((l) => strip(l.text));
    if (from.length === 0 && s === first) continue;
    const to = part.filter((l) => kept(l, [...peers, h])).map((l) => strip(l.text));
    const near = dh.oldStart - 1 + dh.lines.slice(0, s).filter((l) => kept(l, peers)).length;
    const at = find(lines, from, near);
    if (at < 0) continue;
    // The line the edit is shown under: its first removed line, or for an addition the line before it goes in.
    const j = part.slice(0, first - s).filter((l) => kept(l, peers)).length;
    const anchor = dh.lines[first]!.t === "-" ? j : Math.max(0, j - 1);
    return { at, from, to, anchor: at + anchor };
  }
  return null;
}

/** Each diff hunk `h` touches, found in `lines` with `taken` (its branch's accepted edits) applied; null when one is not there. */
function place(lines: readonly string[], h: AiHunk, taken: readonly AiHunk[]): Placed[] | null {
  const peers = taken.filter((x) => x.file === h.file && x !== h);
  const out: Placed[] = [];
  for (const dh of h.file.hunks) {
    if (!dh.lines.some((l) => owns(h, l))) continue;
    const p = placeIn(lines, dh, h, peers);
    if (!p) return null;
    out.push(p);
  }
  out.sort((a, b) => a.at - b.at);
  for (let k = 1; k < out.length; k++) if (out[k - 1]!.at + out[k - 1]!.from.length > out[k]!.at) return null;
  return out;
}

/** The pane's text as it would save (the file, frontmatter included), as lines. */
const fileLines = (t: EditText): string[] => saveText(t.raw, t.buffer.text(), t.storage).replace(/\r\n?/g, "\n").split("\n");
const acceptedOf = (ai: AiDiffs) => ai.hunks.filter((h) => h.state === "accepted");

/**
 * The pane's text with `revisions` attached. An edit already in the text (accepted in an earlier session and saved) is
 * marked accepted and not shown again.
 */
export function withRevisions(t: EditText, revisions: readonly PaneRevision[]): EditText {
  let hunks = revisionHunks(revisions);
  if (hunks.length === 0) return t;
  const lines = fileLines(t);
  for (let changed = true; changed; ) {
    changed = false;
    for (const h of hunks) {
      if (h.state !== "pending") continue;
      const peers = hunks.filter((x) => x.state === "accepted" && x.file === h.file);
      const touched = h.file.hunks.filter((dh) => dh.lines.some((l) => owns(h, l)));
      const applied = touched.every((dh) => find(lines, side(dh, [...peers, h]), dh.oldStart - 1) >= 0 && find(lines, side(dh, peers), dh.oldStart - 1) < 0);
      if (applied) {
        hunks = hunks.map((x) => (x === h ? { ...x, state: "accepted" } : x));
        changed = true;
      }
    }
  }
  return { ...t, ai: { hunks } };
}

/** The buffer row line `k` of the file (`lines`) is shown under: its paragraph's last row, or under `lines`/`screenplay` the same line. */
function rowOf(t: EditText, lines: readonly string[], k: number): number {
  const { headLines } = partsOf(lines.join("\n"));
  const rows = t.buffer.lines;
  const last = Math.max(0, rows.length - 1);
  if (t.storage !== "sentences") return Math.max(0, Math.min(k - headLines, last));
  let block = -1;
  for (let i = headLines, inside = false; i <= Math.min(k, lines.length - 1); i++) {
    const blank = lines[i]!.trim() === "";
    if (!blank && !inside) block++;
    inside = !blank;
  }
  block = Math.max(0, block);
  let n = -1, row = -1;
  for (let r = 0, inside = false; r < rows.length; r++) {
    const blank = rows[r]!.trim() === "";
    if (!blank && !inside) n++;
    inside = !blank;
    if (n > block) break;
    if (n === block && !blank) row = r;
  }
  return row < 0 ? last : row;
}

/** The pending edits where the pane shows them, in row order. */
export function shownHunks(t: EditText): Shown[] {
  const ai = t.ai;
  if (!ai) return [];
  const lines = fileLines(t);
  const taken = acceptedOf(ai);
  const out: Shown[] = [];
  for (const hunk of ai.hunks) {
    if (hunk.state !== "pending") continue;
    const placed = place(lines, hunk, taken);
    const first = hunk.file.hunks.find((dh) => dh.lines.some((l) => owns(hunk, l)));
    const k = placed ? placed[0]!.anchor : (first?.oldStart ?? 1) - 1;
    out.push({ hunk, row: rowOf(t, lines, k), matches: placed !== null });
  }
  return out.sort((a, b) => a.row - b.row);
}

/** The edit the accept and reject keys act on: the first pending one at or below the cursor's row, else the last above it. */
export function currentHunk(t: EditText, shown: readonly Shown[] = shownHunks(t)): Shown | undefined {
  const row = t.buffer.cursor.row;
  return shown.find((s) => s.row >= row) ?? shown[shown.length - 1];
}

const decide = (ai: AiDiffs, id: string, state: HunkState): AiDiffs => ({ hunks: ai.hunks.map((h) => (h.id === id ? { ...h, state } : h)) });

/** Accepts the current edit: the pane's text takes it (one undo step). An edit that no longer matches leaves the text and says so. */
export function acceptHunk(t: EditText): EditText {
  const cur = t.ai ? currentHunk(t) : undefined;
  if (!cur || !t.ai) return t;
  const lines = fileLines(t);
  const placed = place(lines, cur.hunk, acceptedOf(t.ai));
  if (!placed) return { ...t, note: "that AI change no longer matches the text here: g r rejects it" };
  for (const p of [...placed].reverse()) lines.splice(p.at, p.from.length, ...p.to);
  const body = loadForEdit(lines.join("\n"), t.storage).text;
  // The whole text swapped as one undo step (TextBuffer.group), the cursor kept where it was.
  const next = apply(t, (b) => b.group(() => {
    const at = b.cursor;
    const last = b.lines.length - 1;
    b.deleteRange({ row: 0, col: 0 }, { row: last, col: b.lines[last]!.length });
    b.insert(body);
    b.cursor = b.clampPos(at);
  }));
  return { ...next, ai: decide(t.ai, cur.hunk.id, "accepted") };
}

/** Rejects the current edit: the text is left as it is. */
export function rejectHunk(t: EditText): EditText {
  const cur = t.ai ? currentHunk(t) : undefined;
  return cur && t.ai ? { ...t, ai: decide(t.ai, cur.hunk.id, "rejected"), note: null } : t;
}

/** Moves the cursor to the next (`dir` 1) or previous (-1) pending edit's row, wrapping round. */
export function stepHunk(t: EditText, dir: 1 | -1): EditText {
  const rows = [...new Set(shownHunks(t).map((s) => s.row))];
  if (rows.length === 0) return t;
  const at = t.buffer.cursor.row;
  const row = dir > 0 ? rows.find((r) => r > at) ?? rows[0]! : [...rows].reverse().find((r) => r < at) ?? rows[rows.length - 1]!;
  return apply(t, (b) => { b.cursor = { row, col: 0 }; });
}

/** The pending edits left, for the pane's title. */
export const pendingCount = (t: EditText | null | undefined): number => t?.ai?.hunks.filter((h) => h.state === "pending").length ?? 0;

const INDENT = 2;
const COLOR = { "-": "red", "+": "green", "~": "cyan" } as const;
type Part = { text: string; hl: boolean };

/** `segs` cut into rows of at most `width` characters, at spaces where a word fits; a space a row breaks at is dropped. */
function wrapSegs(segs: readonly Seg[], width: number): Part[][] {
  const rows: Part[][] = [[]];
  let used = 0;
  const push = (text: string, hl: boolean) => {
    const row = rows[rows.length - 1]!;
    const last = row[row.length - 1];
    if (last && last.hl === hl) last.text += text;
    else row.push({ text, hl });
    used += text.length;
  };
  const newRow = () => { rows.push([]); used = 0; };
  for (const s of segs) {
    for (const tok of visible(s.text.replace(/\t/g, " ")).match(/\s+|\S+/g) ?? []) {
      let rest = tok;
      while (rest) {
        if (used + rest.length <= width) { push(rest, s.hl); rest = ""; }
        else if (/^\s+$/.test(rest)) { newRow(); rest = ""; }
        else if (used > 0 && rest.length <= width) newRow();
        else { const take = Math.max(1, width - used); push(rest.slice(0, take), s.hl); rest = rest.slice(take); newRow(); }
      }
    }
  }
  return rows.filter((r, i) => r.length > 0 || i === 0);
}

/** The rows the pending edits add under their buffer rows at `width`: a header, then the removed and added sentences, the changed words marked. */
export function aiRows(t: EditText, width: number): Map<number, PaneRow[]> {
  const under = new Map<number, PaneRow[]>();
  const shown = shownHunks(t);
  const cur = currentHunk(t, shown);
  const pad = " ".repeat(INDENT);
  const inner = Math.max(5, width - INDENT - 2);
  for (const s of shown) {
    const current = s === cur;
    const what = !s.matches ? "no longer matches the text · g r rejects" : current ? "g a accept · g r reject" : "g f next";
    const head = `${pad}── AI · ${visible(s.hunk.branch)} · ${what}`;
    const rows: PaneRow[] = [{ kind: "diff", text: head, parts: [{ text: head, hl: false }], color: current ? "yellow" : "gray", ...(current ? { bold: true } : {}) }];
    for (const line of s.hunk.edit.rows) {
      if (line.sign === " ") continue;
      wrapSegs(line.segs, inner).forEach((parts, i) => {
        const lead = `${pad}${i === 0 ? line.sign : " "} `;
        const all = [{ text: lead, hl: false }, ...parts];
        rows.push({ kind: "diff", text: all.map((p) => p.text).join(""), parts: all, color: s.matches ? COLOR[line.sign as keyof typeof COLOR] : "gray" });
      });
    }
    under.set(s.row, [...(under.get(s.row) ?? []), ...rows]);
  }
  return under;
}
