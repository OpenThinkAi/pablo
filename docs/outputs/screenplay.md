# The screenplay output

A screenplay stored as Fountain, one scene per core beat by default. Allowed on
[fiction](../tracks/fiction.md) and [historical-fiction](../tracks/historical-fiction.md).
`pablo guide --track fiction --output screenplay` prints the full path; examples use "The
Ice House".

## Add it

```
pablo output add screenplay --project ice-house
```

Refused until the core has beats. It scaffolds `outputs/screenplay/` (`plan.md`,
`RULES.md`); the scenes live in `outputs/screenplay/scenes/NN-<slug>.fountain`.

## Draft, revise, check

| Step | Command |
|---|---|
| Draft scene N | `pablo write --project ice-house --output screenplay --unit 2` |
| Revise a passage | `pablo revise --project ice-house --file <scene file> --passage "<text>" --instruction "<text>" --branch` |
| Check | `pablo check --project ice-house --output screenplay` |

- The scene is committed on `draft/screenplay-scNN` (a re-draft is `-vK`). Unlike prose,
  Fountain is kept **line for line**, not one sentence per line, because a cue, its
  dialogue and the blank lines between elements are the structure.
- `check` adds a Fountain lint to every scene, in `hits[]`: `fountain-no-heading`,
  `fountain-heading-spacing`, `fountain-cue-no-dialogue`, `fountain-stray-parenthetical`,
  `fountain-colon-dialogue`, `fountain-markdown` and `fountain-unclosed-boneyard`.
- The track's checks (continuity, story-time, unknown-name, plus anachronism and
  fact-accuracy on historical fiction) run after the draft and report hits without
  rewriting it.

## Publish

```
pablo publish --project ice-house --output screenplay --target draft|final|fountain
```

Every target writes `.pablo/out/<slug>-screenplay.fountain`: a `Title:` page, then every
written scene in order, copied line for line. `draft` and `final` also write
`<slug>-screenplay.pdf` in standard screenplay format (US Letter, Courier 12), typeset by
pablo itself; `fountain` writes the Fountain file alone. Full reference:
[publish](../commands.md#publish).
