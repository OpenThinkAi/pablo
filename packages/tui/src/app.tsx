// The screen's root: prview's three-part layout (layout.ts), drawn from the state. A status area on top (status.ts),
// the rail and the main pane in the middle, the content area beside the key panel at the bottom, a footer under it.
// Book mode (AGT-1526+) fills the rail and the main pane through the props below; the too-small notice lives here. The layout's geometry is pure (layout.ts); after each size or content change this component
// tells the model how many rows each region shows (`measured`) and the model keeps every cursor in view.
//
// Everything the screen knows about where the author is lives in state.ts and changes only through `dispatch`: this
// component reads that state and draws it, and holds no state of its own (packages/tui/test/boundary.test.ts holds it
// to that). Every key is resolved through the key rows (keys.ts, chord.ts) into the model's actions, or into a command
// for the layer above; `q` is the app's own command and quits.

import { useEffect, useMemo, useReducer } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { configPath } from "@openthink/pablo-core";
import { tooSmall, useTerminalSize, MIN_COLS, MIN_ROWS } from "./resize";
import type { Size } from "./resize";
import { resolve, tokenOf } from "./chord";
import { bookCounts, bookRail, missingContent, waitingDoc, type BookRail } from "./book";
import { KeyPanel } from "./key-panel";
import { DEFAULT_KEYMAP, effectiveKeys, keyStateOf, voiceChoiceOf, voiceChoicesFor, VOICE_CHOICES, VOICE_TARGETS, type Command, type Keymap } from "./keys";
import { layoutOf, measureOf, wrapText, type Layout } from "./layout";
import { fileLineAt, type MainDoc } from "./document";
import { hitAt, hitDetail, mainPane, nextHitRow, textRows, type CheckHit, type MainRow } from "./hits";
import { piecesOf, selectedOf, type Selected } from "./selection";
import { reviseAction, type Reviser } from "./revise";
import { clean } from "./sanitize";
import { openSettings, settingsPaste, settingsStep } from "./settings";
import { SettingsScreen } from "./settings-view";
import { fitFields, statusFields, GAP, type CommentKind } from "./status";
import { branchRows, editTarget, loadReview, reviewLines, type BranchDiff, type DiffRow, type Note, type ReviewComment } from "./review";
import type { CommentSaver, EditSession, Finisher, Puller, Refresher, Rejected, RoundsPoller } from "./screen";
import { roundDoc, roundOf, roundRows, reviewsIn } from "./reviews";
import { commentAction, isSubmit } from "./comment-input";
import { voiceRuleAction } from "./voice-input";
import type { Voicer, Writer } from "./screen";
import { activityNow, composeAction, composeLayout, composeMeasure, type Composer } from "./compose";
import { ComposeView } from "./compose-view";
import { initialState, pendingText, placeOf, railRow, reduce, reviewCounts, selectedRange, shownRows, viewOf, type LineSpan, type Mark, type RailRow, type Revise, type Round, type State } from "./state";

export interface AppProps {
  /** The project's marker fields the status area shows. */
  readonly title: string;
  readonly format: string;
  /** Chapters drafted of the book's total, the git branch and the comment counts by kind (status area). */
  readonly drafted?: number;
  readonly total?: number;
  readonly branch?: string;
  readonly comments?: Partial<Record<CommentKind, number>>;
  /** The rail's rows and their labels (an id with no label shows as itself). */
  readonly rows?: readonly RailRow[];
  readonly labels?: Readonly<Record<string, string>>;
  /** Book mode's stages laid out (book.ts): rows, labels and the missing reasons; overrides `rows`/`labels` when given. */
  readonly book?: BookRail;
  /** The document behind a rail row id (document.ts), shown in the main pane for the row under the rail's cursor. */
  readonly load?: (id: string) => MainDoc | undefined;
  /** Scans a document's raw text for `check` hits, shown as boxes under their lines; run when a chapter (a doc with a `file`) is opened. */
  readonly checks?: (file: string, text: string) => readonly CheckHit[];
  /** The main pane's heading and its document when no row names one (no `load`, or it has nothing for the row). */
  readonly mainTitle?: string;
  readonly lines?: readonly string[];
  /** Branches waiting for review (draft/, revise/, edit/, reader/): book mode lists them; Enter opens one as a review. */
  readonly branches?: readonly string[];
  /** A branch's changes against `main` as git's diff, for review mode. */
  readonly diffOf?: (branch: string) => BranchDiff;
  /** `a w`: writes a chapter and says what came of it (the CLI's `runWrite`, passed in; this package cannot import it). */
  readonly writer?: Writer;
  /** `a r`: revises the selected sentences and commits the taken candidate on a `revise/` branch (the CLI's `screenReviser`, passed in). */
  readonly reviser?: Reviser;
  /** `a v`: writes the selected sentences into the voice as a flagged line or an exemplar (the CLI's `screenVoicer`, passed in). */
  readonly voicer?: Voicer;
  /** `s` in a review: merges the accepted changes and runs the after-write steps (the CLI's `screenFinisher`, passed in). */
  readonly finisher?: Finisher;
  /** `c` in a review: saves the author's own comment into the branch's comment store (the CLI's `screenCommenter`, passed in). */
  readonly commentSaver?: CommentSaver;
  /** A file's text on a branch (repo-relative path), for the lines around a comment on text the branch did not change. */
  readonly fileOf?: (branch: string, path: string) => string | undefined;
  /** The critic's comments on a branch (the `critique` tool's survivors): review mode shows each under the edit it is on. */
  readonly commentsOf?: (branch: string) => readonly ReviewComment[];
  /** `v e`: opens the editor on the cursor's file and line on an `edit/` branch (the CLI's `screenEditor`, passed in). */
  readonly editSession?: EditSession;
  /** The key rows with the author's overrides laid over them; the defaults when absent. */
  readonly keymap?: Keymap;
  /** The editor command the config sets ("" for none); what the settings screen opens with. */
  readonly editor?: string;
  /** The config file the settings screen saves to. Tests pass a temporary one. */
  readonly configFile?: string;
  /** The harness session the compose view talks to (`a c`); absent, the view opens and says there is none. */
  readonly composer?: Composer;
  /** A command a key caused (`ai.plan`, ...); `quit` and `settings` are handled here and never reach it. */
  readonly onCommand?: (command: Command, selected?: Selected) => void;
  /** Reads the book's stages and waiting branches again, every `refreshMs`: what changed outside the screen shows in the rail (AGT-1640). */
  readonly refresh?: Refresher;
  /** Polls for the work's reading rounds on open and every `roundsMs`: the Reviews group (AGT-1640). */
  readonly rounds?: RoundsPoller;
  /** Enter on a submitted round: pulls its review into a `reader/` branch, then the review opens (AGT-1641). */
  readonly puller?: Puller;
  /** How often the book is read again and the rounds polled; tests pass short ones. */
  readonly refreshMs?: number;
  readonly roundsMs?: number;
  /** Tests pass a fixed size; the real screen measures the terminal. */
  readonly size?: Size;
}

/** The book is read again every few seconds; GitHub is asked about the rounds once a minute (AGT-1640). */
const REFRESH_MS = 3000;
const ROUNDS_MS = 60_000;

const NO_ROWS: readonly RailRow[] = [];
const NO_LINES: readonly string[] = [];
const NO_LABELS: Readonly<Record<string, string>> = {};
const NO_BRANCHES: readonly string[] = [];
const NO_HITS: readonly CheckHit[] = [];
const NO_SENTENCES: readonly LineSpan[] = [];

const fit = (text: string, width: number) => [...clean(text)].slice(0, Math.max(0, width)).join("");

export function App({ title, format, drafted: givenDrafted = 0, total: givenTotal = 0, branch = "main", comments = {}, book: givenBook, rows: givenRows, labels: givenLabels, branches: givenBranches = NO_BRANCHES, diffOf, fileOf, commentsOf, commentSaver, mainTitle = "", lines = NO_LINES, size: override, keymap: given = DEFAULT_KEYMAP, editor: givenEditor = "", configFile, onCommand, load, checks, writer, reviser, voicer, finisher, editSession, composer, refresh, rounds, puller, refreshMs = REFRESH_MS, roundsMs = ROUNDS_MS }: AppProps) {
  const { exit } = useApp();
  const size = useTerminalSize(override);
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  // The book as last read (AGT-1640): each tick reads it again, and a write, a finish or a pull reads it at once. The
  // rail only reloads when what was read differs, so an unchanged book costs a read and nothing more.
  const snap = useMemo(() => refresh?.(), [refresh, state.tick, state.finished.length, state.written.length]);
  const snapKey = snap ? JSON.stringify(snap) : "";
  const book = useMemo(() => (snap ? bookRail(snap.stages) : givenBook), [snapKey, givenBook]);
  const bookRows = (snap ? undefined : givenRows) ?? book?.rows ?? NO_ROWS;
  const bookLabels = (snap ? undefined : givenLabels) ?? book?.labels ?? NO_LABELS;
  const branches = useMemo(() => (snap ? snap.branches : givenBranches), [snapKey, givenBranches]);
  const { drafted, total } = snap ? bookCounts(snap.stages) : { drafted: givenDrafted, total: givenTotal };
  useEffect(() => {
    if (!refresh) return;
    const timer = setInterval(() => dispatch({ type: "tick" }), refreshMs);
    return () => clearInterval(timer);
  }, [refresh, refreshMs]);
  // The reading rounds, on open and every `roundsMs`: a poll that fails says why in the footer and the next one tries again.
  useEffect(() => {
    if (!rounds) return;
    let live = true;
    const poll = () => rounds().then(
      (r) => { if (live) dispatch(r.ok ? { type: "rounds.loaded", rounds: r.rounds, ...(r.note !== undefined ? { note: r.note } : {}) } : { type: "rounds.failed", message: r.message }); },
      (e: unknown) => { if (live) dispatch({ type: "rounds.failed", message: e instanceof Error ? e.message : String(e) }); },
    );
    void poll();
    const timer = setInterval(() => void poll(), roundsMs);
    return () => { live = false; clearInterval(timer); };
  }, [rounds, roundsMs]);
  // A save puts the new bindings in force at once; until one, the keymap and editor the screen opened with.
  const keymap = state.saved ? effectiveKeys(state.saved.overrides) : given;
  const editor = state.saved ? state.saved.editor : givenEditor;
  const layout = layoutOf(size.cols, size.rows, { zen: state.zen, full: state.full });
  // While the editor has the terminal, this screen reads no keys: the editor's go to the editor.
  useInput((input, key) => {
    // In the compose view keys are text; only the arrows, Enter and Esc mean anything else.
    if (state.mode.kind === "compose") {
      const action = composeAction(input, key, state.compose.pick !== null);
      if (action) dispatch(action);
      return;
    }
    // While a comment is open its keys are text: the one line, then Enter saves it and Esc cancels.
    if (state.commenting) {
      if (isSubmit(input, key)) return saveComment();
      const action = commentAction(input, key);
      if (action) dispatch(action);
      return;
    }
    // While a voice rule is open (`a v r`) its keys are text: the one line, Tab changes the target, Enter writes it.
    if (state.voiceRule) {
      if (isSubmit(input, key)) return startVoice("rule");
      const action = voiceRuleAction(input, key);
      if (action) dispatch(action);
      return;
    }
    // While a revise is open its keys are text: the instruction, then the candidate.
    if (state.revise) {
      const action = reviseAction(state.revise, input, key);
      if (action) {
        dispatch(action);
        if (action.type === "revise.run") startRevise(state.revise);
        else if (action.type === "revise.take") startTake(state.revise);
      }
      return;
    }
    const token = tokenOf(input, key);
    if (state.mode.kind === "settings" && state.settings) {
      // The settings screen takes every key itself (a binding being captured must not also act); Esc asks to save.
      if (!token) { if (input && !input.includes("\x1b")) dispatch({ type: "settings.set", settings: settingsPaste(state.settings, input) }); return; }
      const step = settingsStep(state.settings, token);
      dispatch("close" in step ? { type: "settings.close", ...(step.close ? { saved: step.close } : {}) } : { type: "settings.set", settings: step.s });
      return;
    }
    if (!token) return;
    // With the voice offer up (`a v`) its choices (keys.ts `VOICE_CHOICES`: f flags, e keeps, r types a rule) are the
    // keys; every other key goes its way and Esc withdraws the offer. A choice that needs a selection is not one without.
    if (state.voice !== null && state.content?.kind === "voice") {
      const choice = voiceChoiceOf(token, state.voice.length);
      if (choice?.kind === "rule") return void dispatch({ type: "voice.rule", targets: VOICE_TARGETS });
      if (choice) return startVoice(choice.kind);
      if (VOICE_CHOICES.some((c) => c.key === token)) return; // a choice that needs a selection, with none: nothing happens (f is not the filter prefix here)
    }
    for (const action of resolve(keyStateOf(state), state.pending, token, keymap)) {
      // Enter on a reading round (AGT-1641) is the screen's: a review that is in is pulled, then opened.
      const round = action.type === "rail.open" && state.mode.kind === "book" ? roundOf(state.rounds, railRow(viewOf(state).rail)?.id) : undefined;
      // `y` on a reader's comment (AGT-1642) is accept and revise: the author says what Gemma should do about it.
      const row = railRow(viewOf(state).rail);
      const note = row && action.type === "review.mark" && action.mark === "accepted" && state.mode.kind === "review" ? review?.notes.get(row.id) : undefined;
      if (round) openRound(round);
      else if (row && note && note.comment.tag !== "keep" && state.marks[row.id] !== "accepted") openNoteRevise(row.id, note);
      else if (action.type !== "command") dispatch(action);
      else if (action.id === "quit") exit();
      else if (action.id === "settings") dispatch({ type: "settings.open", settings: openSettings(keymap, editor, configFile ?? configPath()) });
      else if (action.id === "check.open") openHit();
      else if (action.id === "check.next" || action.id === "check.prev") {
        const to = nextHitRow(paneRows, viewOf(state).main.cursor, action.id === "check.next" ? 1 : -1);
        // The box's last row first, so the pane scrolls far enough to show the whole box, then its first row.
        if (to !== undefined) { dispatch({ type: "main.goto", line: to + 3 }); dispatch({ type: "main.goto", line: to + 1 }); }
      }
      else if (action.id === "ai.write") startWrite();
      else if (action.id === "ai.revise") openRevise(selectedOf(viewOf(state).main, pane.sentences));
      else if (action.id === "ai.voice") { const sentences = selectedOf(viewOf(state).main, pane.sentences)?.sentences ?? []; dispatch({ type: "voice.offer", sentences, choices: voiceChoicesFor(sentences.length) }); }
      else if (action.id === "review.finish") startFinish();
      else if (action.id === "review.comment") openComment();
      else if (action.id === "view.editor") startEdit();
      else if (action.id === "review.edit") startReviewEdit();
      else if (action.id === "view.save") startSave();
      else onCommand?.(action, selectedOf(viewOf(state).main, pane.sentences) ?? undefined);
    }
  }, { isActive: state.editing === null });

  // `v e`: the file behind the main pane, at the line under the cursor. The session runs from the effect below, once the
  // screen has stopped reading keys.
  function startEdit() {
    if (state.editing !== null || state.finishing !== null) return;
    const file = doc?.editable;
    if (!editSession) return void dispatch({ type: "edit.failed", message: "Editing is not available here." });
    if (state.mode.kind !== "book" || !doc || file === undefined) return void dispatch({ type: "edit.failed", message: state.mode.kind !== "book" ? "Edit from the book, not a review." : "Select a chapter or file to edit." });
    dispatch({ type: "edit.start", file, line: fileLineAt(doc.text, layout.mainInner, paneRows, viewOf(state).main.cursor) });
  }

  // `e` in a review (AGT-1591): the editor opens on the change under the cursor, in the review branch's own worktree. What
  // it leaves is committed on that branch as the author, and the review reads the branch's diff again. Refused, with the
  // reason shown, while a write, a revise, a finish or another edit is running.
  function startReviewEdit() {
    if (state.mode.kind !== "review") return;
    const refuse = (message: string) => void dispatch({ type: "edit.refused", message });
    if (state.editing !== null) return refuse("An edit is already open.");
    if (state.finishing !== null) return refuse("A finish is running; edit when it is done.");
    if (state.writing !== null) return refuse(`Chapter ${state.writing} is being written; edit when it is done.`);
    if (state.revise !== null) return refuse("A revise is open; finish or cancel it first.");
    if (!editSession) return refuse("Editing is not available here.");
    const row = railRow(state.review.rail);
    const target = review && row ? editTarget(review, row.id) : undefined;
    if (!target) return refuse("Select a change to edit.");
    dispatch({ type: "edit.start", file: target.file, line: target.line, branch: reviewBranch ?? state.mode.branch });
  }

  // `v s`: the open edit branch merges into `main` through the same finisher a review's `s` uses, with nothing rejected.
  function startSave() {
    if (state.mode.kind !== "book" || state.finishing !== null || state.editing !== null) return;
    const open = state.editBranch;
    if (open === null) return void dispatch({ type: "save.failed", message: "There are no edits to save." });
    if (!finisher) return void dispatch({ type: "save.failed", message: "Saving is not available here." });
    dispatch({ type: "save.start", branch: open });
    finisher(open, { removed: [], added: [] }).then(
      (r) => dispatch(r.ok ? { type: "save.done", branch: open, lines: r.lines } : { type: "save.failed", message: r.message }),
      (e: unknown) => dispatch({ type: "save.failed", message: e instanceof Error ? e.message : String(e) }),
    );
  }

  // Enter on a round row: a round still with its reader only says so; one with a review in is pulled into its
  // `reader/` branch, and the review opens on it. One pull at a time, and not while a finish or an edit runs.
  function openRound(round: Round) {
    const show = (body: string) => dispatch({ type: "content.show", content: { title: `Review · ${round.reader}`, body, kind: "write" } });
    if (round.status !== "submitted") return show(`${round.reader} has not sent their review yet. This row changes when it comes in.`);
    if (state.pulling !== null) return show(`${state.pulling} is still being pulled.`);
    if (state.finishing !== null || state.editing !== null) return show("Finish what is running first, then pull the review.");
    if (!puller) return show("Pulling reviews is not available here.");
    dispatch({ type: "pull.start", id: round.id });
    puller(round.id).then(
      (r) => dispatch(r.ok ? { type: "pull.done", id: round.id, branch: r.branch, lines: r.lines } : { type: "pull.failed", message: r.message }),
      (e: unknown) => dispatch({ type: "pull.failed", message: e instanceof Error ? e.message : String(e) }),
    );
  }

  // `a w` on a chapter row: the writer runs in the background, its progress lines and its end arrive as actions.
  function startWrite() {
    const id = railRow(viewOf(state).rail)?.id ?? "";
    const chapter = /^chapter:(\d+)$/.exec(id)?.[1];
    if (state.writing !== null) return void dispatch({ type: "write.progress", line: `chapter ${state.writing} is still being written` });
    if (chapter === undefined) return void dispatch({ type: "write.failed", message: "Select a chapter to write.", missing: [] });
    if (!writer) return void dispatch({ type: "write.failed", message: "Writing is not available here.", missing: [] });
    dispatch({ type: "write.start", chapter: Number(chapter) });
    writer(Number(chapter), (line) => dispatch({ type: "write.progress", line })).then(
      (r) => dispatch(r.ok ? { type: "write.done", branch: r.branch, lines: r.lines } : { type: "write.failed", message: r.message, missing: r.missing }),
      (e: unknown) => dispatch({ type: "write.failed", message: e instanceof Error ? e.message : String(e), missing: [] }),
    );
  }

  // `a r` on selected sentences: asks for the instruction in the content area; Enter runs it, the candidate streams in.
  function openRevise(selected: Selected | null) {
    const none = (body: string) => dispatch({ type: "content.show", content: { title: "Revise", body, kind: "revise" } });
    if (state.mode.kind !== "book" || state.revise !== null || state.writing !== null || state.editing !== null || state.finishing !== null) return;
    if (!reviser) return none("Revising is not available here.");
    if (!doc?.file) return none("Open a chapter and select sentences first (Shift+Down in the main pane).");
    if (!selected) return none("Select the sentences to revise first: Shift+Down / Shift+Up in the main pane.");
    dispatch({ type: "revise.open", file: doc.file, sentences: selected.sentences, stored: selected.stored });
  }
  // `y` on a reader's comment in a review: a revise of the commented line(s) on the review branch, with the comment as
  // the reader's note. A comment on blank lines has no sentence to revise; it is marked as is.
  function openNoteRevise(id: string, note: Note) {
    const branch = reviewBranch ?? (state.mode.kind === "review" ? state.mode.branch : undefined);
    const sentences = note.quoted.map((l) => l.trim()).filter((l) => l !== "");
    if (branch === undefined || sentences.length === 0) return void dispatch({ type: "review.mark", mark: "accepted" });
    if (!reviser) return void dispatch({ type: "content.show", content: { title: "Revise", body: "Revising is not available here.", kind: "revise" } });
    dispatch({ type: "revise.open", file: note.path, sentences, stored: note.stored, branch, reader: { reader: note.comment.author || "A reader", quoted: sentences.join(" "), comment: note.comment.body }, answers: id });
  }
  const requestOf = (r: Revise) => ({ file: r.file, sentences: r.sentences, stored: r.stored, instruction: r.instruction, ...(r.branch !== undefined ? { branch: r.branch } : {}), ...(r.reader ? { note: r.reader } : {}) });
  function startRevise(r: Revise) {
    if (r.phase !== "ask" || r.instruction.trim() === "" || !reviser) return;
    reviser.revise(requestOf(r), (text) => dispatch({ type: "revise.partial", id: r.id, text })).then(
      (res) => dispatch(res.ok ? { type: "revise.done", id: r.id, candidate: res.candidate, receipt: res.receipt, model: res.model } : { type: "revise.failed", id: r.id, message: res.message }),
      (e: unknown) => dispatch({ type: "revise.failed", id: r.id, message: e instanceof Error ? e.message : String(e) }),
    );
  }
  function startTake(r: Revise) {
    if (r.phase !== "edit" || r.candidate.trim() === "" || !reviser) return;
    reviser.take({ ...requestOf(r), candidate: r.candidate, offered: r.offered, receipt: r.receipt, model: r.model }).then(
      (res) => dispatch(res.ok ? { type: "revise.taken", id: r.id, branch: res.branch, lines: res.lines } : { type: "revise.failed", id: r.id, message: res.message }),
      (e: unknown) => dispatch({ type: "revise.failed", id: r.id, message: e instanceof Error ? e.message : String(e) }),
    );
  }

  // `f` / `e` on the voice offer, or Enter on a typed rule: the voicer writes it and says where.
  function startVoice(kind: "flag" | "exemplar" | "rule") {
    const rule = state.voiceRule;
    if (kind === "rule" && (rule === null || rule.text.trim() === "")) return;
    const sentences = kind === "rule" ? rule!.sentences : state.voice ?? [];
    if (!voicer) return void dispatch({ type: "voice.failed", message: "The voice is not available here." });
    dispatch({ type: "voice.start", kind });
    voicer(kind, sentences, kind === "rule" ? { text: rule!.text.trim(), target: VOICE_TARGETS[rule!.at]?.id ?? "voice" } : undefined).then(
      (r) => dispatch(r.ok ? { type: "voice.done", lines: r.lines } : { type: "voice.failed", message: r.message }),
      (e: unknown) => dispatch({ type: "voice.failed", message: e instanceof Error ? e.message : String(e) }),
    );
  }

  // `c` in a review: the comment goes on the first line of the change under the rail's cursor (a file's group row, or
  // no change at all, has none to put it on).
  function openComment() {
    if (state.mode.kind !== "review" || state.commenting !== null || state.finishing !== null) return;
    const id = railRow(viewOf(state).rail)?.id ?? "";
    // On a change, the comment goes on its first line; on a reader's comment (a note), beside it: a reply on the same line.
    const at = review?.edits.get(id) ?? review?.notes.get(id);
    if (!commentSaver) return void dispatch({ type: "content.show", content: { title: "Comment", body: "Commenting is not available here.", kind: "comment" } });
    if (!at) return void dispatch({ type: "content.show", content: { title: "Comment", body: "Move the cursor to a change or a comment first: yours goes on its line.", kind: "comment" } });
    dispatch({ type: "comment.open", path: at.path, line: at.line });
  }

  // Enter on the typed comment: the saver writes it to the store and the review reads the store again, so the box
  // is in the pane at once. An empty line saves nothing.
  function saveComment() {
    const c = state.commenting;
    if (!c || !commentSaver || c.text.trim() === "") return;
    try {
      const r = commentSaver(c.branch, { source: "author", path: c.path, line: c.line, author: "", body: c.text.trim() });
      dispatch(r.ok ? { type: "comment.saved" } : { type: "comment.failed", message: r.message });
    } catch (e) {
      dispatch({ type: "comment.failed", message: e instanceof Error ? e.message : String(e) });
    }
  }

  // `s` in a review: every change needs a decision first (an undecided change is neither accepted nor rejected, so it
  // is not merged on a guess); the rejected edits go to the finisher as the lines they own.
  function startFinish() {
    if (state.mode.kind !== "review" || state.finishing !== null) return;
    const open = reviewBranch ?? state.mode.branch;
    const counts = reviewCounts(state);
    if (!finisher) return void dispatch({ type: "finish.failed", message: "Finishing is not available here." });
    // A review of comments only (a reader who suggested nothing) finishes too: with no reply of the author's the branch
    // is discarded, with one it merges empty so the notes are kept (review-finish.ts).
    if (!review || (review.edits.size === 0 && review.notes.size === 0)) return void dispatch({ type: "finish.failed", message: "There are no changes to finish." });
    if (counts.pending > 0) return void dispatch({ type: "finish.failed", message: `${counts.pending} change${counts.pending === 1 ? " has" : "s have"} no decision yet: y accepts, n rejects.` });
    const rejected: Rejected = {
      removed: [...review.edits.values()].filter((e) => state.marks[e.id] === "rejected").flatMap((e) => e.removedLines),
      added: [...review.edits.values()].filter((e) => state.marks[e.id] === "rejected").flatMap((e) => e.addedLines),
    };
    dispatch({ type: "finish.start", branch: open });
    finisher(open, rejected).then(
      (r) => dispatch(r.ok ? { type: "finish.done", branch: open, lines: r.lines } : { type: "finish.failed", message: r.message }),
      (e: unknown) => dispatch({ type: "finish.failed", message: e instanceof Error ? e.message : String(e) }),
    );
  }

  const contentBody = state.content ? clean(state.content.body) : null;
  // Book mode's rows (the stages, then the branches waiting for review), or in a review the branch's changes.
  const place = placeOf(state);
  const reviewBranch = place.kind === "review" ? place.branch : undefined;
  const waiting = useMemo(() => [...branches, ...state.written.filter((b) => !branches.includes(b))].filter((b) => !state.finished.includes(b)), [branches, state.written, state.finished]);
  const extra = useMemo(() => {
    const reviews = roundRows(state.rounds);
    const waitingRows = branchRows(waiting);
    return { rows: [...reviews.rows, ...waitingRows.rows], labels: { ...reviews.labels, ...waitingRows.labels } };
  }, [waiting, state.rounds]);
  const review = useMemo(() => (reviewBranch === undefined ? undefined : loadReview(diffOf?.(reviewBranch), commentsOf?.(reviewBranch), fileOf ? (path) => fileOf(reviewBranch, path) : undefined)), [reviewBranch, diffOf, fileOf, commentsOf, state.reviewGen, state.commentSeq]);
  const bookAll = useMemo(() => [...bookRows, ...extra.rows], [bookRows, extra]);
  const rows = review ? review.rows : bookAll;
  const labels = useMemo(() => (review ? review.labels : { ...bookLabels, ...extra.labels }), [review, bookLabels, extra]);
  // What was loaded and what the layout measured reach the model as actions; neither is state of this component.
  useEffect(() => { dispatch({ type: "rail.loaded", rows, ...(book && !review ? { folded: book.folded } : {}) }); }, [rows]);
  // A stage that is not ready says why in the content area while the cursor is on it, and takes it down when it leaves.
  const stageId = state.mode.kind === "book" ? viewOf(state).rail.rows[viewOf(state).rail.cursor]?.id : undefined;
  const reasons = stageId === undefined ? undefined : book?.missing[stageId];
  useEffect(() => {
    if (reasons) dispatch({ type: "content.show", content: missingContent(labels[stageId!]?.replace(/^\S+ /, "") ?? stageId!, reasons) });
    else if (state.content?.kind === "missing") dispatch({ type: "content.close" });
  }, [stageId, reasons]);
  // The main pane shows the file behind the rail's row, wrapped to its width; a different row starts at the top. A
  // chapter is scanned for `check` hits as it opens, and each hit is a box under its line. In a review the pane shows
  // the change under the cursor instead: its removed and added sentences.
  const rowId = railRow(viewOf(state).rail)?.id;
  // A chapter whose draft is waiting on a branch says so, and how to open it, instead of the missing-file notice.
  const waitingBranch = rowId === undefined || review ? undefined : book?.waiting[rowId];
  // A round row (AGT-1640) says where the round stands and what Enter does.
  const round = review ? undefined : roundOf(state.rounds, rowId);
  const doc = useMemo(() => (round ? roundDoc(round) : waitingBranch !== undefined && rowId !== undefined ? waitingDoc(rowId, waitingBranch) : rowId !== undefined && !review ? load?.(rowId) : undefined), [rowId, load, review, state.finished, waitingBranch, round, snapKey]);
  const hits = useMemo(() => (doc?.file !== undefined && checks ? checks(doc.file, doc.text) : NO_HITS), [doc, checks]);
  const shownTitle = doc ? doc.title : mainTitle;
  // A document's sentences are selectable (their spans are in these rows); lines handed in as plain text are not.
  const pane = useMemo(() => (doc ? mainPane(doc.text, layout.mainInner, hits) : { rows: textRows(lines), sentences: [] }), [doc, hits, lines, layout.mainInner]);
  const paneRows: readonly MainRow[] = pane.rows;
  const changes = useMemo(() => (review ? reviewLines(review, rowId, layout.mainInner - 2) : undefined), [review, rowId, layout.mainInner]);
  const mainLength = changes ? changes.rows.length : paneRows.length;
  // `→` on a hit (its box, or the line above it) opens its rule and flagged pattern in the content area.
  const openHit = () => {
    const at = hitAt(paneRows, viewOf(state).main.cursor);
    if (at !== undefined) dispatch({ type: "content.show", content: { ...hitDetail(hits[at]!), kind: "check" } });
  };
  // A hit's detail belongs to the document it was opened in: opening another takes it down.
  useEffect(() => { if (state.content?.kind === "check") dispatch({ type: "content.close" }); }, [rowId]);
  const mainSentences = changes ? NO_SENTENCES : pane.sentences;
  useEffect(() => { dispatch({ type: "main.loaded", lines: mainLength, sentences: mainSentences, ...(changes && rowId !== undefined ? { doc: `${reviewBranch}\0${rowId}` } : doc && rowId !== undefined ? { doc: rowId } : {}) }); }, [mainLength, mainSentences, doc, rowId, changes === undefined]);
  useEffect(() => {
    dispatch({ type: "measured", measure: measureOf(layout, contentBody) });
  }, [layout.railRows, layout.mainRows, layout.contentRows, layout.contentInner, contentBody]);
  const compLayout = composeLayout(size.cols, size.rows, state.compose.branches.length);
  const entries = state.compose.entries;
  useEffect(() => {
    dispatch({ type: "measured", measure: composeMeasure(compLayout, entries) });
  }, [compLayout.rows, compLayout.inner, entries, state.compose.branches.length]);
  // One message, one effect: `sendSeq` changes only when the author sends. The stream is read to its end whatever
  // view is open, so leaving the compose view mid-reply loses nothing; closing the screen stops it.
  const { sendSeq, outbox } = state.compose;
  useEffect(() => {
    if (outbox === null) return;
    let live = true;
    void (async () => {
      try {
        if (!composer) throw new Error("pablo isn't connected to this screen");
        for await (const event of composer.send(outbox)) if (live) dispatch({ type: "compose.event", event, at: Date.now() });
        if (live) dispatch({ type: "compose.done" });
      } catch (error) {
        if (live) dispatch({ type: "compose.failed", message: (error as Error).message });
      }
    })();
    return () => { live = false; };
  }, [sendSeq]);
  // An answer to a question card goes to the session that asked; the turn's own stream carries on from it.
  const { replySeq, reply } = state.compose;
  useEffect(() => {
    if (reply === null) return;
    // A session that cannot take answers would leave the card's turn waiting for good: say so instead.
    if (composer?.answer) composer.answer(reply.id, reply.text);
    else dispatch({ type: "compose.failed", message: "this session cannot take answers to questions" });
  }, [replySeq]);

  // One editor session per `edit.start`: `editSeq` changes only then. The screen has stopped reading keys by now (the
  // render that set `editing` cleaned up its input effect first).
  const { editSeq, editing } = state;
  useEffect(() => {
    if (editing === null || !editSession) return;
    editSession({ file: editing.file, line: editing.line, editor, ...(editing.branch !== undefined ? { branch: editing.branch } : {}) }).then(
      (r) => dispatch(r.ok ? { type: "edit.done", branch: r.branch, lines: r.lines } : { type: "edit.failed", message: r.message }),
      (e: unknown) => dispatch({ type: "edit.failed", message: e instanceof Error ? e.message : String(e) }),
    );
  }, [editSeq]);

  if (tooSmall(size)) {
    return (
      <Text>
        Terminal too small ({size.cols}x{size.rows}); pablo needs at least {MIN_COLS}x{MIN_ROWS}. q quits.
      </Text>
    );
  }

  if (state.mode.kind === "settings" && state.settings) return <SettingsScreen s={state.settings} cols={size.cols} rows={size.rows} />;

  const view = viewOf(state);
  const working = state.compose.busy ? ` · pablo: ${clean(activityNow(state.compose)) || "working"}` : "";
  const roundsNote = state.roundsNote ? ` · reviews: ${clean(state.roundsNote)}` : "";
  const where = state.mode.kind === "compose" ? `compose · Esc back to the book${working}` : `${state.mode.kind === "review" ? `review ${clean(state.mode.branch)}${state.mode.back ? " · Esc back to compose" : ""}` : "book"} · ${state.focus}${working}${roundsNote}`;
  const pending = pendingText(state.pending);
  const shownComments = hits.length ? { ...comments, check: hits.length } : comments;
  const fields = fitFields(statusFields({ format, drafted, total, branch: reviewBranch ?? branch, comments: review ? { ...shownComments, ...review.counts } : shownComments, ...(reviewBranch !== undefined ? { review: reviewCounts(state) } : {}), reviews: reviewsIn(state.rounds) }), size.cols - 4);
  return (
    <Box flexDirection="column" width={size.cols} height={size.rows}>
      <Box flexDirection="column" borderStyle="single" paddingX={1} height={4}>
        <Text bold wrap="truncate">{clean(title)}</Text>
        <Text wrap="truncate">
          {fields.map((f, i) => (
            <Text key={f.key}>
              {i > 0 ? GAP : ""}
              {f.label ? <Text dimColor>{`${f.label} `}</Text> : null}
              <Text color={f.color}>{clean(f.value)}</Text>
            </Text>
          ))}
        </Text>
      </Box>
      {state.mode.kind === "compose" ? <ComposeView compose={state.compose} size={size} /> : null}
      {state.mode.kind === "compose" || layout.full ? null : (
        <Box height={layout.middleH}>
          {layout.zen ? null : <Rail layout={layout} view={view} labels={labels} title={review ? "CHANGES" : "BOOK"} marks={state.marks} active={state.focus === "rail"} />}
          {layout.zen ? null : <Box width={1} height={layout.middleH} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor="gray" />}
          <Main layout={layout} view={view} title={changes ? changes.title : shownTitle} rows={paneRows} changes={changes?.rows} active={state.focus === "main"} />
        </Box>
      )}
      {state.mode.kind === "compose" ? null : <Box height={layout.bottomH}>
        <Content layout={layout} state={state} />
        <KeyPanel state={state} width={layout.panelW} height={layout.bottomH} keymap={keymap} />
      </Box>}
      <Box height={1} paddingX={1}>
        <Text dimColor wrap="truncate">{`${where}${pending ? ` · ${pending}` : ""}`}</Text>
      </Box>
    </Box>
  );
}

type ViewT = ReturnType<typeof viewOf>;

function Rail({ layout, view, labels, title, marks, active }: { layout: Layout; view: ViewT; labels: Readonly<Record<string, string>>; title: string; marks: Readonly<Record<string, Mark>>; active: boolean }) {
  const shown = shownRows(view.rail).slice(view.rail.scroll, view.rail.scroll + layout.railRows);
  return (
    <Box flexDirection="column" width={layout.railW} height={layout.middleH}>
      <Text dimColor wrap="truncate">{layout.narrow ? ` ${title === "BOOK" ? "BK" : "CH"}` : ` ${title}`}</Text>
      {shown.map(({ row, index }) => {
        const label = clean(labels[row.id] ?? row.id);
        // A change's decision stands where a group's fold mark does: ✓ accepted, ✗ rejected, blank while pending.
        const mark = marks[row.id];
        const fold = row.group ? (view.rail.collapsed.has(row.id) ? "▸ " : "▾ ") : mark === "accepted" ? "✓ " : mark === "rejected" ? "✗ " : "  ";
        const text = layout.narrow ? ` ${label}` : ` ${"  ".repeat(row.depth)}${fold}${label}`;
        const at = index === view.rail.cursor;
        return <Text key={row.id} wrap="truncate" inverse={at && active} bold={at}>{fit(text, layout.railW)}</Text>;
      })}
    </Box>
  );
}

const SIGN_COLOR = { "-": "red", "+": "green", "~": "cyan", " ": undefined } as const;

/** One line of a change: its sign, then its words, the ones that differ standing out. The sign and the colour say removed or added. */
function DiffLine({ row, width, at }: { row: DiffRow; width: number; at: boolean }) {
  const color = row.box ? "yellow" : SIGN_COLOR[row.sign];
  const sign = row.cont ? " " : row.sign === "~" ? "\u21c4" : row.sign;
  return (
    <Text wrap="truncate" {...(color ? { color } : { dimColor: true })}>
      <Text inverse={at}>{sign} </Text>
      {row.segs.map((g, i) => <Text key={i} bold={g.hl} underline={g.hl}>{fit(g.text, width)}</Text>)}
    </Text>
  );
}

function Main({ layout, view, title, rows, changes, active }: { layout: Layout; view: ViewT; title: string; rows: readonly MainRow[]; changes: readonly DiffRow[] | undefined; active: boolean }) {
  const { scroll, cursor } = view.main;
  if (changes) {
    return (
      <Box flexDirection="column" width={layout.mainW} height={layout.middleH} paddingLeft={1}>
        <Text dimColor wrap="truncate">{fit(title, layout.mainInner)}</Text>
        {changes.slice(scroll, scroll + layout.mainRows).map((row, i) => <DiffLine key={scroll + i} row={row} width={layout.mainInner} at={active && scroll + i === cursor} />)}
      </Box>
    );
  }
  // The selected sentences are drawn in blue behind their words, and a bar in the margin marks every line that holds
  // part of one, so the selection shows on a terminal without colour too.
  const range = selectedRange(view.main);
  return (
    <Box flexDirection="column" width={layout.mainW} height={layout.middleH}>
      <Text dimColor wrap="truncate">{` ${fit(title, layout.mainInner)}`}</Text>
      {rows.slice(scroll, scroll + layout.mainRows).map((row, i) => {
        const at = active && scroll + i === cursor;
        if (row.kind === "text") {
          const pieces = piecesOf({ ...row, text: fit(row.text, layout.mainInner) }, range);
          return (
            <Text key={scroll + i} wrap="truncate" inverse={at}>
              <Text color="blue">{pieces.some((p) => p.selected) ? "▌" : " "}</Text>
              {pieces.map((p, k) => <Text key={k} backgroundColor={p.selected ? "blue" : undefined} color={p.selected ? "white" : undefined}>{p.text || " "}</Text>)}
            </Text>
          );
        }
        // A hit's box under its line: the header in the top border, its tag dimmed.
        return (
          <Text key={scroll + i} wrap="truncate" color={row.color} inverse={at}>
            {" "}{row.head !== undefined ? <>{row.head}{row.tag ? <Text dimColor>{row.tag}</Text> : null}{row.text.slice(row.head.length + (row.tag?.length ?? 0))}</> : row.text}
          </Text>
        );
      })}
    </Box>
  );
}

function Content({ layout, state }: { layout: Layout; state: State }) {
  const c = state.content;
  const body = c ? wrapText(clean(c.body), layout.contentInner).slice(state.contentScroll.scroll, state.contentScroll.scroll + layout.contentRows) : [];
  return (
    <Box width={layout.contentW} height={layout.bottomH} borderStyle="single" flexDirection="column" paddingX={1} borderColor={state.focus === "content" ? "cyan" : undefined}>
      <Text bold wrap="truncate">{c ? clean(c.title) : "CONTENT"}</Text>
      {c ? body.map((l, i) => <Text key={i} wrap="truncate">{l || " "}</Text>) : <Text dimColor>Nothing open.</Text>}
    </Box>
  );
}
