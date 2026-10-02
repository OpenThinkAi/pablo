// The screen's state, pure: where the author is and what is open, changed only by named actions through `reduce`.
// Nothing here knows Ink or React, so every action is tested without a terminal, and the Ink layer (app.tsx) only
// reads this state and dispatches actions. prview grew its screen logic into a 1,000-line component holding twenty
// useStates; pablo keeps it out of the rendering layer from the start.
//
// The model holds positions and openings, not text: the rail's rows are an index (an id, a depth, whether the row
// folds), the main pane knows how many lines it has, the content area what it shows. The documents themselves are
// props of the Ink layer, loaded from the vault, and only their shape (`rail.loaded`, `main.loaded`) reaches here.
//
//   mode     book (the stage machine in the rail, a document in the main pane) or review (a branch's changes)
//   pane     the rail or the main pane, where the cursor is
//   focus    that pane, or the content area while Tab has moved focus into it
//   content  the one thing the bottom panel shows, scrollable, closed by Esc
//   pending  a prefix waiting for its second key (`a`, `g`), with the digits of a `g <n>` line number
//   zen      the rail hidden; `full`: the content area taking the screen under the status area
//
// Each mode keeps its own rail and main pane, so leaving a review returns to the book where it was left. Settings holds
// its own model (`settings`, below) instead of a rail and main pane; the settings logic is settings.ts, and reaches
// here as whole values (`settings.set`), so this file stays free of imports.

/** The id prefix of a rail row that names a branch waiting for review (`branch:draft/ch03`). */
export const BRANCH_ROW = "branch:";

/** The id prefix of a rail row that is one change in a review (`edit:3`): the rows a mark can be put on. */
export const EDIT_ROW = "edit:";
/** The author's decision on a change; a change with none is still pending. */
export type Mark = "accepted" | "rejected";

export type Place = { kind: "book" } | { kind: "review"; branch: string };
/** Settings (`\`) is a mode over a place: closing it returns to where it was opened, with that place's own rail and main pane. */
export type Mode = Place | { kind: "settings"; from: Place };
export type PaneName = "rail" | "main";
export type Focus = PaneName | "content";

/** A row of the rail: a stage, a chapter, a change. A `group` row folds the deeper rows after it until the next row at its depth or above. */
export interface RailRow { readonly id: string; readonly depth: number; readonly group?: boolean }

/** A scrolling region: `scroll` is the first visible line, `length` how many there are, `visible` how many fit (0 until measured). */
export interface Scroll { readonly scroll: number; readonly length: number; readonly visible: number }
/** A region with a cursor, kept in view as it moves. */
export interface Pane extends Scroll {
  readonly cursor: number;
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

export interface State {
  readonly mode: Mode;
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
}

/**
 * What the layout measured, dispatched whenever the terminal size or the content changes: rows each region can show,
 * and for the content area also how many lines its text wraps to at the width it has (the model never wraps text).
 */
export interface Measure { readonly rail?: number; readonly main?: number; readonly content?: { readonly visible: number; readonly lines: number } }

export type Action =
  // ---- the rail: the moves skip a folded group's rows; → unfolds, steps into, or enters the main pane; ← folds or steps out
  | { type: "rail.loaded"; rows: readonly RailRow[]; folded?: readonly string[] }
  | { type: "rail.down" } | { type: "rail.up" }
  | { type: "rail.next_group" } | { type: "rail.prev_group" }
  | { type: "rail.expand" } | { type: "rail.collapse" }
  // Enter: on a branch row (`branch:<name>`, a branch waiting for review) opens the review; elsewhere it is → (`rail.expand`)
  | { type: "rail.open" }
  // ---- the main pane: a document's lines, one sentence each
  | { type: "main.loaded"; lines: number; doc?: string }
  | { type: "main.down" } | { type: "main.up" }
  | { type: "main.page_down" } | { type: "main.page_up" }
  | { type: "main.top" } | { type: "main.end" }
  | { type: "main.goto"; line: number }
  | { type: "main.to_rail" }
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
  | { type: "settings.open"; settings: SettingsModel }
  | { type: "settings.set"; settings: SettingsModel }
  | { type: "settings.close"; saved?: SavedSettings }
  // ---- Esc: back out of whatever is open, one thing at a time
  | { type: "escape" }
  // ---- the layout's measure of each region
  | { type: "measured"; measure: Measure };

export type ActionType = Action["type"];
export type Dispatch = (action: Action) => void;

/** A write streams a progress line every couple of seconds; the content area keeps the latest few, so the newest is always in view. */
const PROGRESS_LINES = 5;
const writeContent = (title: string, body: string): Content => ({ title, body, kind: "write" });

const emptyView = (): View => ({ rail: { rows: [], collapsed: new Set(), cursor: 0, scroll: 0, visible: 0 }, main: { cursor: 0, scroll: 0, length: 0, visible: 0 } });

export const initialState = (): State => ({
  mode: { kind: "book" }, book: emptyView(), review: emptyView(), marks: {},
  pane: "rail", focus: "rail", content: null, contentScroll: { scroll: 0, length: 0, visible: 0 }, pending: null, zen: false, full: false, settings: null, saved: null, writing: null, written: [],
});

// ---------------------------------------------------------------- reading the state

/** The book or review the screen is over: the mode itself, or what settings was opened from. */
export const placeOf = (s: State): Place => (s.mode.kind === "settings" ? s.mode.from : s.mode);

/** The rail and main pane of the current mode (under settings, those of the place it was opened from). */
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
    case "main.loaded": {
      const fresh = a.doc !== undefined && a.doc !== main.doc;
      const base = fresh ? { ...main, cursor: 0, scroll: 0 } : main;
      return moveTo({ ...base, length: a.lines, ...(a.doc !== undefined ? { doc: a.doc } : {}) }, base.cursor);
    }
    case "main.down": return moveTo(main, main.cursor + 1);
    case "main.up": return moveTo(main, main.cursor - 1);
    case "main.page_down": return moveTo(main, main.cursor + pageStep(main.visible));
    case "main.page_up": return moveTo(main, main.cursor - pageStep(main.visible));
    case "main.top": return moveTo(main, 0);
    case "main.end": return moveTo(main, main.length - 1);
    case "main.goto": return moveTo(main, a.line - 1);
    default: return main;
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
    case "main.loaded": case "main.down": case "main.up": case "main.page_down": case "main.page_up": case "main.top": case "main.end": case "main.goto":
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
    case "review.open": return s.mode.kind === "settings" ? s : { ...s, mode: { kind: "review", branch: a.branch }, review: emptyView(), marks: {}, pane: "rail", focus: "rail", content: null, full: false, pending: null };
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
    case "review.close": return s.mode.kind === "review" ? { ...s, mode: { kind: "book" }, marks: {}, pane: "rail", focus: "rail", content: null, full: false, pending: null } : s;

    // Settings opens over the book or review and closes back to it. Its keys never reach the chord (settings.ts reads
    // them, including Esc), so `escape` leaves it alone.
    case "settings.open": return s.mode.kind === "settings" ? s : { ...s, mode: { kind: "settings", from: s.mode }, settings: a.settings, pending: null };
    case "settings.set": return s.mode.kind === "settings" ? { ...s, settings: a.settings } : s;
    case "settings.close": return s.mode.kind === "settings" ? { ...s, mode: s.mode.from, settings: null, saved: a.saved ?? s.saved } : s;

    case "escape":
      if (s.mode.kind === "settings") return s;
      if (s.pending) return reduce(s, { type: "prefix.clear" });
      if (s.full) return reduce(s, { type: "view.full" });
      if (s.focus === "content") return reduce(s, { type: "focus.back" });
      if (s.content) return reduce(s, { type: "content.close" });
      if (s.mode.kind === "review") return reduce(s, { type: "review.close" });
      return s;

    case "measured": {
      // Each cursor is kept in view at the new size; the content area's scroll is held within its wrapped lines.
      const m = a.measure;
      const rail = m.rail === undefined ? view.rail : railTo({ ...view.rail, visible: m.rail }, view.rail.cursor);
      const main = m.main === undefined ? view.main : moveTo({ ...view.main, visible: m.main }, view.main.cursor);
      const content = m.content === undefined ? s.contentScroll : clampScroll({ scroll: s.contentScroll.scroll, visible: m.content.visible, length: m.content.lines }, s.contentScroll.scroll);
      return { ...withView({ rail, main }), contentScroll: content };
    }
  }
}
