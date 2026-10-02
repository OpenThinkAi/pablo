// The screen's root: prview's three-part layout (layout.ts), drawn from the state. A status area on top (status.ts),
// the rail and the main pane in the middle, the content area beside the key panel at the bottom, a footer under it.
// Book mode (AGT-1526+) fills the rail and the main pane through the props below; the too-small notice lives here. The layout's geometry is pure (layout.ts); after each size or content change this component
// tells the model how many rows each region shows (`measured`) and the model keeps every cursor in view.
//
// Everything the screen knows about where the author is lives in state.ts and changes only through `dispatch`: this
// component reads that state and draws it, and holds no state of its own (packages/tui/test/boundary.test.ts holds it
// to that). Every key is resolved through the key rows (keys.ts, chord.ts) into the model's actions, or into a command
// for the layer above; `q` is the app's own command and quits.

import { useEffect, useReducer } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { tooSmall, useTerminalSize, MIN_COLS, MIN_ROWS } from "./resize";
import type { Size } from "./resize";
import { resolve, tokenOf } from "./chord";
import { missingContent, type BookRail } from "./book";
import { KeyPanel } from "./key-panel";
import { DEFAULT_KEYMAP, keyStateOf, type Command, type Keymap } from "./keys";
import { layoutOf, measureOf, wrapText, type Layout } from "./layout";
import { clean } from "./sanitize";
import { fitFields, statusFields, GAP, type CommentKind } from "./status";
import { initialState, pendingText, reduce, shownRows, viewOf, type RailRow, type State } from "./state";

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
  /** The main pane's heading and its document, one sentence per line. */
  readonly mainTitle?: string;
  readonly lines?: readonly string[];
  /** The key rows with the author's overrides laid over them; the defaults when absent. */
  readonly keymap?: Keymap;
  /** A command a key caused (`ai.plan`, `settings`, ...); `quit` is handled here and never reaches it. */
  readonly onCommand?: (command: Command) => void;
  /** Tests pass a fixed size; the real screen measures the terminal. */
  readonly size?: Size;
}

const NO_ROWS: readonly RailRow[] = [];
const NO_LINES: readonly string[] = [];

const fit = (text: string, width: number) => [...clean(text)].slice(0, Math.max(0, width)).join("");

export function App({ title, format, drafted = 0, total = 0, branch = "main", comments = {}, book, rows = book?.rows ?? NO_ROWS, labels = book?.labels ?? {}, mainTitle = "", lines = NO_LINES, size: override, keymap = DEFAULT_KEYMAP, onCommand }: AppProps) {
  const { exit } = useApp();
  const size = useTerminalSize(override);
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  useInput((input, key) => {
    const token = tokenOf(input, key);
    if (!token) return;
    for (const action of resolve(keyStateOf(state), state.pending, token, keymap)) {
      if (action.type !== "command") dispatch(action);
      else if (action.id === "quit") exit();
      else onCommand?.(action);
    }
  });

  const layout = layoutOf(size.cols, size.rows, { zen: state.zen, full: state.full });
  const contentBody = state.content ? clean(state.content.body) : null;
  // What was loaded and what the layout measured reach the model as actions; neither is state of this component.
  useEffect(() => { dispatch({ type: "rail.loaded", rows, ...(book ? { folded: book.folded } : {}) }); }, [rows]);
  // A stage that is not ready says why in the content area while the cursor is on it, and takes it down when it leaves.
  const stageId = state.mode.kind === "book" ? viewOf(state).rail.rows[viewOf(state).rail.cursor]?.id : undefined;
  const reasons = stageId === undefined ? undefined : book?.missing[stageId];
  useEffect(() => {
    if (reasons) dispatch({ type: "content.show", content: missingContent(labels[stageId!]?.replace(/^\S+ /, "") ?? stageId!, reasons) });
    else if (state.content?.kind === "missing") dispatch({ type: "content.close" });
  }, [stageId, reasons]);
  useEffect(() => { dispatch({ type: "main.loaded", lines: lines.length }); }, [lines]);
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

  const view = viewOf(state);
  const where = `${state.mode.kind === "review" ? `review ${state.mode.branch}` : "book"} · ${state.focus}`;
  const pending = pendingText(state.pending);
  const fields = fitFields(statusFields({ format, drafted, total, branch, comments }), size.cols - 4);
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
          {layout.zen ? null : <Rail layout={layout} view={view} labels={labels} active={state.focus === "rail"} />}
          {layout.zen ? null : <Box width={1} height={layout.middleH} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor="gray" />}
          <Main layout={layout} view={view} title={mainTitle} lines={lines} active={state.focus === "main"} />
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

function Rail({ layout, view, labels, active }: { layout: Layout; view: ViewT; labels: Readonly<Record<string, string>>; active: boolean }) {
  const shown = shownRows(view.rail).slice(view.rail.scroll, view.rail.scroll + layout.railRows);
  return (
    <Box flexDirection="column" width={layout.railW} height={layout.middleH}>
      <Text dimColor wrap="truncate">{layout.narrow ? " BK" : " BOOK"}</Text>
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

function Main({ layout, view, title, lines, active }: { layout: Layout; view: ViewT; title: string; lines: readonly string[]; active: boolean }) {
  const { scroll, cursor } = view.main;
  return (
    <Box flexDirection="column" width={layout.mainW} height={layout.middleH} paddingLeft={1}>
      <Text dimColor wrap="truncate">{fit(title, layout.mainInner)}</Text>
      {lines.slice(scroll, scroll + layout.mainRows).map((line, i) => (
        <Text key={scroll + i} wrap="truncate" inverse={active && scroll + i === cursor}>{fit(line, layout.mainInner) || " "}</Text>
      ))}
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
