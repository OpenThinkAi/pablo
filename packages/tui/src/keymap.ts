/**
 * The key map, as data.
 *
 * Every binding is a row in `BINDINGS`: an action id, the chords that trigger
 * it, and the label the in-app help shows. Nothing about a key is written into
 * the view — the view looks a key up here and dispatches the action id — so a
 * later ticket adds a verb by adding a row and an action, and the help screen
 * grows on its own.
 *
 * An action is served either by a pure entry in `ACTIONS` (`view-state.ts`) or,
 * when it has to reach the disk, `$EDITOR` or a provider, by the view itself —
 * see `VIEW_OWNED` at the bottom of this file.
 *
 * **Text entry is not in this map.** While a field is open the keys go into the
 * field, not through `matchBinding`; a field is a mode with three keys (send,
 * cancel, and in a multi-line field save), documented in the help footer.
 *
 * **No function row and no number row.** Matt types on a Corne split (ZMK,
 * Colemak, five layers) that has neither, so every action is a letter, a
 * symbol, an arrow, or a control chord, and the letters are mnemonic rather
 * than positional (`n`ext, `p`revious, `i`nsert, `a`fter, `r`eload, `B`rief,
 * `q`uit) so they land in the same place on a Colemak layout as on QWERTY.
 */

export type BindingGroup = "reading" | "selection" | "verbs" | "session";

export interface Binding {
  /** The action id the view dispatches. */
  readonly action: string;
  /** Chords that trigger it, in `chordsFor` notation. */
  readonly chords: readonly string[];
  /** One line of help. */
  readonly label: string;
  readonly group: BindingGroup;
}

/** The subset of opentui's `KeyEvent` a binding lookup needs. */
export interface KeyLike {
  readonly name?: string;
  readonly sequence?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
}

/**
 * The brief's key. Shifted `B` because `b` is already a page up, and because
 * shift is how this map already reaches a second verb on a letter (`g` / `G`)
 * without asking a Corne for a row it does not have.
 */
export const BRIEF_KEY = "B";

export const BINDINGS: readonly Binding[] = [
  { action: "scrollDown", chords: ["down", "ctrl+e"], label: "scroll down one line", group: "reading" },
  { action: "scrollUp", chords: ["up", "ctrl+y"], label: "scroll up one line", group: "reading" },
  { action: "pageDown", chords: ["space", "pagedown", "ctrl+d"], label: "scroll down a screen", group: "reading" },
  { action: "pageUp", chords: ["b", "pageup", "ctrl+u"], label: "scroll up a screen", group: "reading" },
  { action: "top", chords: ["g", "home"], label: "go to the start of the manuscript", group: "reading" },
  { action: "bottom", chords: ["G", "end"], label: "go to the end of the manuscript", group: "reading" },

  { action: "next", chords: ["n", "right"], label: "select the next unit", group: "selection" },
  { action: "previous", chords: ["p", "left"], label: "select the previous unit", group: "selection" },
  { action: "expand", chords: ["+", "="], label: "expand one level, up to the whole chapter", group: "selection" },
  { action: "shrink", chords: ["-", "_"], label: "shrink one level, down to characters", group: "selection" },
  { action: "startBack", chords: ["["], label: "move the selection start one character left", group: "selection" },
  { action: "startForward", chords: ["]"], label: "move the selection start one character right", group: "selection" },
  { action: "endBack", chords: ["{"], label: "move the selection end one character left", group: "selection" },
  { action: "endForward", chords: ["}"], label: "move the selection end one character right", group: "selection" },
  { action: "collapseStart", chords: ["i"], label: "collapse to a boundary before the selection", group: "selection" },
  { action: "collapseEnd", chords: ["a"], label: "collapse to a boundary after the selection", group: "selection" },

  { action: "prompt", chords: [">"], label: "prompt the model on the selection", group: "verbs" },
  { action: "manualEdit", chords: ["e"], label: "edit the selection by hand, no markup", group: "verbs" },
  { action: "cut", chords: ["x"], label: "cut the selection", group: "verbs" },
  { action: "move", chords: ["m"], label: "cut the selection, then m again at a boundary to drop it", group: "verbs" },
  { action: "openEditor", chords: ["o"], label: "open the file in $EDITOR at the cursor line", group: "verbs" },
  { action: "dryRun", chords: ["d"], label: "dry run: the pack that would be sent, slice by slice", group: "verbs" },
  { action: "retry", chords: ["R"], label: "retry the last prompt", group: "verbs" },

  { action: "reload", chords: ["r"], label: "re-read the file from disk", group: "session" },
  { action: "toggleBrief", chords: [BRIEF_KEY], label: "show or hide the work brief", group: "session" },
  { action: "toggleHelp", chords: ["?"], label: "show or hide this help", group: "session" },
  { action: "dismiss", chords: ["escape"], label: "close the brief or the help, clear the message", group: "session" },
  { action: "quit", chords: ["q", "ctrl+c"], label: "quit", group: "session" },
];

export const GROUP_LABELS: Readonly<Record<BindingGroup, string>> = {
  reading: "Reading",
  selection: "Selection",
  verbs: "Verbs on the selection",
  session: "Session",
};

/**
 * The actions `view.ts` handles itself, because each one reaches outside the
 * pure state machine: the disk (`reload`, `cut`, `move`, `manualEdit`), another
 * process (`openEditor`), or a provider (`prompt`, `dryRun`, `retry`).
 *
 * They are bindings like any other and they appear in the help; they simply
 * have no entry in `ACTIONS`. Keeping the list here rather than in the view is
 * what lets the key-map test check that every action is served by exactly one
 * of the two.
 */
export const VIEW_OWNED: ReadonlySet<string> = new Set([
  "reload",
  "prompt",
  "manualEdit",
  "cut",
  "move",
  "openEditor",
  "dryRun",
  "retry",
]);

/** C0 controls and DEL: a chord is a character you can see, never an escape byte. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The chords a key press could match, most specific first.
 *
 * The literal character comes first so a shifted symbol (`?`, `{`, `G`) binds
 * as itself rather than as its unshifted key, which is what makes the map
 * layout-independent — the terminal reports what the layer produced, not which
 * physical key produced it.
 */
export function chordsFor(key: KeyLike): string[] {
  const chords: string[] = [];
  const sequence = key.sequence ?? "";
  const modifiers = `${key.ctrl === true ? "ctrl+" : ""}${key.meta === true ? "meta+" : ""}`;

  if (modifiers === "" && sequence.length > 0 && sequence.length <= 2 && !CONTROL.test(sequence)) {
    chords.push(sequence === " " ? "space" : sequence);
  }

  const name = key.name ?? "";
  if (name.length > 0) chords.push(modifiers + (name === " " ? "space" : name.toLowerCase()));

  return chords;
}

/** The binding a key press triggers, or `undefined` if it is not bound. */
export function matchBinding(key: KeyLike, bindings: readonly Binding[] = BINDINGS): Binding | undefined {
  for (const chord of chordsFor(key)) {
    const binding = bindings.find((candidate) => candidate.chords.includes(chord));
    if (binding !== undefined) return binding;
  }
  return undefined;
}
