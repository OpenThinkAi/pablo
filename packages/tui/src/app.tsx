// The screen's root. This slice is the shell only: a status line, a placeholder main pane and the key line. Book mode
// (AGT-1523+) fills the table of contents and the main pane; the quit key and the too-small notice live here.

import { Box, Text, useApp, useInput } from "ink";
import { tooSmall, useTerminalSize, MIN_COLS, MIN_ROWS } from "./resize";
import type { Size } from "./resize";
import { clean } from "./sanitize";

export interface AppProps {
  /** The project's marker fields the status line shows. */
  readonly title: string;
  readonly format: string;
  /** Tests pass a fixed size; the real screen measures the terminal. */
  readonly size?: Size;
}

export function App({ title, format, size: override }: AppProps) {
  const { exit } = useApp();
  const size = useTerminalSize(override);
  useInput((input) => {
    if (input === "q") exit();
  });

  if (tooSmall(size)) {
    return (
      <Text>
        Terminal too small ({size.cols}x{size.rows}); pablo needs at least {MIN_COLS}x{MIN_ROWS}. q quits.
      </Text>
    );
  }

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
        <Text dimColor>q quit</Text>
      </Box>
    </Box>
  );
}
