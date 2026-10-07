// The key panel as a component: a bordered box of the keys that act in the current state, or a pending prefix's second
// keys. It draws what panel.ts shaped and holds nothing; the layout (AGT-1525) places it at the width and height it
// chooses, beside or below the content area.

import { Box, Text } from "ink";
import { entriesFor, panelOf, panelTitle } from "./panel";
import { keyStateOf, DEFAULT_KEYMAP, type Keymap } from "./keys";
import type { State } from "./state";

export interface KeyPanelProps {
  readonly state: State;
  readonly width: number;
  readonly height: number;
  readonly keymap?: Keymap;
}

export function KeyPanel({ state, width, height, keymap = DEFAULT_KEYMAP }: KeyPanelProps) {
  const shape = panelOf(panelTitle(keyStateOf(state), state.pending, state.voice !== null || state.voiceRule !== null), entriesFor(state, keymap), width, height);
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} width={width} height={height}>
      <Text bold wrap="truncate">{shape.title}</Text>
      {shape.lines.map((line, i) => (
        <Text key={i} wrap="truncate">
          {line.map((seg, j) => (seg.dim ? <Text key={j} dimColor>{seg.text}</Text> : seg.text))}
        </Text>
      ))}
    </Box>
  );
}
