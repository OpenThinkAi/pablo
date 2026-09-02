/**
 * The view's state and the actions that move it.
 *
 * Everything here is pure: an action takes a state and returns a state, and the
 * only impure thing in the whole view — reading the file — happens in
 * `source.ts` and arrives here as `reloaded()`. That is what lets AC3 and AC4 be
 * tested without a terminal, and it is the same core/renderer discipline one
 * level down.
 *
 * A **selection always exists**. It opens on the paragraph under the cursor and
 * every action leaves one behind, including the zero-width selection at a block
 * boundary, which is a real selection with `start === end` and not a special
 * case. Structural movement is expressed entirely through the core's `expand` /
 * `shrink` ladder so the snapping rules (never cut a mark in half) hold for
 * free.
 */

import {
  expand as expandSelection,
  selectionText,
  shrink as shrinkSelection,
  type Document,
  type Granularity,
  type MarkupDocument,
  type Selection,
  type Span,
} from "@openthink/pablo-core";
import { openField, type Field } from "./field";
import {
  blockIndexAt,
  blockRowCount,
  layoutWindow,
  rowIndexAt,
  type Anchor,
  type LineCache,
  type Viewport,
} from "./layout";
import type { BriefOutcome, BriefStatus } from "./brief";
import type { Manuscript } from "./source";

/**
 * The work brief as the view holds it: one fetch per session, cached in memory,
 * shown in an overlay. `status` is the whole state machine — `none` for a file
 * that is not in a writing vault, `loading` while `think` runs off the render
 * loop, then `ready` or `unavailable`.
 */
export interface BriefPane {
  readonly open: boolean;
  /** First row shown; the brief scrolls with the same keys as the help. */
  readonly offset: number;
  readonly status: BriefStatus;
  readonly slug?: string | undefined;
  /** The brief's text, on `ready`. Read-only context: it never reaches the file. */
  readonly text?: string | undefined;
  /** Why there is no brief, on `unavailable`. One line, for the status bar (AC3). */
  readonly notice?: string | undefined;
}

export const IDLE_BRIEF: BriefPane = { open: false, offset: 0, status: "none" };
/** A full-screen page of text over the manuscript: the dry-run pack preview (AC6). */
export interface Overlay {
  readonly title: string;
  readonly lines: readonly string[];
}

/** A span cut by `move` and waiting for the boundary it lands on (AC3). */
export interface PendingMove {
  readonly span: Span;
  readonly text: string;
  /** A structural unit lands as a block, with a blank line each side; a phrase splices in. */
  readonly asBlock: boolean;
}

export type RunPhase = "sending" | "streaming" | "failed";

/** What a model run looks like on the status line, from the ask to the receipt (AC5, AC6). */
export interface RunState {
  readonly phase: RunPhase;
  readonly instruction: string;
  readonly providerId: string;
  /** The pack's size and estimated wait, shown from the ask to the first byte. */
  readonly summary: string;
  /** Just the size, which is what stays on screen once the estimate is moot. */
  readonly size: string;
  /** Wall time since the request went out, so a long prefill is visibly a wait. */
  readonly elapsedMs: number;
  readonly timeToFirstTokenMs: number | undefined;
  readonly tokensWritten: number;
  readonly tokensPerSecond: number | undefined;
  /** Set when the run failed; the message names the endpoint and the retry key. */
  readonly error: string | undefined;
}

export interface ViewState {
  readonly doc: Document;
  readonly model: MarkupDocument;
  readonly selection: Selection;
  readonly anchor: Anchor;
  /** Columns of manuscript, and rows of it — the status line is not included. */
  readonly width: number;
  readonly height: number;
  readonly help: boolean;
  /** First row of the help screen on show; the help scrolls with the same keys. */
  readonly helpOffset: number;
  /** The work brief (AC1, AC2). Present whether or not it has anything in it. */
  readonly brief: BriefPane;
  /** A transient line for the status bar: a reload notice, a read error. */
  readonly message: string;
  /**
   * The receipt of the last run. Separate from `message` because AC6 asks for
   * it to survive the re-read that follows the write it paid for, and to stay
   * until the author does something else.
   */
  readonly receipt: string;
  /** Open text entry: an instruction, or a manual replacement. Absent in reading mode. */
  readonly field: Field | undefined;
  readonly run: RunState | undefined;
  readonly overlay: Overlay | undefined;
  readonly pendingMove: PendingMove | undefined;
  /** False once the author has quit; the view tears down on the next tick. */
  readonly running: boolean;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export function viewportOf(state: ViewState): Viewport {
  return {
    width: state.width,
    height: state.height,
    anchor: state.anchor,
    selection: state.selection.span,
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * The structural unit of `granularity` around `offset`, built by walking the
 * core's ladder up from a zero-width selection. A zero-width selection expands
 * to the unit it sits in (or the nearer one at a boundary), so this is the
 * cheapest correct way to ask "what paragraph is this".
 */
export function unitAt(model: MarkupDocument, offset: number, granularity: Granularity): Selection {
  const at = clamp(offset, 0, model.text.length);
  let selection: Selection = { span: { start: at, end: at }, granularity: "character" };
  if (granularity === "character") return selection;

  for (let step = 0; step < 4; step += 1) {
    const wider = expandSelection(model, selection);
    if (wider.granularity === selection.granularity) break;
    selection = wider;
    if (selection.granularity === granularity) break;
  }
  return selection;
}

function isSpace(text: string, at: number): boolean {
  return /\s/.test(text.charAt(at));
}

/** The first offset of real content — where the view opens. */
function firstContentOffset(model: MarkupDocument): number {
  for (const block of model.blocks) {
    if (block.kind !== "blank") return block.span.start;
  }
  return 0;
}

function lastContentOffset(model: MarkupDocument): number {
  for (let index = model.blocks.length - 1; index >= 0; index -= 1) {
    const block = model.blocks[index];
    if (block !== undefined && block.kind !== "blank") return block.span.start;
  }
  return 0;
}

/**
 * The next or previous unit at the current granularity.
 *
 * The probe skips whitespace so a forward step lands *inside* the next unit
 * rather than on the boundary it just left, and the loop re-probes when the
 * unit it found is the one it started on — which happens at a boundary where
 * the previous unit is exactly as near as the next.
 */
export function stepUnit(model: MarkupDocument, selection: Selection, direction: 1 | -1): Selection {
  const text = model.text;

  if (selection.granularity === "character") {
    const width = Math.max(1, selection.span.end - selection.span.start);
    const start = clamp(selection.span.start + direction, 0, text.length);
    return { span: { start, end: Math.min(text.length, start + width) }, granularity: "character" };
  }

  let probe = direction > 0 ? selection.span.end : selection.span.start - 1;
  for (let tries = 0; tries < 8; tries += 1) {
    while (probe >= 0 && probe < text.length && isSpace(text, probe)) probe += direction;
    if (probe < 0 || probe >= text.length) return selection;

    const candidate = unitAt(model, probe, selection.granularity);
    const moved =
      direction > 0
        ? candidate.span.start > selection.span.start
        : candidate.span.start < selection.span.start;
    if (moved) return candidate;

    probe = direction > 0 ? Math.max(candidate.span.end, probe + 1) : Math.min(candidate.span.start, probe) - 1;
  }
  return selection;
}

/** Rows available from `anchor` forward, counted no further than `limit`. */
function rowsAvailable(state: ViewState, anchor: Anchor, limit: number, cache?: LineCache): number {
  let count = 0;
  for (let index = anchor.blockIndex; index < state.model.blocks.length && count < limit; index += 1) {
    const rows = blockRowCount(state.model, index, state.width, cache);
    count += index === anchor.blockIndex ? Math.max(0, rows - anchor.line) : rows;
  }
  return count;
}

/** The anchor that puts the last row of the manuscript on the last row of the screen. */
function endAnchor(state: ViewState, cache?: LineCache): Anchor {
  let total = 0;
  for (let index = state.model.blocks.length - 1; index >= 0; index -= 1) {
    const rows = blockRowCount(state.model, index, state.width, cache);
    if (total + rows >= state.height) return { blockIndex: index, line: rows - (state.height - total) };
    total += rows;
  }
  return { blockIndex: 0, line: 0 };
}

/**
 * Scroll so the selection is on screen. A selection that has moved off the
 * window brings its own block to the top: deterministic, and cheap because it
 * costs one wrapped block rather than a count of every row above it.
 */
export function follow(state: ViewState, cache?: LineCache): ViewState {
  const offset = state.selection.span.start;
  const visible = layoutWindow(state.model, viewportOf(state), cache).some(
    (line) => offset >= line.span.start && offset <= line.span.end,
  );
  if (visible) return state;

  // The gap between two blocks belongs to a block that draws nothing, and the
  // end of the file is one of those; anchoring there would show an empty
  // screen, so walk back to the last block that has rows.
  let blockIndex = blockIndexAt(state.model, offset);
  while (blockIndex > 0 && blockRowCount(state.model, blockIndex, state.width, cache) === 0) {
    blockIndex -= 1;
  }

  const anchor: Anchor = {
    blockIndex,
    line: rowIndexAt(state.model, blockIndex, offset, state.width, cache),
  };
  const limit = endAnchor(state, cache);
  const past = anchor.blockIndex > limit.blockIndex || (anchor.blockIndex === limit.blockIndex && anchor.line > limit.line);
  return { ...state, anchor: past ? limit : anchor };
}

function scrolled(state: ViewState, rows: number, cache?: LineCache): ViewState {
  let anchor = state.anchor;

  for (let step = 0; step < Math.abs(rows); step += 1) {
    if (rows > 0) {
      const count = blockRowCount(state.model, anchor.blockIndex, state.width, cache);
      const candidate: Anchor =
        anchor.line + 1 < count
          ? { blockIndex: anchor.blockIndex, line: anchor.line + 1 }
          : { blockIndex: anchor.blockIndex + 1, line: 0 };
      if (candidate.blockIndex >= state.model.blocks.length) break;
      // Stop when the final row reaches the bottom of the screen, the way a
      // pager does: past that there is nothing left to reveal.
      if (rowsAvailable(state, candidate, state.height, cache) < state.height) break;
      anchor = candidate;
    } else {
      if (anchor.line > 0) {
        anchor = { blockIndex: anchor.blockIndex, line: anchor.line - 1 };
        continue;
      }
      let index = anchor.blockIndex - 1;
      while (index >= 0 && blockRowCount(state.model, index, state.width, cache) === 0) index -= 1;
      if (index < 0) break;
      anchor = { blockIndex: index, line: blockRowCount(state.model, index, state.width, cache) - 1 };
    }
  }

  return anchor === state.anchor ? state : { ...state, anchor };
}

/**
 * Move the selection. Moving is "the next action" for AC6's purposes, so the
 * receipt clears here rather than lingering over a part of the manuscript it
 * has nothing to do with. A run does not: an in-flight one is still running and
 * a failed one still has a retry key, and both are dismissed with `esc`.
 */
function select(state: ViewState, selection: Selection, cache?: LineCache): ViewState {
  return follow({ ...state, selection, message: "", receipt: "" }, cache);
}

function edge(state: ViewState, which: "start" | "end", direction: 1 | -1, cache?: LineCache): ViewState {
  const { start, end } = state.selection.span;
  const length = state.doc.text.length;
  const span: Span =
    which === "start"
      ? { start: clamp(start + direction, 0, end), end }
      : { start, end: clamp(end + direction, start, length) };
  return select(state, { span, granularity: "character" }, cache);
}

/** An action: state in, state out. AGT-1204's span verbs are more of these. */
export type Action = (state: ViewState, cache?: LineCache) => ViewState;

/**
 * While the help or an overlay is open the scroll keys scroll *it*, so a key
 * map or a dry-run preview taller than the terminal is still readable to the
 * end. The upper bound depends on the rendered page, so it is clamped where
 * that is known — in the view's draw.
 */
function scrollAny(state: ViewState, rows: number, cache?: LineCache): ViewState {
  if (state.brief.open) {
    const offset = Math.max(0, state.brief.offset + rows);
    return offset === state.brief.offset ? state : { ...state, brief: { ...state.brief, offset } };
  }
  if (!state.help && state.overlay === undefined) return scrolled(state, rows, cache);
  const helpOffset = Math.max(0, state.helpOffset + rows);
  return helpOffset === state.helpOffset ? state : { ...state, helpOffset };
}

/** Why the brief is not on screen, said in one line. */
export function briefNotice(brief: BriefPane): string {
  switch (brief.status) {
    case "loading":
      return "the work brief is still loading";
    case "unavailable":
      return brief.notice ?? "the work brief is not available";
    case "ready":
      return "";
    default:
      return "no work brief: this file is not under <vault>/<kind>/<slug>/";
  }
}

/**
 * Close every full-screen page: the help, the brief, and the dry-run preview.
 *
 * There are three of them now and only one screen, so every action that opens
 * one starts by closing the others. Doing it in one place is what stops the
 * fourth page from being the one that forgets.
 */
function closePages(state: ViewState): ViewState {
  return {
    ...state,
    help: false,
    helpOffset: 0,
    overlay: undefined,
    brief: { ...state.brief, open: false, offset: 0 },
  };
}

export const ACTIONS: Readonly<Record<string, Action>> = {
  quit: (state) => ({ ...state, running: false }),
  toggleHelp: (state) => ({
    ...closePages(state),
    help: !state.help,
    message: "",
  }),
  dismiss: (state) => ({
    ...closePages(state),
    message: "",
    run: state.run?.phase === "failed" ? undefined : state.run,
    pendingMove: undefined,
  }),

  // One page at a time: the brief replaces the help and the dry run rather than
  // stacking on either. A brief that is not ready says why in the status line
  // instead of opening an empty pane.
  toggleBrief: (state) => {
    if (state.brief.open) return { ...closePages(state), message: "" };
    if (state.brief.status !== "ready") return { ...state, message: briefNotice(state.brief) };
    return { ...closePages(state), brief: { ...state.brief, open: true, offset: 0 }, message: "" };
  },

  scrollDown: (state, cache) => scrollAny(state, 1, cache),
  scrollUp: (state, cache) => scrollAny(state, -1, cache),
  pageDown: (state, cache) => scrollAny(state, Math.max(1, state.height - 1), cache),
  pageUp: (state, cache) => scrollAny(state, -Math.max(1, state.height - 1), cache),

  top: (state, cache) =>
    select(
      { ...state, anchor: { blockIndex: 0, line: 0 } },
      unitAt(state.model, firstContentOffset(state.model), state.selection.granularity),
      cache,
    ),
  bottom: (state, cache) =>
    select(
      { ...state, anchor: endAnchor(state, cache) },
      unitAt(state.model, lastContentOffset(state.model), state.selection.granularity),
      cache,
    ),

  next: (state, cache) => select(state, stepUnit(state.model, state.selection, 1), cache),
  previous: (state, cache) => select(state, stepUnit(state.model, state.selection, -1), cache),
  expand: (state, cache) => select(state, expandSelection(state.model, state.selection), cache),
  shrink: (state, cache) => select(state, shrinkSelection(state.model, state.selection), cache),

  startBack: (state, cache) => edge(state, "start", -1, cache),
  startForward: (state, cache) => edge(state, "start", 1, cache),
  endBack: (state, cache) => edge(state, "end", -1, cache),
  endForward: (state, cache) => edge(state, "end", 1, cache),

  collapseStart: (state, cache) =>
    select(
      state,
      { span: { start: state.selection.span.start, end: state.selection.span.start }, granularity: "character" },
      cache,
    ),
  collapseEnd: (state, cache) =>
    select(
      state,
      { span: { start: state.selection.span.end, end: state.selection.span.end }, granularity: "character" },
      cache,
    ),
};

/*
 * The verb transitions (AGT-1204).
 *
 * Each verb has a pure half here and, where it has to reach the disk, a
 * provider or `$EDITOR`, an impure half in `view.ts` — the same split `reload`
 * has had since AGT-1203. These are the pure halves: opening and closing a
 * field, remembering a cut that is waiting for a boundary, and the four states
 * a run passes through on the status line.
 */

/** AC1: the one-line intent field over the current selection. */
export function openPrompt(state: ViewState, value = ""): ViewState {
  return { ...closePages(state), field: openField("prompt", value), message: "", receipt: "" };
}

/** AC2: the multi-line field, pre-filled with the span it will replace. */
export function openManual(state: ViewState): ViewState {
  const value = selectionText(state.doc, state.selection.span);
  return { ...closePages(state), field: openField("manual", value), message: "", receipt: "" };
}

export function withField(state: ViewState, field: Field): ViewState {
  return { ...state, field };
}

export function closeField(state: ViewState, message = ""): ViewState {
  return { ...state, field: undefined, message };
}

export function showOverlay(state: ViewState, overlay: Overlay): ViewState {
  return { ...closePages(state), overlay, message: "" };
}

/**
 * The granularities whose spans are whole blocks and land with a blank line on
 * each side. Named rather than excluded, so a granularity added later is inline
 * until someone decides otherwise instead of silently becoming a block.
 */
const BLOCK_GRANULARITIES: ReadonlySet<Granularity> = new Set<Granularity>([
  "paragraph",
  "scene",
  "chapter",
]);

/**
 * AC3, first half of `move`: remember the span and what it is, without writing.
 * The file is never on disk in the half-moved state, because the cut and the
 * insert are one write on the second press.
 */
export function beginMove(state: ViewState): ViewState {
  const { span, granularity } = state.selection;
  if (span.start === span.end) return { ...state, message: "nothing is selected to move" };
  return {
    ...state,
    pendingMove: {
      span,
      text: selectionText(state.doc, span),
      asBlock: BLOCK_GRANULARITIES.has(granularity),
    },
    message: "moving: put the cursor on a boundary and press m again (esc cancels)",
    receipt: "",
  };
}

export function clearMove(state: ViewState, message = ""): ViewState {
  return { ...state, pendingMove: undefined, message };
}

/** AC6: the pack's size and estimated wait go up before the first byte does. */
export function runStarted(
  state: ViewState,
  run: Pick<RunState, "instruction" | "providerId" | "summary" | "size">,
): ViewState {
  return {
    ...state,
    run: {
      ...run,
      phase: "sending",
      elapsedMs: 0,
      timeToFirstTokenMs: undefined,
      tokensWritten: 0,
      tokensPerSecond: undefined,
      error: undefined,
    },
    message: "",
    receipt: "",
  };
}

export function runProgress(
  state: ViewState,
  progress: Pick<RunState, "elapsedMs" | "timeToFirstTokenMs" | "tokensWritten" | "tokensPerSecond">,
): ViewState {
  if (state.run === undefined) return state;
  return { ...state, run: { ...state.run, ...progress, phase: "streaming" } };
}

/**
 * The clock ticking while nothing has come back yet. Its own transition
 * because it must not turn a `sending` run into a `streaming` one: no token has
 * arrived, and claiming otherwise on screen is the lie AC6 exists to prevent.
 */
export function runWaiting(state: ViewState, elapsedMs: number): ViewState {
  if (state.run === undefined || state.run.phase === "failed") return state;
  return { ...state, run: { ...state.run, elapsedMs } };
}

/** AC5: a failure stays on screen, names its endpoint, and offers the retry key. */
export function runFailed(state: ViewState, error: string): ViewState {
  if (state.run === undefined) return state;
  return { ...state, run: { ...state.run, phase: "failed", error } };
}

/** AC6: the run ends, and its receipt is what is left behind. */
export function runFinished(state: ViewState, receipt: string): ViewState {
  return { ...state, run: undefined, receipt, message: "" };
}

/** Dispatch an action id. Unknown ids are ignored, not thrown: the map is data. */
export function applyAction(
  state: ViewState,
  action: string,
  cache?: LineCache,
  actions: Readonly<Record<string, Action>> = ACTIONS,
): ViewState {
  const run = actions[action];
  return run === undefined ? state : run(state, cache);
}

/** The session has started fetching the brief for `slug` (AC1). */
export function briefStarted(state: ViewState, slug: string): ViewState {
  return { ...state, brief: { ...state.brief, status: "loading", slug } };
}

/**
 * The fetch came back. A failure is a one-line notice in the status bar and
 * nothing else: the view was already open and stays open (AC3).
 */
export function briefLoaded(state: ViewState, outcome: BriefOutcome): ViewState {
  if (outcome.status === "ready") {
    return { ...state, brief: { ...state.brief, status: "ready", text: outcome.text, notice: undefined } };
  }
  const notice = outcome.notice ?? "the work brief is not available";
  return {
    ...state,
    brief: { ...state.brief, open: false, offset: 0, status: "unavailable", text: undefined, notice },
    message: notice,
  };
}

export function initialState(manuscript: Manuscript, size: Size, brief: BriefPane = IDLE_BRIEF): ViewState {
  const model = manuscript.model;
  return {
    doc: manuscript.doc,
    model,
    selection: unitAt(model, firstContentOffset(model), "paragraph"),
    anchor: { blockIndex: 0, line: 0 },
    width: Math.max(1, size.width),
    height: Math.max(1, size.height),
    help: false,
    helpOffset: 0,
    brief,
    message: "",
    receipt: "",
    field: undefined,
    run: undefined,
    overlay: undefined,
    pendingMove: undefined,
    running: true,
  };
}

export function resized(state: ViewState, size: Size): ViewState {
  return { ...state, width: Math.max(1, size.width), height: Math.max(1, size.height) };
}

/**
 * Adopt a re-read of the file (AC4).
 *
 * Offsets are UTF-16 code units into the exact text that was parsed, so every
 * one of them is invalidated by a write. Keeping the cursor *position* across a
 * reload therefore means keeping the offsets and clamping them to the new
 * length — the paragraph the author was on stays under the cursor for the edit
 * they actually make in `$EDITOR`, and a file that shrank out from under the
 * selection leaves it at the new end rather than out of bounds.
 */
export function reloaded(
  state: ViewState,
  manuscript: Manuscript,
  cache?: LineCache,
  message = "reloaded from disk",
): ViewState {
  const length = manuscript.doc.text.length;
  const start = clamp(state.selection.span.start, 0, length);
  const end = clamp(state.selection.span.end, start, length);
  const blockIndex = clamp(state.anchor.blockIndex, 0, Math.max(0, manuscript.model.blocks.length - 1));

  const next: ViewState = {
    ...state,
    doc: manuscript.doc,
    model: manuscript.model,
    selection: { span: { start, end }, granularity: state.selection.granularity },
    anchor: {
      blockIndex,
      line: Math.min(
        state.anchor.line,
        Math.max(0, blockRowCount(manuscript.model, blockIndex, state.width, cache) - 1),
      ),
    },
    message,
  };
  return follow(next, cache);
}

/**
 * Adopt a write pablo just made, putting the selection on the text it produced
 * rather than where the cursor happened to be. Every offset the caller held is
 * dead by now — the write moved them — so the new span comes from the edit.
 */
export function applied(
  state: ViewState,
  manuscript: Manuscript,
  span: Span,
  message: string,
  cache?: LineCache,
): ViewState {
  const reread = reloaded(state, manuscript, cache, message);
  const length = manuscript.doc.text.length;
  const start = clamp(span.start, 0, length);
  return follow(
    {
      ...reread,
      selection: { span: { start, end: clamp(span.end, start, length) }, granularity: state.selection.granularity },
      pendingMove: undefined,
    },
    cache,
  );
}
