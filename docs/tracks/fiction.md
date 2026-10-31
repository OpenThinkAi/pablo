# The fiction track

The track for invented stories: a novel, a short story, a screenplay, a radio drama, a
narrated reading, or an essay about the story. It is the default: a `pablo.json` with no
`track` reads as `fiction`. There is no research gate, because nothing in the story has to
be true.

Everything here is what `pablo guide --track fiction` prints today. Run that (or
`pablo guide --track fiction --output <type>`) for the exact commands with your slug filled
in. The examples use a work called "The Ice House".

## Start

```
pablo init --track fiction ice-house "The Ice House"
```

This writes `pablo.json` with `"track": "fiction"` and the track's core files, and no
output yet. `pablo story "<prompt>"` also makes a fiction work; it infers the track from
the prompt (see [historical-fiction](historical-fiction.md) for when it picks the other),
and `--track fiction` forces it. To move an older work onto a track:
`pablo migrate track --project ice-house --track fiction`.

## The core

The core is the work's shared plan. Its stages, in order, are `premise`, `research`,
`bible`, `acts`, `beats` and `facts`.

| Stage | You save | With |
|---|---|---|
| premise | the logline in `bible/overview.md` | `pablo save --stage premise` |
| research | sourced notes under `research/` (optional) | `pablo research save --title ... --note ... --source <url>` |
| bible | characters, places and a timeline | `pablo save --stage bible/<file>` |
| acts | the acts table | `pablo save --stage acts` |
| beats | one row per beat, each with a story date | `pablo save --stage beats` |
| facts | every `[pick]` in the bible decided | `pablo save --stage bible/<file>` |

Research is optional here. `pablo research save` keeps a finding with its sources as
`research/<slug>.md` on a `plan/` branch for you to accept. The checklist
(`research plan`, `waive`, `link`) and `research distill` belong to the gated tracks;
see [the research section of commands.md](../commands.md#research). A `[pick]` blocks
only the units whose beat names it.

## Outputs

The track allows all six: [novel](../outputs/novel.md), [story](../outputs/story.md),
[screenplay](../outputs/screenplay.md), [radio](../outputs/radio.md),
[narrated](../outputs/narrated.md) and [essay](../outputs/essay.md). `pablo output add
<type>` is refused until the core has beats, and for a type the track does not allow.

## Checks

The fiction track runs three checks on every unit:

- `continuity`: facts that contradict the work's continuity ledger (`pablo critique`, and
  `pablo check --across` between outputs).
- `story-time`: something mentioned that is dated after the unit's own year. A unit over several
  beats (a story) is dated first to last: a draft's frontmatter carries `story_date_end` beside
  `story_date`, and only a year after the end of that range is flagged.
- `unknown-name`: a name the bible, `facts.md` and the output's continuity do not know. A
  character file's name counts too, so `bible/characters/clara-vane.md` clears Clara and Vane
  even when the file's text never writes the display name. Three kinds of word are never
  hits: a kinship term of address (Mother, Father, Nonna, Papà), the plural of a known title
  (Doges, when the period facts or bible name the Doge), and a demonym or party name whose
  place or polity is known (Russians, with Russia known).

`pablo check --project ice-house --output novel` also reports the mechanical tells (dashes,
curly quotes, stock names, `Flagged:` lines) and units that lack `model` or `prompt_hash`
provenance. After each draft, `pablo write` and `pablo story` run the track's checks on
that unit and report hits; they never rewrite the draft, and `--no-check` skips all but
the mechanical tells. See [check](../commands.md#check).

## Policy

`pablo agent`, `pablo story` and the screen use the judgement policy
[`fiction.md`](../../packages/cli/policies/fiction.md): what to research, what to invent,
and when to ask you. Set `"policy": "<name>"` in `pablo.json` to override it.
