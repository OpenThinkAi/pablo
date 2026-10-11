# pablo — agent guide

**pablo is a CLI that writes, with a full-terminal screen of its own** (decided
2026-10-01, pm project `ai-terminal`, `--doc screen`; it supersedes the
2026-09-06 "no screen" decision). Bare `pablo` inside a project opens the Ink
screen in `packages/tui`; the CLI verbs and `pablo mcp` stay, so whatever agent
Matt already likes (Claude Code, Codex, pi) can still drive pablo over the shell
or MCP. pablo is the *manager* of the writing project: it knows the vault, the framework a
work's story core and outputs follow, the author's voice, version control, and publishing, and hands
any agent a structured way in and out.

Two invariants:

1. **Prose is produced only through `pablo write`, on the configured local
   model.** The agent plans and discusses; it never drafts prose itself and
   never sends prose through its own context. pablo assembles the prompt,
   sends it to the configured writer (Gemma 4 for Matt, by default), writes
   the file, and returns a receipt.
2. **pablo enforces the framework, in two layers** (decided 2026-10-10, pm
   project `pablo-story-core`; it supersedes "a format is a stage machine").
   A work has one shared **story core** with its own stage machine (premise,
   research, bible, acts, beats, facts decided), and any number of
   **outputs** derived from it (novel, radio, later blog, essay, story), each
   an output type in the output registry with its own stage machine after the
   core (a chapter needs a beat and the previous chapter, a beat needs acts,
   acts need a bible). A verb whose precondition is unmet is refused, naming
   exactly what is missing and which layer is short, so the agent can steer
   the author there instead of guessing.

**The canonical design doc is the pm project `ai-terminal`'s design doc:
`pm project show ai-terminal`** (named docs: `--doc prose`, `--doc screen`;
the vault's `projects/ai-terminal/*.md` are a frozen pre-AGT-1407 snapshot — don't
read or edit them). It holds the session model, the project layout, the full
verb table, the stage machines, the voice model, and the binding-decisions
table. Read it before any non-trivial change; this file deliberately does not
restate it. A change that contradicts a binding decision there amends the doc
in the same task or does not land.

The two-layer design (core machine, output registry, `pablo.json` `outputs`
in place of `format`, per-output continuity) is the pm project
`pablo-story-core`'s design doc (`pm project show pablo-story-core`). Core
material (`research/`, `bible/`, `outline/`, `facts.md`, `notes/`) is shared;
the novel output keeps `chapters/`, every other output lives under
`outputs/<type>/`.

Documents are the plain markdown files already in the `~/writing` vault. pablo
is a manager over that vault, never a replacement for it, and never a second
store.

**No markup, ever.** CriticMarkup and any other inline shorthand were
eliminated 2026-09-06. A chapter file is plain prose with frontmatter; edits
and revisions live in the terminal screen (the 2026-10-01 screen design; the
browser editor, `pablo edit`, was retired), not as a notation in the file.

## Layout

```
packages/core   @openthink/pablo-core — TTY-free, dependency-free. The
                document model, the markup module (used by the provider
                adapters' streaming/normalization path, not by any manuscript
                — no CriticMarkup is ever written to a vault file), the
                context-pack assembler, the provider adapters
                (OpenAI-compatible, Anthropic), and the fiction sentence
                splitter (`splitSentences`/`joinSentences`) behind
                one-sentence-per-line manuscripts.
                `write` and `prose` save through `splitManuscript`; pack
                assembly joins manuscript slices with `joinManuscript`, so the
                model never sees the splits (AGT-1531).
                `review-map.ts` maps a reader's paragraph selections to
                sentence lines and marks to a GitHub review payload and back
                (AGT-1584, `--doc readers`); the reader view, `share`'s
                transport and `notes pull` call it, never re-derive it.
packages/tui    @openthink/pablo-tui — the Ink 7 / React 19 screen, a third
                front end on `verbs.ts` beside the CLI and MCP. Terminal and
                React dependencies live here, never in core. Resize and
                sanitising code is copied from prview, not shared with it.
                Where the author is and what is open is a pure state model
                (`src/state.ts`, no Ink or React); the Ink layer reads it and
                dispatches actions, and `test/boundary.test.ts` holds it to
                that. `packages/tui/README.md` says how to add a mode or action.
packages/cli    @openthink/pablo — the `pablo` bin: argument parsing, verb
                dispatch, `--project` resolution, `pablo mcp`, and the
                harness (`src/harness/`, `pablo agent`, AGT-1552): the
                Claude Agent SDK configured as pablo (`--doc harness`) —
                pablo's system prompt in place of Claude Code's (role, the
                judgement policy `pablo.json`'s `policy` names from
                `packages/cli/policies/`, and the work's `QWEN.md` minus
                `<!-- writer-only -->` sections; AGT-1553), WebSearch
                and WebFetch the only built-ins, pablo's MCP tools attached
                in-process, the subscription by default with a config key
                overriding. A tool added to `VERBS` reaches both `pablo mcp`
                and the harness. `pablo agent --tag-facts` (AGT-1570) is the one-time
                catch-up: it tags every untagged bible and continuity fact on a
                `plan/` branch through `record-fact.ts`'s writer, never a chapter.
                `ask_author` (AGT-1560) is the exception: it needs a
                front end, so a session gets it only when its spec carries an
                `AskAuthor` (`pablo agent` reads answers from stdin; the compose
                view shows a question card). Tests
                inject a fake `HarnessQuery`; nothing
                in `bun test` starts Claude. The screen's compose view
                (`a c`, AGT-1566) talks to the harness through a `Composer`
                seam the cli passes to `runScreen` (`harness/compose.ts`, a
                streaming-prompt session); the tui never imports the SDK.
                The reader's window (`pablo read <round>`, AGT-1586): a ui-leaf
                view, `packages/cli/views/reader.tsx`, mounted by
                `src/reader-host.ts`. The view is dumb: it renders what the
                host sends and posts marks back (`saveDraft`, `submit`); the
                host maps them with core's `review-map` and sends them with
                `submit.ts`. `views/` is type-checked with everything else
                (the root tsconfig carries the DOM lib for it) and ships in
                the package's `files`. It needs real Google Chrome; tests
                use a fake `mount`, never a window.
                Any new dependency the CLI needs
                goes here; core stays dependency-free.
                The output registry (AGT-1668): `src/outputs/registry.ts`'s
                `OUTPUTS` is the single source of output types, like `VERBS`;
                each type is a directory (`src/outputs/novel/`) exporting an
                `OutputDefinition` (`src/outputs/types.ts`: artifact dir,
                rules template, plan, stages, preconditions, pack, rituals,
                publish targets, branch naming). Verbs ask the work's output
                (`workOutput`/`outputForWork`), never a type's paths: nothing
                under `src/` outside `outputs/novel/` spells `chapters/`
                (`test/outputs.test.ts` greps for it), and every type passes
                `src/outputs/conformance.ts` over the four-beat fixture.
                `story` (AGT-1689, `src/outputs/story/`) is the single-unit
                type: one unit (`soleUnit`, so `write --output story` needs
                no `--unit`) over every beat, or the beats its `plan.md` row
                names (a chosen act), in `outputs/story/story.md` on
                `draft/story`; the outline is one pack slice and the length
                is `--words`, else 600 words a beat.
                Addressing (AGT-1669): `write`, `status --for "<type> N"`,
                `check`, `publish` and `share` take `--output <type>`
                (`--chapter N` is `--output novel --unit N`) and resolve it
                with the registry's `resolveOutput`: one output is implied,
                several and none named is a refusal naming them. `pablo
                output list|add|remove|plan` is `src/output-verbs.ts` (one
                `VERBS` entry; `remove` archives under `outputs/_removed/`,
                never deletes). Write receipts carry `output` and `unit`;
                `draft_unit(output, n, direction?)` is `write` for the
                harness beside `draft_chapter`. Tests register fixture types
                with `registerOutput` (tests only; real types are rows).
                The pack layers per output (AGT-1670): voice, the work's
                rules, then `outputs/<type>/RULES.md` as its own
                `outputRules` slice (shown in `--dry-run` with its tokens),
                then the unit's slices. `outputs/<type>/plan.md` rows map a
                unit onto one or several beats (`beats` cell `2-3`, `1, 4`):
                the pack's `chapter` slice carries exactly those beat rows,
                preconditions check each, and no plan row means beat N for
                unit N (core's `planBeatsFor`). `pablo output plan` keeps the
                existing rows (mapping untouched, status refreshed, a stale
                undrafted row dropped) and appends rows for new beats.
                Continuity (AGT-1671): each output keeps its own ledger
                (core's `continuityFile(work, output)`:
                `outputs/<type>/continuity.md`, the novel's through the
                migration shim); a unit's pack carries its output's ledger
                plus `facts.md`, never another output's (a slice under
                another `outputs/<type>/` is a refusal). `check --output`
                adds the core check (`src/core-check.ts`: story-time,
                unknown names); `check --across` (`src/across.ts`) compares
                the ledgers through the critic's refute step, and `pablo
                promote` (one `VERBS` entry, as is `record_fact --promote`)
                writes `facts.md` with `established-by` on a `plan/` branch
                and comments the contradicting unit's line there.
                `src/casting.ts` (AGT-1678) is the runner for the Python
                side: `pablo doctor` reports it, and the first casting verb
                (`audition`, `cast`, `voices`: `src/casting-verbs.ts`,
                AGT-1679, one `VERBS` entry each) provisions it lazily with
                `uv sync --frozen` (venv in `packages/casting/.venv`, or
                `$XDG_DATA_HOME/pablo/casting/venv` for an npm install),
                pulls the configured weights and leaves a receipt. A missing
                `uv` is a refusal naming `brew install uv`; only `cli.ts`
                `radio.ts` and `casting-verbs.ts` import the runner, and it
                runs only inside a casting verb, so a writing verb on a
                writing work never touches it. `src/radio.ts` (AGT-1680) is
                the radio door: `check` (on a work whose scripts carry a
                `CAST:` line), `status --for "episode N"` and `bind` ask the
                Python side through it; scripts are read from
                `outputs/radio/episodes/`, else `chapters/`.
                `pablo gate` (AGT-1682) scoring audio provisions with
                `--extra scorers` (recorded in the venv's stamp, never
                dropped by a later sync); `gate calibrate` and
                `gate --scores` need no extra. `gate` is CLI-only, not in
                `verbs.ts`, until the casting verbs land there together.
                Tests inject `CastingDeps`; `bun test` never needs uv or a
                model. `prepack` copies the casting sources into
                `packages/cli/casting/` (gitignored) for the npm `files`.
packages/casting  pablo-casting — Python 3.12 (`pyproject.toml`, `uv.lock`,
                `src/pablo_casting/`, `tests/`), pm project `pablo-casting`.
                Run only as `python -m pablo_casting <command> --json`
                (`version`, `doctor`, `pull`, `audition`, `cast`, `voices`,
                `takes`, `manifest`, `script`, `check`, `status`, `bind`,
                `gate`, `gate calibrate`),
                never a user-facing binary; same body and exit codes as
                pablo. The script reader (`script.py`), the direction
                grammar (`directions.py`), the `CAST:` traits mapper and the
                traits vocabulary cards validate against (`traits.py`) and
                the `cast.json` binding (`binding.py`, which takes the card
                hash and the library root from `library.py`) are pure
                Python, model-free. So is auto-casting (`matching.py`,
                AGT-1698, `pablo cast --auto --project W [--episode N |
                --all]`): gender filters, weighted trait agreement scores,
                a voice whose stored ECAPA embedding is within the
                distinctness cut of one already bound is skipped, retired
                cards are never candidates; bindings carry `by: match`,
                the score, the runner-up and `review`, and the rest come
                back as `needsDesign`. Thresholds are the config's
                `matching` block over the design's 0.8 / 0.6 / 0.75. The gate's scorers sit behind
                `scorers.py`'s `Scorer` interface with their heavy imports
                inside each backend, so `doctor` lists weights, licenses and
                versions from metadata alone; the backends need the optional
                `scorers` extra (`emotion` for emotion2vec). Thresholds and
                the pass/fail table are `gates.py`, the calibration rule
                `calibrate.py`, the Whisper words/tail check (ported from the
                radio prototype) `words.py`.
                Config: `$XDG_CONFIG_HOME/pablo/casting.json` (engines,
                weights, library, pace; no weights by default). Receipts:
                `<work>/.pablo/casting/receipts.jsonl`. Its tests are pytest;
                the default run is model-free, `-m models` marks the
                hand-run ones.
                The take store (`takes.py`, AGT-1681): takes are
                content-addressed (`takes/<key>/take.wav` + `take.json`,
                key = sha256 of the canonical inputs), written once through
                a staging rename and read-only after; nothing deletes or
                rewrites one, and `pablo takes gc` only *moves* unreferenced
                takes into `archive/takes/<stamp>/` after listing them and
                asking (`--yes` without a terminal). `manifest.py` is the
                only writer of `renders/epNN/v<k>.json`: it refuses (exit 1,
                nothing written) a version whose changed takes are not a
                subset of the applied flags' lines. `fake_engine.py` is the
                model-free engine (silence of the right shape) until C11.
                The voice library (AGT-1679) is the config's `library`, else
                `<vault>/casting`: `voices/<slug>/` holds the tracked card
                (`card.json`, `reference.flac`, `reference.txt`,
                `embedding.ecapa.npy`) and the untracked `auditions/` and
                `recast/`; `library.py` owns the layout and the card hash
                (sha256 of the card's canonical JSON, `retired` excluded).
                Every model sits behind `toolkit.py`'s protocols (designer,
                embedder, MOS, aligner): tests use `fakes.py`, the real
                adapters in `real.py` import their stacks lazily and those
                stacks are not dependencies yet. Synthetic only: a card's
                reference comes from a designer's audition, checked by
                sha256; there is no `--from-wav`.
```

`packages/core/test/tty-free.test.ts` enforces the split — it walks
`packages/core/src` and fails on any terminal import (`opentui`, `node:tty`,
`ink`, `blessed`) or on any dependency at all in core's manifest. There is no
opentui renderer in this repo any more: the first `packages/tui` (opentui-based)
was retired 2026-09-06 along with the CriticMarkup/selection design it
implemented, and the current `packages/tui` is the Ink screen rebuilt from
2026-10-01 (AGT-1522). See the design doc's `History` section for what carried over as
material (the pack assembler, the vault reader, the provider adapters, the
config loader) versus what was cut outright (the screen, the CriticMarkup
parser and renderer, span verbs). The **review queue** (a JSONL log, `pablo review`, AGT-1255..1263) and the **menu-bar tray**
that watched it were both retired 2026-10-01 (AGT-1520, AGT-1541): the
`pm project show ai-terminal --doc screen` decisions supersede them. Every manuscript
change is a git branch, the screen's review mode is where the author decides, and
`pablo status` / `pablo resume` report the branches waiting for review.

## The project

A **project is a vault directory** under `<vault>/novels|stories|essays/<slug>`,
with the writing vault's existing layout (`style/`, `bible/`, `outline/`,
`chapters/`, ...). `--project <slug>` resolves it: the vault is `PABLO_VAULT`
if set, else the nearest ancestor of the current directory holding a `style/`
directory. An unresolvable project is a refusal, exit code 2, naming every
path it tried — see `packages/cli/src/project.ts`.

pablo state that is not a document (last run, receipts, rates, share links)
lives in `<work>/.pablo/`, gitignored. Everything the author would want to
read is a markdown file in the vault, tracked by git.

## Verbs and exit codes

Every verb accepts `--project <slug>` and `--json`. Exit codes are the
contract every ticket builds on: **0** success, **2** refused (a framework
precondition — an unresolvable project, or later an unmet stage
precondition), **1** error (including "not implemented yet" for a verb whose
body has not landed). See the design doc's `Commands` table for what each verb
does and returns; `pablo --help` lists the P0 set.

## Build commands

```sh
bun install            # workspace install; commit the resulting bun.lock
bun run typecheck      # tsc --noEmit across packages/core and packages/cli
bun test               # all tests, both packages
(cd packages/casting && uv run --frozen pytest -q)   # the Python side's tests
bun run pablo          # run the CLI from source (bun run packages/cli/src/cli.ts)
```

`bun run typecheck`, `bun test` and `casting-test` (`cd packages/casting && uv
run --frozen pytest -q`) are the three `required_checks` in
`.stamp/config.yml`: `stamp merge` runs them against the merged tree and rolls
the merge back on a non-zero exit. A `uv.lock` change is a dependency change:
the security reviewer reads it. There is no `build` step yet — the package
ships TypeScript that Bun runs directly. Add a `build` check to
`.stamp/config.yml` the moment that stops being true.

The published manifest is `packages/cli/package.json` (`@openthink/pablo`);
the root `package.json` is a private workspace shell with no version. Nothing
is published yet.

## Conventions

- **Git from code**: always `git -C <dir> add -- <paths>` and
  `git -C <dir> commit -m <msg> -- <paths>`, never `git add -A`. A git failure
  is a returned notice, never a thrown exception — a write to the vault that
  already landed on disk is never undone by git failing afterward.
- **Never write into `~/writing` from tests or from this repo's own tooling.**
  Tests exercise a synthetic fixture vault (`packages/core/test/fixtures/vault`,
  copied under `packages/cli/test/fixtures/`) with invented content — the real
  vault is private, this repo's GitHub mirror is public, and no manuscript
  content belongs in it. Anything that needs a throwaway vault on disk makes
  one in a temp directory and cleans it up.

## Stamp governance

The repo is **stamp-governed**, the same shape as `ui-leaf`: the canonical bare
repo lives on the Railway-hosted stamp server (`origin`), and GitHub
(`OpenThinkAi/pablo`, `github`) is a downstream mirror driven by the server's
post-receive hook via `.stamp/mirror.yml`.

- All merges to `main` go through `stamp review` then `stamp merge`, then
  `stamp push main`.
- **Never `git push github`.** The mirror is push-only from the server, and a
  direct push diverges it from `origin`. The GitHub Ruleset rejects it anyway.
- `.stamp/trusted-keys/` holds both of Matt's signing keys (personal and work),
  so a merge signed from either account verifies.

See [`AGENTS.md`](./AGENTS.md) for the full flow and the recovery paths.

<!-- stamp:begin (managed by `stamp init` — do not edit between markers) -->

## Stamp-protected repository — read AGENTS.md before any git operation

This repository is gated by [stamp-cli](https://github.com/OpenThinkAi/stamp-cli).
**Do not `git commit` directly to protected branches** (typically `main`)
**and do not `git push origin main`** of any commit you didn't produce via
`stamp merge`. The required flow is:

```sh
git checkout -b feature
# ... edit, commit on the feature branch ...
stamp review --diff main..feature       # all reviewers run in parallel
stamp status --diff main..feature       # gate check (exit 0 = open)
git checkout main
stamp merge feature --into main         # signs the merge
git push origin main                    # OR `stamp push main` if origin is a stamp server
```

Key commands: `stamp provision` — provision a new repo; `stamp review` — run reviewers; `stamp merge` — sign a merge; `stamp push` — push to a stamp server.

**The full reference is at [`AGENTS.md`](./AGENTS.md) at the repo root** —
read it before any git command. It covers the mode (server-gated vs.
local-only), what NOT to do, where things live, and how to recover when stamp
blocks you.

**One exception:** the very first commit that ADDS `.stamp/` + `AGENTS.md` +
`CLAUDE.md` to a fresh repo is allowed to land directly on the current branch
(there's nothing to review against). Recent `stamp init` runs do this commit
automatically. Every subsequent change goes through the stamp flow.

<!-- stamp:end -->

# Iterative Learning

Before non-trivial work in this repo, read what earlier agents left:

```
think brief --cortex pablo
```

When you discover a convention, invariant, prior decision, or gotcha worth
knowing next time:

```
think retro "<observation>" --cortex pablo
```
