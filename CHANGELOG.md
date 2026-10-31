# Changelog

Notable changes per release of `@openthink/pablo`, `@openthink/pablo-core` and
`@openthink/pablo-tui` (they release together at one version). The newest is first.

## 0.4.0

### Breaking

- **pablo has no built-in model.** The defaults it used with no config file (a local
  server at `127.0.0.1:8002` serving Gemma, and `claude-opus-5` on Anthropic) are gone;
  every verb that needs a model refuses, pointing at `pablo init --config`. If you ran
  without `~/.config/pablo/config.json`, run `pablo init --config`, set your
  provider's `endpoint` and `model`, and check it with `pablo config test`.
- **pablo no longer runs Claude through `claude -p` or the Claude Agent SDK on its
  own.** `pablo agent`, `pablo story`, the screen's compose view, `critique`,
  `check --across` and `agent --tag-facts` used your Claude Code login implicitly; they
  now run on pablo's own agent loop on whatever provider their intent routes to
  (`agent`, `plan`, `research`, `check`), any kind, with that provider's key. To keep
  using your Claude subscription, declare a provider with `"kind": "claude-code"` and
  route those intents to it (`pablo config set intents.agent claude-code`, and the same
  for `plan`, `research` and `check`); see `docs/configuration.md`. With no non-local
  provider configured, these run on your local model.
- **Old `pablo agent` sessions are not resumed.** Sessions are now provider-neutral JSONL
  in `.pablo/sessions/`; a session saved in the Agent SDK's format is reported as legacy,
  left on disk, and a new session starts.
- **The outside-reader flow is removed**: `pablo share`, `pablo notes pull`,
  `pablo read --list` and `pablo read <round>` (with the reader window and its submit),
  `pablo tray` and its launchd agent, the screen's Reviews group, the `share` and `notes`
  MCP tools, and `install-reader.sh` with `docs/readers.md`. Share a manuscript outside
  pablo. `pablo read --project <slug> <path>` still prints a file of the work. A
  `readers` key and `tray` settings in the config are ignored. Unmerged `reader/`
  branches are left alone and no longer listed as waiting for review; `pablo doctor`
  names them with the command to delete them. If you installed the tray, remove it once
  by hand:

  ```sh
  launchctl bootout gui/$(id -u)/ai.openthink.pablo.tray
  rm -f ~/Library/LaunchAgents/ai.openthink.pablo.tray.plist
  rm -rf ~/Library/Application\ Support/pablo/PabloTray.app ~/.local/state/pablo/tray
  ```
- **`pablo dry-run` is gone** (it only printed "not implemented"). Use `--dry-run` on
  `write`, `prose` or `revise`.
- **`pablo <unknown> --help` and `pablo help <unknown>` exit non-zero** naming the
  unknown verb, instead of printing the global help with exit 0.
- **`pablo story` names the work differently.** Without `--title`, one planner call on the
  prompt picks the working title and the slug is cut from it, instead of both being the
  prompt's first words; when the premise stage writes a `## Title`, `pablo.json`'s
  `title` follows it (the slug never moves). Pass `--title` if a script depends on the
  slug.
- **Cached anachronism verdicts without a model are asked again once.** Verdicts are now
  keyed by the model that gave them, and only that model reuses them; a verdict with no
  `model` (an older lexicon or a `facts/lexicon.json` seed) is re-asked by the next named
  model. A verdict you edit by hand needs `"model": "*"` to bind every model.
- **A work's `pablo.json` may no longer set `key` on any provider** (not even an
  `env:<NAME>` or `keychain:...` reference). Every command refuses such a work, naming
  the provider, until `key` is removed. Keys are set only in the global
  `~/.config/pablo/config.json`: declare the provider there with its `endpoint` and
  `key` (`pablo config set providers.<id>.key env:<NAME>`, without `--project`), and
  override only its `model` from `pablo.json`.
- **A provider a work's `pablo.json` adds has no key**, not even the `<ID>_API_KEY`
  convention. **Neither does a global provider whose `endpoint`, `kind` or `local` the
  work changes**, even to another port on this machine: the global key stays with the
  global endpoint. A non-local provider left without a key is skipped, and the stderr
  notice says how to give it one. Changing only `model`, `timeoutMs`, `temperature`,
  `thinking` or `tools` keeps the key.

### Added

- **Tracks**: `pablo.json` `track` is `fiction` (the default), `historical-fiction` or
  `nonfiction`. Each track has its own core stages, judgement policy (picked
  automatically; `policy` still overrides), checks and allowed outputs.
  `init --track`, `story --track` (inferred from the prompt when omitted) and
  `pablo migrate track` set it; `status` and `resume` report it and its gate.
- **Historical fiction**: a period brief (`bible/period.md`), a required, sourced
  research stage gating `write`, and period facts (`facts/period.md`) distilled from
  the research and sent in every fiction draft pack (raw research never is).
- **Nonfiction**: a thesis, research, claims and sources, and an outline as its core.
- **Research verbs** (each also an MCP tool): `research plan` (a checklist sized to the
  work, from the period brief or thesis), `research add`, `research waive` and
  `research link` (batch ranges like `1,3,5-7`), `research save` (a note with sources;
  non-sources are refused), `research distill`, and `fact record`.
- **New checks**, run by `check` and after every `write`/`story` draft: `anachronism`
  (historical fiction; things and idioms out of period, cached per model in the main
  checkout's `.pablo/lexicon.json`; `check --fresh` re-asks), `fact-accuracy` against
  the period facts, and `claim-support` (nonfiction: an uncited or unsupported claim).
  The core is cross-checked against the distilled facts.
- **New outputs**: `screenplay` (Fountain, a scene per beat; publish `draft`, `final` (a
  standard-format PDF with author credit) and `fountain`), `essay` (sections of the
  nonfiction outline with citations, or a thesis on a fiction work via `output add essay
  --thesis`; publish numbers the sources), and `narrated` (`output add narrated --from
  <output>`: a reading of another output's prose, made with no model, that `cast`,
  `perform`, `mix`, `fix` and `mixer` take with `--output narrated --unit N`).
- **Novel publish** gains `review` (numbered lines for readers to cite) and `final`
  (clean markdown plus EPUB) targets.
- **`pablo guide [--track] [--output]`**: the step-by-step path for a track and output,
  also the `guide` MCP tool, and a guide page per track and output under `docs/`.
- **Model config**: `pablo config show|set|test`; `pablo init --config` writes a
  documented starter config; per-work `providers` and `intents` in `pablo.json`; new
  intents `research`, `agent` and `check`; a provider whose key does not resolve is
  skipped with a notice; `"thinking": false` on Anthropic and hosted OpenAI-compatible
  providers; `config test` also tests providers that intents reach by kind.
- **A `claude-code` provider kind**: Claude on your Claude subscription through one
  `claude -p` per turn, with every Claude Code tool, setting and MCP server off. Receipts
  record `billing: "subscription"` and no cost.
- **Web research for the agent**: `web_search` (a SearXNG backend, `web.search` in the
  config) and `web_fetch` (http(s) only, private hosts refused, size and time capped,
  PDFs read) as agent tools; `pablo story`'s research stage uses them.
- **`pablo story --project <slug> --from <stage>`** adopts an existing work and reruns
  from a stage, archiving that stage's and later files under `_archived/` (never
  deleting).
- **`pablo merge` accepts any change branch** (`draft/`, `revise/`, `edit/`, `plan/`)
  and `merge --reject` deletes one; both remove the branch's worktree. `check` checks a
  pending draft on its branch, against main's core.
- **`revise --branch`** on the CLI commits the revision on a `revise/` branch.
- **Layered voice**: one resolver (global, vault, work, output) for every pack, with
  exemplars; receipts list the layers. `voice edit`, `voice remove`, `voice use` and
  `voice rule --target global|vault|work|output:<type>`.
- **`pablo describe_voice`** is a CLI verb (it was MCP-only).
- **Per-verb help**: `pablo <verb> --help` and `pablo help <verb>`.
- **`pablo doctor` checks the writing side**: the config, each routed provider, the vault
  is a git repo, the search backend; each failure says how to fix it.
- **MCP tools** for `init`, `story`, `output_add` and `merge`; MCP instructions cover
  every track and research.
- **The screen's editor**: `v e` edits a unit in place on its `edit/` branch, with
  normal, insert and select modes, sentence and paragraph motions and text objects,
  operators, registers and grouped undo, search and replace, autosave after an idle
  pause, `g n` / `g p` to move between units, a live word count against the target,
  focus and typewriter modes, and AI revisions shown inline as diffs to accept or
  reject. Every output's units load with their storage mode, and the planning,
  research, output, check, publish, voice and config verbs have screen routes (`r` and
  `o` prefixes).
- **The mixer**: Render from the window, a punch list (flags, re-take, compare and
  choose takes), regenerate a cue, and a Cast panel. `pablo fix` and
  `perform --stream` rebase a human mix onto the new takes instead of setting it aside,
  listing anything that cannot be re-anchored.
- **`[DRAMA] ... [DRAMA: off]`** scene markers in radio scripts render those lines with
  the original Chatterbox; `check` reports unbalanced markers.
- **Opt out of `think`**: `PABLO_NO_THINK=1` or `"think": false` in `pablo.json` skips
  the after-merge `think sync`.
- **`realNames: false`** in `pablo.json` keeps real names out of distilled facts.
- Agent loop runs record each turn, its tool calls and stage transcripts as receipts.

### Changed

- The per-work rules file is `STYLE.md` (was `QWEN.md`). New works get `STYLE.md`; a
  work with only `QWEN.md` is still read. `pablo migrate style --project <slug>` renames
  it with `git mv`.
- MCP `draft_unit`, `draft_chapter` (use `write`) and `revise_passage` (use `revise` with
  `branch`) are deprecated aliases, listed once and marked; they go in the next release.
- A work with no `policy` key now gets its track's policy (`policies/fiction.md` for
  fiction) instead of the minimal default.
- `pablo story` over more than 4 beats drafts the story output beat by beat (one request
  per beat, stitched into one unit and one commit); 4 beats or fewer stay one request.
  `--dry-run` says so (`beatByBeat` in JSON).
- A draft more than 10% under its word target says what to do next, and the result and
  `--json` carry `underTarget: true`.
- Draft packs carry every character file and the premise, use `pablo.json`'s title, and
  scripts and essays drop prose-only slices.
- Continuity files at most 20 facts per unit, and names it adds stay marked
  `unconfirmed` (still reported as unknown) until you confirm them.
- `status` and `resume` list only the work's own branches with changes left; `reader/`
  branches are not review branches.
- `publish` follows the work's quote rule.
- Help, `guide` and `status` describe what the verbs do; text says "the configured
  writer model", not a model name.
- Every model the radio tools download by default is fetched at a pinned commit
  revision (`packages/casting/src/pablo_casting/pins.py`): the gate scorers (Whisper,
  the aligner, ECAPA, Audiobox, emotion2vec), the voice designers and the Stable Audio
  Open cue model join the engines and UTMOS. A `casting.json` `weights` entry may be
  `{"id": "org/name", "revision": "<commit sha>"}`, and an `engines.designers.<name>`
  override may carry a `revision`; without one, pablo warns on stderr that it fetches
  the repo's current revision. `pablo doctor` reports a pinned model as cached only at
  its pinned revision, so a model cached at another revision is fetched once more (a
  one-time download of up to several GB on the next `gate`, `perform` or `mix`).
  `python -m pablo_casting doctor --json`'s `config.weights` is now a list of
  `{"id", "revision"}` objects (was strings), and `pull`'s and `doctor`'s `weights`
  entries gain `revision`.
- When a work's `pablo.json` repoints a global provider (its `endpoint`, `kind` or
  `local`) and so drops a key that would have been sent, pablo prints a one-line stderr
  notice naming the provider and the fix, instead of the local server failing on auth.
- `@openthink/ui-leaf` is pinned to an exact version (`1.6.0`), so `bun pm -g trust
  @openthink/ui-leaf` covers only the ui-leaf a pablo release names. The trust step is
  now documented as optional (only `review` and `mixer` need it).
- The release workflow runs only by hand on `main`; pushing a `v*` tag no longer
  publishes.
- The release workflow packs the tarballs in an unprivileged job and publishes them
  from a job that checks out and installs nothing, in the `npm-release` environment.
- Docs: `docs/configuration.md` gains "What leaves your machine" (each destination,
  what it is sent, and the local copies under `.pablo/`); `neverSend` is described as
  what it is, a guard on drafting packs; `docs/commands.md` says how the radio side's
  packages and weights are pinned.

### Fixed

- The dramatic engine levels a hot cast reference before cloning, so it no longer clips.
- Act rows are never parsed as beats; `output plan` drops stale duplicate rows.
- `unknown-name` agrees between `write` and `check`, learns names from character file
  names (and research notes on historical fiction), and skips forms of address,
  plural titles and demonyms.
- The anachronism check works on local models, fails loudly instead of passing
  silently, asks about things rather than etymology, and skips common words and known
  names; fact-accuracy retries an unreadable reply.
- `story-time` dates a multi-beat unit by its beat range; beat dates are scaffolding,
  not headings.
- Essays: an outline naming its act section `Act I` still finds its beats; an empty
  Sources section, dry-run with unmet preconditions and timeline save fixed.
- Screenplay publish: clean action page breaks, the PDF in the result.
- A second `fix` before a save keeps the earlier rebase's review items.
- A torn session file tail is truncated before appending.
- `web_fetch` caps a PDF's inflated size.
