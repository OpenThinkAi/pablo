# @openthink/pablo-tui

pablo's full-terminal screen, on Ink: a third front end on `packages/cli/src/verbs.ts` beside the CLI and MCP. Bare
`pablo` in a project opens it. The design is the pm project `ai-terminal`'s `screen` doc
(`pm project show ai-terminal --doc screen`); the layout, keys and panel machinery are copied and adapted from
prview, never shared with it.

```
src/state.ts     the state model: modes, focus, cursors, scroll, the pending prefix; `reduce(state, action)`
src/app.tsx      the Ink root: reads the state, draws it, dispatches actions from keys
src/screen.tsx   mounts the app in the alternate screen and restores the terminal
src/resize.ts    the terminal size as state (below the model: plumbing, not where the author is)
src/sanitize.ts  strips control characters from text that did not come from the keyboard
```

## The state model

`state.ts` is pure: no Ink, no React, no imports at all. It holds where the author is and what is open, and nothing
else: the rail's rows are an index (an id, a depth, whether the row folds), the main pane knows how many lines it has,
the content area what it shows. The documents are props of the Ink layer. Every change is a named action through
`reduce`, so each one is tested without a terminal (`test/state.test.ts`), and `test/boundary.test.ts` holds the Ink
layer to one `useReducer` over the model with no `useState` or `useRef` of its own: a component that needs to remember
something dispatches an action instead.

```
mode      { kind: "book" } | { kind: "review", branch }   each mode keeps its own rail and main pane
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
3. Bind a key to it in the key tables (AGT-1524) and draw whatever it changes from the state in `app.tsx`. Nothing
   about it lives in the component.

### Adding a mode

A mode is a variant of `Mode` with its own `View` (a rail and a main pane) on `State`, the way `book` and `review`
are. Add the variant, the view field, the actions that enter and leave it (`review.open` / `review.close` are the
pattern: entering resets the view, leaving restores the pane and focus), extend `viewOf` and `withView` in `reduce`,
and give `escape` its place in the backing-out order. The rail, main pane, content and prefix actions then work in it
unchanged, because they act on `viewOf(state)`.
