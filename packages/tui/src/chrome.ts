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
import { BINDINGS, BRIEF_KEY, GROUP_LABELS, type Binding, type BindingGroup } from "./keymap";
import { CARET_GLYPH } from "./theme";
import { briefNotice, type BriefPane, type ViewState } from "./view-state";

function text(value: string, style: Segment["style"]): Segment {
  return { text: value, style, start: -1, selected: false };
}

function line(segments: Segment[]): DisplayLine {
  return { segments, span: { start: 0, end: 0 }, blockIndex: -1 };
}

const SEPARATOR = "  ·  ";

/** The one-row status line: where you are, what is selected, and how to get help. */
export function statusSegments(state: ViewState): Segment[] {
  if (state.brief.open) {
    return [
      text("brief", "statusAccent"),
      text(SEPARATOR, "status"),
      text(state.brief.slug ?? "this work", "statusAccent"),
      text(SEPARATOR, "status"),
      text("↓ ↑ scroll", "status"),
      text(SEPARATOR, "status"),
      text(`${BRIEF_KEY} or esc to close`, "status"),
    ];
  }

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

  const segments: Segment[] = [text(basename(state.doc.path), "statusAccent"), text(SEPARATOR, "status")];

  // A message is the most perishable thing on the row and the only thing on it
  // the reader has not already seen, so it goes near the left edge where a
  // narrow terminal cannot clip it. The position and the granularity are always
  // recoverable by looking at the screen; "think brief failed" is not.
  if (state.message.length > 0) {
    segments.push(text(state.message, "statusWarning"), text(SEPARATOR, "status"));
  }

  segments.push(text(state.selection.granularity, "statusAccent"), text(SEPARATOR, "status"));

  if (start === end) {
    // AC3: a zero-width selection is a real gesture, so it is named in the
    // status line as well as drawn in the text.
    segments.push(text(`${CARET_GLYPH} boundary at ${start}`, "statusAccent"));
  } else {
    segments.push(text(`${start}–${end}`, "status"));
  }

  segments.push(text(SEPARATOR, "status"), text(`${percent}%`, "status"));
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

/** Word-wrap one line of the brief. `think` emits long rows; the pane is not a pager. */
function wrap(value: string, width: number): string[] {
  const columns = Math.max(20, width);
  if (value.length <= columns) return [value];

  const rows: string[] = [];
  let row = "";
  for (const word of value.split(" ")) {
    if (row.length === 0) row = word;
    else if (row.length + 1 + word.length <= columns) row = `${row} ${word}`;
    else {
      rows.push(row);
      row = word;
    }
    // A single unbreakable token (a path, a URL) is cut rather than allowed to
    // run off the right edge, where it would be invisible.
    while (row.length > columns) {
      rows.push(row.slice(0, columns));
      row = row.slice(columns);
    }
  }
  if (row.length > 0) rows.push(row);
  return rows;
}

/**
 * The brief screen, rendered exactly the way the help screen is: `DisplayLine`
 * rows the view slices into the body, with the status bar as its own row.
 *
 * The footer says where the text came from and that it is not part of the
 * manuscript, because the brief and the chapter are both prose on a terminal
 * and the reader deserves to be told which is which (AC4).
 */
export function briefLines(brief: BriefPane, width = 80): DisplayLine[] {
  const slug = brief.slug ?? "this work";
  const lines: DisplayLine[] = [];
  const push = (value: string, style: Segment["style"]): void => {
    for (const row of wrap(value.replace(/\s+$/u, ""), width)) lines.push(line([text(row, style)]));
  };

  push(`pablo — brief: ${slug}`, "heading");
  lines.push(line([]));

  if (brief.status !== "ready" || brief.text === undefined) {
    push(briefNotice(brief), "statusWarning");
    return lines;
  }

  for (const source of brief.text.split("\n")) {
    // `think` heads its sections with a box rule; keeping them accented is the
    // whole of the formatting this pane does.
    push(source, source.trimStart().startsWith("──") ? "statusAccent" : "prose");
  }

  lines.push(line([]));
  push(`think brief --cortex writing --context ${slug}`, "status");
  push("Context only — never written into the manuscript.", "status");
  return lines;
}
