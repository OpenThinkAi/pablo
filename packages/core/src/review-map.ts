/**
 * A reader's marks ↔ sentence lines ↔ a GitHub pull-request review (AGT-1584, `--doc readers`).
 *
 * The reader sees a chapter as ordinary paragraphs; the file (and the round's pull request, which adds every
 * line of it) is one sentence per line with frontmatter on top. Everything the reader does is a selection in
 * a paragraph, and every selection has to become a review comment on the right file lines. This module is that
 * mapping, both ways, and nothing else: pure and dependency-free, no IO, no GitHub client. The view (AGT-1586)
 * calls the forward half, `notes pull` (AGT-1587) the inverse, the transport (AGT-1585) sends the payload.
 *
 * The pipeline:
 *
 *   stored chapter ──readingChapter──▶ paragraphs + line map
 *   ReviewDraft (selections) ──resolveReview──▶ ResolvedReview (file line ranges, suggestion lines)
 *   ResolvedReview ──reviewPayload──▶ ReviewPayload (GitHub's shape)
 *   GitHub's review ──parseReview──▶ ResolvedReview          (the inverse: reviewPayload ∘ parseReview round-trips)
 *   ResolvedSuggestion ──applySuggestion──▶ the stored chapter with the suggestion taken
 *
 * Coordinates. A file line is 1-based and counts the frontmatter (GitHub's `line` and the `check` numbering).
 * A reading paragraph's offsets are UTF-16 code units into its `text`. A selection is half-open, `[start, end)`,
 * and may start and end in different paragraphs (the reader dragged across a paragraph break).
 *
 * GitHub shapes, as this module assumes them (REST "Create a review for a pull request",
 * `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`): the review `body` is the summary; each entry of
 * `comments` names a `path`, a `body`, and the diff lines it sits on — `line` with `side: "RIGHT"` for one line,
 * plus `start_line`/`start_side` for a range (both sides `RIGHT`: the round's PR only adds lines). A body holding
 * a ```` ```suggestion ```` block offers its content as the replacement for exactly the commented lines (an empty
 * block deletes them). A file-level comment is `{path, subject_type: "file", body}`; that field belongs to the
 * single-comment endpoint (`POST …/pulls/{n}/comments`) and GraphQL's `addPullRequestReviewThread(subjectType:
 * FILE)`, not to the create-review `comments` array, so the transport sends those separately (see
 * {@link partitionComments}).
 */

import { isProseBlock, splitManuscript } from "./sentences";

// ─── Reading form ─────────────────────────────────────────────────────────────────────────────────────────

/** A stored line as it appears in a reading paragraph: file line `line` (1-based) is `text.slice(start, end)`. */
export interface ReadingLine {
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

/**
 * One paragraph as the reader sees it. A prose paragraph's sentence lines are joined with single spaces and
 * their whitespace collapsed (`joinSentences`); a block that is Markdown structure — a heading, a scene break
 * (`* * *`), a list — keeps its lines as they are, joined with `\n` (`joinManuscript` leaves those alone too).
 */
export interface ReadingParagraph {
  readonly text: string;
  readonly prose: boolean;
  /** Every stored line of the paragraph, in order; together they cover every non-space character of `text`. */
  readonly lines: readonly ReadingLine[];
}

/** A chapter in reading form: its paragraphs (frontmatter hidden) and the stored file's lines. */
export interface ReadingChapter {
  readonly paragraphs: readonly ReadingParagraph[];
  /** The stored file's lines (`fileLines[n - 1]` is file line `n`), frontmatter included, line endings removed. */
  readonly fileLines: readonly string[];
}

const SPACE = /[ \t\n\r\f\v]+/g;
const collapse = (text: string): string => text.replace(SPACE, " ").trim();

/** The stored file's lines; a final newline ends the last line rather than opening an empty one. */
function linesOf(stored: string): string[] {
  const lines = stored.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * A stored chapter (frontmatter + one sentence per line) in reading form: paragraphs, and for every stored line
 * the character range of the paragraph it became. Frontmatter (a leading `---` block that closes) is hidden but
 * counted; a byte-order mark is ignored. Blank lines separate paragraphs and belong to none.
 */
export function readingChapter(stored: string): ReadingChapter {
  const fileLines = linesOf(stored.replace(/^﻿/, ""));
  const close = fileLines[0]?.trim() === "---" ? fileLines.findIndex((l, i) => i > 0 && l.trim() === "---") : -1;
  const blocks: { line: number; text: string }[][] = [];
  let run: { line: number; text: string }[] = [];
  for (let i = close + 1; i < fileLines.length; i++) {
    const text = fileLines[i] as string;
    if (text.trim() === "") {
      if (run.length > 0) blocks.push(run);
      run = [];
    } else run.push({ line: i + 1, text });
  }
  if (run.length > 0) blocks.push(run);

  const paragraphs = blocks.map((block): ReadingParagraph => {
    const prose = isProseBlock(block.map((l) => l.text).join("\n"));
    const parts = block.map((l) => (prose ? collapse(l.text) : l.text));
    const separator = prose ? " " : "\n";
    const lines: ReadingLine[] = [];
    let at = 0;
    parts.forEach((part, k) => {
      lines.push({ line: (block[k] as { line: number }).line, start: at, end: at + part.length });
      at += part.length + separator.length;
    });
    return { text: parts.join(separator), prose, lines };
  });
  return { paragraphs, fileLines };
}

/** The whole chapter as the reader reads it: paragraphs separated by one blank line. */
export function readingText(chapter: ReadingChapter): string {
  return chapter.paragraphs.map((p) => p.text).join("\n\n");
}

/**
 * The file line under `offset` in `paragraph`: the line whose characters contain it, or, on the space between
 * two lines, the line before. Offsets past either end clamp to the first or last line.
 */
export function lineAt(paragraph: ReadingParagraph, offset: number): number {
  let found = paragraph.lines[0];
  for (const l of paragraph.lines) if (l.start <= offset) found = l;
  if (found === undefined) throw new RangeError("pablo: an empty paragraph has no lines");
  return found.line;
}

// ─── Selections → file lines ──────────────────────────────────────────────────────────────────────────────

/** A point in a reading chapter: `offset` code units into paragraph `paragraph` (0-based), `0..text.length`. */
export interface Position {
  readonly paragraph: number;
  readonly offset: number;
}

/** A half-open selection `[start, end)`; `start === end` is a caret (an insertion point). */
export interface ReadingSelection {
  readonly start: Position;
  readonly end: Position;
}

/** An inclusive range of file lines, 1-based, frontmatter counted. `start === end` is one line. */
export interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** A selection inside one paragraph: `[start, end)` of paragraph `paragraph`. */
export function inParagraph(paragraph: number, start: number, end: number = start): ReadingSelection {
  return { start: { paragraph, offset: start }, end: { paragraph, offset: end } };
}

/** The chapter's lines and paragraph starts in one coordinate system: `readingText`, paragraphs joined by `\n\n`. */
interface Flat {
  readonly text: string;
  readonly starts: readonly number[];
  readonly lines: readonly ReadingLine[];
}

function flatten(chapter: ReadingChapter): Flat {
  const starts: number[] = [];
  const lines: ReadingLine[] = [];
  let at = 0;
  for (const p of chapter.paragraphs) {
    starts.push(at);
    for (const l of p.lines) lines.push({ line: l.line, start: at + l.start, end: at + l.end });
    at += p.text.length + 2;
  }
  return { text: readingText(chapter), starts, lines };
}

function flatOffset(chapter: ReadingChapter, flat: Flat, pos: Position): number {
  const p = chapter.paragraphs[pos.paragraph];
  if (p === undefined || !Number.isInteger(pos.offset) || pos.offset < 0 || pos.offset > p.text.length) {
    throw new RangeError(`pablo: position ${pos.paragraph}:${pos.offset} is not in the chapter (${chapter.paragraphs.length} paragraphs)`);
  }
  return (flat.starts[pos.paragraph] as number) + pos.offset;
}

function flatSelection(chapter: ReadingChapter, flat: Flat, selection: ReadingSelection): [number, number] {
  const s = flatOffset(chapter, flat, selection.start);
  const e = flatOffset(chapter, flat, selection.end);
  if (e < s) throw new RangeError(`pablo: selection ends (${selection.end.paragraph}:${selection.end.offset}) before it starts (${selection.start.paragraph}:${selection.start.offset})`);
  return [s, e];
}

/**
 * The lines a caret or a span of whitespace touches: every line whose closed range `[start, end]` meets `[s, e]`
 * (so a caret right after a sentence is on that sentence, and a deleted space between two sentences touches
 * both). In a paragraph break, which touches nothing, the line before it (or the first line).
 */
function closedTouch(flat: Flat, s: number, e: number): ReadingLine[] {
  const hit = flat.lines.filter((l) => l.start <= e && s <= l.end);
  if (hit.length > 0) return hit;
  const before = flat.lines.filter((l) => l.end < s).pop() ?? flat.lines[0];
  if (before === undefined) throw new RangeError("pablo: the chapter has no text to select");
  return [before];
}

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/.test(ch);

/** `[a, b]` as a range of the touched lines. */
const rangeOf = (lines: readonly ReadingLine[]): LineRange => ({ start: (lines[0] as ReadingLine).line, end: (lines[lines.length - 1] as ReadingLine).line });

/**
 * The inclusive file-line range a selection is about, for a comment: the selection with its surrounding
 * whitespace trimmed, then every line it shares a character with. A caret or a whitespace-only selection is the
 * line it sits on (the line before, on a space between two). Crossing a paragraph break covers the blank lines
 * between: a PR that adds the file adds those too, so the range is commentable.
 */
export function selectionLines(chapter: ReadingChapter, selection: ReadingSelection): LineRange {
  const flat = flatten(chapter);
  const [from, to] = flatSelection(chapter, flat, selection);
  let s = from;
  let e = to;
  while (s < e && isSpace(flat.text[s])) s++;
  while (e > s && isSpace(flat.text[e - 1])) e--;
  if (s === e) return rangeOf([closedTouch(flat, from, from)[0] as ReadingLine]);
  return rangeOf(flat.lines.filter((l) => l.start < e && s < l.end));
}

/**
 * The lines a suggestion replaces and what replaces them: every line the selection touches (closed ranges, so
 * deleting the space between two sentences joins them), rebuilt from the selection's replacement plus the
 * untouched parts of the first and last of those lines, then re-split one sentence per line (core
 * `splitManuscript`: prose split by `splitSentences`, a heading or scene break kept as it is, paragraphs separated
 * by one blank line). A paragraph break typed at either edge of the range is kept as a blank line.
 */
export function suggestionLines(chapter: ReadingChapter, selection: ReadingSelection, replacement: string): { lines: LineRange; replacement: string[] } {
  const flat = flatten(chapter);
  const [s, e] = flatSelection(chapter, flat, selection);
  const touched = closedTouch(flat, s, e);
  const first = touched[0] as ReadingLine;
  const last = touched[touched.length - 1] as ReadingLine;
  const from = Math.min(first.start, s);
  const to = Math.max(last.end, e);
  const edited = flat.text.slice(from, s) + replacement + flat.text.slice(e, to);
  const lines = edited.trim() === "" ? [] : splitManuscript(edited).split("\n");
  // The lines just outside the range, when they are in the same paragraph as its first and last lines: a break
  // typed at the range's edge has to become a blank line, or the re-split (which trims) would lose it.
  const before = flat.lines[flat.lines.indexOf(first) - 1]?.line === first.line - 1;
  const after = flat.lines[flat.lines.indexOf(last) + 1]?.line === last.line + 1;
  if (lines.length === 0) {
    if (before && after && /\n\s*\n/.test(edited)) lines.push("");
  } else {
    if (before && /^\s*\n\s*\n/.test(edited)) lines.unshift("");
    if (after && /\n\s*\n\s*$/.test(edited)) lines.push("");
  }
  return { lines: rangeOf(touched), replacement: lines };
}

// ─── Marks ────────────────────────────────────────────────────────────────────────────────────────────────

/** A comment's tag: `fix` — this needs work; `keep` — I like this. Tags keep praise from reading as a to-do. */
export type Tag = "fix" | "keep";
export const TAGS: readonly Tag[] = ["fix", "keep"];

/**
 * What the reader made, as the view records it. `path` is the chapter's path in the reading repo (the PR's
 * file). A free edit is recorded exactly like a strike: the selection it changed and the text typed over it.
 */
export type ReaderMark =
  | { readonly kind: "comment"; readonly path: string; readonly selection: ReadingSelection; readonly tag?: Tag; readonly body: string }
  | { readonly kind: "suggestion"; readonly path: string; readonly selection: ReadingSelection; readonly replacement: string; readonly tag?: Tag; readonly note?: string }
  | { readonly kind: "chapter"; readonly path: string; readonly tag?: Tag; readonly body: string };

/** The reader's whole round: the summary and every mark, in the order made. */
export interface ReviewDraft {
  readonly summary: string;
  readonly marks: readonly ReaderMark[];
}

/** A comment on file lines. */
export interface ResolvedComment {
  readonly kind: "comment";
  readonly path: string;
  readonly lines: LineRange;
  readonly tag?: Tag;
  readonly body: string;
}

/** A suggestion: replace file lines `lines` with `replacement` (one sentence per line; `[]` deletes them). */
export interface ResolvedSuggestion {
  readonly kind: "suggestion";
  readonly path: string;
  readonly lines: LineRange;
  readonly replacement: readonly string[];
  readonly tag?: Tag;
  readonly note?: string;
}

/** A note on the whole chapter. */
export interface ResolvedChapterComment {
  readonly kind: "chapter";
  readonly path: string;
  readonly tag?: Tag;
  readonly body: string;
}

/** A mark pinned to file lines: what goes to GitHub and what comes back from it. */
export type ResolvedMark = ResolvedComment | ResolvedSuggestion | ResolvedChapterComment;

/** A round in file-line terms: the summary and the resolved marks. */
export interface ResolvedReview {
  readonly summary: string;
  readonly marks: readonly ResolvedMark[];
}

/** The chapters of a round, by path: each one's stored text exactly as the round's head commit holds it. */
export type Chapters = Readonly<Record<string, string>>;

const withTag = (tag: Tag | undefined) => (tag === undefined ? {} : { tag });

/** One mark pinned to the lines of `chapter` (the reading form of the mark's `path`). */
export function resolveReaderMark(chapter: ReadingChapter, mark: ReaderMark): ResolvedMark {
  switch (mark.kind) {
    case "chapter":
      return { kind: "chapter", path: mark.path, ...withTag(mark.tag), body: mark.body };
    case "comment":
      return { kind: "comment", path: mark.path, lines: selectionLines(chapter, mark.selection), ...withTag(mark.tag), body: mark.body };
    case "suggestion": {
      const { lines, replacement } = suggestionLines(chapter, mark.selection, mark.replacement);
      return { kind: "suggestion", path: mark.path, lines, replacement, ...withTag(mark.tag), ...(mark.note ? { note: mark.note } : {}) };
    }
  }
}

/** Every mark of a draft pinned to file lines. Throws when a mark names a chapter not in `chapters`. */
export function resolveReview(chapters: Chapters, draft: ReviewDraft): ResolvedReview {
  const read = new Map<string, ReadingChapter>();
  const chapterOf = (path: string): ReadingChapter => {
    const stored = Object.prototype.hasOwnProperty.call(chapters, path) ? chapters[path] : undefined;
    if (stored === undefined) throw new RangeError(`pablo: a mark names ${path}, which is not a chapter of this round`);
    let chapter = read.get(path);
    if (chapter === undefined) read.set(path, (chapter = readingChapter(stored)));
    return chapter;
  };
  return { summary: draft.summary, marks: draft.marks.map((mark) => resolveReaderMark(chapterOf(mark.path), mark)) };
}

// ─── Bodies: tags and suggestion blocks ───────────────────────────────────────────────────────────────────

/** A tagged body opens with `**[fix]**` or `**[keep]**`, then one space before the text (none when empty). */
const TAG_PREFIX = /^\*\*\[(fix|keep)\]\*\*(?: |$)/;

/**
 * A comment body with its tag encoded: `**[fix]** text`. An untagged body that could be mistaken for a tagged
 * one, or that opens with a backslash, gets a leading backslash, so {@link decodeBody} always recovers it.
 */
export function encodeBody(tag: Tag | undefined, text: string): string {
  if (tag !== undefined) return text === "" ? `**[${tag}]**` : `**[${tag}]** ${text}`;
  return TAG_PREFIX.test(text) || text.startsWith("\\") ? `\\${text}` : text;
}

/** The tag and text of a body {@link encodeBody} wrote (any other body is untagged text). */
export function decodeBody(body: string): { tag?: Tag; text: string } {
  const m = TAG_PREFIX.exec(body);
  if (m) return { tag: m[1] as Tag, text: body.slice(m[0].length) };
  return { text: body.startsWith("\\") ? body.slice(1) : body };
}

/** A fence longer than any backtick run in `lines`, so the suggestion's own text can never close it. */
function fenceFor(lines: readonly string[]): string {
  const longest = Math.max(0, ...lines.flatMap((l) => (l.match(/`+/g) ?? []).map((run) => run.length)));
  return "`".repeat(Math.max(3, longest + 1));
}

/** A suggestion's body: the tagged note (if any), a blank line, then the ```` ```suggestion ```` block. */
export function suggestionBody(replacement: readonly string[], tag?: Tag, note?: string): string {
  const fence = fenceFor(replacement);
  const block = `${fence}suggestion\n${replacement.map((l) => `${l}\n`).join("")}${fence}`;
  const head = tag !== undefined || note ? encodeBody(tag, note ?? "") : "";
  return head === "" ? block : `${head}\n\n${block}`;
}

/** A suggestion block closing the body: its fence, then its content (empty, or lines each ending in `\n`). */
const SUGGESTION = /(^|\n\n)(`{3,})suggestion[ \t]*\n((?:[^\n]*\n)*?)\2[ \t]*\n?$/;

/** The parts of a suggestion body, or `undefined` when the body ends in no suggestion block. */
export function parseSuggestionBody(body: string): { replacement: string[]; tag?: Tag; note?: string } | undefined {
  const m = SUGGESTION.exec(body);
  if (!m) return undefined;
  const content = m[3] as string;
  const replacement = content === "" ? [] : content.slice(0, -1).split("\n");
  const head = body.slice(0, m.index);
  if (head === "") return { replacement };
  const { tag, text } = decodeBody(head);
  return { replacement, ...withTag(tag), ...(text ? { note: text } : {}) };
}

// ─── GitHub's review shape ────────────────────────────────────────────────────────────────────────────────

/** A comment on one line of the PR's diff (the head side). */
export interface LineComment {
  readonly path: string;
  readonly line: number;
  readonly side: "RIGHT";
  readonly body: string;
}

/** A comment on a range of lines, `start_line` through `line` inclusive. */
export interface RangeComment {
  readonly path: string;
  readonly start_line: number;
  readonly start_side: "RIGHT";
  readonly line: number;
  readonly side: "RIGHT";
  readonly body: string;
}

/** A comment on the whole file, tied to no line. */
export interface FileComment {
  readonly path: string;
  readonly subject_type: "file";
  readonly body: string;
}

export type ReviewComment = LineComment | RangeComment | FileComment;

/**
 * What the reader's Submit sends: the summary as the review `body` and one comment per mark. `event` and
 * `commit_id` (the round's pinned head) are the transport's to add.
 */
export interface ReviewPayload {
  readonly body: string;
  readonly comments: readonly ReviewComment[];
}

/** A comment on `lines`: one line, or a range. */
function onLines(path: string, lines: LineRange, body: string): LineComment | RangeComment {
  if (lines.start === lines.end) return { path, line: lines.end, side: "RIGHT", body };
  return { path, start_line: lines.start, start_side: "RIGHT", line: lines.end, side: "RIGHT", body };
}

/** One resolved mark as a GitHub review comment. */
export function reviewComment(mark: ResolvedMark): ReviewComment {
  switch (mark.kind) {
    case "chapter":
      return { path: mark.path, subject_type: "file", body: encodeBody(mark.tag, mark.body) };
    case "comment":
      if (mark.tag === undefined && mark.body === "") throw new RangeError(`pablo: a comment on ${mark.path} has neither a tag nor any text`);
      return onLines(mark.path, mark.lines, encodeBody(mark.tag, mark.body));
    case "suggestion":
      return onLines(mark.path, mark.lines, suggestionBody(mark.replacement, mark.tag, mark.note));
  }
}

/** A resolved round as GitHub's review payload. */
export function reviewPayload(review: ResolvedReview): ReviewPayload {
  return { body: review.summary, comments: review.marks.map(reviewComment) };
}

/** A draft straight to the payload: {@link resolveReview}, then {@link reviewPayload}. */
export function toReviewPayload(chapters: Chapters, draft: ReviewDraft): ReviewPayload {
  return reviewPayload(resolveReview(chapters, draft));
}

/** Whether a comment is file-level (`subject_type: "file"`). */
export const isFileComment = (c: ReviewComment): c is FileComment => "subject_type" in c;

/**
 * The payload's comments split by how GitHub takes them: line comments go in the create-review call's
 * `comments`; file comments are not accepted there and go one by one (`subject_type: "file"`) or as GraphQL
 * review threads with `subjectType: FILE`.
 */
export function partitionComments(payload: ReviewPayload): { line: (LineComment | RangeComment)[]; file: FileComment[] } {
  const line: (LineComment | RangeComment)[] = [];
  const file: FileComment[] = [];
  for (const c of payload.comments) {
    if (isFileComment(c)) file.push(c);
    else line.push(c);
  }
  return { line, file };
}

/**
 * A review comment as GitHub's API returns it (`GET …/pulls/{n}/reviews/{id}/comments` or `…/pulls/{n}/comments`),
 * narrowed to the fields the inverse reads. `line`/`start_line` are null on an outdated comment; the round's
 * review is pinned to its own commit, so the `original_*` numbers are the same lines and are used then.
 */
export interface GitHubReviewComment {
  readonly path: string;
  readonly body: string;
  readonly line?: number | null;
  readonly start_line?: number | null;
  readonly original_line?: number | null;
  readonly original_start_line?: number | null;
  readonly subject_type?: string | null;
  readonly in_reply_to_id?: number | null;
}

/** A submitted review as the inverse reads it: its body (the summary) and its comments. */
export interface GitHubReview {
  readonly body?: string | null;
  readonly comments: readonly GitHubReviewComment[];
}

/** One GitHub review comment back as a mark. Replies (`in_reply_to_id`) are not marks: `undefined`. */
export function parseComment(comment: GitHubReviewComment): ResolvedMark | undefined {
  if (comment.in_reply_to_id != null) return undefined;
  const body = comment.body.replace(/\r\n/g, "\n");
  const original = comment.line == null;
  const end = original ? comment.original_line : comment.line;
  if (comment.subject_type === "file" || end == null) {
    const { tag, text } = decodeBody(body);
    return { kind: "chapter", path: comment.path, ...withTag(tag), body: text };
  }
  const lines: LineRange = { start: (original ? comment.original_start_line : comment.start_line) ?? end, end };
  const suggestion = parseSuggestionBody(body);
  if (suggestion) return { kind: "suggestion", path: comment.path, lines, ...suggestion };
  const { tag, text } = decodeBody(body);
  return { kind: "comment", path: comment.path, lines, ...withTag(tag), body: text };
}

/**
 * The inverse `notes pull` uses: a submitted review back into the round's resolved marks, in the order given.
 * `parseReview(reviewPayload(r))` is `r` for every round `resolveReview` can produce.
 */
export function parseReview(review: GitHubReview): ResolvedReview {
  const marks = review.comments.map(parseComment).filter((m): m is ResolvedMark => m !== undefined);
  return { summary: (review.body ?? "").replace(/\r\n/g, "\n"), marks };
}

// ─── Taking a suggestion ──────────────────────────────────────────────────────────────────────────────────

/**
 * `stored` with one suggestion taken: file lines `lines.start..lines.end` replaced by its replacement lines.
 * The file's line endings and final newline are kept. Throws when the range is not in the file.
 */
export function applySuggestion(stored: string, suggestion: Pick<ResolvedSuggestion, "lines" | "replacement">): string {
  return applySuggestions(stored, [suggestion]);
}

/**
 * `stored` with several suggestions taken at once, each against the original line numbers (they are applied
 * bottom-up so earlier ones do not shift later ones). Throws when two of them overlap.
 */
export function applySuggestions(stored: string, suggestions: readonly Pick<ResolvedSuggestion, "lines" | "replacement">[]): string {
  const eol = stored.includes("\r\n") ? "\r\n" : "\n";
  const lines = linesOf(stored);
  const finalNewline = lines.length > 0 && stored.endsWith("\n");
  const order = [...suggestions].sort((a, b) => a.lines.start - b.lines.start);
  order.forEach((s, i) => {
    const { start, end } = s.lines;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) {
      throw new RangeError(`pablo: a suggestion on lines ${start}-${end} is not in a file of ${lines.length} lines`);
    }
    const prev = order[i - 1];
    if (prev && prev.lines.end >= start) throw new RangeError(`pablo: suggestions on lines ${prev.lines.start}-${prev.lines.end} and ${start}-${end} overlap`);
  });
  for (const s of order.reverse()) lines.splice(s.lines.start - 1, s.lines.end - s.lines.start + 1, ...s.replacement);
  return lines.join(eol) + (finalNewline ? eol : "");
}
