# @openthink/pablo-tui

pablo's full-terminal screen, on Ink: a third front end on `packages/cli/src/verbs.ts` beside the CLI and MCP. Bare
`pablo` in a project opens it. The design is the pm project `ai-terminal`'s `screen` doc
(`pm project show ai-terminal --doc screen`); the layout, keys and panel machinery are copied and adapted from
prview, never shared with it.

```
src/state.ts     the state model: modes, focus, cursors, scroll, the pending prefix; `reduce(state, action)`
src/keys.ts      the key rows (data): states, primary and secondary keys, prefixes, what each does; overrides and conflicts
src/chord.ts     a keypress, in a state with a prefix pending, to actions; Ink's keys to tokens
src/panel.ts     the key panel's entries and layout, from the rows
src/key-panel.tsx  the key panel as a component the layout places
src/key-config.ts  `keys` in ~/.config/pablo/config.json, laid over the defaults
src/settings.ts  the settings screen's rules (`\`): capture a key, refuse a conflict, type the editor command, save the config
src/settings-view.tsx  the settings screen as a component
src/app.tsx      the Ink root: reads the state, draws it, dispatches actions from keys
src/screen.tsx   mounts the app in the alternate screen and restores the terminal
src/layout.ts    the layout geometry, pure: region sizes at a terminal size, text wrapping, the `measured` payload
src/status.ts    the status area's fields (format, progress, branch, comment counts) and which drop when narrow
src/resize.ts    the terminal size as state (below the model: plumbing, not where the author is)
src/sanitize.ts  strips control characters from text that did not come from the keyboard
```

## The layout

Top to bottom: the status area (title, then fields), the middle (the rail and the main pane), the bottom panel (the
content area beside the key panel) and a one-row footer. `layout.ts` computes every region's size from the terminal's
columns and rows (`layoutOf`), tested at 60x20 to 200x60 with no terminal. Under 100 columns the rail is a narrow
strip; `view.zen` hides it; `view.full` gives the bottom panel the screen. `app.tsx` reads the layout and, whenever
the size or the content changes, dispatches `measured` so the model keeps every cursor in view; a resize relayouts
without a restart. The key panel (AGT-1524) sits in the bottom panel at the width and height the layout gives it.

## The state model

`state.ts` is pure: no Ink, no React, no imports at all. It holds where the author is and what is open, and nothing
else: the rail's rows are an index (an id, a depth, whether the row folds), the main pane knows how many lines it has,
the content area what it shows. The documents are props of the Ink layer. Every change is a named action through
`reduce`, so each one is tested without a terminal (`test/state.test.ts`), and `test/boundary.test.ts` holds the Ink
layer to one `useReducer` over the model with no `useState` or `useRef` of its own: a component that needs to remember
something dispatches an action instead.

```
mode      { kind: "book" } | { kind: "review", branch }   each mode keeps its own rail and main pane
          { kind: "settings", from }                      over a book or review; its model is `settings`, no rail or main pane
saved     the bindings and editor a save put in force, over what the screen opened with
pane      "rail" | "main"                                   where the cursor is
focus     the pane, or "content" while Tab has moved focus into the content area
content   the one thing the bottom panel shows, with its scroll
pending   a prefix waiting for its second key, with the digits of a `g <n>` line number
zen       the rail hidden;  full   the content area taking the screen
```

Actions are `<region>.<verb>`: `rail.down`, `main.goto`, `content.show`, `focus.back`, `prefix.press`, `view.zen`,
`review.open`, `escape`, `measured`. The layout tells the model how many rows each region shows through `measured`,
and the model keeps every cursor in view; it never wraps or measures text itself.

### Adding an action

1. Add its shape to the `Action` union in `state.ts` and its case to `reduce` (the switch is exhaustive: TypeScript
   refuses a missing case). An action that cannot apply where the screen is returns the state unchanged.
2. Test it in `test/state.test.ts`, applied to a state built by earlier actions, and add it to the `every` table there
   so it is known to apply anywhere.
3. Bind a key to it: a row in `DEFAULT_ACTIONS` in `keys.ts` (see "Adding a key"), and draw whatever it changes from
   the state in `app.tsx`. Nothing about it lives in the component.

### Adding a mode

A mode is a variant of `Mode` with its own `View` (a rail and a main pane) on `State`, the way `book` and `review`
are. Add the variant, the view field, the actions that enter and leave it (`review.open` / `review.close` are the
pattern: entering resets the view, leaving restores the pane and focus), extend `viewOf` and `withView` in `reduce`,
and give `escape` its place in the backing-out order. The rail, main pane, content and prefix actions then work in it
unchanged, because they act on `viewOf(state)`.

## Keys

Keys are data (`keys.ts`), copied from prview's key map and free to drift from it. A row has an id, the states it acts
in (`rail`, `main`, `content`, narrowed by `needs`: in a `review`, outside one (`book`), or with the `content` area
open), a primary key, an optional secondary key, a label and a `do`: a model action, or a `Command` for the layer above
(`quit` is the app's; the rest reach `onCommand`). `a`, `f`, `v`, `g` are prefixes: a row with `prefix` is that
prefix's second key, and the key panel shows the second keys while the prefix is pending. `Esc` is not a row: it is
always the model's `escape`. `Tab` is fixed. The panel lists exactly the rows that act in the state, because it reads
the same rows the key handler resolves through (`chord.ts`).

Overrides live in `~/.config/pablo/config.json` as `"keys": { "rail.down": "n", "main.page_down": { "primary": "pgdn",
"secondary": "" } }`. A conflict in one state, an unknown or fixed action, or Esc/Tab as a binding is refused when the
screen opens, with the reason on stderr; the screen does not start on a bad config.

### Settings

`\` opens the settings over the book or review (`settings.open`) and Esc closes it again (`settings.close`). While it
is open the screen takes every key itself (`settings.ts`, not the chord), so a key pressed to rebind an action does not
also run it. Every action's keys are listed; Enter on one captures the next key as its primary (→ first for the
secondary, Backspace clears a secondary), and a key that clashes in one of the action's states is refused on the spot,
with the same check that refuses a bad `keys` at startup. The last line is the editor command (`"editor"` in the config,
what `v e` will run; empty means `$EDITOR`, else `hx`). Esc with changes asks to save: `y` writes `keys` and `editor`
into `~/.config/pablo/config.json` (every other entry is kept, a default key's entry is removed), and the new keys act
at once; `n` discards. The file is re-parsed before it is written, and a save that would not read back writes nothing.

The model is data in `state.ts` (`SettingsModel`) and reaches it as whole values (`settings.set`); the rules that
produce the next value are in `settings.ts`, so `state.ts` stays import-free.

### Adding a key

Add a row to `DEFAULT_ACTIONS` with its `do`; the panel, the chord and the overrides pick it up. Add its action first
if it is a model action (above). A row that needs a command gets one in the layer that owns the work, handled from
`onCommand`; until it is built the key is bound and does nothing. Keep a test in `test/keys.test.ts` and `test/chord.test.ts`.
