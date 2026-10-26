# pablo — agent guide

This file is for working **on** pablo (contributors and their agents). To **use**
pablo, read `README.md` and `docs/` (getting-started, configuration, vault,
commands, agents, readers).

**pablo is a CLI that writes, with a full-terminal screen of its own** (decided
2026-10-01, pm project `ai-terminal`, `--doc screen`; it supersedes the
2026-09-06 "no screen" decision). Bare `pablo` inside a project opens the Ink
screen in `packages/tui`; the CLI verbs and `pablo mcp` stay, so whatever agent
the author already likes (Claude Code, Codex, pi) can still drive pablo over the shell
or MCP. pablo is the *manager* of the writing project: it knows the vault, the framework a
work's story core and outputs follow, the author's voice, version control, and publishing, and hands
any agent a structured way in and out.

Two invariants:

1. **Prose is produced only through `pablo write`, on the configured local
   model.** The agent plans and discusses; it never drafts prose itself and
   never sends prose through its own context. pablo assembles the prompt,
   sends it to the configured writer (the built-in `local` provider, an
   OpenAI-compatible server on 127.0.0.1:8002, by default), writes
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

**Design docs live in the maintainer's private tracker**: `pm project show
ai-terminal` (named docs: `--doc prose`, `--doc screen`, `--doc harness`,
`--doc readers`; it holds the session model, the full verb table, the stage
machines, the voice model and the binding-decisions table) and `pm project
show pablo-story-core` (the two-layer design: core machine, output registry,
`pablo.json` `outputs` in place of `format`, per-output continuity). If you
have `pm` access, read them before any non-trivial change; a change that
contradicts a binding decision there amends the doc in the same task. If you
don't, the code, its tests, `README.md` and `docs/` are the reference, and the
maintainer reconciles the design doc on review. References below to "the
design doc", a `--doc` name or a pm project point there.

Core material (`research/`, `bible/`, `outline/`, `facts.md`, `notes/`) is
shared; the novel output keeps `chapters/`, every other output lives under
`outputs/<type>/`.

Documents are the plain markdown files already in the author's real vault. pablo
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
                (`providers/`: OpenAI-compatible, Anthropic, and `claude-cli`,
                the planner's `claude -p` subscription path; `registry.ts`
                maps an intent to a provider, `planner.ts` picks the planning
                model (`claude -p` unless an Anthropic key resolves),
                `queue.ts` keeps one request in flight per local endpoint,
                `rates.ts` the measured endpoint rates for wait estimates,
                `keys.ts` API keys from the environment or the Keychain,
                `config.ts` the `$XDG_CONFIG_HOME/pablo/config.json` loader;
                `types.ts` also holds the neutral multi-turn `chat()` vocabulary
                (`ChatRequest`, `ChatEvent`, `JsonSchemaTool`, AGT-2116, D-12)
                and `scripted.ts` the fake `chat()` adapter tests drive;
                `openai.ts`'s `chat()` (AGT-2117) streams text and tool calls,
                whole as mlx_lm sends them or as OpenAI deltas, and a
                provider's `"tools": false` refuses a turn that offers tools;
                `anthropic.ts`'s `chat()` (AGT-2118) honours the same flag and
                replays a tool-calling turn's thinking blocks verbatim by
                tool-call id),
                `diff/` (the diff parser, move detection and the stitcher that
                review mode and accept/reject share), `facts.ts` (the fact
                provenance tag), `work-paths.ts` (migration-aware paths to a
                work's files, e.g. `continuityFile`), and the fiction sentence
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
                `packages/cli/policies/`, and the work's `STYLE.md` minus
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
                Other modules, briefly: `src/core/machine.ts` is the story
                core's stage machine (AGT-1667) and `src/novel/` the novel
                output's machine, continuity, merge, pack and rituals;
                `work-state.ts` is both layers' state for `status`/`resume`;
                `book.ts` feeds the screen's table of contents; the screen's
                seams are `screen-{write,revise,voice,reviews}.ts`,
                `edit-session.ts` (`v e`, an `edit/` branch in a worktree,
                AGT-1545) and `review-finish.ts`; `critique.ts` is the critic
                (AGT-1564) and `comments.ts` the per-branch comment store
                (`.pablo/comments/<branch>.json`, AGT-1580); `migrate.ts`
                (`migrate lines`) and `migrate-outputs.ts` (`migrate
                outputs`) are one-time migrations. `voice-layers.ts`
                (AGT-2138, D-15) is the one voice resolver: global
                (`voices/default` + named) -> vault (`style/`, vault voices)
                -> work (`pablo.json` `voice` entries + `STYLE.md`) -> output
                (`outputs/<type>/RULES.md`), each piece labelled with where
                it came from and absent layers listed in `missing`.
                Reading rounds: `share.ts` opens a round as a PR on the
                book's private reading repo (AGT-1582), `read.ts` lists and
                fetches rounds for a reader, `notes.ts` (`notes pull`,
                AGT-1587) turns a submitted review into a vault branch, and
                `round-housekeeping.ts` closes a pulled round (AGT-1588).
                The reader's tray (`pablo tray [install|uninstall]`,
                AGT-1589, `src/tray/`, CLI-only, no `--project`): a
                long-lived daemon that polls GitHub for rounds waiting for
                this reader (`poll.ts`), notifies once per new round
                (`notify.ts`), keeps `tray-state.json` for the Swift
                menu-bar helper (`packages/cli/tray/PabloTray.swift`, built
                and supervised by `bundle.ts`/`supervise.ts`), opens a round
                through `pablo read <ref>`, and `install` writes a launchd
                agent (`launchd.ts`). Every side effect is injected; tests
                never touch launchctl or GitHub. `install-reader.sh` at the
                repo root is the reader's installer (AGT-1590).
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
                `radio` (AGT-1686, `src/outputs/radio/`) is the third row:
                one episode per beat in `outputs/radio/episodes/NN-slug.md`
                on `draft/radio-epNN`, `rulesTemplate` the radio rules
                (`rules.ts`), stages script -> cast -> perform -> mix -> fix
                -> publish. Its `preconditions` are the script stage
                (episode N-1, the beats, picks, timeline); its pack is the
                core slices plus `outputs/radio/RULES.md`, its own ledger
                and the previous episode's summary (never a novel chapter,
                never research); `manuscript: "lines"` makes `write` store
                a script line for line (never sentence-split). The stages
                after the script are `state.ts`'s `radioStageCheck`, read
                from disk with no Python (`script.ts` reads role names the
                way `script.py` does; `packages/casting/tests/fixtures/
                role_names.json` holds both to it): `perform`, `mix`, `fix`
                and `cast --auto --episode N` take `--output radio --unit N`
                (or `--episode N`) and refuse an unmet stage
                (`missing: ["role NED is not cast"]`) before provisioning
                or running anything; `pablo review --episode N` refuses an
                unmixed one. `status --for "radio N"` (the type's
                `unitStatus`) lists what the episode still needs (unbound
                roles, render, mix, open flags, an unprovisioned casting
                side) with its stage; `resume`/`status` units carry
                `render` and `openFlags`. Publish targets: `bundle`
                (`.pablo/out/<slug>-radio-bundle/`: scripts, each mixed
                episode's newest m4a and manifest, `bundle.json`), `player`
                (refused: it is `pablo review`), `stream` (not built).
                `ensure()` only looks (venv stamp, `uv` on PATH) through
                `casting-side.ts`'s `radioMachine` seam, which tests
                replace; the first casting verb still provisions.
                `pablo story "<prompt>"` (AGT-1690, `src/story.ts`, one
                `VERBS` entry with no MCP tool) creates a work under
                `stories/` (`novels/` when a novel is asked for), runs each
                core stage as one harness message on its own `plan/` branch,
                then `output add`, `write`, merge and publish per requested
                output (default `story` or `novel` by the prompt's length
                cue). On demand it accepts every branch and answers
                `ask_author` with "assume and say so"; `--review` stops on
                each branch and `--project <slug>` resumes from
                `.pablo/story.json`. A requested type whose `ensure()` fails
                (or that is not registered) is refused before anything is
                written; an unrequested type's `ensure()` is never called.
                Merges find a draft branch's output by `outputForBranch`, so
                `draft/story` merges on a work that also has a novel. Tests
                use a fake `HarnessQuery` that calls pablo's own tools.
                `--output radio` (AGT-1700) runs the radio chain after the
                core through `src/radio-chain.ts` (imported only when radio
                is asked for): on demand, `runProgressive` writes and
                accepts episode N+1 while episode N is cast (`cast --auto
                --design`), performed with `--stream` and published to the
                listening directory; a refusal stops both queues with its
                own body and leaves what is published. `--review` stops per
                episode on its draft branch, its bindings (`cast:radio:N`)
                and its render (`render:radio:N`; open flags keep it
                waiting), and publishes only once resumed. `pablo perform
                --output radio --all` is the same chain on a work whose
                radio output was added later (the novel's files untouched).
                Tests: `test/story-radio.test.ts` (fake casting machine).
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
                `uv` is a refusal naming `brew install uv`; only `cli.ts`,
                `radio.ts`, `casting-verbs.ts` and `mixer-host.ts` import the
                runner, and it
                runs only inside a casting verb, so a writing verb on a
                writing work never touches it. `src/radio.ts` (AGT-1680) is
                the radio door: `check` (on a work whose scripts carry a
                `CAST:` line), `status --for "episode N"` and `bind` ask the
                Python side through it; scripts are read from
                `outputs/radio/episodes/`, else `chapters/`.
                `pablo gate` (AGT-1682) scoring audio provisions with
                `--extra scorers` (recorded in the venv's stamp, never
                dropped by a later sync); `gate calibrate` and
                `gate --scores` need no extra. `gate` is CLI-only: `cli.ts`
                dispatches it directly, so unlike the `casting-verbs.ts`
                entries it is not in `VERBS` and has no MCP tool.
                Tests inject `CastingDeps`; `bun test` never needs uv or a
                model. `prepack` copies the casting sources into
                `packages/cli/casting/` (gitignored) for the npm `files`.
                The review player (`pablo review --project W [--episode N]`,
                AGT-1693): a ui-leaf view, `views/review.tsx` (the prototype's
                cathedral radio: a reason on each flag, the line's gate
                scores, `by: auto` flags from `best_of_failed` takes in a
                second colour with the failing gates named, a version
                switcher, a chapter list that polls), mounted by
                `src/review-host.ts`. The view never reads a file; the host
                answers exactly `loadTrack`, `setVersion`, `flag`, `unflag`,
                `listChapters` and `loadSegments` (AGT-1697)
                (`views/review-protocol.ts`) from
                `outputs/radio/casting/` and writes only `flags.json`
                (`{id, episode, line, reason, time, source, by, at}`; the
                performer's auto flags are left alone). Only mixed versions
                (manifest `audio` present on disk) are listed. CLI-only, not
                in `VERBS`; needs Google Chrome (`UI_LEAF_NO_OPEN=1` skips
                the check for headless runs). Tests use a fake `mount`.
                `views/mixmath.ts` (AGT-1765) is the mixer's preview
                maths: dB<->gain, fade curves (linear|scurve|log|exp),
                `applyFade`, `equalPowerCrossfade`, automation
                interpolation (`automationDbAt`/`automationGainAt`/
                `sampleAutomation`). It is the twin of casting's
                `mixmath.py` (spec in its docstring); change one and you
                change both plus `packages/casting/tests/fixtures/
                mixmath-golden.json`, which both suites assert within 1e-4.
                The mixer (`pablo mixer --project W --episode N [--version
                k] [--library DIR]`, AGT-1768): a ui-leaf view,
                `views/mixer.tsx`, mounted by `src/mixer-host.ts`'s
                `openMixer` (refused, exit 2, with no mix document; CLI-only,
                not in `VERBS`; `--version` is the mix version, read as for
                `mix`). Fixed tracks (Dialogue a lane per role, SFX, Beds,
                Music) of clips with waveforms (`peaks`) on a ruler, a
                playhead, zoom and scroll; Web Audio plays every clip
                (`views/mixer-audio.ts`) with its gain, fades, same-lane
                equal-power crossfades, track automation, and live track
                volume/mute/solo; the master
                matches `mix.py`'s peak normalising by rendering the
                document offline once. Placement, envelopes, scheduling and
                mute/solo are `views/mixer-logic.ts`'s pure functions:
                clip starts resolve from anchors in whole samples exactly as
                `mix.py`'s `_resolve`, and `packages/casting/tests/fixtures/
                mix-anchors-golden.json` holds both sides to the same
                placement, envelopes and automation
                (`test_mixer_view_parity.py`, `mixer-logic.test.ts`).
                Editing (AGT-1769): `views/mixer-edit.ts` is every edit as a
                pure document -> document function (move re-anchors to the
                nearest line edge, never into a cycle; trim; split; fades,
                gain, track volume/mute/solo) plus undo/redo;
                `views/mixer-inspector.tsx` is the selected clip's panel.
                The host's `saveMix` writes `mix.v<m+1>` `by: "human"` through
                `python -m pablo_casting mixer` (`mixer.py`), refused when the
                base is not the newest version. Markers (AGT-1792):
                `views/mixer-notes.ts` (pure) and `views/mixer-markers.tsx`
                drop notes at the playhead with a snapshot of what is
                sounding; `src/mixer-notes-host.ts` writes
                `renders/epNN/notes.json`, a `punch-list.md` beside it, and
                turns dialogue markers into `flags.json` entries that
                `pablo fix` reads. Regenerate a cue (AGT-2156, D-19):
                right-click a cue clip, `views/mixer-cue.tsx`'s panel calls
                the host's `cueOptions`/`regenerateCue`, which run
                `mixer cue-options|cue` (`mixer_cue.py`): the cue library
                makes the asset, the next mix version swaps only that
                clip's source key.
packages/casting  pablo-casting — Python 3.12 (`pyproject.toml`, `uv.lock`,
                `src/pablo_casting/`, `tests/`), pm project `pablo-casting`.
                Run only as `python -m pablo_casting <command> --json`
                (`version`, `doctor`, `pull`, `audition`, `cast`,
                `describe`, `voices list|show|retire`, `takes`, `manifest`,
                `script`, `check`, `status`, `bind`, `gate`, `gate
                calibrate`, `perform`, `mix`, `fix`, `mixer`, `sounds`; the
                list is `cli.py`'s `COMMANDS`),
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
                `matching` block over the design's 0.8 / 0.6 / 0.75.
                Design on demand (`design.py`, AGT-1699, `cast --auto
                --design`): each `needsDesign` role is auditioned
                unattended (instruct from `traits.describe_traits`),
                screened (UTMOS, pitch band, a usable reference, ECAPA
                distinctness against every card), trialled on three lines
                through `perform.py`'s `Performer` and the full gate stack
                (takes receipted, never stored), and the best pass is cast
                with `admitted.by: auto` plus its trial evidence and bound
                `by: design`; one re-phrased retry, then exit 2 naming the
                role. `describe` (the harness's `describe_voice`) returns
                the mapper's traits, the free text it left and the
                vocabulary; the harness answers with `--role-traits`. The gate's scorers sit behind
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
                model-free engine (silence of the right shape) the take
                store's tests use.
                Perform (AGT-1683, `pablo perform --project W --episode N
                [--engine chatterbox-turbo|dia] [--json-lines]`, a
                `casting-verbs.ts` entry that provisions `--extra scorers`):
                `engines.py` holds the decided engine's adapter
                (Chatterbox-Turbo at its pinned revision: temperature 0.8,
                no emotion mapping, `[laugh]`/`[cough]`/`[chuckle]`, short
                references padded to 5.2 s), Dia with the prototype's pass
                grouping for A/B only, and ALL-CAPS words capitalised in the
                engine input (never in the script). AGT-1798: with numerals
                spoken (`numerals.py`), the work's
                `outputs/radio/pronounce.md` (`lexicon.py`, `word -> respelling`,
                optional `SPEAKER:` scope) respells words, both in the engine
                input only; matching entries are the `lexicon` take-key param,
                and the words gate accepts whatever Whisper heard for a
                respelt word. `perform.py` runs the
                retake loop (4 derived seeds, first pass kept, else best-of
                with an auto flag in `flags.json`), the pace policy (role
                `pace.wps` x 0.85/1.15 for slow/quick; stretch measured and
                held to [0.75, 1.05], applied by the mix), writes takes and
                `v1.json` (with `rtf_total` and a `render` block), a receipt
                per engine pass, and one JSON progress line per line on
                stderr (stdout too with `--json-lines`). It resolves cards
                as `cast` writes them (`<library>/voices/<slug>/`), refuses
                unbound roles, changed pins and already-rendered episodes,
                and resumes a stopped run without re-rendering stored takes.
                Tests use `engines.RecordingEngine` and fake scorers.
                Mix (AGT-1684, `pablo mix --project W --episode N
                [--version k]`, a `casting-verbs.ts` entry that provisions
                `--extra mix`; `--version` is read as `--mix-version` by
                `parseCliArgs` for this verb only): `mix.py` ports
                `radio/produce.py:463-573`: takes in line order paced by the
                manifest `stretch` (sox WSOLA), cues placed from the
                content-addressed cue library (`cues.py`: key = sha256 of kind
                + case-folded description, `<library>/cues/<key>.wav` + a
                `.json` sidecar, written once, never regenerated; MUSIC is
                the numpy tonewheel organ `organ.py`, SFX/BED are Stable Audio
                Open on MPS with the BrownianTree patch, lazily imported from
                the `mix` extra), -1 dBFS, AAC via afconvert/ffmpeg. An
                unmixed manifest is completed in place (`manifest.attach_mix`:
                audio, line `start`/`end`, cue assets, `duration`, `mix`; the
                takes are checked unchanged); mixing a version that has
                audio is a new version with identical takes (`write_version`,
                `changed_lines: []`), and the `epNN.m4a` link moves. Line
                `start`/`end` are the take's own word timings scaled by the
                pace, plus where the mix put the take; `mix.check_timings`
                re-measures them with the aligner on the decoded final file.
                Tests use a fake cue generator, pacer and encoder.
                The progressive render (AGT-1697): the mix's placement is
                `mix.Timeline`, built a line group at a time (`auto_timeline` adds
                every group and finishes; its `frontier` is the first sample a
                later line, SFX or open BED can still change). `pablo perform
                --stream` (`stream.py`, `--extra mix` too) feeds it each pass
                as it is decided and cuts 6 s 16-bit WAV segments of the final
                samples into the listening directory `<work>/.pablo/out/stream/
                epNN/` (`stream.json`, `playlist.m3u8`, `segments/`; playable
                once 30 s of the episode have passed the gates), then finishes
                the same timeline into the episode file through `mix.mix(...,
                timeline=)`, so the file is the segments times the one
                normalising gain. Time to first audio (`ttfa`: first segment,
                playable, episode file, seconds from the start of perform) is
                in the manifest (a `PROPOSED_FIELDS` entry), the `perform` and
                `stream` receipts. Takes, `changed_lines` and `write_version`
                are untouched. `src/radio-stream.ts` owns the rest of that
                directory: `publishStream` (`pablo publish --output radio
                --target stream`, the radio type's `stream` target in
                `outputs/radio/publish.ts`) copies each newest mixed version and writes
                `index.json`; `perform --stream` calls it the moment an episode
                is mixed, and `perform --all` runs the episodes through
                `src/progressive.ts` (`runProgressive`: a writer queue and an
                engine queue, each serial, so unit N+1 is written while N
                performs; the story pipeline supplies `write`). The review
                host lists a playable stream as a chapter with `stream` and no
                version, and `loadSegments` hands its segments to the view,
                which plays them gaplessly on the Web Audio clock
                (`views/review-stream.ts`).
                The mix document (AGT-1764, pm project `pablo-mixer`):
                `mix.py` renders only from `renders/epNN/mix.v<m>.json`
                (`mixdoc.py`: tracks dialogue (a lane per role) / sfx / beds
                / music of clips `{source {kind take|cue, key}, in, out,
                anchor {line, edge, offset} | {at}, gain, fade_in,
                fade_out}`, track volume/mute/solo/automation, master), versioned
                like manifests and never rewritten (`write_mix`). `pablo mix`
                renders `--from DOC` (written `by: "human"`), else the newest
                document whose clips voice the manifest's takes, else a
                newest human document **rebased** onto the manifest
                (`mix.rebase`, AGT-2153: unchanged lines keep every edit, a
                re-take drops into the same clip slot with its fades and
                gain, downstream clips ride their line anchors, and what
                cannot be re-anchored goes into the document's
                `rebase.review`, which the mixer lists; written `by:
                "human"`), else `auto_document` (the rules above as clips)
                written `by: "auto"`. A bad document is exit 2 with `field` naming the
                first bad field and `problems` listing all. The gain, fade,
                crossfade and automation formulas are `mixmath.py`'s
                (AGT-1765, shared with the TS preview); never re-derive them.
                One render path: `mix.Timeline` *is* the auto mix. Each `add`
                appends the rules' clips to the document it builds and places
                them; its `mixdown` and `render_document` both sum clips with
                `_mix_range` and finish through `master`, so `perform
                --stream`'s segments, its episode file (the timeline's
                document written as the next mix version, `by: "auto"`) and a
                later render of that document are the same samples. The auto
                mix puts an overlapping cue on its track's next lane (`main`,
                `2`, ...) so it sums, never crossfades.
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
parser and renderer, span verbs). The old **review queue** (a JSONL log the
first `pablo review` read, AGT-1255..1263) and the author's **menu-bar tray**
that watched it were both retired 2026-10-01 (AGT-1520, AGT-1541; the `screen`
design doc's decisions supersede them). Two names came back for new things:
`pablo review` is now the radio review player and `pablo tray` the reader's
tray (both in `packages/cli` above). Every manuscript change is a git branch,
the screen's review mode is where the author decides, and `pablo status` /
`pablo resume` report the branches waiting for review.

## The project

A **project is a vault directory** under `<vault>/novels|stories|essays/<slug>`,
with the writing vault's existing layout (`style/`, `bible/`, `outline/`,
`chapters/`, ...). `--project <slug>` resolves it: the vault is `PABLO_VAULT`
if set, else the nearest ancestor of the current directory holding a `style/`
or `voices/` directory. An unresolvable project is a refusal, exit code 2, naming every
path it tried — see `packages/cli/src/project.ts`.

pablo state that is not a document (last run, receipts, rates, share links)
lives in `<work>/.pablo/`, gitignored. Everything the author would want to
read is a markdown file in the vault, tracked by git.

## Verbs and exit codes

Every verb accepts `--project <slug>` and `--json`. Exit codes are the
contract every ticket builds on: **0** success, **2** refused (a framework
precondition — an unresolvable project, or later an unmet stage
precondition), **1** error (including "not implemented yet" for a verb whose
body has not landed). `pablo --help` lists the P0 set and its usage lines;
`docs/commands.md` describes each verb (the design doc's `Commands` table too,
if you have `pm` access). A change to a verb's behaviour updates
`docs/commands.md` in the same change.

## Build commands

```sh
bun install            # workspace install; commit the resulting bun.lock
bun run typecheck      # tsc --noEmit: every packages/* src, views and test, plus bench/
bun test               # all TypeScript tests: core, tui, cli and bench
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

The three TypeScript packages are published to npm (`@openthink/pablo-core`,
`@openthink/pablo-tui`, `@openthink/pablo`, the bin) in lockstep at one
version (0.2.x); `CONTRIBUTING.md`'s `Releasing` section is the procedure. The root
`package.json` is a private workspace shell with no version.

## Conventions

- **Git from code**: always `git -C <dir> add -- <paths>` and
  `git -C <dir> commit -m <msg> -- <paths>`, never `git add -A`. A git failure
  is a returned notice, never a thrown exception — a write to the vault that
  already landed on disk is never undone by git failing afterward.
- **Never write into the author's real vault from tests or from this repo's own tooling.**
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
- `.stamp/trusted-keys/` holds the maintainer's signing keys (personal and
  work), so a merge signed from either account verifies.

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

If the `think` CLI is available (the maintainer's setup), read what earlier
agents left before non-trivial work in this repo:

```
think brief --cortex pablo
```

and, when you discover a convention, invariant, prior decision, or gotcha
worth knowing next time:

```
think retro "<observation>" --cortex pablo
```

Without `think`, skip both; put a durable lesson in a code comment or in
`docs/` instead.
