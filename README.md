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
| `>` | **prompt** the model on the selection: type the instruction, `enter` sends |
| `e` | **edit by hand**: a field opens pre-filled with the span, `ctrl+s` saves |
| `x` | **cut** the selection |
| `m` | **move**: cuts the selection, then `m` again at a boundary drops it there |
| `o` | **open `$EDITOR`** at the cursor line, and re-read on return |
| `d` | **dry run**: the pack that would be sent, slice by slice, without sending it |
| `R` | **retry** the last prompt |
| `↓` / `↑`, `ctrl+e` / `ctrl+y` | scroll one line |
| `space` / `b`, `PgDn` / `PgUp`, `ctrl+d` / `ctrl+u` | scroll a screen |
| `g` / `G`, `Home` / `End` | start / end of the manuscript |
| `r` | re-read the file from disk now |
| `B` | show the work brief (`↓` / `↑` scroll it, `esc` closes) |
| `?` | show the key map (`↓` / `↑` scroll it, `esc` closes) |
| `q`, `ctrl+c` | quit |

The character keys are the fallback when no structural unit is the right shape.
A **zero-width selection** — `i` or `a` — is a first-class gesture, not an empty
one: it is where drafting into a boundary happens, and it is drawn in the text
as `‸` and named in the status line.

The map lives in `packages/tui/src/keymap.ts` as data, and the in-app `?` screen
is generated from it, so a new verb documents itself.

**A field is a mode, not a binding.** `>` and `e` open the only text-entry
surface pablo has — one line for an instruction, several for a replacement — and
while it is open the keys go into it: `enter` sends (and is a new line in a
manual edit), `ctrl+s` saves a manual edit, `esc` (or `ctrl+c`) cancels and
changes nothing. There is still no insert mode over the manuscript.

### Prompting a span

`>` assembles a **span-edit context pack** — the prose rules from
`<vault>/style/*.md`, the work's own `QWEN.md` when it has one, the paragraphs
on each side of the selection, the selection, and your instruction — prices it
against what the endpoint has been measured doing, and streams the answer. The
vault is the nearest directory above the file that contains `style/`; a file
opened outside one still works, with a notice saying the pack carries no style
rules. When the work brief below has landed, it goes into the pack too, right
after the style rules — so a prompt run after the brief arrives knows what the
brief knows.

Before the first byte the status line carries the pack's size and the estimated
wait; during the run, time to first token and tokens per second; after it, the
receipt — "read 4,900 tokens in 19s, wrote 1,500 in 50s" — which stays until you
do something else. `d` shows the whole pack, slice by slice with the exact
prompt, and sends nothing. A hung or failed endpoint is an inline error naming
the endpoint, with `R` to try again; the view stays scrollable throughout,
because the request does not run on the render loop.

The answer comes back as **CriticMarkup** — the pack asks for it, because a
streamed completion has no `propose_edit` tool to call — so the model marks the
words it changed and pablo writes exactly that. A model that answers in plain
prose anyway is wrapped in one substitution over the span, `{~~old~>new~~}`, or
an addition at a zero-width selection, `{++new++}`; an answer the CriticMarkup
parser rejects is refused and nothing is written. Either way it is **pablo** that
writes, and nothing is applied — the mark waits for review. `x`, `m` and `e` are
your own edits and apply directly, because git is where the author's edits are
recorded.

## The work brief

Opening a file inside a writing vault runs the work's brief **as an app event**,
because the model will not run a session preamble on its own. The vault root is
the nearest ancestor holding `style/`, and the work is the directory directly
under `<vault>/<kind>/`, so `~/writing/novels/valleys-shadow/chapters/01.md`
briefs the slug `valleys-shadow`:

```sh
think brief --cortex writing --context valleys-shadow
```

It runs **once per session**, off the render loop, with a 20-second timeout, and
the result is cached in memory for as long as the view is open. `B` shows it;
`↓` / `↑` scroll it and `esc` or `B` closes it.

`think` is resolved from `PATH` when the view opens and is never a hardcoded
path. If it is missing, exits non-zero, or times out, the view opens exactly as
it would otherwise and the reason appears as one line in the status bar —
nothing in the session waits on the brief.

The brief is **context, not content**. It is read-only for the whole session and
is never written into the manuscript. `>` reads it through
`ViewHandle.briefText()` at the moment it assembles the pack — not when the view
opened — so a brief that lands mid-session is in the next prompt, and a run
started before it lands simply has one slice fewer. In the pack it sits after
the style rules and before the work's own rules, as prose about the work and
never as an instruction.

## License

MIT
