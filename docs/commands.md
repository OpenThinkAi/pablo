# Command reference

Most verbs work on one work in your vault, named with `--project <slug>`. That slug
resolves to `<vault>/<kind>/<slug>`, where kind is `novels`, `stories` or
`essays`. The vault is `$PABLO_VAULT` when set (it must contain `style/` or
`voices/`). Otherwise it is the nearest ancestor of the current directory that
holds a `style/` or `voices/` directory. Every verb except `init` refuses when the
work has no valid `pablo.json` marker, and points you at `pablo init --adopt`. Pass
`--json` to get one JSON object on stdout instead of prose. Exit codes:

| Code | Meaning |
|---|---|
| `0` | ok |
| `2` | refused: a precondition is unmet (no project, no marker, a missing beat, a file that already exists...). The message names what is missing. |
| `1` | error: something broke, or the verb is not implemented |

These verbs take no `--project`: `prose`, `doctor`, `tray`, `read --list` and
`read <round>`. `init` and `story` take a slug in other ways, described below.
`pablo --version` (or `-v`) prints the installed version. `pablo --help` lists
the verbs; a verb has no help page of its own, so `pablo <verb> --help` prints
the same list.

Most writing verbs never touch `main`. They commit to a change branch (`draft/`,
`revise/`, `edit/`, `plan/` or `reader/`), and you accept that branch when you have
read it. See [Reviewing and accepting](#reviewing-and-accepting).

---

## Setting up a work

### init

```
pablo init novel <slug> "<Title>"
```

Creates a new novel. It copies `<vault>/templates/novel` to `<vault>/novels/<slug>`
and fills `{{TITLE}}`, `{{DATE}}` and `{{SLUG}}` in every `.md` file. It writes the
`pablo.json` marker and adds a row to the vault `README.md`'s works table. It also
adds `.pablo/` to the vault `.gitignore`, then commits exactly those paths. Only
`novel` is supported (any other format exits `1`). A slug may hold only lowercase
letters, digits and hyphens. An existing destination or a missing template is a
refusal. If git fails (for example, the vault is not a repository), the files stay
on disk and the result carries a `notice` instead of `committed: true`.

Returns `{ok, path, format, slug, title, committed, notice?}`.

### init --adopt

```
pablo init --adopt --project <slug>
```

For a work that already exists without a marker. It writes only `pablo.json`, taking
the title from the work `README.md`'s first `# ` heading (minus a trailing "(working
title)"). If missing, it also adds the `.gitignore` line. It never commits; the
result's `notice` reminds you to. A work that already has a `pablo.json` is refused.

### output

```
pablo output list --project <slug>
pablo output add <type> --project <slug>
pablo output remove <type> --project <slug>
pablo output plan <type> --project <slug> [--dry-run]
```

A work is a **story core** (premise, research, bible, acts, beats, facts) plus
one or more **outputs** made from it. The output types are `novel`, `story` and
`radio`.

| Sub | What it does |
|---|---|
| `list` | each output, its units drafted and its next step |
| `add <type>` | declares the output in `pablo.json` and scaffolds `outputs/<type>/` (`plan.md`, `RULES.md`); refused until the core has beats |
| `remove <type>` | undeclares it and moves `outputs/<type>/` under `outputs/_removed/`; nothing is deleted |
| `plan <type>` | rewrites `outputs/<type>/plan.md` (which units tell which beats) from the beats; `--dry-run` shows the rows and writes nothing |

Each change is one commit.

### migrate

```
pablo migrate lines --project <slug> [--dry-run]
pablo migrate outputs --project <slug> [--dry-run]
```

One-time migrations of older works. Running either twice is safe: the second run
changes nothing. `--dry-run` lists what would change.

- `lines` splits `chapters/*.md` to one sentence per line, leaving frontmatter
  alone, and commits only those files. Returns `{ok, dryRun, changed[], committed, notice?}`.
- `outputs` converts a `format: "novel"` work to a story core plus a `novel`
  output, in one commit. It:
  - replaces `pablo.json`'s `format` with `outputs.novel`
  - creates `outputs/novel/plan.md` and `outputs/novel/RULES.md` (`RULES.md` copies the novel-only sections of `QWEN.md`)
  - moves `continuity.md` to `outputs/novel/continuity.md`
  - moves `outline/chapters.md` to `outline/beats.md`
  - creates an empty `facts.md`

  It never writes `chapters/`, `bible/`, `research/`, `notes/` or `QWEN.md`.
  Having both an old and a new path is a refusal. Returns
  `{ok, dryRun, changes[{op, path, from?}], paths[], committed, notice?}`.

Every reader handles both the old and the new layout, so migrating is optional.

---

## Where things stand

### resume

```
pablo resume --project <slug>
```

The one call an agent makes to get up to speed on a work. Returns
`{format, title, core, outputs, waiting[], last, open, next, track, brief?, notices?}`:

| Field | What it holds |
|---|---|
| `track` | the work's track (`fiction`, `historical-fiction` or `nonfiction`), as `status` reports it |
| `core`, `outputs` | the same two layers as `status` |
| `last` | the newest dated file in `notes/` and the last commit touching the work |
| `open` | every `[pick]` placeholder, plus every bullet under a "Decisions" or "Open questions" heading in `bible/` and the beats file |
| `next` | the next step |

If the `think` CLI is installed, its brief for the work is added as `brief` when it
answers within 20 seconds. A missing `think`, a timeout or a failure is a one-line
`notices` entry, never an error. The prose form is under 30 lines and ends with
`next: ...`.

### status

```
pablo status --project <slug>
```

The work in two layers: the story core's stages, then each output and its units,
plus the work's track. Always exits `0`.

```
{core: {stages[{id, done, summary, missing[]}], premise, research[], bible, acts, beats, outlineFile},
 outputs: {<type>: {noun, plural, dir, units[], drafted, total, next?}},
 waiting[], next, track}
```

- **`track`** is `pablo.json`'s `track`, or `fiction` for a work without one. The prose form has it as a `track: <id>` line after the outputs.
- **Core stages** are `premise`, `research`, `bible`, `acts`, `beats` and `facts`.
  - `premise` means `bible/overview.md` has text under `## Logline`.
  - `research` is optional and never holds the core back.
  - `facts` is checked per unit, so an open `[pick]` blocks only the units whose beat names it.
- **The beats file** is `outline/beats.md`, or `outline/chapters.md` on an unmigrated work (`outlineFile` says which).
- **`waiting`** lists the change branches with commits that `main` lacks.
- **`next`** is one of:
  - `core: <action>` while the core is short
  - `add an output` when the core is ready but nothing derives from it
  - `<type>: <action>` for the first output with a unit left to draft
  - `all outputs drafted`

### status --for

```
pablo status --project <slug> --for "<output> N"
```

Checks whether one unit is ready to draft. It accepts these forms:

| Form | Meaning |
|---|---|
| `"novel 3"` | any output type, then a unit number |
| `"chapter 3"`, `chapter-3`, `ch 3` | the novel's chapter 3 |
| `"episode 3"` | a radio episode |
| bare `3` | unit 3, on a work with one output |

It returns a plain `{ready, missing[]}` (a radio unit adds detail) and exits `0` when
ready, `2` when not. For a novel chapter, the checks run in this order:

1. Beat row N exists. If it doesn't, that is the only entry in `missing`.
2. Chapter N-1 is written, unless N is 1.
3. `bible/timeline.md` has a row dated at or before the beat's year.
4. No undecided `[pick]` name appears in the beat's text.

For a radio episode, `missing` lists roles still to cast, plus the render, mix,
open flags and the state of the casting side. A form pablo cannot read is a refusal
that names the accepted forms.

---

## Planning

Planning (premise, research, bible, acts, beats) is a conversation between you and
your agent. pablo's part is saving the results where its stage checks can see them.

### save

```
pablo save --project <slug> --stage premise|acts|beats|bible/<file> [--file F]
```

Reads stdin, or `--file`, and writes:

| Stage | Target |
|---|---|
| `premise` | replaces `bible/overview.md` |
| `acts` | replaces the acts table in the beats file; the rest of the file is kept byte for byte |
| `beats` | replaces the beat table in the beats file |
| `bible/<file>` | replaces that `.md` file, which must stay under `bible/` |

Table input may be a full table or rows only; it is rewritten under the standard
header. Input is checked before anything is written. A beat row needs six columns
(`# | Story date | Title | Beat | POV | Status`) with a four-digit year in the date.
An act row needs three. A bad row is refused, naming the row and column. The file is
committed by path. Returns `{ok, path, stage, committed, notice?}`.

---

## Writing

### write

```
pablo write --project <slug> [--output <type>] --unit N [flags]
pablo write --project <slug> --chapter N [flags]
```

Drafts one unit of an output on your configured local model. `--chapter N` is
short for `--output novel --unit N`. A work with several outputs needs `--output`.
The `story` output has a single unit, so `write --output story` needs no `--unit`.

| Flag | Meaning |
|---|---|
| `--words W` | target length; default is the output's own (1800 for a chapter; for a story, 600 per beat and at least 1800) |
| `--scenes S` | minimum scenes; default 3 |
| `--temperature T` | 0 to 2; default is the provider's `temperature` in config, else 0.8 |
| `--seed N` | sampling seed, for a repeatable draw |
| `--direction "..."` | a steer beyond the beat ("slower, stay on Cora"); sent as its own section and recorded as `direction:` in the frontmatter |
| `--force` | overwrite an existing unit file |
| `--dry-run` | build and show the prompt pack, send nothing |

Before sending anything, it:

1. Runs the same checks as `status --for` and refuses (exit `2`, with `missing[]`) if any fail.
2. Builds the pack: the voice, the work's rules, period facts, cast and places, the timeline up to the beat's date, continuity, the end of the previous unit, and the beat.
   - Any source under one of the marker's `neverSend` prefixes is a refusal, not a silent drop.
   - In the style files, any section whose heading mentions replies or agents is left out.
3. Refuses if the unit file already exists, unless you pass `--force`.

`--dry-run` prints each section of the pack with its token count, plus a wait estimate
when the endpoint has been timed. With `--json` it returns
`{ok, dryRun: true, output, unit, slices[], totalTokens, expectedOutputTokens, prompt_hash, adjustments}`.
The same inputs give the same `prompt_hash`.

Without `--dry-run`, the pack is sent once. While it streams, progress goes to
stderr. The answer is cleaned up: em-dashes become commas, en-dashes become "to",
and curly quotes become straight. The unit is written one sentence per line, with
frontmatter in this order: `<noun>`, `title`, `pov`, `story_date`, `status: draft`,
`words`, `model`, `generated`, `prompt_hash`, then `direction` if given. For a novel,
`<noun>` is `chapter`.

The file is committed in its own worktree on a draft branch, authored as the model,
with the prompt hash as its `Receipt:` line. Branches are `draft/chNN` for a novel,
`draft/story` for a story and `draft/radio-epNN` for radio; a re-draft gets `-v2`,
`-v3` and so on. `main` is not touched. A receipt (model, tokens, time to first
token, wall time, temperature, seed) is appended to `<work>/.pablo/receipts.jsonl`.
The same check as `pablo check` runs on the new text. Its hits are reported but never
change the exit code.

```
{ok, path, branch, worktree, commit, receipt, check[]}      // success
{ok: false, code, message, missing?}                        // refusal or error
```

A hung endpoint, a bad or empty answer, or a config error is a refusal and leaves
nothing behind. If the final commit fails, it exits `1` and names the worktree that
holds the uncommitted draft.

### prose

```
pablo prose --voice <name> --brief <file|-> [--context <file>]...
            [--format email|post|page|reply|note] [--words N]
            [--draft <file> --instruction "<text>"]
            [--out <file> [--force]] [--dry-run]
```

Writes a freestanding piece (an email, post or page) in a named voice. No project
or vault is needed: a global voice and a brief anywhere will do. It builds the pack
from the voice, the brief and any `--context` files (in the order given), sends it
once, and prints the text. `--out` writes the text to a file; `--force` overwrites
one. `--draft` with `--instruction` revises an earlier piece instead of starting
over. A receipt goes to `<vault>/.pablo/receipts.jsonl`, or
`$XDG_STATE_HOME/pablo/receipts.jsonl` when there is no vault. The voice's own
flagged lines are checked against the answer.

### revise

```
pablo revise --project <slug> --file F
             (--passage "<quoted text>" | --start N --end N)
             --instruction "<text>" [--dry-run]
```

Sends one passage of a file to the local model with your instruction and returns a
candidate. It never changes the file. Find the passage by quoting it, or with
`--start`/`--end` character offsets into the body (frontmatter excluded). Returns
`{ok, candidate, span, receipt}`. To keep a candidate, use the screen's revise
action, which commits it on a `revise/<id>` branch.

---

## Reviewing and accepting

Drafts, revisions, planning saves from an agent session, and reader notes each land
on their own branch:

| Branch | Made by |
|---|---|
| `draft/...` | `write` |
| `revise/<id>` | revising in the screen, or the MCP `revise_passage` tool |
| `edit/...` | editing by hand in the screen |
| `plan/...` | an agent session's planning writes; `promote`; `research save`; `fact record`; `agent --tag-facts` |
| `reader/<round>` | `notes pull` |

`status` and `resume` list them under `waiting`.

### merge

```
pablo merge --project <slug> <draft-branch>
```

Merges a reviewed draft branch (`draft/chNN`, `draft/story`, ...) into `main`, then
runs the after-write steps for that unit, in this order:

1. **Outline tick**: the unit's row in the beats file moves to `draft`.
2. **Note**: a dated note under `notes/`.
3. **README**: a bullet under "Where things stand" in the work's `README.md`.
4. **Continuity**: facts are extracted from the new text and filed under the matching headings of the output's continuity file, citing the unit (2-minute limit). A fact the model can't anchor to a sentence goes under `## Check`. Existing bullets are never duplicated.
5. **Commit**: one commit of exactly the touched paths.
6. **think sync**: runs only when the `think` CLI is on your `PATH`. Otherwise this step is reported as `skipped`. A timeout (20s) or a non-zero exit is reported as `failed`.

Each step is reported (`ran`, `skipped` or `failed`), and a failing step never
undoes the merge. A conflicting merge changes nothing and runs no steps. A branch
that isn't a draft branch is refused.

### The screen (bare `pablo`)

```
cd <vault>/novels/<slug> && pablo
```

Run with no arguments inside a work, on a terminal, `pablo` opens the full-screen
view of the work: its stages, its units with check hits marked under each line, and
the branches waiting for review with their diffs and comments. You can:

- draft a unit, revise a selection, or add a selection to the voice
- edit by hand on an `edit/` branch
- comment on a branch, and accept it (accepting runs the same after-write steps as `merge`)
- compose a message to the agent
- pull readers' reviews when they arrive

Outside a work, or without a terminal, bare `pablo` prints the help.

---

## Checking

### check

```
pablo check --project <slug> [--file F] [--output <type>]
pablo check --project <slug> --across
```

Scans an output's units (or one `--file` inside the work; a file outside it is a
refusal) for two things:

- **Provenance**: units whose frontmatter lacks `model` or `prompt_hash`
  (`unprovenanced[]`).
- **Mechanical tells** (`hits[]`, each `{path, line, rule, excerpt, detail?}`):
  - em-dashes, en-dashes and curly quotes
  - dash year ranges and foreshadowing phrases
  - stock names listed in `style/prose.md` (`## Names`) and `style/anti-tells.md`
  - every `Flagged:` line from `style/prose.md`, found verbatim

With `--output`, it also runs the core check (`core[]`). That flags mentions dated
after the unit's year, and names the bible, `facts.md` and the output's continuity
don't know. On a work with radio scripts it adds a `radio` block: directions outside
the vocabulary, and roles with no voice. Hits are data: exit is `0` either way.

```
{ok: true, hits[], unprovenanced[], core?[], radio?}
```

`--across` compares the continuity of every output instead. It reports facts the
tellings disagree on, each with a finding id and a `promote` action.

### promote

```
pablo promote --project <slug> --finding <id> --keep <type>
```

Settles a `check --across` finding. The kept output's fact goes into `facts.md`
(the facts every output must honour) on a `plan/` branch for review. Each
contradicting unit gets a comment on its line there.

### research

```
pablo research save --project <slug> --title <text> --note <text> --source <url> [--source <url>]...
```

Keeps a research finding as `research/<slug>.md` in the work: the title, the
retrieval date, the note, then a Sources list. At least one `--source` (a URL or
a full citation) is required, and a note never replaces an earlier one (the slug
gets a `-2` suffix). The write lands on a new `plan/` branch for you to review.
The same writer is the harness's `save_research` tool, and over MCP this verb is
the `save_research` tool (sources go in `sources`).

```
{ok: true, path, branch, sha?}
```

### fact

```
pablo fact record --project <slug> --fact <text> --where continuity|<bible file> --kind researched|invented|author
                  [--source <citation>] [--heading <text>] [--chapter chNN]
pablo fact record --project <slug> --fact <text> --kind author --promote --established-by <output>/<unit>
```

Appends one fact, tagged with where it came from: `researched` needs a
`--source` (several are joined into one citation), `invented` and `author` need
none. It goes to `continuity` or a bible file, under `--heading` when given, or
with `--promote` to `facts.md` (the facts every output honours), which needs
`--established-by` such as `novel/ch03`. Never to `research/`. The write lands on
a new `plan/` branch for you to review. The same writer is the harness's
`record_fact` tool, and over MCP this verb is the `record_fact` tool.

```
{ok: true, path, line, branch, sha?}
```

---

## Publishing

### publish

```
pablo publish --project <slug> [--output <type>] --target <target>
```

| Output | Targets | Writes |
|---|---|---|
| `novel` | `draft`, `review`, `final` | `<work>/.pablo/out/<slug>-<target>.md`. `draft`: every chapter in order, frontmatter stripped, sentence lines joined into paragraphs, quotes curled. `review`: chapter headings with each source sentence line numbered `[n]` (restarting in every chapter) so a reader can cite a line. `final`: the clean manuscript, same as the draft, plus `<slug>-final.epub` (one XHTML file per chapter; no pandoc needed); `files` lists both. |
| `story` | `draft`, `review`, `final` | `<work>/.pablo/out/<slug>-story-<target>.md`: `draft` and `final` are the clean compiled story; `review` adds a "Review copy, N words" line under the title |
| `radio` | `bundle`, `stream` | `bundle`: `.pablo/out/<slug>-radio-bundle/` with every script, each mixed episode's newest audio and manifest, and `bundle.json`; unmixed episodes are listed in `notes`. `stream`: each mixed episode to `.pablo/out/stream/`. `player` is refused; use `pablo review`. |

Returns `{ok, output, target, where, chapters, words, files?, notes?}`. Here
`chapters` counts units, whatever the output calls them.

---

## Voice

A voice is a directory of rules, flagged lines and exemplars. The `fiction` voice is
the vault's `style/` directory. Named voices live under the vault's `voices/`, or the
global `~/.config/pablo/voices/` (respects `XDG_CONFIG_HOME`).

```
pablo voice new <name> [--global]
pablo voice list
pablo voice show <name>
pablo voice flag <name> "<line>" [--section <heading>]
pablo voice exemplar <name> <file> [--title "<t>"]
pablo voice rule <name> "<text>" [--example "<sentences>"] [--target voice|work --project <slug>]
```

| Sub | What it does |
|---|---|
| `new` | scaffolds a voice directory in the vault, or the global directory with `--global` |
| `list` | every voice in the vault and the global directory |
| `show` | the assembled voice as a model will see it |
| `flag` | records a rejected line under a section of `voice.md`, or `style/prose.md` for `fiction` (default section "Flagged") |
| `exemplar` | keeps a piece as-is under the voice's `exemplars/` |
| `rule` | adds `- <text>` as the last bullet of the target's `## Rules` (created if missing) |

For `rule`, the default target `voice` writes `style/prose.md` for `fiction` and
`voice.md` for a named voice. `--target work` writes the work's `QWEN.md` instead.
That needs `--project`, joins an existing "Ground rules" section if there is one, and
is refused when the work has no `QWEN.md`. `--example` adds a `Flagged: "..."` line
under the rule. `check` and `write` read those lines from `style/prose.md`, but not
from `QWEN.md`. Changes are committed by path.

---

## Searching and reading

```
pablo search --project <slug> <phrase...>
pablo read --project <slug> <path>
```

`search` finds a phrase across the work's bible, chapters, outline, continuity and
research, printing `file:line: sentence` for each match. `read` prints one file of
the work, with chapters joined back into paragraphs. A path outside the work is
refused. Both are also MCP tools.

---

## One-shot

### story

```
pablo story "<prompt>" [--output <type>]... [--review] [--title T] [--words N]
pablo story --project <slug>
```

Writes a work end to end from a prompt. It:

1. Creates the work, under `stories/` for a story or `novels/` for a novel.
2. Builds the story core through the agent harness (research, premise, bible, acts, beats), each stage on a `plan/` branch.
3. Drafts, merges and publishes each requested output.

`--output` is repeatable. The default is one written output, `story` or `novel`
depending on the length the prompt asks for. A type that can't run here (radio
without the casting side) is refused before anything is written.

By default every branch is accepted as soon as it lands. The agent's questions are
answered by stated assumptions, which are kept with the run. With `--review`, the run
stops on each branch for you to accept; `pablo story --project <slug>` then picks the
run up again. Progress is kept in `<work>/.pablo/story.json`, so a stopped or failed
run resumes where it was. Needs the same Claude access as `agent`.

---

## Agents

### mcp

```
pablo mcp
```

A stdio MCP server, for Claude Code or any MCP client. Its tools and their input
schemas are generated from the same definitions as the CLI, so the two stay in step.
It serves:

| Area | Tools |
|---|---|
| Where things stand | `resume`, `status`, `timeline` |
| Writing | `write`, `draft_unit`, `draft_chapter`, `prose`, `revise`, `revise_passage` |
| Planning and checks | `save`, `check`, `critique`, `promote`, `save_research`, `record_fact` |
| Setup and publishing | `output`, `migrate`, `publish` |
| Voice | `voice_list`, `voice_show`, `voice_flag`, `voice_exemplar`, `voice_rule` |
| Reading | `read`, `search` |
| Radio | `bind`, `audition`, `cast`, `voices`, `describe_voice`, `perform`, `mix`, `fix` |

Deliberately missing: `merge`, `story`, `share` and `notes`. Accepting work and
sending it to people are your acts, never a model's. There is also no `voice new`
tool.

### agent

```
pablo agent --project <slug> [--new] "<message>"
pablo agent --project <slug> --tag-facts
```

Runs one session of pablo's own agent: Claude, through the Agent SDK. Its system
prompt carries the work's policy and `QWEN.md`. Its tools are web search, web fetch
and pablo's MCP tools. It uses your Claude subscription unless an Anthropic API key
is set in pablo's config.

The transcript prints as it arrives. The conversation is saved under the work's
`.pablo/sessions/`, and the next run resumes it; `--new` starts fresh and keeps the
old one. When the agent asks you a question, it prints the choices and reads your
answer from stdin (type a number to pick one).

`--tag-facts` tags every untagged bible and continuity fact as researched, invented
or author on a `plan/` branch. Chapters are never touched. With `--json` it returns
`{ok, route, session: {id, resumed}, entries[], result}`. Exit `0` on success, `2`
refused, `1` failed.

---

## Sharing with readers

> **Limitation:** sharing currently uses a fixed GitHub organisation, `OpenThinkAi`.
> Reading repositories are always `OpenThinkAi/<slug>-reading`, and `read` only lists
> or fetches from that organisation. This can't be configured yet, so the reader flow
> works only for accounts with access to that org. Every call goes through the `gh`
> CLI, which must be signed in.

Readers are listed in pablo's config (`~/.config/pablo/config.json`):

```json
{ "readers": { "sam": { "github": "<login>", "name": "Sam Lee", "email": "sam@example.com" } } }
```

### share

```
pablo share --project <slug> --reader <name> --chapters N|N-M [--output <type>]
pablo share --list --project <slug>
```

Opens a reading round. Every chapter must already be on `main`; if one isn't, it is
refused by name.

1. On first use, creates the private reading repository.
2. Pushes a base branch without the chapters, and a round branch with them exactly as on `main`. Only chapter files ever reach that repository.
3. Opens a pull request and gives the reader read access. A pending invitation is reported; the reader accepts it once per book.
4. Requests the reader's review. If that fails, the notice prints the command to retry.
5. Records the round in `<vault>/.pablo/rounds/<reader>-<date>.json`.

`--list` shows the work's rounds:

| Status | Meaning |
|---|---|
| `open` | not yet reviewed |
| `submitted` | reviewed, waiting for `notes pull` |
| `pulled` | pulled into the vault |

### read (reader's side)

```
pablo read --list
pablo read <slug>-reading#<pr> [--no-open]
```

For the reader, on a machine with no vault. `--list` shows open rounds that request
your review, plus rounds this machine already sent. `read <round>` fetches the
round's chapters at the pull request's head commit into
`$XDG_STATE_HOME/pablo/rounds/...` (default `~/.local/state/pablo/rounds/`). It then
opens the reader window, which needs Google Chrome. In the window you mark lines,
suggest edits, and submit everything as one review. `--no-open` only fetches.

### notes pull

```
pablo notes pull --project <slug>
```

For each round with a submitted review, it builds a `reader/<round>` branch from the
vault commit that was shared. Each suggestion becomes one commit authored as the
reader, using the name and email from your config. Every comment is stored for
review in the screen. A review with no suggestions still gets one empty commit.

A review that touches a file outside the round, or text that no longer matches the
vault, is refused. After a pull, the pull request is closed (not merged), its
branches are deleted, and the round is marked `pulled`. It is never pulled twice.
Returns `{ok, code, pulled[], skipped[{round, reason, message}], notices[]}`. Exit is
`1` if any round errored and `2` if any was refused.

### tray

```
pablo tray
pablo tray install | uninstall
```

The reader's menu-bar app (macOS). It checks GitHub every 30-60 seconds for new
rounds, sends a notification, and opens a round from the menu. `install` and
`uninstall` add or remove the launchd agent that keeps it running.

---

## Radio (experimental)

The `radio` output turns a work into an audio drama: scripts, cast voices, rendered
lines, mixes. These verbs are experimental and need Apple Silicon (the speech models
run on MLX) and [uv](https://docs.astral.sh/uv/) (`brew install uv`). The Python
side installs itself on first use, and only verbs that need it ever install it.
Rendering uses the GPU.

| Verb | What it does |
|---|---|
| `pablo doctor` | reports the casting side's state, uv and config; never installs anything |
| `pablo audition --role R --describe "..." [-n 6] [--designer qwen3\|voxcpm2] [--traits '{...}'] [--seed S]` | renders candidate voices reading a test passage, scored. `audition --dry-run` installs and checks the casting side without loading a model |
| `pablo cast --role R --candidate n [--recast] [--notes "..."]` | freezes a candidate as a voice card in the shared library. `cast --auto --project <slug> [--episode N\|--all]` matches unbound roles to library voices; add `--design` to design voices for roles with no match. Synthetic voices only |
| `pablo voices list [--auto-admitted] \| show <slug> \| retire <slug> [--reason "..."]` | the shared voice library; a retired voice still plays for stories already pinned to it |
| `pablo bind --project <slug> --role <NAME> --voice <slug>` | pins a script role to a library voice in the work's `cast.json` |
| `pablo perform --project <slug> --episode N [--engine chatterbox-turbo\|dia] [--json-lines]` | renders an episode's lines in their bound voices, retrying lines that fail the quality gates; refused while a role is uncast. `--stream` (with `--episode N` or `--all`) mixes and publishes as it goes |
| `pablo mix --project <slug> --episode N [--version k]` | mixes a performed episode with its sound cues into `epNN.m4a` |
| `pablo fix --project <slug> --episode N` | re-records only the flagged lines, then remixes |
| `pablo gate <take.wav> --line "..." --card <slug>` | scores one take against a card's quality gates; `gate calibrate` fits the thresholds |
| `pablo takes show <key> \| gc [--yes] --project <slug>` | inspects one take, or archives the takes no manifest uses (moved, never deleted) |
| `pablo review --project <slug> [--episode N]` | the review player (needs Google Chrome): play episodes, flag lines for `fix` |
| `pablo mixer --project <slug> --episode N [--version k] [--library DIR] [--export-notes]` | the mixer window (needs Google Chrome): edit the mix, Save writes the next mix version, Render saves (if edited), runs `pablo mix` on that version and reloads the window's audio; the window says whenever the audio on disk is older than the mix it shows. `--library DIR` is the library whose `cues/` hold the cue audio; `--export-notes` writes the episode's punch list without opening it |

`perform`, `mix` and `fix` also accept `--output radio --unit N` in place of
`--episode N`. Check an episode's progress with `pablo status --for "episode N"`.
