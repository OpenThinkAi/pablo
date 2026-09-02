/**
 * The chrome around the manuscript: the status line and the help screen.
 *
 * Both are built from the same `Segment` the manuscript uses, so `render.ts`
 * has one conversion to opentui and not three. The help screen is generated
 * from `BINDINGS`, which means a ticket that adds a verb gets its key
 * documented in the app for free.
 */

import { basename } from "node:path";
import type { DisplayLine, Segment } from "./layout";
import { BINDINGS, GROUP_LABELS, type Binding, type BindingGroup } from "./keymap";
import { CARET_GLYPH } from "./theme";
import type { ViewState } from "./view-state";

function text(value: string, style: Segment["style"]): Segment {
  return { text: value, style, start: -1, selected: false };
}

function line(segments: Segment[]): DisplayLine {
  return { segments, span: { start: 0, end: 0 }, blockIndex: -1 };
}

const SEPARATOR = "  ·  ";

/** The one-row status line: where you are, what is selected, and how to get help. */
export function statusSegments(state: ViewState): Segment[] {
  if (state.help) {
    return [
      text("keys", "statusAccent"),
      text(SEPARATOR, "status"),
      text("↓ ↑ scroll", "status"),
      text(SEPARATOR, "status"),
      text("? or esc to close", "status"),
    ];
  }

  const { start, end } = state.selection.span;
  const length = Math.max(1, state.doc.text.length);
  const percent = Math.round((start / length) * 100);

  const segments: Segment[] = [
    text(basename(state.doc.path), "statusAccent"),
    text(SEPARATOR, "status"),
    text(state.selection.granularity, "statusAccent"),
    text(SEPARATOR, "status"),
  ];

  if (start === end) {
    // AC3: a zero-width selection is a real gesture, so it is named in the
    // status line as well as drawn in the text.
    segments.push(text(`${CARET_GLYPH} boundary at ${start}`, "statusAccent"));
  } else {
    segments.push(text(`${start}–${end}`, "status"));
  }

  segments.push(text(SEPARATOR, "status"), text(`${percent}%`, "status"));

  if (state.message.length > 0) {
    segments.push(text(SEPARATOR, "status"), text(state.message, "statusWarning"));
  }

  segments.push(text(SEPARATOR, "status"), text("? keys", "status"));
  return segments;
}

function chordList(binding: Binding): string {
  return binding.chords.join(" ");
}

/** The help screen, generated from the key map. */
export function helpLines(bindings: readonly Binding[] = BINDINGS): DisplayLine[] {
  const width = bindings.reduce((widest, binding) => Math.max(widest, chordList(binding).length), 0);
  const groups: BindingGroup[] = ["reading", "selection", "session"];
  const lines: DisplayLine[] = [line([text("pablo — keys", "heading")]), line([])];

  for (const group of groups) {
    const rows = bindings.filter((binding) => binding.group === group);
    if (rows.length === 0) continue;
    lines.push(line([text(GROUP_LABELS[group], "statusAccent")]));
    for (const binding of rows) {
      lines.push(
        line([
          text(`  ${chordList(binding).padEnd(width, " ")}  `, "helpKey"),
          text(binding.label, "prose"),
        ]),
      );
    }
    lines.push(line([]));
  }

  lines.push(line([text("No action needs a function key or a number key.", "status")]));
  return lines;
}
