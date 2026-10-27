# The radio output

A radio drama: one episode per core beat by default, scripted, cast with voices,
performed, mixed and published as audio. Allowed on [fiction](../tracks/fiction.md) and
[historical-fiction](../tracks/historical-fiction.md). It is experimental and needs
Apple Silicon for the casting side (the first casting verb provisions it; writing verbs
never do). `pablo guide --track fiction --output radio` prints the full path; examples
use "The Ice House".

## Add it

```
pablo output add radio --project ice-house
```

Scaffolds `outputs/radio/` (`plan.md`, `RULES.md`); scripts live in
`outputs/radio/episodes/NN-<slug>.md` and casting state in `outputs/radio/casting/`.

## The stages

| Stage | Command |
|---|---|
| Script episode N | `pablo write --project ice-house --output radio --unit 1` |
| Cast the roles | `pablo cast --auto --project ice-house --episode 1`, or the mixer's Cast panel |
| Perform | `pablo perform --project ice-house --episode 1` |
| Mix | `pablo mix --project ice-house --episode 1`, then edit in `pablo mixer --project ice-house --episode 1` |
| Re-record flagged lines | `pablo fix --project ice-house --episode 1` (flag lines in `pablo review` or the mixer's punch list) |
| Check | `pablo check --project ice-house --output radio` |

The script is committed on `draft/radio-epNN`. `check` adds a `radio` block: stage
directions outside the vocabulary and roles with no voice. `pablo status --for "radio N"`
and `resume` report each episode's stage. The track's checks run after the script like any
other output's.

## Publish

```
pablo publish --project ice-house --output radio --target bundle|player|stream
```

- `bundle`: `.pablo/out/<slug>-radio-bundle/` with every script, each mixed episode's
  newest audio and manifest, and `bundle.json`; unmixed episodes are listed in `notes`.
- `stream`: each mixed episode's newest audio and manifest, with its time to first
  audio, in `.pablo/out/stream/`.
- `player`: refused; use `pablo review`.

More: [Radio](../commands.md#radio-experimental) in commands.md.
