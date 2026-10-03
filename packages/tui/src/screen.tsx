// Mounts the app in the terminal's alternate screen and restores the terminal on the way out, however it ends.

import { render } from "ink";
import type { LineRef } from "@openthink/pablo-core";
import { App } from "./app";
import { bookRail, type BookStage } from "./book";
import { loadEditor, loadKeymap } from "./key-config";
import type { Composer } from "./compose";
import type { Reviser } from "./revise";
import { KeysError } from "./keys";
import type { BranchDiff, ReviewComment } from "./review";
import type { CheckHit } from "./hits";
import { loadDocument } from "./source";

const ENTER_ALT = "\x1b[?1049h\x1b[H";
const LEAVE_ALT = "\x1b[?1049l";

/** What a write came to: the branch it made and the receipt lines, or the refusal and the reasons it names. */
export type WriteResult =
  | { readonly ok: true; readonly branch: string; readonly lines: readonly string[] }
  | { readonly ok: false; readonly message: string; readonly missing: readonly string[] };
export type Writer = (chapter: number, progress: (line: string) => void) => Promise<WriteResult>;

/** What `a v` came to: lines saying where the sentences were written, or why they were not. */
export type VoiceResult = { readonly ok: true; readonly lines: readonly string[] } | { readonly ok: false; readonly message: string };
export type Voicer = (kind: "flag" | "exemplar", sentences: readonly string[]) => Promise<VoiceResult>;

/** What a review's rejected edits come to as lines: removed ones by old line number, added ones by new (the stitcher's `removedLines` / `addedLines`). */
export interface Rejected { readonly removed: readonly LineRef[]; readonly added: readonly LineRef[] }
/** What finishing a review came to: lines for the content area (the merge and each after-write step), or why it did not finish. */
export type FinishResult = { readonly ok: true; readonly lines: readonly string[] } | { readonly ok: false; readonly message: string };
export type Finisher = (branch: string, rejected: Rejected) => Promise<FinishResult>;

/** What saving the author's own comment (`c` in a review) came to; the layer above writes it to the comment store (AGT-1581). */
export type CommentResult = { readonly ok: true } | { readonly ok: false; readonly message: string };
export type CommentSaver = (branch: string, comment: ReviewComment) => CommentResult;

/** What `v e` hands the editor session: a project-relative file, the line to open it at, and the editor command the settings name ("" for none). */
export interface EditRequest {
  readonly file: string;
  readonly line: number;
  readonly editor: string;
  /** Set by `e` in a review (AGT-1591): the review branch to edit in its own worktree, with `file` repo-relative as the branch's diff names it. Unset for `v e`, whose `file` is project-relative on the work's `edit/` branch. */
  readonly branch?: string;
}
/** What the editor session came to: the `edit/` branch the change is on (null when nothing changed) with lines for the content area, or why it could not run. */
export type EditResult = { readonly ok: true; readonly branch: string | null; readonly lines: readonly string[] } | { readonly ok: false; readonly message: string };
export type EditSession = (request: EditRequest) => Promise<EditResult>;

export interface ScreenOptions {
  readonly title: string;
  readonly format: string;
  /** The novel stage machine's stages: the book mode rail (AGT-1526). */
  readonly stages?: readonly BookStage[];
  /** The project directory; the main pane reads the selected stage's file from it. */
  readonly dir?: string;
  /** Branches waiting for review: book mode lists them, Enter opens one (AGT-1538). */
  readonly branches?: readonly string[];
  /** A branch's changes against `main` as git's diff, for review mode. */
  readonly diffOf?: (branch: string) => BranchDiff;
  /** Scans a chapter's raw text for `check` hits (pablo-cli's checkFile, with the vault's rules): each shows as a box under its line. */
  readonly checks?: (file: string, text: string) => readonly CheckHit[];
  /** `a w`: writes a chapter (the CLI's `runWrite`, passed in from cli.ts) and says what came of it (AGT-1542). */
  readonly writer?: Writer;
  /** `a r`: revises the selected sentences and commits the taken candidate on a `revise/` branch (the CLI's `screenReviser`, passed in; AGT-1544). */
  readonly reviser?: Reviser;
  /** `a v`: flags the selected sentences in the voice, or keeps them as an exemplar (the CLI's `screenVoicer`, passed in from cli.ts; AGT-1547). */
  readonly voicer?: Voicer;
  /** The harness session behind the compose view; the cli builds it (the tui does not depend on the Agent SDK). */
  readonly composer?: Composer;
  /** `s` in a review: merges the accepted changes into `main`, runs the after-write steps and deletes the branch (the CLI's `screenFinisher`, passed in; AGT-1540). */
  readonly finisher?: Finisher;
  /** `c` in a review: saves the author's own comment on a change into the branch's comment store (the CLI's `screenCommenter`, passed in; AGT-1581). */
  readonly commentSaver?: CommentSaver;
  /** The critic's saved comments on a branch, shown under the edits they are on (AGT-1564). */
  readonly commentsOf?: (branch: string) => readonly ReviewComment[];
  /** `v e`: opens the editor on a file at a line on the work's `edit/` branch and commits what it left as the author (the CLI's `screenEditor`, passed in; AGT-1545). The screen gives up the terminal while it runs. */
  readonly editSession?: EditSession;
  readonly stdout?: NodeJS.WriteStream;
  readonly stdin?: NodeJS.ReadStream;
}

/** Runs the screen until the author quits; resolves with the process exit code. */
export async function runScreen(options: ScreenOptions): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  // A bad or conflicting binding in the config is refused before the screen opens, with the reason on stderr.
  let keymap;
  try {
    keymap = loadKeymap();
  } catch (error) {
    if (!(error instanceof KeysError)) throw error;
    process.stderr.write(`pablo: ${error.message}\n`);
    return 1;
  }
  const book = bookRail(options.stages ?? []);
  const drafted = (options.stages ?? []).filter((s) => s.status === "drafted").length;
  const total = (options.stages ?? []).filter((s) => s.depth > 0).length;
  stdout.write(ENTER_ALT);
  try {
    const root = options.dir;
    const load = root === undefined ? undefined : (id: string) => loadDocument(root, id);
    // The editor takes the whole terminal: the alternate screen is left while it runs and entered again after.
    const editSession: EditSession | undefined = options.editSession && (async (request) => {
      stdout.write(LEAVE_ALT);
      try {
        return await options.editSession!(request);
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      } finally {
        stdout.write(ENTER_ALT);
      }
    });
    const app = render(<App title={options.title} format={options.format} drafted={drafted} total={total} book={book} keymap={keymap} branches={options.branches} diffOf={options.diffOf} commentSaver={options.commentSaver} commentsOf={options.commentsOf} editor={loadEditor()} load={load} checks={options.checks} writer={options.writer} reviser={options.reviser} finisher={options.finisher} voicer={options.voicer} {...(editSession ? { editSession } : {})} {...(options.composer ? { composer: options.composer } : {})} />, {
      exitOnCtrlC: true,
      stdout,
      ...(options.stdin ? { stdin: options.stdin } : {}),
    });
    await app.waitUntilExit();
    app.clear();
  } finally {
    options.composer?.close?.();
    stdout.write(LEAVE_ALT);
  }
  return 0;
}
