// The screen's state, pure: where the author is and what is open, changed only by named actions through `reduce`.
// Nothing here knows Ink or React, so every action is tested without a terminal, and the Ink layer (app.tsx) only
// reads this state and dispatches actions. prview grew its screen logic into a 1,000-line component holding twenty
// useStates; pablo keeps it out of the rendering layer from the start.
//
// The model holds positions and openings, not text: the rail's rows are an index (an id, a depth, whether the row
// folds), the main pane knows how many lines it has, the content area what it shows. The documents themselves are
// props of the Ink layer, loaded from the vault, and only their shape (`rail.loaded`, `main.loaded`) reaches here.
//
//   mode     book (the stage machine in the rail, a document in the main pane), review (a branch's changes) or compose
//            (the full-screen conversation with pablo, which remembers the mode Esc returns to)
//   pane     the rail or the main pane, where the cursor is
//   focus    that pane, or the content area while Tab has moved focus into it
//   content  the one thing the bottom panel shows, scrollable, closed by Esc
//   pending  a prefix waiting for its second key (`a`, `g`), with the digits of a `g <n>` line number
//   zen      the rail hidden; `full`: the content area taking the screen under the status area
//
// Each mode keeps its own rail and main pane, so leaving a review returns to the book where it was left. Settings holds
// its own model (`settings`, below) instead of a rail and main pane; the settings logic is settings.ts, and reaches
// here as whole values (`settings.set`), so this file stays free of imports. The conversation (`compose`) belongs to
// the screen, not to a mode's data: Esc leaves the view and the session, its entries and any reply still streaming in
// carry on, and `a c` comes back to them. The session itself runs behind a seam the layer above passes in (compose.ts);
// here are only its entries, the author's input and what is in flight.

/** The id prefix of a rail row that names a branch waiting for review (`branch:draft/ch03`). */
export const BRANCH_ROW = "branch:";

/** The id prefix of a rail row that is one change in a review (`edit:3`): the rows a mark can be put on. */
export const EDIT_ROW = "edit:";
/** The author's decision on a change; a change with none is still pending. */
export type Mark = "accepted" | "rejected";

/** A review opened from the compose view carries `back`, the place compose was opened from: Esc returns to compose, not the book. */
export type Place = { kind: "book" } | { kind: "review"; branch: string; back?: Place };
/** Settings (`\`) and compose (`a c`) are modes over a place: closing one returns to where it was opened, with that place's own rail and main pane. */
export type Mode = Place | { kind: "settings"; from: Place } | { kind: "compose"; from: Place };
export type PaneName = "rail" | "main";
export type Focus = PaneName | "content";

/** A row of the rail: a stage, a chapter, a change. A `group` row folds the deeper rows after it until the next row at its depth or above. */
export interface RailRow { readonly id: string; readonly depth: number; readonly group?: boolean }

/** The lines a sentence covers, first to last (both inclusive; a wrapped sentence covers several, and two sentences may share a line). */
export interface LineSpan { readonly first: number; readonly last: number }
export interface Selection { readonly anchor: number; readonly head: number }

/** A scrolling region: `scroll` is the first visible line, `length` how many there are, `visible` how many fit (0 until measured). */
export interface Scroll { readonly scroll: number; readonly length: number; readonly visible: number }
/** A region with a cursor, kept in view as it moves. */
export interface Pane extends Scroll {
  readonly cursor: number;
  /** Where each sentence of the document sits among the lines (inclusive), in order; empty when the pane's lines are not a document. */
  readonly sentences: readonly LineSpan[];
  /** The selected sentences, by index into `sentences`: `head` is the end the arrows move, `anchor` where it began. */
  readonly selection: Selection | null;
  /** The document the main pane shows, once one is loaded: a different one starts at its top. */
  readonly doc?: string;
}
/** The rail: `cursor` indexes `rows`; a folded group's rows are skipped by the moves and left out of the scroll. */
export interface Rail { readonly rows: readonly RailRow[]; readonly collapsed: ReadonlySet<string>; readonly cursor: number; readonly scroll: number; readonly visible: number }
export interface View { readonly rail: Rail; readonly main: Pane }

// ---- the settings screen's model: data only; the rules that change it are in settings.ts

/** A line of the settings list: one action's keys, or the editor command. */
export type SettingsField = { readonly kind: "key"; readonly id: string } | { readonly kind: "editor" };
/** What the screen edits, spelled out: an unbound secondary or an unset editor is "". */
export interface SettingsValues { readonly keys: Readonly<Record<string, { readonly primary: string; readonly secondary: string }>>; readonly editor: string }
/** What is being captured, typed or asked: a key press, the editor line, or the save question on the way out. */
export type SettingsSub = { readonly kind: "capture" } | { readonly kind: "typing"; readonly text: string } | { readonly kind: "confirm" };
export interface SettingsModel {
  readonly fields: readonly SettingsField[];
  /** As loaded: what "unsaved changes" and a save compare against. */
  readonly initial: SettingsValues;
  readonly values: SettingsValues;
  readonly cursor: number;
  /** On a key: which of its two bindings the cursor is on. */
  readonly slot: "primary" | "secondary";
  readonly sub: SettingsSub | null;
  /** The config file a save writes. */
  readonly path: string;
  /** What the last key did, or why it was refused. */
  readonly message?: { readonly text: string; readonly error?: boolean };
}
/** What a save leaves in force for the rest of the session: the `keys` overrides and the editor command, as written. */
export interface SavedSettings { readonly overrides: Readonly<Record<string, { readonly primary?: string; readonly secondary?: string }>>; readonly editor: string }

/** What the content area shows: a planner turn, a receipt, a beat, a refusal's missing reasons. */
export interface Content { readonly title: string; readonly body: string; /** Which feature put it up, so that feature can take it down again (`missing`: a stage's unmet reasons). */ readonly kind?: string }
/** A prefix waiting for its second key; `digits` while a number is typed after it (`g 12`). */
export interface Pending { readonly prefix: string; readonly digits?: string }

/**
 * One thing said in the conversation. `question` is the card `ask_author` stops the loop with (AGT-1560): shown in
 * place, `answer` filled when the author replies. Entries are data, so a new kind is one more variant here and one
 * more case in compose.ts's `composeLines`.
 */
export type ComposeEntry =
  | { readonly kind: "author"; readonly text: string }
  | { readonly kind: "pablo"; readonly text: string }
  | { readonly kind: "tool"; readonly id: string; readonly tool: string; readonly input: unknown; readonly result?: { readonly text: string; readonly isError: boolean }; /** When the call began and ended (ms), for the activity line's duration (AGT-1567). */ readonly startedAt?: number; readonly endedAt?: number }
  | { readonly kind: "question"; readonly id: string; readonly question: string; readonly options?: readonly string[]; readonly why?: string; readonly answer?: string }
  | { readonly kind: "error"; readonly text: string };

/** What the session reports as a turn runs; the seam's stream (compose.ts `Composer`) yields these. */
export type ComposeEvent =
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "tool_call"; readonly id: string; readonly tool: string; readonly input: unknown }
  | { readonly kind: "tool_result"; readonly id: string; readonly text: string; readonly isError: boolean }
  | { readonly kind: "result"; readonly ok: boolean; readonly errors: readonly string[] }
  /** `ask_author` has stopped the loop: the card is shown in place and the author's next line answers it. */
  | { readonly kind: "question"; readonly id: string; readonly question: string; readonly options: readonly string[]; readonly why: string };

/**
 * The conversation: `entries`, the author's `input` line, whether a turn is `busy` and what it is doing (`activity`),
 * the session's id once it has one (`sessionId`, for saved sessions, AGT-1565). `outbox` is the message the layer
 * above must send, `sendSeq` counts sends so an effect fires once per message. `offset` is how many lines the view is
 * scrolled up from the newest; `length` and `visible` come from the layout like every other scroll.
 */
export interface Compose {
  readonly entries: readonly ComposeEntry[];
  readonly input: string;
  readonly busy: boolean;
  readonly activity: string;
  readonly sessionId: string | null;
  readonly outbox: string | null;
  readonly sendSeq: number;
  /** The author's answer to a question card, for the layer above to hand to the session; `replySeq` counts them. */
  readonly reply: { readonly id: string; readonly text: string } | null;
  readonly replySeq: number;
  readonly offset: number;
  readonly length: number;
  readonly visible: number;
  /** The branches the session's tools report making (`plan/`, `draft/`, `revise/` names in their results), oldest first. */
  readonly branches: readonly string[];
  /** The branch list's cursor while Tab has moved the keys into it (Enter opens that branch in review); null while typing. */
  readonly pick: number | null;
}

export interface State {
  readonly mode: Mode;
  readonly compose: Compose;
  readonly book: View;
  readonly review: View;
  /** The open review's decisions, by change id (`edit:<n>`); empty outside a review and fresh on each `review.open`. */
  readonly marks: Readonly<Record<string, Mark>>;
  readonly pane: PaneName;
  readonly focus: Focus;
  readonly content: Content | null;
  readonly contentScroll: Scroll;
  readonly pending: Pending | null;
  readonly zen: boolean;
  readonly full: boolean;
  /** The settings screen's model while the mode is `settings`. */
  readonly settings: SettingsModel | null;
  /** Set by a save: the bindings and editor now in force, over what the screen opened with. */
  readonly saved: SavedSettings | null;
  /** The chapter being written (`a w`) while the writer runs; one at a time. */
  readonly writing: number | null;
  /** Branches this session's writes made, so the book lists them as waiting for review. */
  readonly written: readonly string[];
  /** The branch whose review is being finished (`s`) while the merge and the after-write steps run; one at a time. */
  readonly finishing: string | null;
  /** Branches this session finished (merged or discarded): the book no longer lists them, though its `branches` prop still does. */
  readonly finished: readonly string[];
}

/**
 * What the layout measured, dispatched whenever the terminal size or the content changes: rows each region can show,
 * and for the content area also how many lines its text wraps to at the width it has (the model never wraps text).
 */
export interface Measure {
  readonly rail?: number; readonly main?: number; readonly content?: { readonly visible: number; readonly lines: number };
  /** The conversation's rows and how many lines its entries wrap to at its width. */
  readonly compose?: { readonly visible: number; readonly lines: number };
}

export type Action =
  // ---- the rail: the moves skip a folded group's rows; → unfolds, steps into, or enters the main pane; ← folds or steps out
  | { type: "rail.loaded"; rows: readonly RailRow[]; folded?: readonly string[] }
  | { type: "rail.down" } | { type: "rail.up" }
  | { type: "rail.next_group" } | { type: "rail.prev_group" }
  | { type: "rail.expand" } | { type: "rail.collapse" }
  // Enter: on a branch row (`branch:<name>`, a branch waiting for review) opens the review; elsewhere it is → (`rail.expand`)
  | { type: "rail.open" }
  // ---- the main pane: a document's lines, one sentence each
  | { type: "main.loaded"; lines: number; doc?: string; sentences?: readonly LineSpan[] }
  | { type: "main.down" } | { type: "main.up" }
  | { type: "main.page_down" } | { type: "main.page_up" }
  | { type: "main.top" } | { type: "main.end" }
  | { type: "main.goto"; line: number }
  | { type: "main.to_rail" }
  // ---- selecting sentences: ⇧↓ / ⇧↑ extend by a whole sentence (the first press takes the one under the cursor), Esc clears
  | { type: "select.down" } | { type: "select.up" } | { type: "select.clear" }
  // ---- the content area
  | { type: "content.show"; content: Content }
  | { type: "content.close" }
  | { type: "content.down" } | { type: "content.up" }
  | { type: "content.page_down" } | { type: "content.page_up" }
  // ---- focus: Tab into the content area and back
  | { type: "focus.content" } | { type: "focus.back" }
  // ---- a prefix being typed
  | { type: "prefix.press"; prefix: string }
  | { type: "prefix.digit"; digit: string }
  | { type: "prefix.backspace" }
  | { type: "prefix.clear" }
  // ---- the view
  | { type: "view.zen" } | { type: "view.full" }
  // ---- modes
  | { type: "review.open"; branch: string }
  | { type: "review.close" }
  // `a w`: start writing a chapter, stream the writer's progress into the content area, then open the review on the new
  // branch with the receipt shown, or show the refusal and its missing reasons
  | { type: "write.start"; chapter: number }
  | { type: "write.progress"; line: string }
  | { type: "write.done"; branch: string; lines: readonly string[] }
  | { type: "write.failed"; message: string; missing: readonly string[] }
  // y / n on the change under the rail's cursor: sets the mark; the same mark again clears it, the other one changes it
  | { type: "review.mark"; mark: Mark }
  // `s`: finish the review (merge what was accepted, run the after-write steps); done closes the review with the
  // result shown in the content area, failed stays in the review with the reason shown
  | { type: "finish.start"; branch: string }
  | { type: "finish.done"; branch: string; lines: readonly string[] }
  | { type: "finish.failed"; message: string }
  | { type: "settings.open"; settings: SettingsModel }
  | { type: "settings.set"; settings: SettingsModel }
  | { type: "settings.close"; saved?: SavedSettings }
  // ---- compose: the conversation with pablo (`a c` opens it, Esc leaves it with the session kept)
  | { type: "compose.open" } | { type: "compose.close" }
  | { type: "compose.type"; text: string } | { type: "compose.backspace" }
  | { type: "compose.submit" }
  | { type: "compose.event"; event: ComposeEvent; /** When the layer above saw it (ms); the reducer reads no clock, so tool durations come from this. */ at?: number }
  | { type: "compose.add"; entry: ComposeEntry }
  | { type: "compose.failed"; message: string }
  | { type: "compose.done" }
  // Tab moves between the input and the branches the session made; Up/Down move in the list, Enter opens the branch in review.
  | { type: "compose.pick" } | { type: "compose.pick_move"; by: number } | { type: "compose.open_branch" }
  | { type: "compose.up" } | { type: "compose.down" } | { type: "compose.page_up" } | { type: "compose.page_down" }
  // ---- Esc: back out of whatever is open, one thing at a time
  | { type: "escape" }
  // ---- the layout's measure of each region
  | { type: "measured"; measure: Measure };

export type ActionType = Action["type"];
export type Dispatch = (action: Action) => void;

/** A write streams a progress line every couple of seconds; the content area keeps the latest few, so the newest is always in view. */
const PROGRESS_LINES = 5;
const writeContent = (title: string, body: string): Content => ({ title, body, kind: "write" });

const emptyView = (): View => ({ rail: { rows: [], collapsed: new Set(), cursor: 0, scroll: 0, visible: 0 }, main: { cursor: 0, scroll: 0, length: 0, visible: 0, sentences: [], selection: null } });

export const initialCompose = (): Compose => ({ entries: [], input: "", busy: false, activity: "", sessionId: null, outbox: null, sendSeq: 0, reply: null, replySeq: 0, offset: 0, length: 0, visible: 0, branches: [], pick: null });

export const initialState = (): State => ({
  mode: { kind: "book" }, compose: initialCompose(), book: emptyView(), review: emptyView(), marks: {},
  pane: "rail", focus: "rail", content: null, contentScroll: { scroll: 0, length: 0, visible: 0 }, pending: null, zen: false, full: false, settings: null, saved: null, writing: null, written: [], finishing: null, finished: [],
});

// ---------------------------------------------------------------- reading the state

/** The book or review the screen is over: the mode itself, or what settings or compose was opened from. */
export const placeOf = (s: State): Place => (s.mode.kind === "settings" || s.mode.kind === "compose" ? s.mode.from : s.mode);

/** The rail and main pane of the current mode (under settings or compose, those of the place it was opened from). */
export const viewOf = (s: State): View => (placeOf(s).kind === "book" ? s.book : s.review);

/** The rail's rows as drawn, in order, with their index in `rows`: a folded group's rows are left out. */
export function shownRows(rail: Rail): { row: RailRow; index: number }[] {
  const out: { row: RailRow; index: number }[] = [];
  let hiddenBelow: number | null = null; // the depth of the folded group whose rows are being skipped
  rail.rows.forEach((row, index) => {
    if (hiddenBelow !== null && row.depth > hiddenBelow) return;
    hiddenBelow = row.group && rail.collapsed.has(row.id) ? row.depth : null;
    out.push({ row, index });
  });
  return out;
}

/** The selected sentences as a range of indexes, first to last inclusive; null with nothing selected. */
export const selectedRange = (main: Pane): { first: number; last: number } | null =>
  main.selection ? { first: Math.min(main.selection.anchor, main.selection.head), last: Math.max(main.selection.anchor, main.selection.head) } : null;

/** The row under the rail's cursor, or undefined with no rows loaded. */
export const railRow = (rail: Rail): RailRow | undefined => rail.rows[rail.cursor];

/** The open review's changes by decision: how many are accepted, rejected and still pending (a mark on a change no longer in the rail is not counted). */
export function reviewCounts(s: State): { accepted: number; rejected: number; pending: number } {
  const out = { accepted: 0, rejected: 0, pending: 0 };
  if (placeOf(s).kind !== "review") return out;
  for (const r of s.review.rail.rows) {
    if (!r.id.startsWith(EDIT_ROW)) continue;
    const m = s.marks[r.id];
    if (m === "accepted") out.accepted++; else if (m === "rejected") out.rejected++; else out.pending++;
  }
  return out;
}

/** What the footer shows while a chord is being typed: `g`, `g 12`. */
export const pendingText = (p: Pending | null): string => (!p ? "" : `${p.prefix}${p.digits !== undefined ? ` ${p.digits}` : ""}`);

// ---------------------------------------------------------------- helpers

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, hi));
/** The scroll that keeps `cursor` on the screen, moving as little as it can, and never past the end; unmeasured (visible 0), it stays. */
const follow = (cursor: number, scroll: number, visible: number, length: number): number =>
  !visible ? scroll : clamp(cursor < scroll ? cursor : cursor >= scroll + visible ? cursor - visible + 1 : scroll, 0, Math.max(0, length - visible));
const clampScroll = (r: Scroll, scroll: number): Scroll => ({ ...r, scroll: clamp(scroll, 0, Math.max(0, r.length - (r.visible || r.length))) });
/** A page keeps one line of the previous page in view, so the eye has something to hold on to. */
const pageStep = (visible: number) => Math.max(1, visible - 1);

const moveTo = (p: Pane, cursor: number): Pane => {
  const at = clamp(cursor, 0, Math.max(0, p.length - 1));
  return { ...p, cursor: at, scroll: follow(at, p.scroll, p.visible, p.length) };
};
const scrollBy = (r: Scroll, by: number): Scroll => clampScroll(r, r.scroll + by);

/** The group row that holds `index`: the nearest row before it at a lower depth. */
const parentOf = (rows: readonly RailRow[], index: number): number => {
  const depth = rows[index]?.depth ?? 0;
  for (let i = index - 1; i >= 0; i--) if (rows[i]!.depth < depth) return i;
  return -1;
};

/** The rail with its cursor on `index`, scrolled to keep it in view among the shown rows. */
const railTo = (rail: Rail, index: number): Rail => {
  const shown = shownRows(rail);
  const at = shown.findIndex((r) => r.index === index);
  return { ...rail, cursor: index, scroll: follow(at < 0 ? 0 : at, rail.scroll, rail.visible, shown.length) };
};

function reduceRail(rail: Rail, a: Action): Rail {
  const shown = shownRows(rail);
  const at = shown.findIndex((r) => r.index === rail.cursor);
  const row = railRow(rail);
  const step = (to: { index: number } | undefined) => (to ? railTo(rail, to.index) : rail);
  const fold = (id: string, folded: boolean) => { const c = new Set(rail.collapsed); if (folded) c.add(id); else c.delete(id); return c; };
  switch (a.type) {
    case "rail.loaded": {
      // The same row, if it is still there, else the row at the same place: a reload after a write keeps the author's spot.
      // Folds are kept for the groups that remain; a spot now inside a fold goes up to the folded group.
      const same = row ? a.rows.findIndex((r) => r.id === row.id) : -1;
      // `folded` names the groups that start folded: honoured on the first load, when the rail had no rows yet.
      const kept = new Set(rail.rows.length === 0 ? (a.folded ?? []) : [...rail.collapsed].filter((id) => a.rows.some((r) => r.id === id && r.group)));
      const loaded: Rail = { ...rail, rows: a.rows, collapsed: kept };
      let index = clamp(same >= 0 ? same : rail.cursor, 0, Math.max(0, a.rows.length - 1));
      const visible = new Set(shownRows(loaded).map((r) => r.index));
      while (index > 0 && !visible.has(index)) index = parentOf(a.rows, index);
      return railTo(loaded, Math.max(0, index));
    }
    case "rail.down": return step(shown[at + 1]);
    case "rail.up": return step(shown[at - 1]);
    // ⇧↓ / ⇧↑: the next or previous group at the cursor's group's depth (or above), the way prview walks chapters.
    case "rail.next_group": case "rail.prev_group": {
      if (!row) return rail;
      const base = row.group ? rail.cursor : parentOf(rail.rows, rail.cursor);
      const depth = base < 0 ? row.depth : rail.rows[base]!.depth;
      const groups = shown.filter((r) => r.row.group && r.row.depth <= depth && r.index !== base);
      return step(a.type === "rail.next_group" ? groups.find((r) => r.index > rail.cursor) : groups.filter((r) => r.index < rail.cursor).pop());
    }
    case "rail.expand": {
      if (!row?.group) return rail;
      if (rail.collapsed.has(row.id)) return { ...rail, collapsed: fold(row.id, false) };
      const child = rail.rows[rail.cursor + 1];
      return child && child.depth > row.depth ? railTo(rail, rail.cursor + 1) : rail;
    }
    case "rail.collapse": {
      if (!row) return rail;
      if (row.group && !rail.collapsed.has(row.id)) return railTo({ ...rail, collapsed: fold(row.id, true) }, rail.cursor);
      const parent = parentOf(rail.rows, rail.cursor);
      return parent < 0 ? rail : railTo(rail, parent);
    }
    default: return rail;
  }
}

function reduceMain(main: Pane, a: Action): Pane {
  switch (a.type) {
    // A different document (by id) starts at its top; the same one, rewrapped or reloaded, keeps the author's line.
    // The selection survives a rewrap of the same document (the same sentences, new lines); any other change drops it.
    case "main.loaded": {
      const fresh = a.doc !== undefined && a.doc !== main.doc;
      const sentences = a.sentences ?? [];
      const keep = !fresh && sentences.length === main.sentences.length;
      const base = fresh ? { ...main, cursor: 0, scroll: 0 } : main;
      return moveTo({ ...base, length: a.lines, sentences, selection: keep ? main.selection : null, ...(a.doc !== undefined ? { doc: a.doc } : {}) }, base.cursor);
    }
    // Moving the cursor on its own leaves the selection (the author is looking around; Esc clears it); only ⇧ extends it.
    case "main.down": return moveTo(main, main.cursor + 1);
    case "main.up": return moveTo(main, main.cursor - 1);
    case "main.page_down": return moveTo(main, main.cursor + pageStep(main.visible));
    case "main.page_up": return moveTo(main, main.cursor - pageStep(main.visible));
    case "main.top": return moveTo(main, 0);
    case "main.end": return moveTo(main, main.length - 1);
    case "main.goto": return moveTo(main, a.line - 1);
    case "select.clear": return main.selection ? { ...main, selection: null } : main;
    case "select.down": case "select.up": {
      const n = main.sentences.length;
      if (n === 0) return main;
      // No selection yet: it starts on the sentence under the cursor (the first one that reaches it), and ⇧ moves the head from there.
      let start: Selection;
      if (main.selection) start = main.selection;
      else {
        const at = main.sentences.findIndex((x) => x.last >= main.cursor);
        const i = at < 0 ? n - 1 : at;
        start = { anchor: i, head: i };
      }
      const head = main.selection ? clamp(start.head + (a.type === "select.down" ? 1 : -1), 0, n - 1) : start.head;
      // The cursor goes to the head so it stays in view.
      return { ...moveTo(main, main.sentences[head]!.first), selection: { anchor: start.anchor, head } };
    }
    default: return main;
  }
}

/** Scrolls the conversation `by` lines further back (negative: towards the newest), held within what there is. */
const scrollCompose = (c: Compose, by: number): Compose => ({ ...c, offset: clamp(c.offset + by, 0, Math.max(0, c.length - (c.visible || c.length))) });

/** The question card still waiting for an answer, if any. */
export const openQuestion = (c: Compose): Extract<ComposeEntry, { kind: "question" }> | undefined =>
  c.entries.find((e): e is Extract<ComposeEntry, { kind: "question" }> => e.kind === "question" && e.answer === undefined);

/** The branches a tool's result names: the kinds compose makes (`plan/`, `draft/`, `revise/`), each once, in order. */
export const BRANCH_NAME = /\b(?:plan|draft|revise)\/[A-Za-z0-9][A-Za-z0-9._/-]*/g;
const branchesIn = (text: string): string[] => [...text.matchAll(BRANCH_NAME)].map((m) => m[0].replace(/[._/-]+$/, ""));

/** A session event applied to the conversation; a new line of it brings the view back to the newest. */
function reduceEvent(c: Compose, e: ComposeEvent, at?: number): Compose {
  switch (e.kind) {
    case "session": return { ...c, sessionId: e.id };
    case "assistant": return { ...c, entries: [...c.entries, { kind: "pablo", text: e.text }], offset: 0 };
    case "tool_call": return { ...c, entries: [...c.entries, { kind: "tool", id: e.id, tool: e.tool, input: e.input, ...(at === undefined ? {} : { startedAt: at }) }], activity: `calling ${e.tool}`, offset: 0 };
    case "question": {
      const card: ComposeEntry = { kind: "question", id: e.id, question: e.question, options: e.options, why: e.why };
      return { ...c, entries: [...c.entries, card], activity: "waiting for your answer", offset: 0 };
    }
    case "tool_result": {
      const seen = e.isError ? [] : branchesIn(e.text).filter((b, i, all) => all.indexOf(b) === i && !c.branches.includes(b));
      return { ...c, branches: [...c.branches, ...seen], activity: "thinking", entries: c.entries.map((x) => (x.kind === "tool" && x.id === e.id ? { ...x, result: { text: e.text, isError: e.isError }, ...(at === undefined ? {} : { endedAt: at }) } : x)) };
    }
    case "result": {
      const errors = e.ok ? [] : [{ kind: "error" as const, text: e.errors.length ? e.errors.join("; ") : "the session ended without finishing" }];
      return { ...c, entries: [...c.entries, ...errors], busy: false, activity: "", outbox: null, offset: 0 };
    }
  }
}

// ---------------------------------------------------------------- the reducer

/** The state after `a`. Every action type has its case here; an action that cannot apply where the screen is leaves the state as it was. */
export function reduce(s: State, a: Action): State {
  const view = viewOf(s);
  const withView = (v: View): State => (placeOf(s).kind === "book" ? { ...s, book: v } : { ...s, review: v });
  switch (a.type) {
    case "rail.loaded": case "rail.down": case "rail.up": case "rail.next_group": case "rail.prev_group": case "rail.collapse":
      return withView({ ...view, rail: reduceRail(view.rail, a) });
    case "rail.open": case "rail.expand": {
      const row = railRow(view.rail);
      // A branch row in the book opens that branch as a review; the book keeps its place for when the review closes.
      if (row && !row.group && row.id.startsWith(BRANCH_ROW)) {
        return s.mode.kind === "book" ? reduce(s, { type: "review.open", branch: row.id.slice(BRANCH_ROW.length) }) : s;
      }
      // On a row that does not fold (a stage, a chapter, a change), → enters the main pane.
      if (row && !row.group) return { ...s, pane: "main", focus: s.focus === "content" ? "content" : "main" };
      return withView({ ...view, rail: reduceRail(view.rail, { type: "rail.expand" }) });
    }
    case "main.loaded": case "main.down": case "main.up": case "main.page_down": case "main.page_up": case "main.top": case "main.end": case "main.goto": case "select.down": case "select.up": case "select.clear":
      return withView({ ...view, main: reduceMain(view.main, a) });
    case "main.to_rail":
      return { ...s, pane: "rail", focus: s.focus === "content" ? "content" : "rail" };

    case "content.show": return { ...s, content: a.content, contentScroll: { ...s.contentScroll, scroll: 0, length: 0 } };
    case "content.close": return { ...s, content: null, full: false, focus: s.focus === "content" ? s.pane : s.focus, contentScroll: { ...s.contentScroll, scroll: 0, length: 0 } };
    case "content.down": return { ...s, contentScroll: scrollBy(s.contentScroll, 1) };
    case "content.up": return { ...s, contentScroll: scrollBy(s.contentScroll, -1) };
    case "content.page_down": return { ...s, contentScroll: scrollBy(s.contentScroll, pageStep(s.contentScroll.visible)) };
    case "content.page_up": return { ...s, contentScroll: scrollBy(s.contentScroll, -pageStep(s.contentScroll.visible)) };

    // Tab into the content area only while it shows something; back returns to the pane the cursor is in.
    case "focus.content": return s.content ? { ...s, focus: "content" } : s;
    case "focus.back": return { ...s, focus: s.pane };

    case "prefix.press": return { ...s, pending: { prefix: a.prefix } };
    case "prefix.digit": return s.pending && /^[0-9]$/.test(a.digit) ? { ...s, pending: { prefix: s.pending.prefix, digits: (s.pending.digits ?? "") + a.digit } } : s;
    case "prefix.backspace": {
      const p = s.pending;
      if (!p || p.digits === undefined) return s;
      // The last digit goes; with none left the prefix itself is cancelled.
      return p.digits.length > 1 ? { ...s, pending: { prefix: p.prefix, digits: p.digits.slice(0, -1) } } : { ...s, pending: null };
    }
    case "prefix.clear": return { ...s, pending: null };

    case "view.zen": return { ...s, zen: !s.zen };
    case "view.full": return s.content ? { ...s, full: !s.full } : s;

    // A review opens on a branch with a fresh rail and main pane; the book keeps its place for when the review closes.
    case "review.open": return s.mode.kind === "settings" || s.mode.kind === "compose" ? s : { ...s, mode: { kind: "review", branch: a.branch }, review: emptyView(), marks: {}, pane: "rail", focus: "rail", content: null, full: false, pending: null };
    case "write.start":
      if (s.writing !== null) return s;
      return { ...s, writing: a.chapter, content: writeContent(`Writing chapter ${a.chapter}`, "starting…"), contentScroll: { ...s.contentScroll, scroll: 0, length: 0 } };
    case "write.progress":
      return s.writing === null || s.content?.kind !== "write" ? s : { ...s, content: { ...s.content, body: s.content.body === "starting…" ? a.line : `${s.content.body}\n${a.line}`.split("\n").slice(-PROGRESS_LINES).join("\n") } };
    case "write.done": {
      const written = s.written.includes(a.branch) ? s.written : [...s.written, a.branch];
      const next = reduce({ ...s, writing: null, written }, { type: "review.open", branch: a.branch });
      // The receipt stays up beside the review it led to; Esc takes it down.
      return next.mode.kind === "review" ? { ...next, content: writeContent(`Wrote ${s.writing === null ? "" : `chapter ${s.writing} `}on ${a.branch}`, a.lines.join("\n")) } : next;
    }
    case "write.failed":
      return { ...s, writing: null, content: writeContent("Not written", [a.message, ...a.missing.map((m) => `- ${m}`)].join("\n")), contentScroll: { ...s.contentScroll, scroll: 0, length: 0 } };
    case "review.mark": {
      const row = s.mode.kind === "review" ? railRow(s.review.rail) : undefined;
      if (!row || !row.id.startsWith(EDIT_ROW)) return s;
      const { [row.id]: was, ...rest } = s.marks;
      return { ...s, marks: was === a.mark ? rest : { ...rest, [row.id]: a.mark } };
    }
    case "finish.start":
      return s.finishing !== null || s.mode.kind !== "review" ? s : { ...s, finishing: a.branch, content: writeContent(`Finishing ${a.branch}`, "merging…"), contentScroll: { ...s.contentScroll, scroll: 0, length: 0 } };
    case "finish.done": {
      if (s.finishing === null) return s;
      const closed = reduce({ ...s, finishing: null, finished: s.finished.includes(a.branch) ? s.finished : [...s.finished, a.branch] }, { type: "review.close" });
      return { ...closed, content: writeContent(`Finished ${a.branch}`, a.lines.join("\n")), contentScroll: { ...closed.contentScroll, scroll: 0, length: 0 } };
    }
    case "finish.failed":
      return { ...s, finishing: null, content: writeContent("Not finished", a.message), contentScroll: { ...s.contentScroll, scroll: 0, length: 0 } };
    case "review.close": return s.mode.kind === "review" ? { ...s, mode: s.mode.back ? { kind: "compose", from: s.mode.back } : { kind: "book" }, marks: {}, pane: "rail", focus: "rail", content: null, full: false, pending: null } : s;

    // Settings opens over the book or review and closes back to it. Its keys never reach the chord (settings.ts reads
    // them, including Esc), so `escape` leaves it alone.
    case "settings.open": return s.mode.kind === "settings" || s.mode.kind === "compose" ? s : { ...s, mode: { kind: "settings", from: s.mode }, settings: a.settings, pending: null };
    case "settings.set": return s.mode.kind === "settings" ? { ...s, settings: a.settings } : s;
    case "settings.close": return s.mode.kind === "settings" ? { ...s, mode: s.mode.from, settings: null, saved: a.saved ?? s.saved } : s;

    case "compose.open": return s.mode.kind === "book" || s.mode.kind === "review" ? { ...s, mode: { kind: "compose", from: s.mode }, pending: null, compose: { ...s.compose, offset: 0 } } : s;
    case "compose.close": return s.mode.kind === "compose" ? { ...s, mode: s.mode.from } : s;
    case "compose.type": return s.mode.kind === "compose" ? { ...s, compose: { ...s.compose, input: s.compose.input + a.text } } : s;
    case "compose.backspace": return s.mode.kind === "compose" ? { ...s, compose: { ...s.compose, input: [...s.compose.input].slice(0, -1).join("") } } : s;
    case "compose.submit": {
      const c = s.compose, text = c.input.trim();
      if (s.mode.kind !== "compose" || !text) return s;
      // A question card waiting: the line answers it (a number picks an option) instead of starting a turn.
      const asking = openQuestion(c);
      if (asking) {
        const index = /^\d+$/.test(text) ? Number(text) : 0;
        const answer = index >= 1 && index <= (asking.options?.length ?? 0) ? asking.options![index - 1]! : text;
        const entries = c.entries.map((e) => (e === asking ? { ...asking, answer } : e));
        return { ...s, compose: { ...c, entries, input: "", activity: "thinking", reply: { id: asking.id, text: answer }, replySeq: c.replySeq + 1, offset: 0 } };
      }
      if (c.busy) return s;
      return { ...s, compose: { ...c, entries: [...c.entries, { kind: "author", text }], input: "", busy: true, activity: "thinking", outbox: text, sendSeq: c.sendSeq + 1, offset: 0 } };
    }
    case "compose.event": return { ...s, compose: reduceEvent(s.compose, a.event, a.at) };
    case "compose.add": return { ...s, compose: { ...s.compose, entries: [...s.compose.entries, a.entry], offset: 0 } };
    case "compose.failed": return { ...s, compose: { ...s.compose, entries: [...s.compose.entries, { kind: "error", text: a.message }], busy: false, activity: "", outbox: null, offset: 0 } };
    case "compose.done": return { ...s, compose: { ...s.compose, busy: false, activity: "", outbox: null } };
    case "compose.pick": return s.mode.kind === "compose" && s.compose.branches.length > 0 ? { ...s, compose: { ...s.compose, pick: s.compose.pick === null ? s.compose.branches.length - 1 : null } } : s;
    case "compose.pick_move": return s.compose.pick === null ? s : { ...s, compose: { ...s.compose, pick: clamp(s.compose.pick + a.by, 0, s.compose.branches.length - 1) } };
    // The picked branch opens in review; Esc there returns to compose (`back` is where compose was opened from).
    case "compose.open_branch": {
      const branch = s.mode.kind === "compose" && s.compose.pick !== null ? s.compose.branches[s.compose.pick] : undefined;
      return s.mode.kind === "compose" && branch !== undefined ? { ...s, mode: { kind: "review", branch, back: s.mode.from }, review: emptyView(), marks: {}, pane: "rail", focus: "rail", content: null, full: false, pending: null, compose: { ...s.compose, pick: null } } : s;
    }
    case "compose.up": return { ...s, compose: scrollCompose(s.compose, 1) };
    case "compose.down": return { ...s, compose: scrollCompose(s.compose, -1) };
    case "compose.page_up": return { ...s, compose: scrollCompose(s.compose, pageStep(s.compose.visible)) };
    case "compose.page_down": return { ...s, compose: scrollCompose(s.compose, -pageStep(s.compose.visible)) };

    case "escape":
      if (s.mode.kind === "settings") return s;
      if (s.mode.kind === "compose") return s.compose.pick !== null ? reduce(s, { type: "compose.pick" }) : reduce(s, { type: "compose.close" });
      if (s.pending) return reduce(s, { type: "prefix.clear" });
      if (s.full) return reduce(s, { type: "view.full" });
      if (s.focus === "content") return reduce(s, { type: "focus.back" });
      if (view.main.selection) return reduce(s, { type: "select.clear" });
      if (s.content) return reduce(s, { type: "content.close" });
      if (s.mode.kind === "review") return reduce(s, { type: "review.close" });
      return s;

    case "measured": {
      // Each cursor is kept in view at the new size; the content area's scroll is held within its wrapped lines.
      const m = a.measure;
      const rail = m.rail === undefined ? view.rail : railTo({ ...view.rail, visible: m.rail }, view.rail.cursor);
      const main = m.main === undefined ? view.main : moveTo({ ...view.main, visible: m.main }, view.main.cursor);
      const content = m.content === undefined ? s.contentScroll : clampScroll({ scroll: s.contentScroll.scroll, visible: m.content.visible, length: m.content.lines }, s.contentScroll.scroll);
      const compose = m.compose === undefined ? s.compose : scrollCompose({ ...s.compose, length: m.compose.lines, visible: m.compose.visible }, 0);
      return { ...withView({ rail, main }), contentScroll: content, compose };
    }
  }
}
