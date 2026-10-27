# The story output

One short piece told over the whole core: a single unit in `outputs/story/story.md`.
Allowed on [fiction](../tracks/fiction.md) and [historical-fiction](../tracks/historical-fiction.md).

`pablo story "<prompt>"` is the one-command route: it builds the core, then drafts, accepts
and publishes a story (or a novel, by the length the prompt asks for). This page is the
step-by-step route that `pablo guide --track fiction --output story` prints. Examples use
"The Ice House".

## Add it

```
pablo output add story --project ice-house
```

Refused until the core has beats. It scaffolds `outputs/story/` (`plan.md`, `RULES.md`).

## Draft, revise, check

| Step | Command |
|---|---|
| Draft | `pablo write --project ice-house --output story` (one unit, so no `--unit`) |
| Revise a passage | `pablo revise --project ice-house --file outputs/story/story.md --passage "<text>" --instruction "<text>" --branch` |
| Check | `pablo check --project ice-house --output story` |

The draft lands on `draft/story` (a re-draft is `-v2`); you accept it with `pablo merge`
or in the screen. The default length grows with the beats (600 words per beat, never below
a chapter's default); `--words` overrides it. The track's checks run after the draft and
report hits without rewriting it; `pablo story --no-check` and `write --no-check` skip
them.

## Publish

```
pablo publish --project ice-house --output story --target draft|review|final
```

Writes `.pablo/out/<slug>-story-<target>.md`. `draft` and `final` are the clean compiled
story; `review` adds a "Review copy, N words" line under the title. Full reference:
[publish](../commands.md#publish).
