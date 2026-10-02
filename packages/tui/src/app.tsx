// The screen's root. This slice is the shell only: a status line, a placeholder main pane, the key panel and the footer
// line. Book mode (AGT-1526+) fills the table of contents and the main pane; the layout (AGT-1525) places the regions.
//
// Everything the screen knows about where the author is lives in state.ts and changes only through `dispatch`: this
// component reads that state and draws it, and holds no state of its own (packages/tui/test/boundary.test.ts holds it
// to that). Every key is resolved through the key rows (keys.ts, chord.ts) into the model's actions, or into a command
// for the layer above; `q` is the app's own command and quits.

import { useReducer } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { resolve, tokenOf } from "./chord";
import { KeyPanel } from "./key-panel";
import { DEFAULT_KEYMAP, keyStateOf, type Command, type Keymap } from "./keys";
import { tooSmall, useTerminalSize, MIN_COLS, MIN_ROWS } from "./resize";
import type { Size } from "./resize";
import { clean } from "./sanitize";
import { initialState, pendingText, reduce } from "./state";

export interface AppProps {
  /** The project's marker fields the status line shows. */
  readonly title: string;
  readonly format: string;
  /** Tests pass a fixed size; the real screen measures the terminal. */
  readonly size?: Size;
  /** The key rows with the author's overrides laid over them; the defaults when absent. */
  readonly keymap?: Keymap;
  /** A command a key caused (`ai.plan`, `settings`, ...); `quit` is handled here and never reaches it. */
  readonly onCommand?: (command: Command) => void;
}

const PANEL_HEIGHT = 7;

export function App({ title, format, size: override, keymap = DEFAULT_KEYMAP, onCommand }: AppProps) {
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
      <KeyPanel state={state} width={size.cols} height={PANEL_HEIGHT} keymap={keymap} />
      <Box height={1} paddingX={1}>
        <Text dimColor>{`${where}${pending ? ` · ${pending}` : ""}`}</Text>
      </Box>
    </Box>
  );
}
