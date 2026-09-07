# pablo

**pablo is a CLI that writes.** It is not an app and has no screen. The conversation
about a book happens in whatever agent you already like (Claude Code, Codex, pi);
that agent drives pablo over the shell or `pablo mcp`. pablo is the *manager* of the
writing project: it knows the vault, the framework a format follows, the author's
voice, version control, and publishing, and hands any agent a structured way in and
out so it is competent on the project in one call.

Two invariants:

1. **Prose is produced only through `pablo write`, on the configured local model.**
   The agent plans and decides; it never drafts prose itself.
2. **pablo enforces the framework.** A chapter needs a beat, a beat needs acts, acts
   need a bible. Ask for something whose preconditions are unmet and pablo says
   exactly which one is missing.

No markup, ever — a chapter file is plain prose with frontmatter; edits are a view,
not a notation.

Canonical design doc (session model, project layout, stage machines, voice model,
binding decisions): `~/saltline-digital-vault/projects/ai-terminal/README.md`
(vault project id `ai-terminal`).

## Status

P0 in progress: the repo reshape and CLI skeleton landed 2026-09-06; `init` and the
`pablo.json` marker landed 2026-09-06; the novel stage machine and `status` landed
2026-09-06. `packages/tui` (the earlier terminal-renderer design) is retired; see
`CLAUDE.md`'s `Layout` section and the design doc's `History` for what carried over.

## Install / run

```sh
bun install
bun run typecheck
bun test
bun run pablo --help          # or: bun run packages/cli/src/cli.ts --help
```

`pablo` is `packages/cli` (`@openthink/pablo`), which depends on
`packages/core` (`@openthink/pablo-core`) — a TTY-free, dependency-free library:
the document model, the markup module the provider adapters use for
normalization, the context-pack assembler, and the OpenAI-compatible and
Anthropic adapters.

## Commands

Every verb accepts `--project <slug>` and `--json`. `--project` resolves to
`<vault>/<kind>/<slug>` (kind: `novels`, `stories`, `essays`); the vault is
`PABLO_VAULT` if set, else the nearest ancestor of the current directory holding a
`style/` directory. Exit codes: `0` ok, `2` refused (a framework precondition,
including an unresolvable project), `1` error.

| Command | Does | Returns |
|---|---|---|
| `pablo init <format> <slug> "<Title>"` | scaffold from `<vault>/templates/<format>`, write the marker, commit | `{ok, path, format, slug, title, committed, notice?}` |
| `pablo init --adopt --project <slug>` | write only the marker into a work that already exists, touching nothing else; never commits | same shape, `committed: false` |
| `pablo resume --project <slug>` | the structured summary: stage per part, last event, open decisions, next step | `{format, title, stages, last, open, next, brief?, notices?}` |
| `pablo status --project <slug>` | the novel machine's state: premise, bible (files + `[pick]` rows), acts, beats, chapters | the state object; exit 0 |
| `pablo status --project <slug> --for "chapter N"` | that chapter's preconditions — exit carries readiness | `{ready, missing[]}`; exit `0` if ready, `2` if not |
| `pablo write --project <slug> --chapter N [--words W] [--scenes S] [--variants V]` | the prose call: check, pack, send, write, rituals | `{path, receipt, rituals[]}` or `{refused, missing[]}` |
| `pablo save --project <slug> --stage acts\|beats\|premise\|bible/<file> [--file F]` | the agent's planning output (stdin or `--file`) saved through pablo so the framework sees it | `{ok, path, stage, committed, notice?}` |
| `pablo check --project <slug> [--file F]` | the tells check and provenance check on prose | `{tells[], unprovenanced[]}` |
| `pablo dry-run ...` | any write or revise, assembled and priced, nothing sent | the pack, slice by slice |
| `pablo mcp` | serve all of the above as MCP tools, same schemas | |
| *later* `revise`, `voice`, `edit`, `share`, `notes`, `publish` | P1/P2 — the voice loop, local editing, sharing, publishing | |

Everything past the skeleton (parsing, `--help`, `--project` resolution, `init`) is a
stub today: each other verb prints "not implemented yet" and exits 1. See the design
doc's `Commands` table for the full return shapes and the `Build order` section for
what ships next.

`pablo resume` is how an agent gets competent on a project in one call instead of
reading ten files: `format`/`title` come from the marker, `stages` from the novel
machine, `last` is the newest `notes/` file plus the last commit touching the work,
`open` is every `[pick]` row and every bullet under a "Decisions"/"Open questions"
heading in `bible/` and `outline/chapters.md`, and `next` is the first unmet stage or
the next unwritten chapter. A `think brief` for the project's cortex runs off the
critical path with a 20s timeout and lands as `brief` when it's ready in time; a
missing `think`, a timeout, or a non-zero exit is a one-line entry in `notices`,
never a failure. The prose form is under 30 lines and always ends with `next: ...`.

`init` is the one verb that runs without a marker — its job is to write one. Every
other verb refuses (exit 2) when the resolved project has no valid `pablo.json`,
naming the missing file or key and pointing at `pablo init --adopt --project <slug>`.

Only `novel` is implemented as an `init` format today; `story`/`essay` scaffolds land
when their format machines do.

`pablo init novel <slug> "<Title>"` copies `<vault>/templates/novel` to
`<vault>/novels/<slug>`, fills `{{TITLE}}`/`{{DATE}}`/`{{SLUG}}` in every `.md` file,
writes `.brief.md`, adds the work's row to `<vault>/README.md`'s works table, writes
`pablo.json`, adds `.pablo/` to `<vault>/.gitignore` if it's not already there, and
commits everything it just created or changed by pathspec (never `git add -A`). A
destination that already exists, or a missing template directory, is a refusal
naming the path. A git failure (the vault isn't a repo, say) never aborts the
scaffold — the files are already on disk; the result just carries a `notice` instead
of `committed: true`.

`pablo init --adopt --project <slug>` is for a work that already exists without a
marker: it writes only `pablo.json` (title taken from the work's `README.md` first
`# ` heading, minus a trailing "(working title)") and, if absent, the `.gitignore`
line — nothing else in the work changes, and it never commits. Refuses (exit 2) if
the work already has a `pablo.json`.

`pablo status --project <slug>` reads the novel machine's state from the vault (see
the design doc's `Novel` stage table): `premise` (`bible/overview.md` has a
`## Logline` with text), `bible` (`{file, exists}` for each `bible/characters/*.md`,
`bible/places.md`, `bible/timeline.md`, plus every `[pick]` placeholder found in a
bible file's table rows), `acts` (the first `| Act | ... |` table in
`outline/chapters.md`), `beats` (every numbered row of that file's chapter table),
and `chapters` (`chapters/NN-*.md` files with their frontmatter). With no `--json` it
prints one line per stage instead of the state object.

`pablo status --project <slug> --for "chapter N"` (also accepts `chapter-N`, `ch N`,
or a bare `N`; anything else is a refusal naming the expected form) checks one
chapter's preconditions and returns `{ready, missing[]}` — a plain body, not the
`{ok, code, message}` refusal shape, because an unmet precondition here is the
answer, not a framework-resolution failure. The exit code still carries the
framework-precondition contract: `0` when ready, `2` when not. Checks, in order:
beat row N exists (if not, that is the *only* entry in `missing` — everything else
needs the beat); chapter N-1 is written, unless N is 1; `bible/timeline.md` has a row
dated at or before the beat's story-date year; and no `[pick]` row's name appears, as
a whole word or phrase, in beat N's own text.

`pablo save --project <slug> --stage <stage> [--file <path>]` (AGT-1233) reads
stdin, or `--file` when given, and writes the file that `--stage` names:
`premise` replaces `bible/overview.md` whole; `acts` and `beats` replace their
table in `outline/chapters.md` (the acts table or the chapter table) and leave
the rest of the file byte-for-byte intact — the input may be a full table or
rows only, either way it's normalised to the canonical header before writing;
`bible/<file>` replaces that file whole and must stay under `bible/` (`.md`
only). Table input is validated before anything is written — a beat row needs
six columns with a four-digit year in its story date, an act row needs three
— and a malformed row is refused (exit 2) naming the row and column, with
nothing written. The touched file is committed by pathspec, same as `init`.

## Project layout

A project is a vault directory:

```
<vault>/
  style/               the shared voice: prose.md, anti-tells.md
  novels/<slug>/
    pablo.json         the project marker
    bible/, outline/, chapters/, continuity.md, notes/, research/, feedback/
  stories/<slug>/
  essays/<slug>/
```

Full layout is in the design doc's `The project` section. pablo state that is not a
document (receipts, share links) lives in `<work>/.pablo/`, gitignored — everything
an author would want to read is markdown in the vault, tracked by git.

### `pablo.json`

The marker that makes a directory a pablo project. `packages/cli/src/marker.ts` is
the loader; it rejects an unknown `format` or a missing required key, naming it.

```json
{
  "format": "novel",
  "title": "The Valley's Shadow",
  "slug": "valleys-shadow",
  "author": "matt",
  "voice": ["../../style", "QWEN.md"],
  "neverSend": ["research/", "notes/"],
  "publish": { "review": "artifact", "final": null }
}
```

| key | required | default |
|---|---|---|
| `format` | yes | — (`"novel"` for P0; any other value is refused, naming it) |
| `title` | yes | — |
| `slug` | yes | — |
| `author` | no | `"matt"` |
| `voice` | no | `["../../style", "QWEN.md"]` |
| `neverSend` | no | `["research/", "notes/"]` |
| `publish` | no | `{}` |

A directory with no `pablo.json` at all is a refusal naming
`pablo init --adopt --project <slug>` as the fix.

## Contributing

Read `CLAUDE.md` and `AGENTS.md` before any change — this repo is stamp-governed
(`stamp review` → `stamp merge` → `stamp push`), and `CLAUDE.md`'s conventions
section covers the git-from-code rule and the fixture-vault-only rule for tests.
