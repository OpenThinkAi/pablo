# pablo

AI-native terminal tool for writing and composition. Not a text editor.

`pablo` opens a manuscript from a plain markdown vault, lets you select a span and
tag it, prompt on it, or replace it by hand, and reviews the model's proposals as
inline CriticMarkup you accept, reject, or edit in place. Context for a long
manuscript is retrieved by walking a map of the book (structure, entities, facts
with story-time and provenance), not by dumping the book into the prompt.

**The model has no write tool.** It proposes; the app applies.

Local models are the default (no key required). OpenAI and Anthropic are a key and
a toggle away.

Design doc (canonical, decisions table, build order):
`saltline-digital-vault/projects/ai-terminal/README.md`.

Status: design complete 2026-09-01; P0 in progress. The repo is a Bun workspace —
`packages/core` (TTY-free document, span, and CriticMarkup model) and
`packages/tui` (the opentui renderer and the `pablo` bin).

```sh
bun install
bun run typecheck
bun test
bun run pablo                 # usage
bun run pablo chapter-01.md   # the manuscript view
```

## The manuscript view

`pablo <file.md>` opens the file full-screen. Prose wraps to the terminal;
CriticMarkup renders as styled text with the delimiters hidden — an addition in
green, a deletion struck through in red, a substitution as the old text struck
through followed by the new text underlined, a note in violet italic, a
highlight on a warm background. Only the visible window is laid out, so a
500-page manuscript costs the same per frame as a one-page one.

The file is re-read whenever it changes on disk, so editing it in `$EDITOR`, or
having pablo apply a proposal, both land in the view without losing your place.

A **selection always exists**. It opens on the paragraph under the cursor, and
every verb pablo grows from here acts on it — pablo is not a text editor and has
no insert mode or free cursor.

### Keys

The map is built for a keyboard with **no function row and no number row**
(Matt's Corne split: ZMK, Colemak, five layers). Every action is a letter, a
symbol, an arrow, or a control chord; the letters are mnemonic rather than
positional, so they sit in the same place on Colemak as on QWERTY.

| Key | Does |
|---|---|
| `n` / `p`, `→` / `←` | select the next / previous unit at the current granularity |
| `+` (or `=`) | expand one level: sentence → paragraph → scene → chapter |
| `-` (or `_`) | shrink one level: chapter → scene → paragraph → sentence → character |
| `[` / `]` | move the selection **start** one character left / right |
| `{` / `}` | move the selection **end** one character left / right |
| `i` / `a` | collapse to a zero-width selection before / after the selection |
| `↓` / `↑`, `ctrl+e` / `ctrl+y` | scroll one line |
| `space` / `b`, `PgDn` / `PgUp`, `ctrl+d` / `ctrl+u` | scroll a screen |
| `g` / `G`, `Home` / `End` | start / end of the manuscript |
| `r` | re-read the file from disk now |
| `?` | show the key map (`↓` / `↑` scroll it, `esc` closes) |
| `q`, `ctrl+c` | quit |

The character keys are the fallback when no structural unit is the right shape.
A **zero-width selection** — `i` or `a` — is a first-class gesture, not an empty
one: it is where drafting into a boundary happens, and it is drawn in the text
as `‸` and named in the status line.

The map lives in `packages/tui/src/keymap.ts` as data, and the in-app `?` screen
is generated from it, so a new verb documents itself.

## License

MIT
