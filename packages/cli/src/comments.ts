/**
 * The comment store (AGT-1580): every comment on a branch, from any source, in one file,
 * `<work>/.pablo/comments/<branch>.json` (gitignored with the rest of `.pablo/`). Review mode reads it and shows each
 * entry as a box; a reader's pulled review (AGT-1587) and the author's own comments (AGT-1581) write it. The critic's
 * survivors keep their own file (`.pablo/critique/`, keyed to the branch head) and join the store's entries at display
 * time (`reviewCommentsOf`, critique.ts).
 *
 * The file is `{ "comments": [ ...entries ] }`. Reading is forgiving, as the file may be hand-edited or half-written
 * by an older build: a missing or unparseable file reads as no comments, and an entry that is not well formed is
 * skipped without dropping its neighbours. Writing is atomic (temp file, rename). `parseComments` and
 * `serializeComments` are pure; `readComments` / `writeComments` / `addComment` are the only functions that touch the disk.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const COMMENT_SOURCES = ["critic", "reader", "author"] as const;
export type CommentSource = (typeof COMMENT_SOURCES)[number];
export const COMMENT_TAGS = ["fix", "keep"] as const;
export type CommentTag = (typeof COMMENT_TAGS)[number];

/**
 * One comment. `path` is the file's path relative to the repo root, as the branch's diff names it; `line` counts from
 * 1 in the branch's new text, `startLine` (with `line`) makes it a span. No `line` is a file-level comment; `review:
 * true` is the whole review's summary, and its `path` is "" (a summary has no file). Structurally a `ReviewComment`
 * of the tui package, which this package never has to import.
 */
export interface StoredComment {
  readonly source: CommentSource;
  readonly tag?: CommentTag;
  readonly path: string;
  readonly line?: number;
  readonly startLine?: number;
  readonly review?: true;
  /** Who wrote it: the reader's name, or the author's. */
  readonly author: string;
  readonly body: string;
}

/** `<work>/.pablo/comments/<branch>.json`, the slash in a branch name made safe for a file name. */
export function commentsPath(projectPath: string, branch: string): string {
  return join(projectPath, ".pablo", "comments", `${branchFileName(branch)}.json`);
}

/** A branch name as a file name: every character outside word characters, dot and dash becomes `__`. Shared with the critic's store. */
export const branchFileName = (branch: string): string => branch.replace(/[^\w.-]/g, "__");

const isLine = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

/** One well-formed entry from untrusted JSON, or undefined. Unknown fields are dropped; a bad optional field is dropped, not the entry. */
function entryOf(raw: unknown): StoredComment | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!oneOf(COMMENT_SOURCES, r.source) || typeof r.body !== "string" || typeof r.author !== "string") return undefined;
  const review = r.review === true;
  // A summary needs no file; every other comment needs one.
  if (!review && (typeof r.path !== "string" || r.path === "")) return undefined;
  const line = isLine(r.line) ? r.line : undefined;
  const startLine = line !== undefined && isLine(r.startLine) && r.startLine <= line ? r.startLine : undefined;
  return {
    source: r.source,
    ...(oneOf(COMMENT_TAGS, r.tag) ? { tag: r.tag } : {}),
    path: review ? "" : (r.path as string),
    ...(!review && line !== undefined ? { line } : {}),
    ...(!review && startLine !== undefined ? { startLine } : {}),
    ...(review ? { review: true as const } : {}),
    author: r.author,
    body: r.body,
  };
}

/** The entries in a store file's text; unparseable text, or text of another shape, is no comments. */
export function parseComments(text: string): StoredComment[] {
  try {
    const parsed = JSON.parse(text) as { comments?: unknown } | null;
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.comments)) return [];
    return parsed.comments.flatMap((c) => entryOf(c) ?? []);
  } catch {
    return [];
  }
}

/** A store file's text for `comments`: normalised the way `parseComments` reads them, so a write reads back identical. */
export function serializeComments(comments: readonly StoredComment[]): string {
  return `${JSON.stringify({ comments: comments.flatMap((c) => entryOf(c) ?? []) }, null, 2)}\n`;
}

/** The branch's comments, in the order stored; none when the file is missing or unreadable. */
export function readComments(projectPath: string, branch: string): StoredComment[] {
  try {
    return parseComments(readFileSync(commentsPath(projectPath, branch), "utf8"));
  } catch {
    return [];
  }
}

/** Replaces the branch's comments with `comments` (an empty list writes an empty store). Atomic: a reader never sees half a file. */
export function writeComments(projectPath: string, branch: string, comments: readonly StoredComment[]): void {
  const path = commentsPath(projectPath, branch);
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, serializeComments(comments));
  renameSync(tmp, path);
}

/** Appends one comment to the branch's store and returns what was stored; an entry that is not well formed is refused (undefined). */
export function addComment(projectPath: string, branch: string, comment: StoredComment): StoredComment | undefined {
  const entry = entryOf(comment);
  if (!entry) return undefined;
  writeComments(projectPath, branch, [...readComments(projectPath, branch), entry]);
  return entry;
}
