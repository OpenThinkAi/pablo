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
import { missingContent, type BookRail } from "./book";
import { KeyPanel } from "./key-panel";
import { DEFAULT_KEYMAP, effectiveKeys, keyStateOf, type Command, type Keymap } from "./keys";
import { layoutOf, measureOf, wrapText, type Layout } from "./layout";
import { fileLineAt, type MainDoc } from "./document";
import { hitAt, hitDetail, mainPane, nextHitRow, textRows, type CheckHit, type MainRow } from "./hits";
import { piecesOf, selectedOf, type Selected } from "./selection";
import { clean } from "./sanitize";
import { openSettings, settingsPaste, settingsStep } from "./settings";
import { SettingsScreen } from "./settings-view";
import { fitFields, statusFields, GAP, type CommentKind } from "./status";
import { branchRows, loadReview, reviewLines, type BranchDiff, type DiffRow, type ReviewComment } from "./review";
import type { EditSession, Finisher, Rejected } from "./screen";
import type { Writer } from "./screen";
import { activityNow, composeAction, composeLayout, composeMeasure, type Composer } from "./compose";
import { ComposeView } from "./compose-view";
import { initialState, pendingText, placeOf, railRow, reduce, reviewCounts, selectedRange, shownRows, viewOf, type LineSpan, type Mark, type RailRow, type State } from "./state";

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
  /** `s` in a review: merges the accepted changes and runs the after-write steps (the CLI's `screenFinisher`, passed in). */
  readonly finisher?: Finisher;
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
  /** Tests pass a fixed size; the real screen measures the terminal. */
  readonly size?: Size;
}

const NO_ROWS: readonly RailRow[] = [];
const NO_LINES: readonly string[] = [];
const NO_LABELS: Readonly<Record<string, string>> = {};
const NO_BRANCHES: readonly string[] = [];
const NO_HITS: readonly CheckHit[] = [];
const NO_SENTENCES: readonly LineSpan[] = [];

const fit = (text: string, width: number) => [...clean(text)].slice(0, Math.max(0, width)).join("");

export function App({ title, format, drafted = 0, total = 0, branch = "main", comments = {}, book, rows: bookRows = book?.rows ?? NO_ROWS, labels: bookLabels = book?.labels ?? NO_LABELS, branches = NO_BRANCHES, diffOf, commentsOf, mainTitle = "", lines = NO_LINES, size: override, keymap: given = DEFAULT_KEYMAP, editor: givenEditor = "", configFile, onCommand, load, checks, writer, finisher, editSession, composer }: AppProps) {
  const { exit } = useApp();
  const size = useTerminalSize(override);
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
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
    const token = tokenOf(input, key);
    if (state.mode.kind === "settings" && state.settings) {
      // The settings screen takes every key itself (a binding being captured must not also act); Esc asks to save.
      if (!token) { if (input && !input.includes("\x1b")) dispatch({ type: "settings.set", settings: settingsPaste(state.settings, input) }); return; }
      const step = settingsStep(state.settings, token);
      dispatch("close" in step ? { type: "settings.close", ...(step.close ? { saved: step.close } : {}) } : { type: "settings.set", settings: step.s });
      return;
    }
    if (!token) return;
    for (const action of resolve(keyStateOf(state), state.pending, token, keymap)) {
      if (action.type !== "command") dispatch(action);
      else if (action.id === "quit") exit();
      else if (action.id === "settings") dispatch({ type: "settings.open", settings: openSettings(keymap, editor, configFile ?? configPath()) });
      else if (action.id === "check.open") openHit();
      else if (action.id === "check.next" || action.id === "check.prev") {
        const to = nextHitRow(paneRows, viewOf(state).main.cursor, action.id === "check.next" ? 1 : -1);
        // The box's last row first, so the pane scrolls far enough to show the whole box, then its first row.
        if (to !== undefined) { dispatch({ type: "main.goto", line: to + 3 }); dispatch({ type: "main.goto", line: to + 1 }); }
      }
      else if (action.id === "ai.write") startWrite();
      else if (action.id === "review.finish") startFinish();
      else if (action.id === "view.editor") startEdit();
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

  // `s` in a review: every change needs a decision first (an undecided change is neither accepted nor rejected, so it
  // is not merged on a guess); the rejected edits go to the finisher as the lines they own.
  function startFinish() {
    if (state.mode.kind !== "review" || state.finishing !== null) return;
    const open = reviewBranch ?? state.mode.branch;
    const counts = reviewCounts(state);
    if (!finisher) return void dispatch({ type: "finish.failed", message: "Finishing is not available here." });
    if (!review || review.edits.size === 0) return void dispatch({ type: "finish.failed", message: "There are no changes to finish." });
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
  const extra = useMemo(() => branchRows(waiting), [waiting]);
  const review = useMemo(() => (reviewBranch === undefined ? undefined : loadReview(diffOf?.(reviewBranch), commentsOf?.(reviewBranch))), [reviewBranch, diffOf, commentsOf]);
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
  const doc = useMemo(() => (rowId !== undefined && !review ? load?.(rowId) : undefined), [rowId, load, review, state.finished]);
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
    editSession({ file: editing.file, line: editing.line, editor }).then(
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
  const where = state.mode.kind === "compose" ? `compose · Esc back to the book${working}` : `${state.mode.kind === "review" ? `review ${clean(state.mode.branch)}${state.mode.back ? " · Esc back to compose" : ""}` : "book"} · ${state.focus}${working}`;
  const pending = pendingText(state.pending);
  const shownComments = hits.length ? { ...comments, check: hits.length } : comments;
  const fields = fitFields(statusFields({ format, drafted, total, branch: reviewBranch ?? branch, comments: review ? { ...shownComments, ...review.counts } : shownComments, ...(reviewBranch !== undefined ? { review: reviewCounts(state) } : {}) }), size.cols - 4);
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
