/**
 * The chrome around the manuscript: the status line and the help screen.
 *
 * Both are built from the same `Segment` the manuscript uses, so `render.ts`
 * has one conversion to opentui and not three. The help screen is generated
 * from `BINDINGS`, which means a ticket that adds a verb gets its key
 * documented in the app for free.
 */

import { basename } from "node:path";
import { fieldRows, type Field } from "./field";
import type { DisplayLine, Segment } from "./layout";
import { BINDINGS, BRIEF_KEY, GROUP_LABELS, type Binding, type BindingGroup } from "./keymap";
import { KIND_LABELS, originalText, proposedText, reviewQueue } from "./review";
import { NO_RECEIPT } from "./receipts";
import { CARET_GLYPH } from "./theme";
import { briefNotice, type BriefPane, type Overlay, type RunState, type ViewState } from "./view-state";

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

  // The file is the anchor: it is first and it never moves.
  const head: Segment[] = [text(basename(state.doc.path), "statusAccent")];

  // Where you are. Droppable, tail first, when the row will not fit: it is the
  // same on every frame, so it is what a narrow terminal can afford to lose.
  // Everything between the two is news, and news is never what gets dropped —
  // the position and the granularity are recoverable by looking at the screen,
  // and "think brief failed" is not. The queue position is a "where" too: the
  // panel below already names the hunk, so this is the redundant copy.
  const queue = state.review.open ? reviewQueue(state.model) : [];
  const tail: Segment[] = [
    ...(state.review.open
      ? [text(`proposal ${Math.min(state.review.index + 1, queue.length)} of ${queue.length}`, "statusAccent")]
      : []),
    text(state.selection.granularity, "statusAccent"),
    start === end
      ? // AC3: a zero-width selection is a real gesture, so it is named in the
        // status line as well as drawn in the text.
        text(`${CARET_GLYPH} boundary at ${start}`, "statusAccent")
      : text(`${start}–${end}`, "status"),
    text(`${percent}%`, "status"),
    text("? keys", "status"),
  ];

  // What just happened. A run, its receipt and a message are three different
  // lifetimes — the run lasts while it runs, the receipt until the next action
  // (AC6), the message until anything else happens — and all three are news,
  // so they are kept when the row is too long and the position is not.
  const news: Segment[] = [];
  if (state.pendingMove !== undefined) news.push(text("moving", "statusWarning"));
  if (state.run !== undefined) news.push(...runSegments(state.run));
  if (state.receipt.length > 0) news.push(text(state.receipt, "statusAccent"));
  if (state.message.length > 0) news.push(text(state.message, "statusWarning"));

  return fit(head, news, tail, state.width);
}

/**
 * The run, on one row: what it is waiting for, then the two numbers AC6 asks to
 * see *while* it waits, then the error and the key that repeats it (AC5).
 */
function runSegments(run: RunState): Segment[] {
  if (run.phase === "failed") {
    // The key comes first so a narrow terminal truncates the explanation and
    // not the way out of it.
    return [text("R retries", "statusAccent"), text(run.error ?? "the run failed", "statusWarning")];
  }

  // Before the first byte the estimate is the only thing worth saying; after
  // it, the measurement replaces the estimate and the size is all that is left
  // of the ask. The elapsed second comes first in both phases: it is the one
  // number that moves, and a moving number is how a wait is told from a hang.
  const waited = `${Math.round(run.elapsedMs / 1000)}s`;
  if (run.phase === "sending") return [text(`waiting ${waited}  ·  ${run.summary}`, "statusAccent")];

  const parts: string[] = [waited, run.size];
  if (run.timeToFirstTokenMs !== undefined) {
    parts.push(`first token ${Math.round(run.timeToFirstTokenMs / 100) / 10}s`);
  }
  if (run.tokensPerSecond !== undefined) parts.push(`${Math.round(run.tokensPerSecond)} tok/s`);
  return [text(parts.join(SEPARATOR), "statusAccent")];
}

/**
 * Join the three parts of the status line into one row no wider than the
 * terminal.
 *
 * The status line is one row in the layout, so anything past the edge would
 * wrap into the manuscript. The position is dropped from the tail until the
 * news fits, and only then is the row itself truncated — a narrow terminal
 * should lose "42%", not the error that just came back from an endpoint.
 */
function fit(
  head: readonly Segment[],
  news: readonly Segment[],
  tail: readonly Segment[],
  width: number,
): Segment[] {
  const kept = [...tail];
  while (kept.length > 0 && news.length > 0 && lengthOf([...head, ...news, ...kept]) > width && width > 0) {
    kept.pop();
  }
  return truncate(joined([...head, ...news, ...kept]), width);
}

function lengthOf(pieces: readonly Segment[]): number {
  return joined(pieces).reduce((total, segment) => total + segment.text.length, 0);
}

/** Every piece separated from the next by the same dot. */
function joined(pieces: readonly Segment[]): Segment[] {
  return pieces.flatMap((piece, index) => (index === 0 ? [piece] : [text(SEPARATOR, "status"), piece]));
}

function truncate(segments: readonly Segment[], width: number): Segment[] {
  if (width <= 0) return [...segments];
  const kept: Segment[] = [];
  let used = 0;
  for (const segment of segments) {
    if (used + segment.text.length <= width) {
      kept.push(segment);
      used += segment.text.length;
      continue;
    }
    const room = width - used;
    if (room > 1) kept.push({ ...segment, text: `${segment.text.slice(0, room - 1)}…` });
    break;
  }
  return kept;
}

function chordList(binding: Binding): string {
  return binding.chords.join(" ");
}

/** The help screen, generated from the key map. */
export function helpLines(bindings: readonly Binding[] = BINDINGS): DisplayLine[] {
  const width = bindings.reduce((widest, binding) => Math.max(widest, chordList(binding).length), 0);
  const groups: BindingGroup[] = ["reading", "selection", "verbs", "review", "session"];
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

  // Text entry is a mode, not a binding, so it cannot come from the table —
  // but it is three keys and the author has to know them.
  lines.push(line([text("In a field", "statusAccent")]));
  for (const [keys, what] of [
    ["enter", "send the prompt (a new line in a manual or proposal edit)"],
    ["ctrl+s", "save a manual edit, or accept an edited proposal"],
    ["esc", "cancel the field, change nothing"],
  ]) {
    lines.push(line([text(`  ${(keys ?? "").padEnd(width, " ")}  `, "helpKey"), text(what ?? "", "prose")]));
  }
  lines.push(line([]));

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

/**
 * The field, drawn as the bottom rows of the manuscript pane (AC1, AC2).
 *
 * It is rows rather than a second renderable so that everything on screen goes
 * through one buffer and one `frameText`, which is what lets a test read the
 * field out of `handle.frame()` like any other text.
 */
export function fieldLines(field: Field, width: number): DisplayLine[] {
  const inner = Math.max(1, width - 2);
  const { rows, caret } = fieldRows(field, inner);
  const lines: DisplayLine[] = [line([text(`── ${field.title}`, "statusAccent")])];

  for (const [index, row] of rows.entries()) {
    const segments: Segment[] = [text("  ", "status")];
    if (index === caret.row) {
      segments.push(
        text(row.slice(0, caret.column), "prose"),
        text(row.charAt(caret.column) === "" ? " " : row.charAt(caret.column), "caret"),
        text(row.slice(caret.column + 1), "prose"),
      );
    } else {
      segments.push(text(row, "prose"));
    }
    lines.push(line(segments));
  }

  lines.push(line([text(`  ${field.hint}`, "status")]));
  return lines;
}

/** How many rows one side of a hunk gets before it is cut with an ellipsis. */
const HUNK_ROWS = 3;

/** One side of a hunk, wrapped and capped, with newlines shown as the spaces they read as. */
function hunkRows(marker: string, value: string, style: Segment["style"], width: number): DisplayLine[] {
  const flat = value.replace(/\s+/gu, " ").trim();
  const rows = wrap(flat === "" ? "(nothing)" : flat, Math.max(20, width - 6));
  const kept = rows.slice(0, HUNK_ROWS);
  if (rows.length > HUNK_ROWS) kept[HUNK_ROWS - 1] = `${(kept[HUNK_ROWS - 1] ?? "").slice(0, -1)}…`;

  return kept.map((row, index) =>
    line([text(index === 0 ? `  ${marker} ` : "    ", "status"), text(row, style)]),
  );
}

/**
 * The review panel: the hunk under the cursor, old against new, with its
 * receipt (AGT-1205 AC1, AC5).
 *
 * It sits at the bottom of the manuscript pane, exactly where the field does,
 * because the point of review is to read the proposal **in context** — the
 * manuscript above is still the manuscript, the mark is still rendered inline
 * by `layout.ts` in its own colours, and the cursor is on it. This panel is the
 * part the inline rendering cannot show: which hunk of how many, the two sides
 * quoted plainly next to each other, and what the run cost.
 */
export function reviewLines(state: ViewState, width: number): DisplayLine[] {
  const queue = reviewQueue(state.model);
  const mark = queue[state.review.index];
  if (mark === undefined) {
    return [line([text("── review — no proposals left in this file", "statusAccent")])];
  }

  const source = state.model.text;
  const original = originalText(source, mark);
  const proposed = proposedText(source, mark);
  const position = `${Math.min(state.review.index + 1, queue.length)} of ${queue.length}`;

  const lines: DisplayLine[] = [
    line([text(`── review — proposal ${position} · ${KIND_LABELS[mark.kind]}`, "statusAccent")]),
  ];

  switch (mark.kind) {
    case "addition":
      lines.push(...hunkRows("+", proposed ?? "", "addition", width));
      break;
    case "deletion":
      lines.push(...hunkRows("−", original, "deletion", width));
      break;
    case "substitution":
      lines.push(...hunkRows("−", original, "substitutionOld", width));
      lines.push(...hunkRows("+", proposed ?? "", "substitutionNew", width));
      break;
    case "note":
      lines.push(...hunkRows("»", original, "note", width));
      break;
    case "highlight":
      lines.push(...hunkRows("=", original, "highlight", width));
      break;
  }

  // AC5: what produced it. "no receipt" is a true statement about a file whose
  // proposals predate the log, or were written by hand, and it is said rather
  // than left blank so the row is never mistaken for a measurement of zero.
  lines.push(line([text(`    ${state.review.receipt === "" ? NO_RECEIPT : state.review.receipt}`, "status")]));
  lines.push(
    line([
      text("  y accept  ·  k reject  ·  c change  ·  n / p move  ·  Y / K all  ·  esc leaves", "status"),
    ]),
  );
  return lines;
}

/** A full-screen page of plain text: the dry-run pack preview (AC6). */
export function overlayLines(overlay: Overlay): DisplayLine[] {
  return [
    line([text(overlay.title, "heading")]),
    line([]),
    ...overlay.lines.map((row) => line([text(row, "prose")])),
    line([]),
    line([text("esc closes", "status")]),
  ];
}
