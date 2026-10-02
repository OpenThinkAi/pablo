// The keys, as data. Every action is a row: a stable id, the states it acts in, a primary key, an optional secondary
// key (the vim/helix spelling), the label the key panel shows, and what it does (`do`: a model action from state.ts, or
// a command for the layer above it). Arrows move around the screen; letter prefixes hold everything else: `a` AI,
// `f` filter, `v` view, `g` go to. A prefixed row's key is its second key, pressed after the prefix. Copied from
// prview's keys.ts and adapted (pablo's states are the rail, the main pane and the content area, and a review is a
// mode of them); never shared with it, so the two may drift.
//
// The key panel (panel.ts) is drawn from these rows and the key handler resolves a keypress through the same rows
// (chord.ts), so what the panel lists is exactly what acts. Esc is not a row: it always backs out of whatever is open
// (a pending prefix, a content focus, a full-screen content area, a review) through the model's `escape` action.
// Keys are tokens: one printable character, or a name (`down`, `shift-down`, `enter`, `tab`, `pgdn`, `ctrl-d`, ...).
//
// The rows below are the defaults. `effectiveKeys` lays the author's overrides (`keys` in ~/.config/pablo/config.json)
// over them, refusing two bindings on one key in one state; the result is a Keymap that is passed explicitly to the
// panel and the key handler, never installed globally.

import type { Action as ModelAction, State } from "./state";

export const STATES = ["rail", "main", "content"] as const;
export type KeyStateName = (typeof STATES)[number];

export const PREFIXES = { a: "AI", f: "filter", v: "view", g: "go to" } as const;
export type Prefix = keyof typeof PREFIXES;
export const isPrefix = (k: string): k is Prefix => k in PREFIXES;

/** What a key does beyond the model: the layer above (the app, later the harness) handles it by `id`. `quit` is the app's own. */
export interface Command { readonly type: "command"; readonly id: string }
export type Do = ModelAction | Command;
const cmd = (id: string): Command => ({ type: "command", id });

/** What the model's state looks like to the keys: which region has focus, whether a review is open, whether the content area shows something. */
export interface KeyState { readonly state: KeyStateName; readonly review?: boolean; readonly content?: boolean }

/** The key state of the screen's model. */
export const keyStateOf = (s: State): KeyState => ({ state: s.focus, review: s.mode.kind === "review", content: s.content !== null });

export interface KeyAction {
  /** Stable across key changes: overrides, the key panel and the docs name the action by it. */
  readonly id: string;
  readonly states: readonly KeyStateName[];
  /** Pressed after this prefix: `key` is then the second key. */
  readonly prefix?: Prefix;
  /** The primary key, a token; "" when unbound. */
  readonly key: string;
  /** The alias (vim/helix spelling), if any. */
  readonly secondary?: string;
  readonly label: string;
  readonly description: string;
  /** What it does; absent only on `g <digits>`, which the chord reads itself. */
  readonly do?: Do;
  /** Only in a review (`review`), only outside one (`book`), or only while the content area shows something (`content`). */
  readonly needs?: "review" | "book" | "content";
  /** Not remappable: Tab, and `g <digits>` (the number closes on the prefix key itself, Enter alike). */
  readonly fixed?: true;
}

const RAIL: readonly KeyStateName[] = ["rail"], MAIN: readonly KeyStateName[] = ["main"], CONTENT: readonly KeyStateName[] = ["content"];
const OUTSIDE: readonly KeyStateName[] = ["rail", "main"];

export const DEFAULT_ACTIONS: readonly KeyAction[] = [
  // ---- the rail: the stage machine in a book, the changes in a review
  { id: "rail.down", states: RAIL, key: "down", secondary: "j", label: "row", description: "Move to the next row of the rail; a folded group is one stop.", do: { type: "rail.down" } },
  { id: "rail.up", states: RAIL, key: "up", secondary: "k", label: "row", description: "Move to the previous row of the rail; a folded group is one stop.", do: { type: "rail.up" } },
  { id: "rail.next_group", states: RAIL, key: "shift-down", secondary: "J", label: "group", description: "Move to the next group in the rail.", do: { type: "rail.next_group" } },
  { id: "rail.prev_group", states: RAIL, key: "shift-up", secondary: "K", label: "group", description: "Move to the previous group in the rail.", do: { type: "rail.prev_group" } },
  { id: "rail.expand", states: RAIL, key: "right", secondary: "l", label: "expand / enter", description: "Unfold the group under the cursor, step into it, or enter the main pane on a row that does not fold.", do: { type: "rail.expand" } },
  { id: "rail.open", states: RAIL, key: "enter", label: "open", description: "Open the row under the cursor: a branch waiting for review opens as a review; any other row is entered like →.", do: { type: "rail.open" } },
  { id: "rail.collapse", states: RAIL, key: "left", secondary: "h", label: "collapse", description: "Fold the group under the cursor; on a row, go up to its group.", do: { type: "rail.collapse" } },
  { id: "rail.focus_content", states: RAIL, needs: "content", key: "tab", label: "content", description: "Move focus into the content area to scroll it.", do: { type: "focus.content" }, fixed: true },

  // ---- the main pane: a document's lines, one sentence each
  { id: "main.down", states: MAIN, key: "down", secondary: "j", label: "line", description: "Move down a sentence line.", do: { type: "main.down" } },
  { id: "main.up", states: MAIN, key: "up", secondary: "k", label: "line", description: "Move up a sentence line.", do: { type: "main.up" } },
  { id: "main.select_down", states: MAIN, key: "shift-down", secondary: "J", label: "select", description: "Select the sentence under the cursor, then extend the selection down by a sentence; Esc clears it.", do: { type: "select.down" } },
  { id: "main.select_up", states: MAIN, key: "shift-up", secondary: "K", label: "select", description: "Select the sentence under the cursor, then extend the selection up by a sentence; Esc clears it.", do: { type: "select.up" } },
  { id: "main.page_down", states: MAIN, key: "pgdn", secondary: "ctrl-d", label: "page", description: "Page down.", do: { type: "main.page_down" } },
  { id: "main.page_up", states: MAIN, key: "pgup", secondary: "ctrl-u", label: "page", description: "Page up.", do: { type: "main.page_up" } },
  { id: "main.open", states: MAIN, key: "right", secondary: "l", label: "open hit", description: "Open the check hit on this line (its rule and the pattern it flagged) in the content area.", do: cmd("check.open") },
  { id: "main.to_rail", states: MAIN, key: "left", secondary: "h", label: "rail", description: "Back to the rail.", do: { type: "main.to_rail" } },
  { id: "main.focus_content", states: MAIN, needs: "content", key: "tab", label: "content", description: "Move focus into the content area to scroll it.", do: { type: "focus.content" }, fixed: true },

  // ---- the content area, with focus in it
  { id: "content.down", states: CONTENT, key: "down", secondary: "j", label: "scroll", description: "Scroll the content area down.", do: { type: "content.down" } },
  { id: "content.up", states: CONTENT, key: "up", secondary: "k", label: "scroll", description: "Scroll the content area up.", do: { type: "content.up" } },
  { id: "content.page_down", states: CONTENT, key: "pgdn", secondary: "ctrl-d", label: "page", description: "Page the content area down.", do: { type: "content.page_down" } },
  { id: "content.page_up", states: CONTENT, key: "pgup", secondary: "ctrl-u", label: "page", description: "Page the content area up.", do: { type: "content.page_up" } },
  { id: "content.back", states: CONTENT, key: "tab", label: "back", description: "Move focus back out of the content area, to the pane where the cursor is.", do: { type: "focus.back" }, fixed: true },

  // ---- in a review: each change in the rail is accepted, rejected or edited; finishing merges the branch
  { id: "review.accept", states: OUTSIDE, needs: "review", key: "y", label: "accept", description: "Accept the change under the cursor; again to clear it.", do: { type: "review.mark", mark: "accepted" } },
  { id: "review.reject", states: OUTSIDE, needs: "review", key: "n", label: "reject", description: "Reject the change under the cursor; again to clear it.", do: { type: "review.mark", mark: "rejected" } },
  { id: "review.edit", states: OUTSIDE, needs: "review", key: "e", label: "edit", description: "Edit the change under the cursor.", do: cmd("review.edit") },
  { id: "review.finish", states: OUTSIDE, needs: "review", key: "s", label: "finish", description: "Finish the review: merge what was accepted.", do: cmd("review.finish") },

  // ---- anywhere outside the content area
  { id: "app.settings", states: OUTSIDE, key: "\\", label: "settings", description: "Open the settings: keys, models and display.", do: cmd("settings") },
  { id: "app.quit", states: OUTSIDE, key: "q", label: "quit", description: "Leave pablo; nothing is lost.", do: cmd("quit") },

  // ---- a: AI
  { id: "ai.plan", states: OUTSIDE, prefix: "a", key: "p", label: "planner", description: "Talk to the planner about the stage under the cursor.", do: cmd("ai.plan") },
  { id: "ai.compose", states: OUTSIDE, prefix: "a", key: "c", label: "compose", description: "Open the compose view: a full-screen conversation with pablo. Esc returns here with the session kept.", do: { type: "compose.open" } },
  { id: "ai.write", states: OUTSIDE, needs: "book", prefix: "a", key: "w", label: "write chapter", description: "Write the selected chapter with the local writer.", do: cmd("ai.write") },
  { id: "ai.revise", states: MAIN, prefix: "a", key: "r", label: "revise", description: "Revise the selected sentences.", do: cmd("ai.revise") },
  { id: "ai.voice", states: MAIN, prefix: "a", key: "v", label: "voice", description: "Flag the line under the cursor as a voice tell, or keep it as an exemplar.", do: cmd("ai.voice") },

  // ---- f: filter
  { id: "filter.all", states: OUTSIDE, needs: "review", prefix: "f", key: "a", label: "all changes", description: "Show every change in the review.", do: cmd("filter.all") },
  { id: "filter.pending", states: OUTSIDE, needs: "review", prefix: "f", key: "p", label: "pending only", description: "Show only the changes not yet accepted or rejected.", do: cmd("filter.pending") },

  // ---- v: view
  { id: "view.zen", states: OUTSIDE, prefix: "v", key: "z", label: "zen", description: "Hide or show the rail.", do: { type: "view.zen" } },
  { id: "view.fullscreen", states: ["rail", "main", "content"], needs: "content", prefix: "v", key: "c", label: "full-screen content", description: "Make the content area full-screen, or restore it; Esc restores it too.", do: { type: "view.full" } },
  { id: "view.editor", states: MAIN, prefix: "v", key: "e", label: "editor", description: "Open the editor at the cursor, on an edit branch.", do: cmd("view.editor") },
  { id: "view.save", states: OUTSIDE, needs: "book", prefix: "v", key: "s", label: "save edits", description: "Save your edits: merge the edit branch into main.", do: cmd("view.save") },

  // ---- g: go to
  { id: "go.top", states: MAIN, prefix: "g", key: "g", label: "top", description: "Go to the first line of the document.", do: { type: "main.top" } },
  { id: "go.end", states: MAIN, prefix: "g", key: "e", label: "end", description: "Go to the last line of the document.", do: { type: "main.end" } },
  { id: "go.hit_next", states: MAIN, prefix: "g", key: "f", label: "next hit", description: "Go to the next check hit in the document, wrapping round at the end.", do: cmd("check.next") },
  { id: "go.hit_prev", states: MAIN, prefix: "g", key: "F", label: "previous hit", description: "Go to the previous check hit in the document, wrapping round at the start.", do: cmd("check.prev") },
  { id: "go.line", states: MAIN, prefix: "g", key: "<n>", label: "line", description: "Type a line number, then close it with the go prefix key again or Enter, to go to that line.", fixed: true },
];

// ---------------------------------------------------------------- key tokens

/** The named keys a binding may use besides one printable character. */
export const NAMED_KEYS = ["up", "down", "left", "right", "shift-up", "shift-down", "shift-left", "shift-right", "tab", "shift-tab", "enter", "esc", "backspace", "pgup", "pgdn", "space", "home", "end"] as const;
const SHOWN: Record<string, string> = {
  up: "↑", down: "↓", left: "←", right: "→", "shift-up": "⇧↑", "shift-down": "⇧↓", "shift-left": "⇧←", "shift-right": "⇧→",
  tab: "Tab", "shift-tab": "⇧Tab", enter: "Enter", esc: "Esc", backspace: "Backspace", pgup: "PgUp", pgdn: "PgDn", space: "Space", home: "Home", end: "End", "<n>": "<n> g",
};
/** A token as the panel draws it: arrows as arrows, names capitalised, a character as itself. */
export const showKey = (token: string): string => SHOWN[token] ?? token;

const ALIASES: Record<string, string> = { return: "enter", escape: "esc", pagedown: "pgdn", pageup: "pgup", "page-down": "pgdn", "page-up": "pgup", " ": "space", "↑": "up", "↓": "down", "←": "left", "→": "right" };
const printable = (c: string) => /^[^\p{C}\s]$/u.test(c);

/** A key as written in the config to its token (`Shift+Down` becomes `shift-down`), or null when it is no key at all. */
export function normKey(raw: string): string | null {
  if ([...raw].length === 1) return ALIASES[raw] ?? (printable(raw) ? raw : null);
  const s = raw.trim().toLowerCase().replace(/\s*\+\s*/g, "-");
  const t = ALIASES[s] ?? s;
  if ((NAMED_KEYS as readonly string[]).includes(t)) return t;
  if (/^ctrl-[a-z]$/.test(t)) return t;
  return null;
}

// ---------------------------------------------------------------- reading the rows

export interface Keymap { readonly actions: readonly KeyAction[] }
export const DEFAULT_KEYMAP: Keymap = { actions: DEFAULT_ACTIONS };

/** The keys that trigger a row, primary first; the unbound ones left out. */
export const keysOf = (a: KeyAction): string[] => [a.key, a.secondary ?? ""].filter(Boolean);

const inState = (ks: KeyState) => (a: KeyAction): boolean =>
  a.states.includes(ks.state) && (a.needs === undefined || (a.needs === "review" ? !!ks.review : a.needs === "book" ? !ks.review : !!ks.content));

/** The top-level rows that act in a state (no prefix), bound ones only, in table order. */
export const rowsOf = (ks: KeyState, km: Keymap = DEFAULT_KEYMAP): KeyAction[] => km.actions.filter((a) => !a.prefix && inState(ks)(a) && keysOf(a).length);
/** The second keys of prefix `p` in a state. */
export const prefixRows = (ks: KeyState, p: Prefix, km: Keymap = DEFAULT_KEYMAP): KeyAction[] => km.actions.filter((a) => a.prefix === p && inState(ks)(a) && keysOf(a).length);
/** The prefixes that have second keys in a state, in a/f/v/g order. */
export const prefixesOf = (ks: KeyState, km: Keymap = DEFAULT_KEYMAP): Prefix[] => (Object.keys(PREFIXES) as Prefix[]).filter((p) => prefixRows(ks, p, km).length);

/** Consecutive rows with the same label read as one panel entry: ↓ and ↑, both "row", show as "↓/↑ j/k row". */
export function groups<R extends KeyAction>(rows: R[]): R[][] {
  const out: R[][] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last[0]!.label === r.label) last.push(r); else out.push([r]);
  }
  return out;
}

// ---------------------------------------------------------------- the author's bindings

export class KeysError extends Error {}

/** A `keys` entry: `"rail.down": "n"` sets the primary; `{ "primary": "n", "secondary": "j" }` either or both, `"secondary": ""` removes it. */
export interface Binding { readonly primary?: string; readonly secondary?: string }

/** Why `token` cannot be `a`'s key, or null when it can. */
function badKey(a: KeyAction, token: string): string | null {
  if (token === "esc") return "Esc always backs out and cannot be rebound";
  if (token === "tab" || token === "shift-tab") return "Tab moves focus to the content area and back, and cannot be rebound";
  if (a.prefix === "g" && /^[0-9]$/.test(token)) return "after g a digit starts a line number";
  return null;
}

/**
 * The defaults with `overrides` ({ "<id>": binding }) laid over them. Throws a KeysError, worded for the person who
 * wrote the config, on an unknown action, a fixed one, a key that is no key, Esc or Tab, or two bindings on one key in
 * one state (primary or secondary, a prefix's second keys among themselves, or a key that is a prefix there).
 */
export function effectiveKeys(overrides: Readonly<Record<string, Binding | string>> = {}): Keymap {
  const byId = new Map(DEFAULT_ACTIONS.map((a) => [a.id, a]));
  const set = new Map<string, Binding>();
  for (const [id, given] of Object.entries(overrides)) {
    const b: Binding = typeof given === "string" ? { primary: given } : given;
    const a = byId.get(id);
    if (!a) throw new KeysError(`keys: unknown action "${id}"`);
    if (a.fixed) throw new KeysError(`keys: ${id} is fixed (${showKey(a.key)}) and cannot be rebound`);
    const norm: { primary?: string; secondary?: string } = {};
    for (const slot of ["primary", "secondary"] as const) {
      const raw = b[slot];
      if (raw === undefined) continue;
      if (raw === "") { norm[slot] = ""; continue; }
      const t = normKey(raw);
      if (!t) throw new KeysError(`keys: ${id} ${slot} = ${JSON.stringify(raw)}: a key is one printable character or a name (${NAMED_KEYS.filter((k) => !/tab|esc/.test(k)).join(", ")}, ctrl-<letter>)`);
      const why = badKey(a, t);
      if (why) throw new KeysError(`keys: ${id} ${slot} = ${JSON.stringify(raw)}: ${why}`);
      norm[slot] = t;
    }
    set.set(id, norm);
  }
  const actions = DEFAULT_ACTIONS.map((a): KeyAction => {
    const b = set.get(a.id);
    if (!b) return a;
    const { secondary: _drop, ...rest } = a;
    const secondary = b.secondary ?? a.secondary;
    return { ...rest, key: b.primary ?? a.key, ...(secondary ? { secondary } : {}) };
  });
  const km: Keymap = { actions };
  checkConflicts(km);
  return km;
}

const where = (a: KeyAction, slot: "primary" | "secondary") => `${a.id}${slot === "secondary" ? " (secondary)" : ""}`;

/** Every state the keys can be in: the three regions, in a book or a review, with the content area open or not. */
const VARIANTS: readonly KeyState[] = STATES.flatMap((state) => [false, true].flatMap((review) => [false, true].map((content) => ({ state, review, content }))));

/** Two bindings on one key in one state, per layer: the keys pressed first, and each prefix's second keys. */
function checkConflicts(km: Keymap): void {
  for (const ks of VARIANTS) {
    const prefixes = prefixesOf(ks, km);
    const layers: [string, KeyAction[]][] = [["", rowsOf(ks, km)], ...prefixes.map((p): [string, KeyAction[]] => [p, prefixRows(ks, p, km)])];
    for (const [layer, rows] of layers) {
      const seen = new Map<string, string>();
      for (const a of rows) {
        for (const slot of ["primary", "secondary"] as const) {
          const k = slot === "primary" ? a.key : a.secondary;
          if (!k) continue;
          const at = layer ? ` after ${layer}` : "";
          if (!layer && isPrefix(k) && prefixes.includes(k)) throw new KeysError(`keys: ${where(a, slot)} = ${JSON.stringify(k)}, but ${k} is the ${PREFIXES[k]} prefix in the ${ks.state} state`);
          const other = seen.get(k);
          if (other) throw new KeysError(other === a.id ? `keys: ${a.id} has ${JSON.stringify(k)} as both primary and secondary` : `keys: ${other} and ${where(a, slot)} are both ${JSON.stringify(k)}${at} in the ${ks.state} state`);
          seen.set(k, where(a, slot));
        }
      }
    }
  }
}
