# The historical-fiction track

The track for invented stories set against real events, where getting the period right
matters. It adds a research gate: `pablo write` refuses until the period brief, the
research and the period facts exist. Drafts are then checked against those facts.

This page describes what `pablo guide --track historical-fiction` prints today; the
examples use a work called "The Ice House".

## Start

```
pablo init --track historical-fiction ice-house "The Ice House"
```

`pablo story "<prompt>"` infers this track when the prompt names a period or event, says
so (`pablo story: track historical-fiction (inferred: ...)`), and writes it to
`pablo.json`; pass `--track` to override. A run that falls back to `fiction` because the
planner could not be reached says why. Move an existing work with
`pablo migrate track --project ice-house --track historical-fiction`, which commits the
marker and lists the new core stages the work lacks.

## The core and its gate

The stages, in order: `premise`, `period`, `research`, `period-facts`, `bible`, `acts`,
`beats`, `facts`. The guide marks the gated steps with `(gate)`.

| # | Step | Command |
|---|---|---|
| 1 | Save the premise | `pablo save --stage premise` |
| 2 | Save the period brief, `bible/period.md` (gate) | `pablo save --stage bible/period.md` |
| 3 | Plan the research checklist, `research/checklist.md` (gate) | `pablo research plan` |
| 4 | Source each item with a note (gate) | `pablo research save --title ... --note ... --source <url> --item <#>` |
| 5 | Or waive an item with a reason (gate) | `pablo research waive <#,#,a-b> "<reason>"` |
| 6 | Distill the research into period facts, `facts/period.md` (gate) | `pablo research distill` |
| 7 | Bible, acts, beats, decide every `[pick]` | `pablo save --stage ...` |

How the research steps work:

- **The checklist.** `research plan` asks the research agent (the `research` intent) to
  read `bible/period.md` and list what to look up under people, places, technology,
  language, daily life, politics and dates. Each row is `open`, `sourced` (it names a
  research note that has a `## Sources` entry) or `waived` (it gives a reason). Running
  `plan` again keeps existing rows and appends only new ones. The list is sized to the work
  (`--max N` sets the cap). It writes on a `plan/` branch.
- **The gate.** It passes when every item is sourced or waived. `status` and `resume`
  list the open ones, and `write` names the first: `historical-fiction: checklist item #3
  people: Who ran the ice houses is open`.
- **Merge order.** `waive` and `link` rewrite the whole checklist from main, so accept
  each `plan/` branch (`pablo merge --project <slug> <branch>`, or in the screen) before
  the next; two unaccepted ones conflict. Name several items at once (`waive 3,5-8 "..."`,
  `link 1,2 <note>`) to close them on one branch.
- **Distill.** `research distill` turns the notes into short, sourced rows
  (`| Fact | Source | Story date |`) in `facts/period.md`, replacing the file's earlier
  rows. A fact with no source, a source that is not a note, over 280 characters or with a
  bad date is rejected and listed under `rejected`. Only these facts reach the drafting
  model: a unit's pack carries the rows dated on or before its story date plus every
  undated row, never the source note, and nothing under `research/` is ever sent.

## Real names

By default the distilled facts may name the real people and places in `research/`, so a
story about a real event can use them. A work that must keep them out sets `realNames`
in `pablo.json`:

```json
{ "title": "The Ice House", "slug": "ice-house", "track": "historical-fiction", "realNames": false }
```

With it `false`, `research distill` swaps each research name for the bible's invented one,
mapped in `research/names.md` (`| Research name | Bible name |`), and is refused, listing
the names, while any name has no mapping. A research name found anywhere else in a pack is
a refusal from `write`. A real name the agent fails to list is not detected: read the
`plan/` branch. See [configuration.md](../configuration.md#per-work-realnames).

## Checks

On top of the [fiction checks](fiction.md#checks) (`continuity`, `story-time`,
`unknown-name`), this track runs two more on every unit:

- **anachronism**: a word, object or idiom out of the work's period (`rule: "anachronism"`).
  The period is the `## When and where` section of `bible/period.md`; with no brief the
  check is skipped and says so. The unit's distinct words go to the `check` intent's
  model (function words and names the bible or continuity already knows are not sent),
  verdicts are cached per (period, term) in the work's `.pablo/lexicon.json` in the main
  checkout, and you can edit a verdict there to overrule the model. A fully cached unit
  makes no model call. Words the model leaves unjudged make the check fail (exit `1`),
  never a silent pass.
- **fact-accuracy**: the unit against `facts/period.md`. One model call per unit; the
  model names each sentence a fact contradicts, and each hit quotes the sentence, the
  fact and its source note.

`write` and `story` run these after each draft and report hits, never rewriting the
draft; a check that cannot run (no model configured) is reported as a notice and does not
fail the write. `pablo check --project ice-house --output novel --unit 3` runs them on
demand. See [check](../commands.md#check).

## Outputs

The same six as [fiction](fiction.md#outputs): [novel](../outputs/novel.md),
[story](../outputs/story.md), [screenplay](../outputs/screenplay.md),
[radio](../outputs/radio.md), [narrated](../outputs/narrated.md) and
[essay](../outputs/essay.md). The judgement policy is
[`historical-fiction.md`](../../packages/cli/policies/historical-fiction.md).
