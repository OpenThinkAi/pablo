# The essay output

An argued, cited piece. A blog post is an essay; where you post it is up to you. Allowed
on every track: [nonfiction](../tracks/nonfiction.md),
[fiction](../tracks/fiction.md) and [historical-fiction](../tracks/historical-fiction.md).
`pablo guide --track <t> --output essay` prints the full path; examples use "The Ice
House".

## On a nonfiction work

```
pablo output add essay --project ice-house
```

Refused until the core is complete (thesis, research, claims, outline). Its units are the
**sections**, the rows of `core/outline.md`. All sections live in `outputs/essay/essay.md`
under `## <section title>` headings in outline order. A section's claims are the
`core/claims.md` rows its "What it covers" cell names (`#2`, `#3`), or every claim when it
names none.

## On a fiction or historical-fiction work

The essay argues a thesis **about the story**, and `output add` needs it:

```
pablo output add essay --thesis "The ice trade made the town and then left it." --project ice-house
```

(On a terminal it prompts instead.) It writes `outputs/essay/thesis.md` and
`outputs/essay/outline.md` (`| # | Section | What it covers |`), drawn from the story core:
the story, the world, one section per act, and what it argues. Edit the outline freely and
run `pablo output plan essay`. A thesis already in `thesis.md` is kept (passing `--thesis`
again is refused); `--thesis` is refused on nonfiction.

## Draft, revise, check

| Step | Command |
|---|---|
| Draft section N | `pablo write --project ice-house --output essay --unit 1` |
| Revise a passage | `pablo revise --project ice-house --file outputs/essay/essay.md --passage "<text>" --instruction "<text>" --branch` |
| Check | `pablo check --project ice-house --output essay` |

- The pack carries the section and the outline around it, the thesis, the section's
  claims each with its citation (`[#2]`, `[@note-id]`), the layered voice, `RULES.md` and
  the end of the previous section. Research notes are never sent; a claim's sources go as
  ids. On a fiction work the pack carries the story, the distilled period facts, `facts.md`,
  cast, places and timeline instead of claims.
- The writer cites each claim where it uses it. The section replaces its text in
  `essay.md` and is committed on `draft/essay-NN`; a section that already has text needs
  `--force`. Default length is 600 words a section (1500 for a fiction essay with no
  `outline.md`).
- On nonfiction, `check` flags `claim-unsupported` and `claim-uncited` sentences, see
  [the track page](../tracks/nonfiction.md#checks). On fiction tracks the track's own
  checks run.

## Publish

```
pablo publish --project ice-house --output essay --target draft|final
```

Writes `.pablo/out/<slug>-essay-<target>.md`: the title, each section under its heading,
then `## Sources`. Citations become numbered references (`[1]`, `[2, 3]`), and the sources
list gives each cited note's title, sources and retrieval date. `draft` adds a "Draft, N
words" line naming any citation that resolves to nothing; `final` is the clean copy and is
refused while one remains. Full reference: [publish](../commands.md#publish).
