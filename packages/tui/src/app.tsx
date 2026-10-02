// The screen's root. This slice is the shell only: a status line, a placeholder main pane and the key line. Book mode
// (AGT-1526+) fills the table of contents and the main pane; the quit key and the too-small notice live here.
//
// Everything the screen knows about where the author is lives in state.ts and changes only through `dispatch`: this
// component reads that state and draws it, and holds no state of its own (packages/tui/test/boundary.test.ts holds it
// to that). The key handler below reads the arrows, Tab and Esc directly until the key tables land (AGT-1524), which
// resolve every key through the same actions.

import { useReducer } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { tooSmall, useTerminalSize, MIN_COLS, MIN_ROWS } from "./resize";
import type { Size } from "./resize";
import { clean } from "./sanitize";
import { initialState, pendingText, reduce, type Action, type State } from "./state";

export interface AppProps {
  /** The project's marker fields the status line shows. */
  readonly title: string;
  readonly format: string;
  /** Tests pass a fixed size; the real screen measures the terminal. */
  readonly size?: Size;
}

/** What Ink hands a key handler, the fields read here. */
type InkKey = { upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean; tab?: boolean; escape?: boolean };

/** The arrows move in the pane the cursor is in (or scroll the content area), Tab moves focus in and out, Esc backs out. */
export function actionOf(input: string, key: InkKey, s: State): Action | null {
  if (key.escape) return { type: "escape" };
  if (key.tab) return { type: s.focus === "content" ? "focus.back" : "focus.content" };
  const arrow = key.upArrow ? "up" : key.downArrow ? "down" : key.leftArrow ? "left" : key.rightArrow ? "right" : null;
  if (!arrow) return null;
  if (s.focus === "content") return arrow === "down" ? { type: "content.down" } : arrow === "up" ? { type: "content.up" } : null;
  if (s.focus === "rail") return { type: ({ up: "rail.up", down: "rail.down", right: "rail.expand", left: "rail.collapse" } as const)[arrow] };
  return arrow === "up" ? { type: "main.up" } : arrow === "down" ? { type: "main.down" } : arrow === "left" ? { type: "main.to_rail" } : null;
}

export function App({ title, format, size: override }: AppProps) {
  const { exit } = useApp();
  const size = useTerminalSize(override);
  const [state, dispatch] = useReducer(reduce, undefined, initialState);
  useInput((input, key) => {
    if (input === "q") { exit(); return; }
    const action = actionOf(input, key, state);
    if (action) dispatch(action);
  });

  if (tooSmall(size)) {
    return (
      <Text>
        Terminal too small ({size.cols}x{size.rows}); pablo needs at least {MIN_COLS}x{MIN_ROWS}. q quits.
      </Text>
    );
  }

  const where = `${state.mode.kind === "review" ? `review ${state.mode.branch}` : "book"} · ${state.focus}`;
  const pending = pendingText(state.pending);
  return (
    <Box flexDirection="column" width={size.cols} height={size.rows}>
      <Box borderStyle="single" paddingX={1} height={3}>
        <Text bold wrap="truncate">{clean(title)}</Text>
        <Text dimColor wrap="truncate">{`  ${clean(format)}`}</Text>
      </Box>
      <Box flexGrow={1} paddingX={1}>
        <Text dimColor>Book mode is not built yet.</Text>
      </Box>
      <Box height={1} paddingX={1}>
        <Text dimColor>{`q quit · ${where}${pending ? ` · ${pending}` : ""}`}</Text>
      </Box>
    </Box>
  );
}
