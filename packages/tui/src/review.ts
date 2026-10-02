// Review mode's data, pure: a branch's changes against `main` as the rail's rows and the main pane's lines. The CLI
// runs git (it owns the branch layer, branch.ts) and hands the diff text over; this package parses it with core's
// diff parser, groups it with the stitcher (stitch.ts) and lays it out. Nothing here reads the disk or the terminal.
//
// The rail lists the changes, grouped by file: a file is a group row (`file:<path>`), each edit under it a row
// (`edit:<n>`). The main pane shows the edit under the rail's cursor: its removed and added sentences, the words that
// differ marked, one unchanged line either side for context. Book mode lists the branches waiting for review as rows
// `branch:<name>`; opening one is the model's `review.open`.

import { detectMoves, parseDiff } from "@openthink/pablo-core";
import { clean } from "./sanitize";
import { stitch, type Edit, type EditLine, type Seg } from "./stitch";
import { BRANCH_ROW, type RailRow } from "./state";

/** What the CLI hands over for a branch: git's diff of it against `main`, or why there is none. */
export type BranchDiff = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly notice: string };

export const BRANCH_GROUP = "branches";

/** Book mode's rail rows for the branches waiting for review: a group, and a row per branch. None waiting, no rows. */
export function branchRows(branches: readonly string[]): { rows: RailRow[]; labels: Record<string, string> } {
  if (branches.length === 0) return { rows: [], labels: {} };
  const labels: Record<string, string> = { [BRANCH_GROUP]: `branches to review (${branches.length})` };
  const rows: RailRow[] = [{ id: BRANCH_GROUP, depth: 0, group: true }];
  for (const b of branches) {
    rows.push({ id: `${BRANCH_ROW}${b}`, depth: 1 });
    labels[`${BRANCH_ROW}${b}`] = b;
  }
  return { rows, labels };
}

export interface Review {
  readonly rows: readonly RailRow[];
  readonly labels: Readonly<Record<string, string>>;
  readonly edits: ReadonlyMap<string, Edit>;
  /** What the main pane says when there is nothing to show: no changes, or git's reason for none. */
  readonly notice?: string;
}

const MARK: Record<Edit["kind"], string> = { change: "~", add: "+", remove: "-", move: "⇄" };

/** A short rail label: the kind's mark, then the first sentence the edit puts in (or takes out). */
function labelOf(e: Edit): string {
  const first = e.rows.find((r) => r.sign === "+" || r.sign === "~") ?? e.rows.find((r) => r.sign === "-") ?? e.rows[0];
  const text = (first?.segs.map((s) => s.text).join("") ?? "").trim();
  return `${MARK[e.kind]} ${text || "(blank line)"}`;
}

/** The review of a branch's diff: the diff text is cleaned of control characters before it is parsed, tabs widened. */
export function loadReview(diff: BranchDiff | undefined): Review {
  if (!diff) return { rows: [], labels: {}, edits: new Map(), notice: "The changes could not be read." };
  if (!diff.ok) return { rows: [], labels: {}, edits: new Map(), notice: clean(diff.notice) };
  const files = parseDiff(clean(diff.text).replace(/\t/g, "  "));
  const edits = stitch(files, detectMoves(files));
  if (edits.length === 0) return { rows: [], labels: {}, edits: new Map(), notice: "No changes against main." };
  const rows: RailRow[] = [];
  const labels: Record<string, string> = {};
  const byId = new Map<string, Edit>();
  for (const path of [...new Set(edits.map((e) => e.path))]) {
    const mine = edits.filter((e) => e.path === path);
    rows.push({ id: `file:${path}`, depth: 0, group: true });
    labels[`file:${path}`] = `${path} (${mine.length})`;
    for (const e of mine) {
      rows.push({ id: e.id, depth: 1 });
      labels[e.id] = labelOf(e);
      byId.set(e.id, e);
    }
  }
  return { rows, labels, edits: byId };
}

/** A line of the main pane: a sign column and the words, wrapped to the pane (`cont` rows continue the one above). */
export interface DiffRow extends EditLine { readonly cont?: true }

/** Wraps one edit line to `width` columns of text on word breaks, keeping each word's highlight. */
export function wrapLine(row: EditLine, width: number): DiffRow[] {
  const max = Math.max(1, width);
  const tokens = row.segs.flatMap((s) => s.text.split(/(\s+)/).filter((t) => t !== "").map((text) => ({ text, hl: s.hl })));
  const out: DiffRow[] = [];
  let cur: Seg[] = [];
  let used = 0;
  const flush = () => {
    // A line breaks at a space: the space it broke at is not carried to the next line or left trailing on this one.
    while (cur.length > 0 && /^\s+$/.test(cur[cur.length - 1]!.text)) cur.pop();
    out.push({ sign: row.sign, segs: cur, ...(out.length > 0 ? { cont: true as const } : {}) });
    cur = [];
    used = 0;
  };
  for (const t of tokens) {
    const space = /^\s+$/.test(t.text);
    if (space && used === 0 && out.length > 0) continue;
    let text = t.text;
    if (!space && used > 0 && used + text.length > max) flush();
    // A word longer than the pane is cut where it overflows.
    while (!space && text.length > max) { cur.push({ text: text.slice(0, max - used), hl: t.hl }); text = text.slice(max - used); flush(); }
    cur.push({ text, hl: t.hl });
    used += text.length;
  }
  if (cur.length > 0 || out.length === 0) flush();
  return out;
}

/** The main pane's lines for the edit under the rail's cursor (a file's group row has none of its own). */
export function reviewLines(review: Review, rowId: string | undefined, width: number): { title: string; rows: DiffRow[] } {
  const edit = rowId === undefined ? undefined : review.edits.get(rowId);
  if (!edit) {
    const notice = review.notice ?? (rowId?.startsWith("file:") ? "Open a change under this file." : "");
    return { title: rowId?.startsWith("file:") ? rowId.slice(5) : "changes", rows: notice ? wrapLine({ sign: " ", segs: [{ text: notice, hl: false }] }, width) : [] };
  }
  const where = edit.kind === "move" && edit.from ? `moved from ${edit.from.path}:${edit.from.line} to line ${edit.line}` : `line ${edit.line} · ${edit.kind}`;
  return { title: `${edit.path} · ${where}`, rows: edit.rows.flatMap((r) => wrapLine(r, width)) };
}
