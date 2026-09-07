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
| `pablo write --project <slug> --chapter N [--words W] [--scenes S] [--force]` | check, pack; `--dry-run` renders the pack and sends nothing (AGT-1230); without it, sends the pack once, normalizes the answer, writes `chapters/NN-<slug>.md` with provenance frontmatter, appends a receipt, and runs the post-write check (AGT-1237) | `{ok, path, receipt, check[]}` / `{ok: false, code, message, missing?}`, or the dry-run body below |
| `pablo save --project <slug> --stage acts\|beats\|premise\|bible/<file> [--file F]` | the agent's planning output (stdin or `--file`) saved through pablo so the framework sees it | `{ok, path, stage, committed, notice?}` |
| `pablo check --project <slug> [--file F]` | the tells check and provenance check on prose | `{ok, hits[], unprovenanced[]}` |
| `pablo dry-run ...` | (planned; today this is `write`'s own `--dry-run`) any write or revise, assembled and priced, nothing sent | the pack, slice by slice |
| `pablo mcp` | serve all of the above as MCP tools, same schemas | |
| *later* `revise`, `voice`, `edit`, `share`, `notes`, `publish` | P1/P2 — the voice loop, local editing, sharing, publishing | |

`check` scans `chapters/*.md` (or one `--file`, work-relative or absolute inside the
work — outside it is a refusal, exit `2`) for two things: chapters whose frontmatter
lacks `model` or `prompt_hash` (`unprovenanced[]`), and lines that trip a mechanical
rule — em-dashes, curly quotes, dash year ranges, foreshadowing phrases, the banned
stock names from `style/prose.md` and `anti-tells.md`, and every `Flagged:` line from
`style/prose.md` found verbatim (`hits[]`, each `{path, line, rule, excerpt}`). A hit
is data, not a failure: exit is `0` whether or not there are hits. `check.ts` exports
`checkFile` and `checkWork` standalone, and `write` (AGT-1237) calls `checkFile`
directly on the normalized body right after writing, putting the hits in its own
`check[]` rather than re-reading the file through `checkWork`. Voice-pattern scoring
beyond verbatim flagged lines is P1, out of scope.

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

`pablo write --project <slug> --chapter N [--words W] [--scenes S]` (AGT-1230) first
runs chapter N's preconditions (same checks as `status --for`) and refuses, exit 2,
naming `missing[]`, if any fail. Then it assembles the drafting pack from
`@openthink/pablo-core`'s `readDraftingInputs` + `assemblePack` — the voice
(`style/*.md`'s prose sections only; any `## ` heading matching `/repl(y|ies)|agent/i`
is dropped before assembly, never sent), the work's rules, period facts, cast and
places, the timeline gated by the beat's story date, `continuity.md`, the tail of
chapter N-1, and the beat row itself, at `--words` (default 1800) and `--scenes`
(default 3). Any slice sourced under one of the marker's `neverSend` prefixes is a
refusal naming the slice and the prefix, not a silent drop. `--dry-run` renders the
pack (a slice table with token counts, and an estimated wait when the target endpoint
has been measured) and sends nothing, exit 0; `--json --dry-run` returns
`{ok, dryRun: true, slices[], totalTokens, expectedOutputTokens, prompt_hash,
adjustments}` — the same inputs produce the same `prompt_hash` on two runs.

Without `--dry-run` (AGT-1237), the filename is fixed first (`NN-<slug>.md`, slug
from the beat's title) so an existing file is a refusal, exit 2, before anything is
sent — pass `--force` to overwrite it. The pack is then sent once to the intent's
routed provider (local by default; `createProviders`' per-endpoint `Gate` already
serializes concurrent calls to the same local endpoint, so `write` adds no
serialization of its own). A hung endpoint, a bad response, or a config error is a
refusal, exit 2, naming the endpoint where relevant — nothing is written on any
error, including an empty or whitespace-only answer. While the model streams,
progress goes to stderr (`waiting for first token…`, `first token after Xs`, then
`N tokens, R tok/s` every ~2s) so a human sees the wait; `--json` output on stdout
is unaffected. The answer is normalized (em-dashes to commas, en-dashes to "to",
curly quotes to straight — `@openthink/pablo-core`'s `normalizeOutput`) and written
with frontmatter in this exact key order: `chapter`, `title`, `pov`, `story_date`,
`status: draft`, `words`, `model`, `generated` (ISO 8601), `prompt_hash`. A receipt
(prompt hash, model, tokens read/written, time to first token, wall) is appended to
`<work>/.pablo/receipts.jsonl` (`withReceipts` + `fileReceiptSink`, rooted at the
work directory, not the vault) and returned as `{path, receipt}`; the prose form
adds one line, `read N tokens in Xs, wrote M in Ys`. The post-write mechanical-tells
check (`check.ts`'s `checkFile`) runs over the normalized body and its hits are
returned as `check[]` — a hit never changes the exit code, which is `0` throughout
this whole path once the file is written.

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
