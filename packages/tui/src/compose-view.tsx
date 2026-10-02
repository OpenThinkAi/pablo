// The compose view, full screen (AGT-1566): the conversation with pablo, an activity line, the input box. Drawn from
// the model's `compose` and laid out by compose.ts; it holds no state of its own (test/boundary.test.ts).

import { Box, Text } from "ink";
import { FOOTER_H, STATUS_H } from "./layout";
import { clean } from "./sanitize";
import { activityNow, composeLayout, composeLines, inputTail, visibleBranches, visibleLines, type LineStyle } from "./compose";
import { openQuestion, type Compose } from "./state";
import type { Size } from "./resize";

const COLOR: Partial<Record<LineStyle, string>> = { author: "cyan", error: "red", question: "yellow" };
const DIM: readonly LineStyle[] = ["tool", "result", "dim"];

export function ComposeView({ compose, size }: { compose: Compose; size: Size }) {
  const layout = composeLayout(size.cols, size.rows, compose.branches.length);
  const lines = visibleLines(composeLines(compose.entries, layout.inner), layout.rows, compose.offset);
  const asking = openQuestion(compose) !== undefined;
  const id = compose.sessionId ? ` · session ${clean(compose.sessionId).slice(0, 8)}` : "";
  const scrolled = compose.offset > 0 ? " · scrolled back, ↓ for the newest" : "";
  return (
    <Box flexDirection="column" height={size.rows - STATUS_H - FOOTER_H} paddingX={1}>
      <Text dimColor wrap="truncate">{`COMPOSE${id}${scrolled}`}</Text>
      <Box flexDirection="column" height={layout.rows}>
        {compose.entries.length === 0 ? <Text dimColor>Talk to pablo about the book: where it stands, what to plan, what to write next.</Text> : null}
        {lines.map((line, i) => (
          <Text key={i} wrap="truncate" {...(COLOR[line.style] ? { color: COLOR[line.style] } : {})} dimColor={DIM.includes(line.style)}>{line.text || " "}</Text>
        ))}
      </Box>
      {compose.branches.length === 0 ? null : (
        <Box flexDirection="column">
          <Text dimColor wrap="truncate">{compose.pick === null ? `BRANCHES (${compose.branches.length}) · Tab to pick one, Enter reviews it` : "BRANCHES · ↑↓ pick, Enter reviews, Esc back to the input"}</Text>
          {visibleBranches(compose.branches, compose.pick).map(({ name, index }) => (
            <Text key={name} wrap="truncate" inverse={index === compose.pick}>{`  ${clean(name)}`}</Text>
          ))}
        </Box>
      )}
      <Text color="magenta" wrap="truncate">{compose.busy ? `● ${clean(activityNow(compose)) || "working"}…` : " "}</Text>
      <Box borderStyle="single" paddingX={1} height={3} borderColor={asking ? "yellow" : compose.busy || compose.pick !== null ? "gray" : "cyan"}>
        <Text wrap="truncate">
          <Text dimColor={!asking} color={asking ? "yellow" : undefined}>{asking ? "answer › " : "› "}</Text>
          {inputTail(compose.input, layout.inputInner - (asking ? 7 : 0))}
          <Text inverse>{" "}</Text>
        </Text>
      </Box>
    </Box>
  );
}
