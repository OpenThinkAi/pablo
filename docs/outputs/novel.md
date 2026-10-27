# The novel output

A book told chapter by chapter from the work's core: one chapter per beat by default.
Allowed on the [fiction](../tracks/fiction.md) and
[historical-fiction](../tracks/historical-fiction.md) tracks; refused on nonfiction.

`pablo guide --track fiction --output novel` prints the full path; this page covers the
output's own part. The examples use "The Ice House".

## Add it

```
pablo output add novel --project ice-house
```

Refused until the core has beats (and, on historical fiction, until the research gate has
passed for `write`). It scaffolds `outputs/novel/` with `plan.md` (which chapters tell
which beats; `pablo output plan novel` rewrites it) and `RULES.md`, the output's own
voice rules. The chapters themselves live in `chapters/`.

## Draft, revise, check

| Step | Command |
|---|---|
| Draft chapter N | `pablo write --project ice-house --output novel --unit 3` (or `--chapter 3`) |
| Revise a passage | `pablo revise --project ice-house --file <file> --passage "<text>" --instruction "<text>" --branch` |
| Check | `pablo check --project ice-house --output novel [--unit N]` |

- A chapter needs its beat, the chapter before it written, a timeline row dated at or
  before its year, and no `[pick]` its beat names. A refusal lists what is missing
  (`pablo status --for "chapter 3"` shows the same list).
- The chapter is written one sentence per line with frontmatter (`model`, `prompt_hash`,
  `words` and so on) and committed on `draft/chNN` (a re-draft is `-v2`). Default length
  is 1800 words. Accept it with `pablo merge --project ice-house draft/ch03` or in the
  screen. `--dry-run` shows the pack without sending it.
- After the draft, the track's checks run on that unit and report hits without
  rewriting. See the track page: [fiction](../tracks/fiction.md#checks),
  [historical-fiction](../tracks/historical-fiction.md#checks).

## Publish

```
pablo publish --project ice-house --output novel --target draft|review|final
```

| Target | Writes (under `.pablo/out/`) |
|---|---|
| `draft` | `<slug>-draft.md`: every chapter in order, frontmatter stripped, sentences joined into paragraphs, quotes curled |
| `review` | `<slug>-review.md`: chapter headings with each source line numbered `[n]` so a reader can cite a line |
| `final` | the clean manuscript as above, plus `<slug>-final.epub` |

Full reference: [publish](../commands.md#publish).
