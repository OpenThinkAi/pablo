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
import type { MainDoc } from "./document";
import { hitAt, hitDetail, mainRows, nextHitRow, textRows, type CheckHit, type MainRow } from "./hits";
import { clean } from "./sanitize";
import { openSettings, settingsPaste, settingsStep } from "./settings";
import { SettingsScreen } from "./settings-view";
import { fitFields, statusFields, GAP, type CommentKind } from "./status";
import { branchRows, loadReview, reviewLines, type BranchDiff, type DiffRow } from "./review";
import { initialState, pendingText, placeOf, railRow, reduce, shownRows, viewOf, type RailRow, type State } from "./state";

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
  /** The key rows with the author's overrides laid over them; the defaults when absent. */
  readonly keymap?: Keymap;
  /** The editor command the config sets ("" for none); what the settings screen opens with. */
  readonly editor?: string;
  /** The config file the settings screen saves to. Tests pass a temporary one. */
  readonly configFile?: string;
  /** A command a key caused (`ai.plan`, ...); `quit` and `settings` are handled here and never reach it. */
  readonly onCommand?: (command: Command) => void;
  /** Tests pass a fixed size; the real screen measures the terminal. */
  readonly size?: Size;
}

const NO_ROWS: readonly RailRow[] = [];
const NO_LINES: readonly string[] = [];
const NO_LABELS: Readonly<Record<string, string>> = {};
const NO_BRANCHES: readonly string[] = [];
const NO_HITS: readonly CheckHit[] = [];

const fit = (text: string, width: number) => [...clean(text)].slice(0, Math.max(0, width)).join("");

export function App({ title, format, drafted = 0, total = 0, branch = "main", comments = {}, book, rows: bookRows = book?.rows ?? NO_ROWS, labels: bookLabels = book?.labels ?? NO_LABELS, branches = NO_BRANCHES, diffOf, mainTitle = "", lines = NO_LINES, size: override, keymap: given = DEFAULT_KEYMAP, editor: givenEditor = "", configFile, onCommand, load, checks }: AppProps) {
  const { exit } = useApp();
  const size = useTerminalSize(override);
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  // A save puts the new bindings in force at once; until one, the keymap and editor the screen opened with.
  const keymap = state.saved ? effectiveKeys(state.saved.overrides) : given;
  const editor = state.saved ? state.saved.editor : givenEditor;
  const layout = layoutOf(size.cols, size.rows, { zen: state.zen, full: state.full });
  useInput((input, key) => {
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
      else onCommand?.(action);
    }
  });

  const contentBody = state.content ? clean(state.content.body) : null;
  // Book mode's rows (the stages, then the branches waiting for review), or in a review the branch's changes.
  const place = placeOf(state);
  const reviewBranch = place.kind === "review" ? place.branch : undefined;
  const extra = useMemo(() => branchRows(branches), [branches]);
  const review = useMemo(() => (reviewBranch === undefined ? undefined : loadReview(diffOf?.(reviewBranch))), [reviewBranch, diffOf]);
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
  const doc = useMemo(() => (rowId !== undefined && !review ? load?.(rowId) : undefined), [rowId, load, review]);
  const hits = useMemo(() => (doc?.file !== undefined && checks ? checks(doc.file, doc.text) : NO_HITS), [doc, checks]);
  const shownTitle = doc ? doc.title : mainTitle;
  const paneRows = useMemo<readonly MainRow[]>(() => (doc ? mainRows(doc.text, layout.mainInner, hits) : textRows(lines)), [doc, hits, lines, layout.mainInner]);
  const changes = useMemo(() => (review ? reviewLines(review, rowId, layout.mainInner - 2) : undefined), [review, rowId, layout.mainInner]);
  const mainLength = changes ? changes.rows.length : paneRows.length;
  // `→` on a hit (its box, or the line above it) opens its rule and flagged pattern in the content area.
  const openHit = () => {
    const at = hitAt(paneRows, viewOf(state).main.cursor);
    if (at !== undefined) dispatch({ type: "content.show", content: { ...hitDetail(hits[at]!), kind: "check" } });
  };
  // A hit's detail belongs to the document it was opened in: opening another takes it down.
  useEffect(() => { if (state.content?.kind === "check") dispatch({ type: "content.close" }); }, [rowId]);
  useEffect(() => { dispatch({ type: "main.loaded", lines: mainLength, ...(changes && rowId !== undefined ? { doc: `${reviewBranch}\0${rowId}` } : doc && rowId !== undefined ? { doc: rowId } : {}) }); }, [mainLength, doc, rowId, changes === undefined]);
  useEffect(() => {
    dispatch({ type: "measured", measure: measureOf(layout, contentBody) });
  }, [layout.railRows, layout.mainRows, layout.contentRows, layout.contentInner, contentBody]);

  if (tooSmall(size)) {
    return (
      <Text>
        Terminal too small ({size.cols}x{size.rows}); pablo needs at least {MIN_COLS}x{MIN_ROWS}. q quits.
      </Text>
    );
  }

  if (state.mode.kind === "settings" && state.settings) return <SettingsScreen s={state.settings} cols={size.cols} rows={size.rows} />;

  const view = viewOf(state);
  const where = `${state.mode.kind === "review" ? `review ${clean(state.mode.branch)}` : "book"} · ${state.focus}`;
  const pending = pendingText(state.pending);
  const shownComments = hits.length ? { ...comments, check: hits.length } : comments;
  const fields = fitFields(statusFields({ format, drafted, total, branch: reviewBranch ?? branch, comments: shownComments }), size.cols - 4);
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
      {layout.full ? null : (
        <Box height={layout.middleH}>
          {layout.zen ? null : <Rail layout={layout} view={view} labels={labels} title={review ? "CHANGES" : "BOOK"} active={state.focus === "rail"} />}
          {layout.zen ? null : <Box width={1} height={layout.middleH} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor="gray" />}
          <Main layout={layout} view={view} title={changes ? changes.title : shownTitle} rows={paneRows} changes={changes?.rows} active={state.focus === "main"} />
        </Box>
      )}
      <Box height={layout.bottomH}>
        <Content layout={layout} state={state} />
        <KeyPanel state={state} width={layout.panelW} height={layout.bottomH} keymap={keymap} />
      </Box>
      <Box height={1} paddingX={1}>
        <Text dimColor wrap="truncate">{`${where}${pending ? ` · ${pending}` : ""}`}</Text>
      </Box>
    </Box>
  );
}

type ViewT = ReturnType<typeof viewOf>;

function Rail({ layout, view, labels, title, active }: { layout: Layout; view: ViewT; labels: Readonly<Record<string, string>>; title: string; active: boolean }) {
  const shown = shownRows(view.rail).slice(view.rail.scroll, view.rail.scroll + layout.railRows);
  return (
    <Box flexDirection="column" width={layout.railW} height={layout.middleH}>
      <Text dimColor wrap="truncate">{layout.narrow ? ` ${title === "BOOK" ? "BK" : "CH"}` : ` ${title}`}</Text>
      {shown.map(({ row, index }) => {
        const label = clean(labels[row.id] ?? row.id);
        const fold = row.group ? (view.rail.collapsed.has(row.id) ? "▸ " : "▾ ") : "  ";
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
  const color = SIGN_COLOR[row.sign];
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
  return (
    <Box flexDirection="column" width={layout.mainW} height={layout.middleH} paddingLeft={1}>
      <Text dimColor wrap="truncate">{fit(title, layout.mainInner)}</Text>
      {rows.slice(scroll, scroll + layout.mainRows).map((row, i) => {
        const at = active && scroll + i === cursor;
        if (row.kind === "text") return <Text key={scroll + i} wrap="truncate" inverse={at}>{fit(row.text, layout.mainInner) || " "}</Text>;
        // A hit's box under its line: the header in the top border, its tag dimmed.
        return (
          <Text key={scroll + i} wrap="truncate" color={row.color} inverse={at}>
            {row.head !== undefined ? <>{row.head}{row.tag ? <Text dimColor>{row.tag}</Text> : null}{row.text.slice(row.head.length + (row.tag?.length ?? 0))}</> : row.text}
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
