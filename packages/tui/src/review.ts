// Review mode's data, pure: a branch's changes against `main` as the rail's rows and the main pane's lines. The CLI
// runs git (it owns the branch layer, branch.ts) and hands the diff text over; this package parses it with core's
// diff parser, groups it with core's stitcher and lays it out. Nothing here reads the disk or the terminal.
//
// The rail lists the changes, grouped by file: a file is a group row (`file:<path>`), each edit under it a row
// (`edit:<n>`). The main pane shows the edit under the rail's cursor: its removed and added sentences, the words that
// differ marked, one unchanged line either side for context. Book mode lists the branches waiting for review as rows
// `branch:<name>`; opening one is the model's `review.open`.

import { parseDiff } from "@openthink/pablo-core";
import { clean } from "./sanitize";
import { stitch, type Edit, type EditLine, type Seg } from "./stitch";
import { commentBox } from "./comment-box";
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

/** Where a comment came from: the critic (AGT-1564), a reader (a pulled GitHub review) or the author (Matt's own). */
export type CommentSource = "critic" | "reader" | "author";
/** A reader's or the author's tag: a thing to fix, or a thing to keep (so praise never reads like a to-do). */
export type CommentTag = "fix" | "keep";

/**
 * A comment as review mode needs it, whatever its source: the CLI's comment store entry (`.pablo/comments/<branch>.json`,
 * AGT-1580) or a critic survivor mapped to this shape. A structural type, so this package never imports the CLI.
 * `path` is the diff's path (relative to the repo) and `line` counts in the new text; `startLine` makes it a span.
 * No `line` is a file-level comment; `review: true` is the whole review's summary (its `path` is then not read).
 * `label` is an extra word for the box's header (the critic's kind: continuity, timeline, tells).
 */
export interface ReviewComment {
  readonly source: CommentSource;
  readonly tag?: CommentTag;
  readonly path: string;
  readonly line?: number;
  readonly startLine?: number;
  readonly review?: true;
  readonly author: string;
  readonly body: string;
  readonly label?: string;
}

const SOURCES: readonly CommentSource[] = ["critic", "reader", "author"];

/** What the status area counts a comment under: its source, then its tag (`critic`, `reader fix`, `author keep`). */
export const countKey = (c: ReviewComment): string => (c.tag ? `${c.source} ${c.tag}` : c.source);

export interface Review {
  readonly rows: readonly RailRow[];
  readonly labels: Readonly<Record<string, string>>;
  readonly edits: ReadonlyMap<string, Edit>;
  /** Line comments by the edit (`edit:<n>`) whose changed lines they are on, in the order given. */
  readonly comments: ReadonlyMap<string, readonly ReviewComment[]>;
  /** Comments shown at the top of a file's changes: the file-level ones, and line comments on no edit's lines. By path. */
  readonly fileComments: ReadonlyMap<string, readonly ReviewComment[]>;
  /** The whole-review summaries, shown at the top of every pane of the review. */
  readonly summary: readonly ReviewComment[];
  /** Every comment's count by source and tag (`countKey`), sources in the order critic, reader, author; for the status area. */
  readonly counts: Readonly<Record<string, number>>;
  /** What the main pane says when there is nothing to show: no changes, or git's reason for none. */
  readonly notice?: string;
}

const MARK: Record<Edit["kind"], string> = { change: "~", add: "+", remove: "-", move: "⇄" };

/** A short rail label: the kind's mark, then the first sentence the edit puts in (or takes out). */
function labelOf(e: Edit): string {
  const textOf = (r: EditLine) => r.segs.map((s) => s.text).join("").trim();
  const first = (signs: string) => e.rows.find((r) => signs.includes(r.sign) && textOf(r) !== "");
  // A binary file's change has only its notice row.
  const row = first("+~") ?? first("-") ?? (e.kind === "change" ? e.rows[0] : undefined);
  // Only blank lines changed: in sentence-per-line prose that is a paragraph split or joined.
  return `${MARK[e.kind]} ${(row && textOf(row)) || "(paragraph break)"}`;
}

/** The review of a branch's diff: the diff text is cleaned of control characters before it is parsed, tabs widened. */
export function loadReview(diff: BranchDiff | undefined, comments: readonly ReviewComment[] = []): Review {
  const summary = comments.filter((c) => c.review);
  const none = { rows: [], labels: {}, edits: new Map(), comments: new Map(), fileComments: new Map(), summary, counts: countComments(comments) };
  if (!diff) return { ...none, notice: "The changes could not be read." };
  if (!diff.ok) return { ...none, notice: clean(diff.notice) };
  const files = parseDiff(clean(diff.text).replace(/\t/g, "  "));
  const edits = stitch(files);
  if (edits.length === 0) return { ...none, notice: "No changes against main." };
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
  // A line comment belongs to the edit whose added lines include its line (a span: its last line). One on no edit's
  // lines, and a file-level one, show at the top of the file's changes, so no comment is ever hidden.
  const placed = new Map<string, ReviewComment[]>();
  const perFile = new Map<string, ReviewComment[]>();
  const push = (m: Map<string, ReviewComment[]>, k: string, c: ReviewComment) => m.set(k, [...(m.get(k) ?? []), c]);
  for (const c of comments) {
    if (c.review) continue;
    const at = c.line;
    const e = at === undefined ? undefined : edits.find((x) => x.path === c.path && x.kind !== "remove" && at >= x.line && at < x.line + Math.max(1, x.added));
    if (e) push(placed, e.id, c);
    else push(perFile, c.path, c);
  }
  return { rows, labels, edits: byId, comments: placed, fileComments: perFile, summary, counts: countComments(comments) };
}

/** Counts by source and tag, sources in a fixed order so the status line does not shuffle. */
function countComments(comments: readonly ReviewComment[]): Record<string, number> {
  const n = new Map<string, number>();
  for (const c of [...comments].sort((a, b) => SOURCES.indexOf(a.source) - SOURCES.indexOf(b.source))) n.set(countKey(c), (n.get(countKey(c)) ?? 0) + 1);
  return Object.fromEntries(n);
}

/**
 * Where `e` opens the change `id`: its file (repo-relative, as the diff names it) and the line in the branch's new text.
 * That is the change's first added line; a pure removal has none, so it is the line before the removal. The removal's
 * line (the first of the lines it owns, in old numbering), so it is carried to the new text by what the earlier changes in the same file added and
 * removed (the edits are in diff order). Undefined when `id` is not a change in this review.
 */
export function editTarget(review: Review, id: string): { readonly file: string; readonly line: number } | undefined {
  const edit = review.edits.get(id);
  if (!edit) return undefined;
  const mine = edit.addedLines.filter((l) => l.path === edit.path).map((l) => l.line);
  if (mine.length > 0) return { file: edit.path, line: Math.min(...mine) };
  let shift = 0;
  for (const e of review.edits.values()) {
    if (e === edit) break;
    shift += e.addedLines.filter((l) => l.path === edit.path).length - e.removedLines.filter((l) => l.path === edit.path).length;
  }
  const gone = edit.removedLines.filter((l) => l.path === edit.path).map((l) => l.line);
  return { file: edit.path, line: Math.max(1, (gone.length > 0 ? Math.min(...gone) : edit.line) - 1 + shift) };
}

/** A line of the main pane: a sign column and the words, wrapped to the pane (`cont` rows continue the one above). */
export interface DiffRow extends EditLine { readonly cont?: true; readonly box?: true }

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
  const path = edit ? edit.path : rowId?.startsWith("file:") ? rowId.slice(5) : undefined;
  // The review's summary and the file's own comments come first, whichever change is under the cursor.
  const top = [...review.summary, ...(path === undefined ? [] : review.fileComments.get(path) ?? [])].flatMap((c) => commentRows(c, width));
  if (!edit) {
    const notice = review.notice ?? (path !== undefined ? (top.length > 0 ? "" : "Open a change under this file.") : "");
    return { title: path ?? "changes", rows: [...top, ...(notice ? wrapLine({ sign: " ", segs: [{ text: notice, hl: false }] }, width) : [])] };
  }
  const where = edit.kind === "move" && edit.from ? `moved from ${edit.from.path}:${edit.from.line} to line ${edit.line}` : `line ${edit.line} · ${edit.kind}`;
  const rows: DiffRow[] = [...top, ...edit.rows.flatMap((r) => wrapLine(r, width))];
  for (const c of review.comments.get(edit.id) ?? []) rows.push(...commentRows(c, width));
  return { title: `${edit.path} · ${where}`, rows };
}

/** Where a comment is, for its box's header: `review`, `file`, `line 3` or `lines 3-5`. */
function whereOf(c: ReviewComment): string {
  if (c.review) return "review";
  if (c.line === undefined) return "file";
  return c.startLine !== undefined && c.startLine < c.line ? `lines ${c.startLine}-${c.line}` : `line ${c.line}`;
}

/**
 * A comment as a box, from any source, through the one box component (comment-box.ts): the top border carries the
 * source, the tag, the critic's kind and where it is, the author dimmed after it; the body wraps onto as many rows as it
 * needs; rows are plain so the pane scrolls over them like any other. Text is cleaned: a comment is someone's words.
 */
export function commentRows(c: ReviewComment, width: number): DiffRow[] {
  const title = ["▲", c.source, ...(c.tag ? [c.tag] : [])].join(" ") + ` · ${c.label ? `${c.label} · ` : ""}${whereOf(c)}`;
  return commentBox({ title, tag: c.author, body: c.body }, Math.max(8, width), { maxLines: Infinity }).map((b) => ({ sign: " ", segs: [{ text: b.text, hl: false }], box: true as const }));
}
