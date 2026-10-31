# The nonfiction track

The track for pieces that argue something true: an essay or a blog post, and an audio
reading of one. It has its own core (a thesis, research, claims and an outline) instead of
a bible, acts and beats, and the same research gate as historical fiction. Its checks hold
a draft to the claims and sources you saved.

This page describes what `pablo guide --track nonfiction` prints today; the examples use
a work called "The Ice House" (a piece on the 19th-century ice trade).

## Start

```
pablo init --track nonfiction ice-house "The Ice House"
```

`pablo story` writes fiction and refuses `--track nonfiction`; nonfiction works start
with `init`. A nonfiction work with no output yet is never read as a novel: a verb that
needs one is refused naming `pablo output add essay`. Move an existing work with
`pablo migrate track --project ice-house --track nonfiction`.

## The core and its gate

The stages, in order: `thesis`, `research`, `claims`, `outline`.

| Step | Command |
|---|---|
| Save the thesis, `core/thesis.md` (gate) | `pablo save --stage thesis` |
| Plan the research checklist (gate) | `pablo research plan` |
| Add a claim the plan missed (optional) | `pablo research add "<claim>"` |
| Source each item, or waive it with a reason (gate) | `pablo research save ... --item <#>` / `pablo research waive <#,#,a-b> "<reason>"` |
| Save the claims, `core/claims.md` (gate) | `pablo save --stage claims` |
| Save the outline sections, `core/outline.md` (gate) | `pablo save --stage outline` |

- The checklist works as on [historical-fiction](historical-fiction.md#the-core-and-its-gate),
  but `research plan` reads the thesis (and `core/claims.md` when present) and lists the
  claims to support, category `claim`.
- Claims are a table, `| # | Claim | Sources |`. Every claim must cite at least one research
  note by id (a note's id is its path under `research/` without `.md`), and the id must
  resolve to a file. An unsourced claim blocks the stage.
- The outline is a table, `| # | Section | What it covers |`. At least one row is required;
  `write` refuses otherwise (`nonfiction: core/outline.md has no section rows`).
- `research distill` and the period brief are not steps on this track (the guide lists
  none).

## Checks

Each `*.md` unit gets **claim support**. Every sentence that states a fact (a number, a
name past its first word, or a cue such as "according to") is traced by shared words to a
`core/claims.md` row or a note under `research/`:

- `claim-unsupported`: the claim traces to nothing; `detail` names the nearest candidate.
- `claim-uncited`: the claim traces to a source but the text does not cite it; `detail`
  names the citation to add.

A citation is a bracket of note ids (`@<id>`) and/or claims row numbers (`#<n>`):
`[@ice-harvest]`, `[#2]`, `[@ice-harvest; #3]`. The track's check list in the guide is
`claim-support`; the hits you see are the two above, and a citation that
resolves to nothing is named in the hit. The tracing is by shared words, not a model. `write` runs it
after each draft and reports hits without rewriting; `--no-check` skips it. See
[check](../commands.md#check).

## Outputs

Two: [essay](../outputs/essay.md) and [narrated](../outputs/narrated.md) (reading an
essay). `novel`, `story`, `screenplay` and `radio` are refused on this track, naming the
two that are allowed. The judgement policy is
[`nonfiction.md`](../../packages/cli/policies/nonfiction.md): research each checkable
claim, ask for the author's calls, never state a claim without a source.
