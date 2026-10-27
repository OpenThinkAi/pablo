# The vault

pablo keeps nothing of its own that you would want to read. Your writing lives in a
**vault**: a git repository of plain markdown that you can open in any editor, and
pablo is a manager over it. [`examples/starter-vault`](../examples/starter-vault) is a
minimal one to copy.

pablo finds the vault from `$PABLO_VAULT`, or else by walking up from the current
directory to the first one that holds `style/` or `voices/`.

## Layout

```
<vault>/
  README.md              a table of works; `init` adds a row
  QWEN.md                rules for the whole vault (for you and your agent)
  style/
    prose.md             the shared style guide; sent to the writer with every chapter
    anti-tells.md        what makes text read as machine-written; also sent, and checked
  voices/<name>/         optional named voices for `pablo prose` (voice.md, exemplars/)
  templates/novel/       what `pablo init novel` copies
  novels/<slug>/         one directory per novel (stories/ and essays/ work the same way)
```

A work:

```
novels/<slug>/
  pablo.json             the marker that makes this a pablo project
  STYLE.md               this work's own rules: ground rules, period facts, point of view
  README.md              where things stand; `merge` appends a line per chapter
  bible/
    overview.md          the premise; it counts once `## Logline` has text
    timeline.md          | Year | Real events | In the novel |
    places.md
    characters/          one file per character (a family-tree.md is read too)
  outline/chapters.md    the acts table and the beats table (`outline/beats.md` after `migrate outputs`)
  research/              your sources; never sent to the writer
  notes/                 session notes; never sent to the writer
  continuity.md          facts the text has established, kept by `merge`
  chapters/NN-slug.md    the novel, one sentence per line, with frontmatter
  .pablo/                pablo's own state (receipts, comments, rounds, output); gitignored
```

## The story core and its outputs

A work has one **story core**: premise, research, bible, acts, beats, and decided
facts. From it pablo derives one or more **outputs**: a `novel` (chapters), a
`story` (one short piece over the beats), a `screenplay` (one scene per beat, in
Fountain: `outputs/screenplay/scenes/NN-slug.fountain`, stored line for line), or
`radio` (an experimental audio drama, see [commands.md](commands.md#radio-experimental)), a `narrated`
reading of another output, or an `essay` (on a nonfiction work, one section per
row of `core/outline.md`; on a fiction work, one per row of `outputs/essay/outline.md`,
arguing `outputs/essay/thesis.md`; all in `outputs/essay/essay.md`). `pablo output add <type>` adds one;
outputs other than the novel live under `outputs/<type>/`, each with its own
`RULES.md`, `plan.md` and continuity ledger.

## What pablo enforces

pablo will not draft something whose plan is missing. `pablo status` shows the stages;
`pablo status --for "chapter N"` lists exactly what chapter N still needs, and
`write` refuses (exit 2) with the same list.

The story core is ready when:

- `bible/overview.md` has text under `## Logline` (the premise);
- the bible files exist;
- the outline has an acts table (`| Act | Years | What it accomplishes |`) and beat rows
  (`| # | Story date | Title (working) | Beat | POV | Status |`).

`research/` is optional. A chapter can be drafted when, in addition:

- its beat row exists;
- the chapter before it is written;
- `bible/timeline.md` has a row dated at or before the chapter's year (the first
  four-digit year in its story date);
- no character the beat names still has a `[pick]` placeholder in the bible. Write
  `[pick]` in a table row for a decision you haven't made yet; pablo will refuse to
  draft any chapter that depends on it.

`pablo save` writes the premise, either table or any bible file, validates tables
before writing, and commits only that file.

## `pablo.json`

```json
{
  "title": "The Lighthouse",
  "slug": "lighthouse",
  "author": "Your Name",
  "voice": ["../../style", "STYLE.md"],
  "neverSend": ["research/", "notes/"],
  "publish": {},
  "outputs": { "novel": { "dir": "chapters", "added": "2026-10-12" } }
}
```

| Key | Required | Default | Meaning |
|---|---|---|---|
| `title`, `slug` | yes | | |
| `outputs` | no | `{}` | The work's outputs: `novel`, `story`, `screenplay`, `radio`, `narrated` or `essay`. Each entry has `added` (YYYY-MM-DD); the novel's `dir` is always `"chapters"` |
| `author` | no | `"author"` | Free text. `init` writes your git `user.name` |
| `voice` | no | `["../../style", "STYLE.md"]` | Which voice the screen's voice tools edit. The writer always gets `style/` then the work's `STYLE.md` |
| `neverSend` | no | `["research/", "notes/"]` | Paths that must never reach a model. A prompt that would include one is refused, not silently trimmed |
| `publish` | no | `{}` | Per-target publish settings |
| `track` | no | `"fiction"` | The kind of work: `fiction`, `historical-fiction` or `nonfiction`. Any other value is refused, naming the allowed ones. `status` and `resume` report it |
| `policy` | no | the track's policy | The judgement policy for `pablo agent` (see below) |
| `providers`, `intents` | no | the global config's | This work's model routing, merged over `~/.config/pablo/config.json` (see [configuration.md](configuration.md#per-work-providers-and-intents)) |
| `format` | old | | `"format": "novel"` is the pre-outputs form. It still works; `pablo migrate outputs` converts the work |

A directory without `pablo.json` is refused with `pablo init --adopt --project <slug>`
as the fix, which writes only the marker into an existing work.

## Voice: what the writer is told

Every drafting prompt carries, in order: `style/` (both files), then the rule sections
of the work's `STYLE.md` (its ground rules, point of view and voice). The period facts
go in as their own slice: the rows of `facts/period.md` dated on or before the unit's story
date (and every undated row), then the `STYLE.md` setting and period facts section. A work's rules add to the shared ones;
they never remove them.

A work made before the rename keeps its rules in `QWEN.md`, which pablo still reads when there is
no `STYLE.md`; `pablo migrate style --project <slug>` renames it with `git mv`.

Sections of `STYLE.md` meant for your agent, not the writer, are left out: any heading
mentioning replies or the agent, and anything from the file map onward. Wrap any other
section in `<!-- writer-only -->` ... `<!-- /writer-only -->` to keep it *out of the
agent's* prompt and in the writer's.

The voice grows from your edits. `pablo voice flag` records a line you rejected as a
`Flagged:` example (and `pablo check` will catch it next time), `voice rule` adds a
rule, and `voice exemplar` keeps a passage you liked. `pablo voice show <name>` prints
the voice exactly as a model sees it.

## Policies

The work's `track` picks its judgement policy automatically: `fiction` loads
[`fiction.md`](../packages/cli/policies/fiction.md), `historical-fiction` loads
[`historical-fiction.md`](../packages/cli/policies/historical-fiction.md) and `nonfiction` loads
[`nonfiction.md`](../packages/cli/policies/nonfiction.md); a work with no `track` reads as `fiction`.
`pablo agent`, `pablo story` and the screen all use it. The policy says what to research, what to
invent, when to ask you and when to proceed. `"policy": "<name>"` in `pablo.json` overrides the
track's choice with any shipped policy.

## Branches

pablo never writes manuscript changes to `main` directly. A draft goes to `draft/chNN`
(`draft/story`, `draft/radio-epNN` for other outputs), a revision to `revise/<id>`, a
planning change from the agent to `plan/<id>`.
Read them with `git diff`, or in the screen's review mode (bare `pablo`). Accept a
draft with `pablo merge`; accept the other kinds in the screen's review mode, which
also lets you take part of a change. Both run the after-write steps. `pablo status`
lists the branches waiting for you.
