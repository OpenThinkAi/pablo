/**
 * Editor host handlers (AGT-1269): save as an author edit, revise
 * passthrough, approve, reject, refresh.
 *
 * Per the design (`~/saltline-digital-vault/projects/ai-terminal/review-tray.md`,
 * "The editor"): the view never touches files or the model — it displays and
 * asks. Judgement (word counts, the tells check, the commit, the queue
 * decision) lives here, in the host. Every side effect — reading/writing the
 * chapter file, committing, calling the model, deciding a piece — is
 * injected, so this module is pure orchestration and fully testable with
 * fakes.
 */

import { randomBytes } from "node:crypto";
import { renameSync, unlinkSync } from "node:fs";
import { basename, dirname, extname } from "node:path";
import { appendEvent, decide } from "./review";
import type { DecideResult, DecisionEvent, PieceRecord } from "./review";
import { parseFrontmatter } from "./novel/machine";
import type { Hit as CheckHit } from "./check";

export type { CheckHit };

/** Thrown by `revise()` on a bad span or a blank instruction — the view displays `code`/`detail`. */
export class EditHostError extends Error {
  readonly code: string;
  readonly detail: string;

  constructor(code: string, detail: string) {
    super(detail);
    this.name = "EditHostError";
    this.code = code;
    this.detail = detail;
  }
}

export interface EditHostDeps {
  /** Absolute path to the chapter file being edited. */
  readonly path: string;
  /** The queue record for this file, when it is a queued piece. Unset for a plain edit of a file that was never written by `pablo write`/`prose`. */
  readonly piece?: PieceRecord;
  /** The review queue's JSONL path. */
  readonly queuePath: string;
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, text: string) => void;
  readonly gitCommit: (dir: string, paths: string[], message: string) => { ok: boolean; detail?: string };
  readonly revise: (input: {
    path: string;
    start: number;
    end: number;
    instruction: string;
  }) => Promise<{ candidate: string; receipt: unknown }>;
  readonly check: (body: string) => CheckHit[];
  readonly countWords: (body: string) => number;
  readonly now: () => Date;
}

export interface EditorData {
  readonly piece: PieceRecord | undefined;
  readonly path: string;
  readonly title: string;
  readonly text: string;
  readonly check: readonly CheckHit[];
  readonly words: number;
}

export interface SaveResult {
  readonly ok: true;
  readonly unchanged?: true;
  readonly words: number;
  readonly check: readonly CheckHit[];
  readonly git: { ok: boolean; detail?: string };
}

export type DecisionResult =
  | { readonly ok: true; readonly event: DecisionEvent }
  | { readonly ok: false; readonly code: "unknown-piece" | "already-decided" | "not-a-piece"; readonly detail: string };

export interface EditHost {
  data(): EditorData;
  save(args: { text: string }): Promise<SaveResult>;
  revise(args: { start: number; end: number; instruction: string }): Promise<{ candidate: string; receipt: unknown }>;
  approve(): Promise<DecisionResult>;
  reject(args: { reason?: string }): Promise<DecisionResult>;
  refresh(): Promise<EditorData>;
}

/**
 * The frontmatter block per the ticket's rule: the text from the opening
 * `---` line through the closing `---` line inclusive, plus the newline
 * after it — only when the file starts with `---\n`. Kept as a plain string
 * slice of `raw` (never re-serialised) so `save` can concatenate it with a
 * new body and reproduce the original bytes exactly when the body is
 * unchanged.
 */
function splitFrontmatter(raw: string): { readonly frontmatter: string; readonly body: string } {
  if (!raw.startsWith("---\n")) {
    return { frontmatter: "", body: raw };
  }

  const closing = raw.indexOf("\n---", 3);
  if (closing === -1) {
    return { frontmatter: "", body: raw };
  }

  // Right after the closing "---" itself.
  let end = closing + "\n---".length;
  // The closing line's own trailing newline, if the file has one.
  if (raw[end] === "\n") end += 1;
  // "plus the newline after it" — one more, if present.
  if (raw[end] === "\n") end += 1;

  return { frontmatter: raw.slice(0, end), body: raw.slice(end) };
}

function titleFor(path: string, raw: string): string {
  const fields = parseFrontmatter(raw);
  const fromFrontmatter = fields.title;
  if (fromFrontmatter !== undefined && fromFrontmatter.trim() !== "") return fromFrontmatter;
  return basename(path, extname(path));
}

function readCurrent(deps: EditHostDeps): { readonly raw: string; readonly frontmatter: string; readonly body: string } {
  const raw = deps.readFile(deps.path);
  const { frontmatter, body } = splitFrontmatter(raw);
  return { raw, frontmatter, body };
}

function buildData(deps: EditHostDeps): EditorData {
  const { raw, body } = readCurrent(deps);
  return {
    piece: deps.piece,
    path: deps.path,
    title: titleFor(deps.path, raw),
    text: body,
    check: deps.check(body),
    words: deps.countWords(body),
  };
}

/**
 * Writes `text` to `path` atomically: `deps.writeFile` lands the bytes at a
 * sibling temp path, then a real filesystem rename swaps it onto `path` in
 * one step. `path` is only ever touched by the rename, so a failure at any
 * point before it — `writeFile` throwing, the temp file never landing — never
 * leaves `path` itself half-written; a failure during the rename itself
 * cleans up the temp file and rethrows.
 */
function atomicWrite(deps: EditHostDeps, text: string): void {
  const tempPath = `${deps.path}.tmp-${randomBytes(6).toString("hex")}`;
  deps.writeFile(tempPath, text);
  try {
    renameSync(tempPath, deps.path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // best-effort cleanup; the rename's own error is the one that matters
    }
    throw error;
  }
}

async function saveEdit(deps: EditHostDeps, text: string): Promise<SaveResult> {
  const { frontmatter, body } = readCurrent(deps);

  if (text === body) {
    return {
      ok: true,
      unchanged: true,
      words: deps.countWords(body),
      check: deps.check(body),
      git: { ok: true },
    };
  }

  atomicWrite(deps, frontmatter + text);

  const git = deps.gitCommit(dirname(deps.path), [deps.path], `author edit: ${basename(deps.path)}`);

  if (deps.piece !== undefined) {
    // `edited` carries no text, per the queue's no-manuscript-text discipline
    // (`review.ts`) — only the word count.
    appendEvent(deps.queuePath, {
      type: "edited",
      id: deps.piece.id,
      at: deps.now().toISOString(),
      words: deps.countWords(text),
    });
  }

  return { ok: true, words: deps.countWords(text), check: deps.check(text), git };
}

async function reviseSpan(
  deps: EditHostDeps,
  start: number,
  end: number,
  instruction: string,
): Promise<{ candidate: string; receipt: unknown }> {
  const { body } = readCurrent(deps);

  const spanOk = Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start < end && end <= body.length;
  if (!spanOk) {
    throw new EditHostError(
      "bad-span",
      `pablo: revise span [${start}, ${end}) does not address ${deps.path} (${body.length} characters)`,
    );
  }

  if (instruction.trim() === "") {
    throw new EditHostError("no-instruction", "pablo: revise requires a non-blank instruction");
  }

  return deps.revise({ path: deps.path, start, end, instruction });
}

async function decideForHost(deps: EditHostDeps, kind: "approved" | "rejected", reason: string | undefined): Promise<DecisionResult> {
  if (deps.piece === undefined) {
    return { ok: false, code: "not-a-piece", detail: `pablo: ${deps.path} is not a queued piece` };
  }

  const result: DecideResult = decide(deps.queuePath, {
    id: deps.piece.id,
    kind,
    by: "editor",
    read: true,
    reason,
    now: deps.now(),
  });

  return result;
}

export function createEditHost(deps: EditHostDeps): EditHost {
  return {
    data(): EditorData {
      return buildData(deps);
    },
    async save({ text }: { text: string }): Promise<SaveResult> {
      return saveEdit(deps, text);
    },
    async revise({ start, end, instruction }: { start: number; end: number; instruction: string }) {
      return reviseSpan(deps, start, end, instruction);
    },
    async approve(): Promise<DecisionResult> {
      return decideForHost(deps, "approved", undefined);
    },
    async reject({ reason }: { reason?: string }): Promise<DecisionResult> {
      return decideForHost(deps, "rejected", reason);
    },
    async refresh(): Promise<EditorData> {
      return buildData(deps);
    },
  };
}
