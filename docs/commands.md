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

`config` takes `--project` only to pick a work's `pablo.json` instead of the global file. These verbs take no `--project`: `guide`, `prose` and `doctor`. `init` and `story` take a slug in other ways, described below.
`pablo --version` (or `-v`) prints the installed version. `pablo --help` lists
the verbs with their usage. `pablo <verb> --help` (or `pablo help <verb>`) prints
just that verb's usage, flags and an example; an unknown verb exits 1 naming it.

Most writing verbs never touch `main`. They commit to a change branch (`draft/`,
`revise/`, `edit/`, `plan/` or `reader/`), and you accept that branch when you have
read it. See [Reviewing and accepting](#reviewing-and-accepting).

---

## Setting up a work

### guide

```
pablo guide
pablo guide --track <t>
pablo guide --track <t> --output <type> [--project <slug>]
```

Start here. With a track and an output, `guide` prints the path from nothing to a
finished piece, one numbered step per line with the command that does it: create
the work (`init --track`), each of the track's core stages in order (`save
--stage ...`), the research stage (on `historical-fiction` and `nonfiction` the
gated checklist: `research plan`, then `research save --item` or `research waive`
for every item, and `research distill` for the period facts; on `fiction` an
optional note), `output add` (for `narrated`, first a prose output to read and then
`output add narrated --from <novel|story|essay>`), each of the output's own stages (`write`, `revise`,
and for performed outputs `cast --auto`, `perform`, `mix`, `fix`), `check`, and
`publish` with the output's targets. A step the track gates is marked `(gate)`;
`write` refuses until it is met. Commands carry placeholders (`<slug>`, `N`) for
you to fill. The draft step names the writer model your config routes the `draft`
intent to (`anthropic (the-model-id)`); with `--project` it reads that work's
`pablo.json` routing too, and with no model configured it says so. On
`nonfiction` the outline step notes the `#N` convention below.

The path is composed from the track and output registries, not written per pair,
so it follows them (a stage with no step fails the guide test). With no
flags, `guide` lists every track (its core stages, the outputs it allows, and those
planned but not built) and every output (its stages, tracks and publish targets);
`--track` alone lists that track's. `--output` alone reads the `fiction` track when
it allows the output, else the first track that does. An unknown track or output,
an output the track does not allow, a planned one not built yet, or one
that cannot be finished yet is refused (exit 2) naming the choices. `narrated` reads
a prose output, so its path first adds and writes one (on `nonfiction`, the
`essay`). `guide` reads no vault and needs no project.

```
{ok: true, track, output, steps: [{phase, stage?, title, command, detail?, gate?, optional?}]}
{ok: true, tracks: [{id, coreStages, outputs, waiting, planned}], outputs: [{id, noun, tracks, stages, targets}], next}    with no output
```

`phase` is one of `create`, `core`, `research`, `output`, `write`, `check`,
`publish`, in that order. Over MCP it is the `guide` tool (`track`, `output`), and
the server's instructions tell an agent to call it first.

### init

```
pablo init novel <slug> "<Title>" [--track <t>]
pablo init --track <t> <slug> "<Title>"
```

Creates a new novel. It copies `<vault>/templates/novel` to `<vault>/novels/<slug>`
and fills `{{TITLE}}`, `{{DATE}}` and `{{SLUG}}` in every `.md` file. It writes the
`pablo.json` marker and adds a row to the vault `README.md`'s works table. It also
adds `.pablo/` to the vault `.gitignore`, then commits exactly those paths. Only
`novel` is supported (any other format exits `1`). A slug may hold only lowercase
letters, digits and hyphens. An existing destination or a missing template is a
refusal. If git fails (for example, the vault is not a repository), the files stay
on disk and the result carries a `notice` instead of `committed: true`.

`--track` (`fiction`, `historical-fiction`) writes `track` into `pablo.json` and adds
the files that track's core needs beside the template's: on `historical-fiction`, the
period brief `bible/period.md` and the period facts table `facts/period.md`, as
headings only (they satisfy no stage until you fill them). Without `--track` the
marker has none and the work reads as `fiction`. A track the novel output does not
allow (`nonfiction`) is refused.

`pablo init --track <t> <slug> "<Title>"` (two positionals; a first positional that
names an output, as in `pablo init novel <slug> --track <t>` with the title left off,
is a usage error) creates a work with only
its track's core and no output yet: `README.md`, `STYLE.md`, the core files and a
`pablo.json` with `track` and empty `outputs`, under `essays/<slug>` for
`nonfiction` and `stories/<slug>` for the fiction tracks. The core files per track:

| Track | Core files |
|---|---|
| `fiction` | `bible/overview.md`, `bible/places.md`, `bible/timeline.md`, `bible/characters/`, `outline/beats.md`, `facts.md`, `research/`, `notes/` |
| `historical-fiction` | fiction's, plus `bible/period.md` and `facts/period.md` |
| `nonfiction` | `core/thesis.md`, `core/claims.md`, `core/outline.md`, `research/`, `notes/` |

It adds the README row and `.gitignore` line and commits like the novel form; its
`notice` names the outputs the track allows, for `pablo output add` later.

Returns `{ok, path, format, track?, slug, title, committed, notice?}` (`format` is
`null` for a core-only work).

### init --adopt

```
pablo init --adopt --project <slug>
```

For a work that already exists without a marker. It writes only `pablo.json`, taking
the title from the work `README.md`'s first `# ` heading (minus a trailing "(working
title)"). If missing, it also adds the `.gitignore` line. It never commits; the
result's `notice` reminds you to. A work that already has a `pablo.json` is refused.

### init --config

```
pablo init --config
```

Writes a documented starter model config to `$XDG_CONFIG_HOME/pablo/config.json`
(`~/.config/pablo/config.json`): a local OpenAI-compatible provider and an Anthropic
one, with notes in `_about` fields, no key, and placeholder model ids for you to set.
It needs no vault. It never overwrites: if the file exists it exits `2` and changes
nothing. pablo has no built-in model, so until a config names one every verb that
needs a model refuses (exit `2`) and points here; `pablo init <format> ...` and
`init --adopt` print the same pointer while there is no config file. Next:
`pablo config set` to fill in the ids, `pablo config test` to check them.

### output

```
pablo output list --project <slug>
pablo output add <type> --project <slug>
pablo output add narrated --from <output> --project <slug>
pablo output add essay --thesis "<thesis>" --project <slug>
pablo output remove <type> --project <slug>
pablo output plan <type> --project <slug> [--dry-run]
```

A work is a **story core** (premise, research, bible, acts, beats, facts) plus
one or more **outputs** made from it. The output types are `novel`, `story`,
`screenplay`, `radio`, `narrated` and `essay`. Each output declares the tracks it allows
(`novel`, `story`, `screenplay` and `radio`: `fiction` and `historical-fiction`;
`narrated` and `essay`: `fiction`, `historical-fiction` and `nonfiction`); `pablo output add
<type>` refuses a type the work's track does not allow, naming the types it does.
A verb run on a `nonfiction` work that has no output yet is refused naming
`pablo output add essay`, never read as a novel.

`essay` is an argued, cited piece; a blog post is an essay (where it is posted is
up to you). On a `nonfiction` work its units are **sections**, the rows of the
core outline (`core/outline.md`), and every section lives in one file,
`outputs/essay/essay.md`, under a `## <section title>` heading in outline order.
A section's claims are the `core/claims.md` rows its "What it covers" cell names
(`#2`, `#3`), or every claim when it names none.

On a `fiction` or `historical-fiction` work the essay argues a **thesis about the
story**. `pablo output add essay` asks for it (on a terminal it prompts; otherwise
it is refused with `missing: ["--thesis: ..."]` until you pass `--thesis "<text>"`)
and writes two files beside `plan.md` and `RULES.md`: `outputs/essay/thesis.md`,
and `outputs/essay/outline.md`, the sections (`| # | Section | What it covers |`)
drawn from the story core: the story, the world it is drawn from (historical
fiction only), one section per act (titled with the act's own title), and what the
story argues. Edit the outline freely; `pablo output plan essay`
re-reads it. A thesis already in `thesis.md` is kept (passing `--thesis` then is
refused), and `--thesis` is refused on nonfiction, whose essay argues
`core/thesis.md`. Each section's pack carries the thesis, the story it is about
(`bible/overview.md`), the outline, the distilled period facts (`facts/period.md`,
under the bible's names on a `realNames: false` work), `facts.md`, the cast, the
places and the whole timeline (`bible/timeline.md`); never `research/` itself. The
writer cites nothing. An essay added to a fiction work before this had one section
about the story, and still does until it gets an `outline.md`.

`narrated` is a straight, audiobook-style reading of another output's prose. It is
added over a prose output the work already has: `pablo output add narrated --from
novel` (or `story`, or `essay`) records `"from": "novel"` in `pablo.json`'s `outputs.narrated`.
An essay section is read without its citations. Its units (readings) mirror the source's units one for one, so its `plan.md` is
the source's. `--from` is refused without a source, for a script output such as
`radio`, for an output the work does not have, and on any other type. While a
narrated output reads an output, `output remove` refuses that output.

| Sub | What it does |
|---|---|
| `list` | each output, its units drafted and its next step |
| `add <type>` | declares the output in `pablo.json` and scaffolds `outputs/<type>/` (`plan.md`, `RULES.md`); refused until the core has beats (on `nonfiction`, until the core is complete) |
| `remove <type>` | undeclares it and moves `outputs/<type>/` under `outputs/_removed/`; nothing is deleted |
| `plan <type>` | rewrites `outputs/<type>/plan.md` (which units tell which beats) from the beats: existing rows keep their mapping; an undrafted row whose beats are gone, or a second row for a unit whose title matches no beat, is dropped as stale; new beats get rows. `--dry-run` shows the rows and writes nothing |

Each change is one commit.

### migrate

```
pablo migrate lines --project <slug> [--dry-run]
pablo migrate outputs --project <slug> [--dry-run]
pablo migrate track --project <slug> --track <t> [--dry-run]
pablo migrate style --project <slug> [--dry-run]
```

One-time migrations of older works. Running any of them twice is safe: the second run
changes nothing. `--dry-run` lists what would change.

- `lines` splits `chapters/*.md` to one sentence per line, leaving frontmatter
  alone, and commits only those files. Returns `{ok, dryRun, changed[], committed, notice?}`.
- `outputs` converts a `format: "novel"` work to a story core plus a `novel`
  output, in one commit. It:
  - replaces `pablo.json`'s `format` with `outputs.novel`
  - creates `outputs/novel/plan.md` and `outputs/novel/RULES.md` (`RULES.md` copies the novel-only sections of the rules file)
  - moves `continuity.md` to `outputs/novel/continuity.md`
  - moves `outline/chapters.md` to `outline/beats.md`
  - creates an empty `facts.md`

  It never writes `chapters/`, `bible/`, `research/`, `notes/` or the rules file (`STYLE.md`, or `QWEN.md` on an older work).
  Having both an old and a new path is a refusal. Returns
  `{ok, dryRun, changes[{op, path, from?}], paths[], committed, notice?}`.
- `track` writes `track` (`fiction`, `historical-fiction` or `nonfiction`) into
  `pablo.json` and commits only that file on the vault's current branch, with a
  `Pablo-Migrate: track=<id>` trailer. Works without a `track` read as `fiction`.
  Returns `{ok, dryRun, from, track, changes[], paths[], committed, missingStages[], notice?}`;
  `missingStages` lists the core stages of the new track that the old track's core
  lacks (fiction to `historical-fiction`: `period`, `period-facts`). An unknown
  track, or uncommitted changes to `pablo.json`, is a refusal.
- `style` renames the work's `QWEN.md` to `STYLE.md` with `git mv`, points a `QWEN.md` entry in
  `pablo.json`'s `voice` list at the new name, and commits both in one commit. Every verb reads
  `STYLE.md` and falls back to `QWEN.md`, so migrating is optional. It refuses when both files
  exist. New works (`init`, `story`) are scaffolded with `STYLE.md`.
  Returns `{ok, dryRun, changes[], committed, notice?}`.

Every reader handles both the old and the new layout, so migrating is optional.

---

### config

`pablo config show|set|test [--project <slug>]` finds, edits and checks the model
config (see [configuration](configuration.md)). It needs no vault unless `--project`
is given, and `--json` prints one JSON object.

- `config show` prints the merged providers (kind, endpoint, model, `local`, timeout)
  and which provider each intent routes to. A key is shown as its reference
  (`env:NAME`, `keychain:service/account`), never its value. With `--project <slug>`
  the work's `pablo.json` `providers` and `intents` are merged over the global file.
- `config set <path> <value>` edits `$XDG_CONFIG_HOME/pablo/config.json`, or with
  `--project` the work's `pablo.json`. Paths: `default` (global only),
  `intents.<intent>`, and `providers.<id>.<field>` with field one of `kind`,
  `endpoint`, `model`, `local`, `key`, `timeoutMs`, `temperature`, `thinking`. The
  result is validated like a normal load first, so an inline key, an intent naming
  no provider, or a work repointing a remote provider is a refusal and nothing is
  written. Other keys in the file are kept.
- `config test` sends one tiny request per mapped intent (the default route when none
  is mapped) and prints ok or the error per provider. Exit `1` if any failed. The
  request allows 1024 output tokens so a reasoning model can think and still answer;
  a reply that is only thinking names the `"thinking": false` fix. A
  billing or credit error (an exhausted balance, a quota, `402`) is labelled
  `billing/credit problem`, and `doctor` says to add credit rather than check the key.

---

## Where things stand

### resume

```
pablo resume --project <slug>
```

The one call an agent makes to get up to speed on a work. Returns
`{format, title, core, outputs, waiting[], last, open, next, track, gate?, realNames?, brief?, notices?}`:

| Field | What it holds |
|---|---|
| `track` | the work's track (`fiction`, `historical-fiction` or `nonfiction`), as `status` reports it |
| `realNames` | `false` when the work's `pablo.json` sets `realNames: false` (`research distill` swaps research names for the bible's); omitted when real names are allowed, the default. See `docs/configuration.md` |
| `gate` | the track's shut gate, `{stage, message, missing[]}` (`message` names the track, e.g. `historical-fiction: research has no sourced notes yet`); omitted when the track lets drafting go ahead. The prose form has it as a `gate: ...` line. Open research checklist items are the first entries of `open` |
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
{core: {track, stages[{id, done, summary, missing[], optional?, gate?}], premise, period, research[], sourcedResearch[], checklist?{file, items[{number, category, item, sources[], waived?, status}]}, periodFacts, bible, acts, beats, outlineFile},
 outputs: {<type>: {noun, plural, dir, units[], drafted, total, next?}},
 waiting[], next, track}
```

- **`track`** is `pablo.json`'s `track`, or `fiction` for a work without one. The prose form has it as a `track: <id>` line after the outputs.
- **`checklist`** is the work's research checklist (`research/checklist.md`, see `research plan`), each item with its `status` (`open`, `sourced` or `waived`); absent when the work has none. The prose form lists the open items under `open research (research/checklist.md):`, and `resume` puts them first in its `open` list.
- **Core stages** depend on the track. On `fiction` they are `premise`, `research`, `bible`, `acts`, `beats` and `facts`.
  - `premise` means `bible/overview.md` has text under `## Logline`.
  - `research` is optional and never holds the core back.
  - `facts` is checked per unit, so an open `[pick]` blocks only the units whose beat names it.
- **On `historical-fiction`** they are `premise`, `period`, `research`, `period-facts`, `bible`, `acts`, `beats` and `facts`. The three stages the track adds or makes required carry `gate: true`; `write` refuses while one is short.
  - `period` means `bible/period.md` has text: the brief for the period or event.
  - `research` is required: a research checklist (`research/checklist.md`, from `research plan`) with every item sourced or waived, and at least one note under `research/` with an entry under `## Sources` (what `research save` writes). Its summary reads `2 sourced notes, checklist 3 sourced, 1 waived, 2 open`, and `missing` names each open item.
  - `period-facts` means `facts/period.md` has at least one fact row.
- **On `nonfiction`** they are `thesis`, `research`, `claims` and `outline` (no bible, acts or beats stage); each carries `gate: true`, and `write` refuses while one is short. The core JSON adds `thesis`, `claims[{number, claim, sources[]}]` and `sections[{number, section, summary}]`.
  - `thesis` means `core/thesis.md` has text.
  - `research` is required, as on `historical-fiction`: a closed research checklist (derived from the thesis) and at least one sourced note under `research/`.
  - `claims` means `core/claims.md` has claim rows, each citing at least one research note id that exists under `research/`.
  - `outline` means `core/outline.md` has at least one section row.
- **The beats file** is `outline/beats.md`, or `outline/chapters.md` on an unmigrated work (`outlineFile` says which).
- **`units[].words`** is a drafted unit's word count (absent for units that share one file, like the essay's sections): the unit file's body (frontmatter left out) split on whitespace. The screen's editor counts the same way, so its live count for a saved file equals this number.
- **`waiting`** lists the change branches with commits that `main` lacks.
- **`next`** is one of:
  - `core: <action>` while the core is short. Once any bible file exists the bible counts as done, so `next` moves on to acts or beats; it then appends `; the bible still lacks: <files>` naming the bible files still to save (`pablo save --stage bible/<file>`)
  - `add an output (pablo output add <type>|... --project <slug>)` when the core is ready but nothing derives from it, listing the outputs the track allows
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
pablo save --project <slug> --stage thesis|claims|outline [--file F]     # nonfiction
```

Reads stdin, or `--file`, and writes:

| Stage | Target |
|---|---|
| `premise` | replaces `bible/overview.md` |
| `acts` | replaces the acts table in the beats file; the rest of the file is kept byte for byte |
| `beats` | replaces the beat table in the beats file |
| `bible/<file>` | replaces that `.md` file, which must stay under `bible/`; input of table rows only (no header row) replaces the data rows of the file's first table and keeps its heading and header |

Table input may be a full table or rows only; it is rewritten under the standard
header. Input is checked before anything is written. A beat row needs six columns
(`# | Story date | Title | Beat | POV | Status`) with a four-digit year in the date.
An act row needs three (`Act | Years | What it accomplishes`): the act's id (`I`, `II`
or `1`, `2`), the story time it spans (a year or range of years for a long work, the
dates or days for a short one; the column keeps its name either way) and what the act
does. The acts table never counts as beats, whatever its ids. A bad row is refused, naming the row and column. The file is
committed by path. Returns `{ok, path, stage, committed, notice?}`.

A nonfiction work (`track: "nonfiction"`) has its own core, and its own stages:

| Stage | Target |
|---|---|
| `thesis` | replaces `core/thesis.md` (empty input is refused) |
| `claims` | replaces the claims table in `core/claims.md` |
| `outline` | replaces the section table in `core/outline.md` |

A claim row needs three columns (`# | Claim | Sources`), and its sources cell names at
least one research note id: the note's path under `research/` without `.md`
(`printing-press` for `research/printing-press.md`), comma separated. A section row
needs three (`# | Section | What it covers`). Each track refuses the other's stages.

A section's claims are chosen in its "What it covers" cell: write `#2, #3` and the
section's draft pack carries claims 2 and 3 (a number the claims table lacks
refuses the draft); a cell with no `#N` gives the section every claim.

`save` commits straight to the work's current branch (main), with no `plan/`
review branch; the verbs that write a `plan/` branch are `research save`,
`research plan`, `research distill`, `fact record` and the other research and fact
verbs.

---

## Writing

### write

```
pablo write --project <slug> [--output <type>] --unit N [flags]
pablo write --project <slug> --chapter N [flags]
```

Drafts one unit of an output on your configured writer model. A draft more than
10% off its word target gets a warning (stderr; `lengthWarning` in JSON); the
draft is still written. While it streams, stderr shows `~N tokens`, estimated from
the text so far, not the number of stream chunks. `--chapter N` is
short for `--output novel --unit N`. A work with several outputs needs `--output`.
The `story` output has a single unit, so `write --output story` needs no `--unit`.

`write --output essay --unit N` drafts section N of the essay. Its pack is the
section and the outline around it, the thesis (`core/thesis.md`; on a fiction
track the story's `bible/overview.md`), the section's claims each with its
citation (`[#2]` for claims row 2, with the research note ids it cites as
`[@note-id]`), the layered voice and `outputs/essay/RULES.md`, and the end of the
previous section. Research notes themselves are never sent: a claim's sources go
as ids. The writer is told to cite each claim it uses, where it uses it; `check`
flags a claim without one (`claim-uncited`). The section is put into
`outputs/essay/essay.md` (any heading the writer added is dropped, the other
sections are kept) and committed on `draft/essay-NN`; the file's frontmatter is
the provenance of the section written last. A section that already has text is
refused without `--force`. On a fiction track a section's pack also carries the cast (every character
file, as below), and a section about one act (`Act I`, as `output add essay` names them) carries that act's
beat rows: the beats under the act's own `## Act I` heading in `outline/beats.md` when the beats are split
across act headings, else the beats divided over the acts in order. Default length: 600 words a section (1500 for a
fiction essay with no `outline.md`, whose one section is the whole essay).

`write --output narrated --unit N` makes reading N from the source output's unit N
with **no model**: a `CAST:` line, then a `NARRATOR:` line per paragraph, the words
the source's, unchanged. With `--voices characters`, a paragraph whose quoted
dialogue names its speaker in its narration (exactly one character from
`bible/characters/`; a paragraph naming two stays the narrator's) is split at the quotes: each quote, without its quotation marks, becomes that
character's line (`WILFRED: Four thousand ton,`), the narration stays the
narrator's, and the character joins the `CAST:` line. A paragraph whose speaker
cannot be named stays the narrator's, whole. It is refused (exit `2`) when the
source unit is not written yet. The reading is stored line for line on
`draft/narrated-NN` with `model: pablo-derived` and the script's hash as
`prompt_hash`; the JSON body adds `from` (the source unit's file), and `--dry-run`
shows the script as the pack's one `source` section. `--words`, `--scenes`,
`--temperature`, `--seed` and `--direction` do nothing for a reading.

| Flag | Meaning |
|---|---|
| `--words W` | target length; default is the output's own (1800 for a chapter; for a story, 600 per beat and at least 1800) |
| `--scenes S` | minimum scenes; default 3 (a screenplay scene is always one scene) |
| `--temperature T` | 0 to 2; default is the provider's `temperature` in config, else 0.8 |
| `--seed N` | sampling seed, for a repeatable draw |
| `--direction "..."` | a steer beyond the beat ("slower, stay on Cora"); sent as its own section and recorded as `direction:` in the frontmatter |
| `--voices narrator\|characters` | the narrated output only: one narrator (default), or speaker lines for attributed dialogue; refused on any other output |
| `--force` | overwrite an existing unit file (an essay section: replace its text) |
| `--no-check` | skip the track's checks after the draft (see below) |
| `--dry-run` | build and show the prompt pack, send nothing; a unit whose preconditions are unmet is shown with them as a warning (`warnings` in `--json`) instead of being refused |

Before sending anything, it:

1. Checks the work's track gate. On a `historical-fiction` work it refuses (exit `2`) until the
   period brief, the research (a closed checklist and a sourced note) and the period facts exist,
   naming the track and the short stage: `historical-fiction: checklist item #3 people: Who ran the ice houses is open`.
   On a `nonfiction` work it refuses until the thesis, the research (as above), the claims
   (each citing a note) and at least one outline section exist: `nonfiction: core/outline.md has no section rows`.
   A `fiction` work has no gate.
2. Runs the same checks as `status --for` and refuses (exit `2`, with `missing[]`) if any fail.
3. Builds the pack: the voice, the work's rules, period facts, cast and places, the timeline up to the beat's date, continuity, the end of the previous unit, and the beat.
   - The premise is `bible/overview.md` (its logline, premise, themes and tone), its own `premise` section.
   - The cast is every `bible/characters/*.md`: `family-tree.md` first, then each character's own file by name
     (a file whose name starts with `_`, like the template's `_template.md`, is skipped), each cut at a
     `## Decisions for Matt` heading. Under budget pressure the cast is cut from its end, so the family tree
     is the last of it to go. `--dry-run` lists both sections with every file they came from.
   - The period facts are the rows of `facts/period.md` (from `research distill`) whose story date is on or
     before the unit's (its latest beat's, for a unit telling several), plus every undated row, then the
     `Setting and period facts` section of the work's `STYLE.md`. Only the fact and its date are sent, never
     its source note; nothing under `research/` is ever read into a pack.
   - On a work with `realNames: false`, a research name `research/names.md` maps is swapped for its bible
     name in the period facts, and a research name anywhere else in the pack is a refusal (exit `2`) naming
     the section and the name.
   - Any source under one of the marker's `neverSend` prefixes is a refusal, not a silent drop.
   - In the style files, any section whose heading mentions replies or agents is left out.
   - The voice is layered, lowest first: **global** (`~/.config/pablo/voices/default/`,
     then any global voice the work's `pablo.json` `voice` list names), **vault**
     (`style/`, then any vault voice the list names), **work** (any other voice file or
     directory the list names, then the work's `QWEN.md`), **output**
     (`outputs/<type>/RULES.md`). Every voice's `never.md` is its own section after the
     rules, and every voice's exemplars a section after the craft rules (the work's own
     voices first, each voice's newest first; the first section to give under the
     budget). Every output (novel, story, radio) builds its voice this way.
4. Refuses if the unit file already exists, unless you pass `--force`.

`--dry-run` prints each section of the pack with its token count, plus a wait estimate
when the endpoint has been timed, and the voice layers it used, one line each with the
`pablo.json` entry that named it (the global default is labelled `global default`); a
voice the list names that was not found is a `missing` line, never silently left out.
With `--json` it returns
`{ok, dryRun: true, output, unit, slices[], totalTokens, expectedOutputTokens, prompt_hash, adjustments, voiceLayers, periodFacts?}`,
where `voiceLayers` is `{layers: [{layer, name, source, via?}], missing: [{name, via, reason}]}` and
`periodFacts` (present when the work has `facts/period.md`) is how many of its rows the prompt carries,
also shown as `period facts sent: N` in the text dry run and recorded as `period_facts` in the receipt.
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
token, wall time, temperature, seed, and the voice layers as `voice_layers`, plus
`voice_missing` when a listed voice was not found) is appended to
`<work>/.pablo/receipts.jsonl`.
After the draft is committed, `write` runs the checks of the work's track on that one unit, the
same ones `pablo check --output <type> --unit N` runs: the mechanical tells and the core check on
every track, anachronism and fact accuracy on `historical-fiction`, claim support on `nonfiction`.
Their hits are reported (`check[]` in the JSON, one line each in the prose form) but never change
the exit code, and a hit never rewrites the draft. A check that cannot run (no model configured,
a model error) is reported in `checkNotices[]` (stderr in the prose form) and does not fail the
write; an anachronism run that left words unjudged is reported there as a `pablo: check error`.
`--no-check` skips the track's checks and keeps only the mechanical tells. The checks run in
the draft branch's worktree; the fact-accuracy cache they write stays there, while the anachronism
lexicon goes to the work's `.pablo/lexicon.json` in the main checkout, so it outlives the worktree
and nothing untracked is left in it.

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

The voice is layered like `write`'s: the global default
(`~/.config/pablo/voices/default/`) first, then the `--voice` itself, in the layer of
where it lives. Their rules, exemplars and `never.md` are merged in that order, and the
dry run (`voiceLayers` in `--json`) and the receipt (`voice_layers`) list both.

### revise

```
pablo revise --project <slug> --file F
             (--passage "<quoted text>" | --start N --end N)
             --instruction "<text>" [--dry-run | --branch]
```

Sends one passage of a file to the configured writer model with your instruction and returns a
candidate. It never changes the file. Find the passage by quoting it, or with
`--start`/`--end` character offsets into the body (frontmatter excluded). Returns
`{ok, candidate, span, receipt}`. To keep a candidate, use the screen's revise
action, or `--branch` (with `--passage`, not with `--dry-run`), which commits it on a
`revise/<id>` branch and prints the branch, file and receipt instead of the prose.

---

## Reviewing and accepting

Drafts, revisions, and planning saves from an agent session each land
on their own branch:

| Branch | Made by |
|---|---|
| `draft/...` | `write` |
| `revise/<id>` | revising in the screen, or the MCP `revise` tool with `branch` |
| `edit/...` | editing by hand in the screen |
| `plan/...` | an agent session's planning writes; `promote`; `research save`; `fact record`; `agent --tag-facts` |
| `reader/<round>` | nothing now; left over from an earlier version, kept so an old vault still lists it |

`status` and `resume` list them under `waiting`.

### merge

```
pablo merge --project <slug> <branch>
pablo merge --project <slug> --reject <branch>
```

Accepts any change branch pablo made (`draft/`, `revise/`, `edit/`, `plan/`) onto
`main`, the way accepting it in the screen does with nothing rejected. A draft
branch (`draft/chNN`, `draft/story`, ...) merges and runs the after-write steps for
that unit, in this order:

1. **Outline tick**: the unit's row in the beats file moves to `draft`.
2. **Note**: a dated note under `notes/`.
3. **README**: a bullet under "Where things stand" in the work's `README.md`.
4. **Continuity**: facts are extracted from the new text and filed under the matching headings of the output's continuity file, citing the unit (2-minute limit). At most 20 facts are filed per unit, anchored ones first. A fact files under `## Dates` only when its text names a year, month or weekday. A fact the model can't anchor to a sentence goes under `## Check`. A bullet that names a person or place is marked `, unconfirmed` (`[ch03, unconfirmed]`): `pablo check` still reports that name as an `unknown-name` until you delete the mark or add the name to the bible. Existing bullets are never duplicated.
5. **Commit**: one commit of exactly the touched paths.
6. **think sync**: runs only when the `think` CLI is on your `PATH`. Otherwise this step is reported as `skipped`. It is also `skipped` when the environment sets `PABLO_NO_THINK` (anything but empty, `0` or `false`) or the work's `pablo.json` has `"think": false`; use either for scratch and test vaults so they never write to your real cortex. A timeout (20s) or a non-zero exit is reported as `failed`.

Each step is reported (`ran`, `skipped` or `failed`), and a failing step never
undoes the merge. A `revise/` or `edit/` branch merges and runs the after-revision
steps for each unit it changes (your own comments on it become notes). A `plan/`
branch (`research plan|save|waive|link|distill`, `promote`, `fact record`, an agent
session's planning writes) merges with no steps: its files are core material, not
units. A branch that changes nothing on `main` is discarded instead (`merged: false`).

`--reject` deletes the branch, its worktree and its comments; `main` is not touched.

Either way the branch's worktree under `~/.cache/pablo/worktrees/` (or
`$PABLO_HOME/worktrees/`) is removed, along with the directories it leaves empty.
A conflicting merge changes nothing and runs no steps. A branch that is not a change
branch, a branch of a kind that does not exist in the work, or a draft branch that is
no unit of the work's outputs is refused (exit 2), naming the kind. `--json` returns
`{ok, branch, kind, merged, commit, chapter (a draft), chapters, rituals, notices}`,
or `{ok, branch, kind, rejected: true}` with `--reject`. Over MCP: the `merge` tool,
with `reject: true` for `--reject`.

### The screen (bare `pablo`)

```
cd <vault>/novels/<slug> && pablo
```

Run with no arguments inside a work, on a terminal, `pablo` opens the full-screen
view of the work: its stages, its units with check hits marked under each line, and
the branches waiting for review with their diffs and comments. You can:

- draft a unit, revise a selection, or add a selection to the voice
- edit by hand on an `edit/` branch
- comment on a branch, and accept it (accepting runs the same steps as `merge`)
- compose a message to the agent

Outside a work, or without a terminal, bare `pablo` prints the help.

---

## Checking

### check

```
pablo check --project <slug> [--file F] [--output <type> [--unit N]] [--branch <b>] [--strict]
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
  - `narration-drift` on a narrated reading: the first line where its words (speaker
    labels, the `CAST:` line and double quotation marks aside) differ from its source
    unit's prose, or the words the reading lost

With `--output` (or when the work has one output), it also runs the core check
(`core[]`), the same one `write` runs after a draft. That flags mentions dated
after the unit's year, and names the bible, `facts.md`, `facts/period.md`, the work's
title and the output's continuity (on a nonfiction work, also `research/`) don't know.
Headings and a word right after an opening quote are not names. On a work with radio scripts it adds a `radio` block: directions outside
the vocabulary, and roles with no voice. A screenplay's scenes (`*.fountain`) also
get the Fountain lint in `hits[]`: `fountain-no-heading` (the scene does not open
with a scene heading), `fountain-heading-spacing` (a heading without a blank line
before and after), `fountain-cue-no-dialogue`, `fountain-stray-parenthetical` (one
outside a speech), `fountain-colon-dialogue` (`NAME: words` on one line),
`fountain-markdown` (a code fence) and `fountain-unclosed-boneyard`.

On a **nonfiction** work, each `*.md` unit also gets **claim support** in `hits[]`.
Every sentence that states a fact (a number, a name past its first word, or a
reporting cue such as "according to" or "was founded") is traced by shared words
to a `core/claims.md` row or a note under `research/`:

- `claim-unsupported`: the claim traces to no row or note. `detail` names the
  nearest candidate source, or says there is none.
- `claim-uncited`: the claim traces to a source but the text does not cite it.
  `detail` names the source and the citation to add.

A citation is a bracket of research note ids (`@<id>`) and/or claims row numbers
(`#<n>`): `[@ice-harvest]`, `[#2]`, `[@ice-harvest; #3]`. A claim whose citation
resolves is never a hit; a citation that resolves to nothing is named in the hit.

On a **historical-fiction** work, every unit also gets the **anachronism** check
(`rule: "anachronism"` in `hits[]`): a word, object or idiom out of the work's
period. Each hit carries `term`, `why` (why it is out of period) and `belongs` (the
period it belongs to); `detail` says the same in one line. The period is the
`## When and where` section of `bible/period.md` (else its first paragraph); with no
brief the check is skipped and `anachronism.notice` says so. The unit's distinct
words, never its sentences, go to the model the `check` intent routes to. Function
words, month and day names, and capitalised names the bible, `facts.md` or a
continuity ledger already uses mid-sentence are never sent. The model lists only the
words that are out of period, one `term | why | belongs` line each, then a line `END`;
a reply that never reaches `END` (cut short, or in another shape) leaves the words it
did not list unjudged rather than passing them. Every verdict is cached per (period,
term) in the work's `.pablo/lexicon.json`, so a re-check asks only about words it has
not seen and a fully cached one makes no model call. A first run on a long work can
take a while: it says on stderr how many new words it is asking about and prints each
batch as it goes. `anachronism.asked` is how many model calls the run made.

When any word goes unjudged (no model configured, a model error, a reply missing
verdicts) the check fails: the hits it did find are still reported,
`anachronism.notice` names what went wrong and where to look, `anachronism.failed` is
`true`, the prose form prints `pablo: check error: anachronism: ...` on stderr, and
`check` exits `1`. It is never a silent pass.

The lexicon is machine state under the work's `.pablo/` (gitignored), and always the
one in the repository's main checkout: a check run in a draft branch's worktree writes
there too, so the cache survives the merge that removes the worktree. Edit a verdict
there (`inPeriod`, `why`, `belongs`) to overrule the model; a hand-edited verdict is
used as is. A lexicon that does not parse is left alone and the check fails with a
notice. A `facts/lexicon.json` from an earlier pablo seeds a missing cache and is never
written. Verdicts are keyed by the period text, so rewriting the brief's
`## When and where` section starts a fresh set.

On a **historical-fiction** work with `--output`, each unit also gets **fact accuracy**
against the distilled period facts (`facts/period.md`, from `research distill`). This
part calls a model: one call per unit, on the provider the `check` intent routes to, so
on a local endpoint it takes a while; a line goes to stderr before each unit. The unit
is held to the facts its drafting pack was given: every undated row, and every row
dated on or before the unit's story date. The model names each sentence a fact
contradicts. Each `fact-accuracy` hit in `hits[]` quotes the draft sentence
(`excerpt`), the fact (`fact`) and its source note (`source`, `research/<id>.md`), with
all three in `detail`. A unit with no relevant facts is not sent. `--unit N` checks only
unit N of the output, on any track (every check above narrows to it); a unit it does not
have, or `--unit` with `--file`, is a refusal, exit `2`.

A unit still on its draft branch is checked there: when `main` lacks unit N, `--unit N`
reads the newest draft branch of that unit that has commits `main` does not (a re-draft
`-v2` over `-v1`), so lint, core and fact checks run before the draft is accepted.
`--branch <b>` names the branch (any change branch; with `--unit` it narrows to that unit)
and is refused with `--file`. The prose form notes `checked the pending draft on <b>` on
stderr, and the JSON has `branch`. A section of the essay is found in its shared
`essay.md` by its text, so every section's draft is checked, not only the first. With no
drafted units, `check` prints `nothing to check: no drafted <units> in <dir>/ (<output>
output)` (JSON: `notice`) instead of `no hits`.

`--strict` makes the run exit `1` when any hit is reported (`hits[]` or `core[]`; provenance
gaps and radio findings are not counted); without it a hit never changes the exit code. A
refusal is still `2`. Exit `1` with `ok: true` in the JSON means hits, or (with or without
`--strict`) an anachronism run that left words unjudged (`anachronism.failed`).

Checking a pending draft adds the branch's git worktree under `$PABLO_HOME/worktrees/` when
it has none (never in the vault tree); the fact-accuracy cache lands there too, while the
anachronism lexicon goes to the main checkout's `.pablo/lexicon.json`.

The summary is `factAccuracy: {checked, notice?}`: how many units were sent, and why
the run stopped short (no model configured, or the model failed). A notice never fails
the check. The hits are also kept in `.pablo/fact-accuracy.json`, so the screen shows
them on a unit with its other check hits until the unit's text changes.

Hits are data: without `--strict` exit is `0` either way, except an anachronism run
that left words unjudged (exit `1`, `anachronism.failed`).

```
{ok: true, hits[], unprovenanced[], core?[], radio?, anachronism?{asked, notice?, failed?}, factAccuracy?{checked, notice?}}
```

`--across` compares the continuity of every output instead. It reports facts the
tellings disagree on, each with a finding id and a `promote` action. Its critic, like
`critique`'s, runs on the provider the `check` intent goes to (the `plan` mapping when
`check` is unmapped; see [configuration.md](configuration.md#default-and-intents)).

### promote

```
pablo promote --project <slug> --finding <id> --keep <type>
```

Settles a `check --across` finding. The kept output's fact goes into `facts.md`
(the facts every output must honour) on a `plan/` branch for review. Each
contradicting unit gets a comment on its line there.

### research

```
pablo research save --project <slug> --title <text> --note <text> --source <url> [--source <url>]... [--item <#>]...
```

Keeps a research finding as `research/<slug>.md` in the work: the title, the
retrieval date, the note, then a Sources list. At least one `--source` is
required, and every one must be a source a reader can follow: an http(s) URL, a
DOI or ISBN, or a bibliographic citation naming the work and its year
(`"Hobsbawm, The Age of Empire, 1987"`). Anything else ("General knowledge of
...", "memory", "Wikipedia") is refused, naming the entry, and nothing is
written. A note never replaces an earlier one (the slug
gets a `-2` suffix). The write lands on a new `plan/` branch for you to review.
The same writer is the harness's `save_research` tool, and over MCP this verb is
the `save_research` tool (sources go in `sources`).

With `--item <#>` (repeatable; `items` over MCP) the note also sources those
research checklist items: its id joins each item's Sources on the same branch,
so the note and the items it closes are reviewed together. An item number not on
the checklist, or a work with no checklist, is refused before anything is written.

```
{ok: true, path, branch, sha?}
{ok: true, path, branch, sha?, note, items: [{number, category, item, sources, status}], open}    with --item
```

```
pablo research plan --project <slug> [--max <N>]
```

Derives the work's research checklist, `research/checklist.md`, so an agent knows
what still needs researching. The research agent (the `research` intent, as for
`distill`) reads the period brief (`bible/period.md`) and lists what to look up
under people, places, technology, language, daily life, politics and dates; on a
`nonfiction` work it reads the thesis (`core/thesis.md`, with `core/claims.md` when
present) and lists the claims to support (category `claim`). The write lands on a
new `plan/` branch for you to review:

```
| # | Category | Item | Status | Sources | Waived |
| --- | --- | --- | --- | --- | --- |
| 1 | people | Who ran the Knickerbocker ice houses | sourced | knickerbocker | |
| 2 | language | Ice-trade slang of the 1880s | waived | | the cutters never speak on the page |
| 3 | dates | When the river froze in 1888 | open | | |
```

Every item is `open`, `sourced` (Sources names at least one research note, by
id, that has a `## Sources` entry) or `waived` (Waived gives a reason). pablo
works the status out from those two cells, never from the Status cell it writes.
Running `plan` again keeps every existing row as it is and appends only new
items. The list is sized to the work: by default no more than about a dozen
items for a short work with one output, more for a longer brief or thesis or
several outputs (never fewer than 8 or more than 24 in all); `--max <N>` sets
the cap yourself (`max` over MCP), counting items already on the checklist.
A proposed item in an unknown category, empty, over 200 characters, already
listed or past the cap is rejected and listed under `rejected`; a category left
with no item gets a placeholder to source or waive while there is room. With no brief (or thesis) it is
refused (exit 2); nothing new to add is refused too. Over MCP this is the
`plan_research` tool.

```
{ok: true, path, branch, sha?, added, max, items: [{number, category, item, status}], rejected: [{category, item, reason}], from, provider, model}
```

```
pablo research waive <#,#,a-b> "<reason>" --project <slug>
pablo research link <#,#,a-b> <note> --project <slug>
```

`waive` closes items with a reason; `link` closes them with a research note
already in the work (its id, the path under `research/` without `.md`; a note
with no `## Sources` entry is refused). Name the items as a list and ranges,
`1,3,5-8`: all of them close on one new `plan/` branch for you to review. A note
still on an unmerged `plan/` branch (a `research save` without `--item`) links
too, and the result's `pending` names the branch to accept with it. Both read the
checklist from the work as merged, so merge `plan`'s branch first (if it is not
merged, the refusal names its branch); merge each `waive`/`link` branch before the
next: every one rewrites the whole table from main, so two unmerged ones conflict.
Over MCP: `waive_research_item` (`items`, `reason`) and `link_research_item`
(`items`, `note`), each taking an array (a single `item` still works).

```
{ok: true, path, branch, sha?, items: [{number, category, item, sources, waived?, status}], item? (one item only), open, pending?: [{note, branch}]}
```

The research gate on `historical-fiction` and `nonfiction` works passes only when
every checklist item is sourced or waived; `status` and `resume` list the open ones.

```
pablo research distill --project <slug>
```

Turns the work's research notes into short, sourced period facts, the only form of
research the drafting model sees. The research agent (whatever the `research`
intent routes to; see `docs/configuration.md`) reads every note under `research/`
and proposes facts; pablo writes the ones that pass to `facts/period.md` on a new
`plan/` branch for you to review, replacing the file's earlier rows:

```
| Fact | Source | Story date |
| --- | --- | --- |
| Ice sold for four dollars a ton. | ice-prices-1929 | 1929-01 |
```

One fact per row; the source is a research note id (`research/<source>.md`) and
the story date (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`) is optional. A proposed fact
with no source, a source that is not a note, a fact over 280 characters or a bad
date is rejected and listed under `rejected`, never written. With no notes, or
no fact left, it is refused (exit 2).

On a work with `realNames: false`, every name the agent lists as taken from
research, and every mapped name found in a fact, is swapped for its bible
counterpart, mapped in `research/names.md` (it stays under `research/`, which
never reaches a writer):

```
| Research name | Bible name |
| --- | --- |
| Halvorsen Ice Co. | Nadeau Ice |
```

The bible name must appear in `bible/`. A listed research name with no
counterpart refuses the whole run (exit 2) and `names` lists every one to map.
pablo relies on the agent to list the names it used; a real name it fails to
list is caught only when you review the `plan/` branch. The work's period brief
(`bible/period.md`), when present, is sent with the notes. Unless `intents.research`
maps to a local provider, the notes go to the first non-local provider. Over MCP
this is the `distill_facts` tool.

After writing the facts, the same agent holds the period brief (`bible/period.md`)
and the premise (`bible/overview.md`) against them and reports every claim a fact
contradicts (a brief saying the saloons closed while a fact says they stayed open):
`contradiction:` lines in the output, `contradictions` in the JSON. It only reports;
nothing is rewritten. If the cross-check model fails, `crosscheckNotice` says so and
the distillation stands. The `fact-accuracy` check also tells the model the unit's
story date and each fact's date, so a date contradiction is caught.

```
{ok: true, path, branch, sha?, facts, rejected: [{fact, source, reason}], swapped?: [{from, to}], contradictions?: [{document, claim, fact, source, why}], crosscheckNotice?, provider, model}
{ok: false, code: 2, message, names?}       realNames: false and unmapped research names
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
| `novel` | `draft`, `review`, `final` | `<work>/.pablo/out/<slug>-<target>.md`. `draft`: every chapter in order, frontmatter stripped, sentence lines joined into paragraphs, quotes curled. `review`: chapter headings with each source sentence line numbered `[n]` (restarting in every chapter) so a reader can cite a line. `final`: the clean manuscript, same as the draft, plus `<slug>-final.epub` (one XHTML file per chapter; no pandoc needed); `files` lists both |
| `story` | `draft`, `review`, `final` | `<work>/.pablo/out/<slug>-story-<target>.md`: `draft` and `final` are the clean compiled story; `review` adds a "Review copy, N words" line under the title |
| `essay` | `draft`, `final` | `<work>/.pablo/out/<slug>-essay-<target>.md`: `# <title>`, every section under its `## ` heading (a one-section essay has none) with sentences joined into paragraphs and quotes curled, then `## Sources` (left out when nothing is cited). Each citation becomes a numbered reference (`[1]`, `[2, 3]`; a `#n` cites the notes claims row n names), and the sources list gives each cited research note's title, its sources and its retrieval date, in order of first citation. `draft` adds a "Draft, N words" line under the title naming any citation that resolves to nothing; `final` is the clean copy and is refused while such a citation remains. |
| `narrated` | `script` | `<work>/.pablo/out/<slug>-narrated-script.md`: every reading's script in unit order, frontmatter stripped, under a `## Reading N: <title>` heading each. The audio targets come with the mixer. |
| `screenplay` | `draft`, `final`, `fountain` | `<work>/.pablo/out/<slug>-screenplay.fountain`: a title block (`Title:`, then `Credit: Written by` and `Author:` from `pablo.json` `author`, plus `Draft date:` and `Contact:` from the optional `pablo.json` keys `draftDate` and `contact`), then every written scene in order, frontmatter stripped, the Fountain copied line for line. `draft` and `final` also write `<slug>-screenplay.pdf` beside it in standard screenplay format (US Letter, Courier 12, 1.5in left and 1in other margins, indented dialogue, page numbers from page 2); `fountain` writes the Fountain file alone. The PDF is typeset by pablo itself (`packages/cli/src/screenplay-pdf.ts`, no dependency, no pandoc, Courier is a built-in PDF font); `files` lists both, and the text output names them (`files: <slug>-screenplay.fountain, <slug>-screenplay.pdf`). Action never breaks across a page with fewer than two lines on either side. |
| `radio` | `bundle`, `stream` | `bundle`: `.pablo/out/<slug>-radio-bundle/` with every script, each mixed episode's newest audio and manifest, and `bundle.json`; unmixed episodes are listed in `notes`. `stream`: each mixed episode to `.pablo/out/stream/`. `player` is refused; use `pablo review`. |

Quotes follow the work's rule: when its `STYLE.md` or the vault's `style/prose.md`
says "straight quotes" or "never curly", `publish` writes straight quotes (even
over curly ones in the source); with no such rule it curls them, as the table says.

Returns `{ok, output, target, where, chapters, words, files?, notes?}`. Here
`chapters` counts units, whatever the output calls them.

---

## Voice

A voice is a directory of rules, flagged lines and exemplars. The `fiction` voice is
the vault's `style/` directory. Named voices live under the vault's `voices/`, or the
global `~/.config/pablo/voices/` (respects `XDG_CONFIG_HOME`).

```
pablo voice new <name> [--global]
pablo voice list [--project <slug>]
pablo voice show <name>
pablo voice flag <name> "<line>" [--section <heading>]
pablo voice exemplar <name> <file> [--title "<t>"]
pablo voice rule <name> "<text>" [--example "<sentences>"]
pablo voice rule "<text>" --target global|vault|work|output:<type> [--project <slug>]
pablo voice edit <id> "<text>" [--target <t>] [--project <slug>]
pablo voice remove <id> [--target <t>] [--project <slug>]
pablo voice use <name> --project <slug>
```

| Sub | What it does |
|---|---|
| `new` | scaffolds a voice directory in the vault, or the global directory with `--global` |
| `list` | every voice in the vault and the global directory, then every rule with its id (`id`, target, text); a work's own and its outputs' rules show with `--project` or when you run it inside the work |
| `show` | the assembled voice as a model will see it |
| `flag` | records a rejected line under a section of `voice.md`, or `style/prose.md` for `fiction` (default section "Flagged") |
| `exemplar` | keeps a piece as-is under the voice's `exemplars/` |
| `rule` | adds `- <text>` as the last bullet of the target's `## Rules` (created if missing) |
| `edit` | changes one rule's text by its id, keeping its `Flagged:` example; prints the rule's new id |
| `remove` | deletes one rule, with its example lines, by its id |
| `use` | adds a named voice to the work's `pablo.json` `voice` list (once), so every pack for the work carries it |

For `rule`, the default target `voice` writes `style/prose.md` for `fiction` and
`voice.md` for a named voice. `--target` picks a layer instead, and then no voice name
is needed: `global` writes the global default voice
(`~/.config/pablo/voices/default/voice.md`, never committed), `vault` writes
`style/prose.md`, `work` writes the work's `STYLE.md`, and `output:<type>` writes
`outputs/<type>/RULES.md` (created if missing). `work` and `output:<type>` need
`--project`. `work` joins an existing "Ground rules" section if there is one, and is
refused when the work has no `STYLE.md`.

A rule's id is six hex digits of the hash of its text, so it stays put while other
rules come and go and changes only when you `edit` that rule. If the same text is in
two files, `edit` and `remove` refuse until `--target` (`global`, `vault`, `work`,
`output:<type>` or `voice:<name>`) says which. `--example` adds a `Flagged: "..."` line
under the rule. `check` and `write` read those lines from `style/prose.md`, but not
from `STYLE.md`. Changes are committed by path.

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
pablo story "<prompt>" [--output <type>]... [--review] [--no-check] [--title T] [--words N] [--track <t>]
pablo story --project <slug>
```

Writes a work end to end from a prompt. It:

1. Creates the work, under `stories/` for a story or `novels/` for a novel.
2. Builds the story core through the agent harness (research, premise, bible, acts, beats), each stage on a `plan/` branch. A `historical-fiction` run builds that track's core instead: premise, the period brief (`bible/period.md`), the research checklist (pablo runs `research plan` on the brief), research (the agent sources each open item with `save_research` or waives it with a reason, every write on the stage's one branch), period facts (pablo runs `research distill`), then bible, acts and beats.
3. Drafts, merges and publishes each requested output.

`--output` is repeatable. The default is one written output, `story` or `novel`
depending on the length the prompt asks for. A type that can't run here (radio
without the casting side) is refused before anything is written.

The work's track is `--track <t>` when given. Without it, one planner call reads the
prompt: a prompt that names a historical period or event (a past year or era, a war,
a named event) is `historical-fiction`, anything else `fiction`; `nonfiction` is never
inferred, and `--track nonfiction` is refused (a story is fiction; start a nonfiction
work with `pablo init --track nonfiction`). While the planner is asked, the run prints
`pablo story: choosing a track from the prompt`. Then it prints `pablo story: track <t>
(inferred: <why>)` on stderr, writes the track into `pablo.json`, scaffolds that
track's core files (see `init`) and returns `track: {track, inferred, why}` in its
result (`why` is `--track` for a named one). If the planner can't be reached or answers
with something unreadable, the run stays on `fiction` and `why` says so. An unknown
track, or a requested output the track does not allow, is refused before anything is
written. A historical-fiction run reaches the draft through its own core, so
`write`'s track gate is open by the time a unit is drafted; the checklist and the
period facts ask the `research` intent's provider, as `research plan|distill` do.

By default every branch is accepted as soon as it lands. The agent's questions are
answered by stated assumptions, which are kept with the run. An `--output essay` on a
fiction work assumes the premise (`bible/overview.md`'s `## Premise`, else its logline)
as the essay's thesis, recorded among the assumptions; edit `outputs/essay/thesis.md`
to change it. With `--review`, the run
stops on each branch for you to accept; `pablo story --project <slug>` then picks the
run up again. Progress is kept in `<work>/.pablo/story.json`, so a stopped or failed
run resumes where it was. Runs on the same provider as `agent`.

Every turn of the agent loop in a core stage appends a receipt to `<work>/.pablo/receipts.jsonl`
(`intent` `research` or `plan`, `provider`, `model`, tokens, `cost_usd`, and `tool_calls`, the
names of the tools the turn called), and each stage's full transcript is saved as JSONL under
`<work>/.pablo/transcripts/`. The result (`--json`) lists them as `transcripts`.

After each drafted unit the run does what `write` does: it runs the work's track checks on
that unit and keeps the hits (and any check that could not run) on the draft's record in
the result, `drafts.<output>[].check[]` and `.checkNotices[]`; the prose form prints one
line per hit. A hit never rewrites the draft and a failed check never stops the run.
`--no-check` skips the track's checks (and stays on when the run is resumed). The radio
output's episodes are checked by `write` as usual, but their hits are not summarised here.

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
| Writing | `write`, `prose`, `revise` (deprecated aliases, removed next release: `draft_unit`, `draft_chapter` for `write`; `revise_passage` for `revise` with `branch`) |
| Planning and checks | `save`, `check`, `critique`, `promote`, `save_research`, `distill_facts`, `plan_research`, `waive_research_item`, `link_research_item`, `record_fact` |
| Starting a work | `guide` (call it first), `init`, `story`, `output_add` |
| Accepting or rejecting a change branch | `merge` |
| Setup and publishing | `output` (list, remove, plan), `migrate`, `publish` |
| Voice | `voice_list`, `voice_show`, `voice_flag`, `voice_exemplar`, `voice_rule`, `voice_edit`, `voice_remove`, `voice_use` |
| Reading | `read`, `search`, `web_search`, `web_fetch` |
| Radio | `bind`, `audition`, `cast`, `voices`, `describe_voice`, `perform`, `mix`, `fix` |

`init`, `story`, `output_add` and `merge` take the same arguments as the verbs and
refuse the same way. `merge` accepts a change branch of any kind (or with `reject`
deletes one): an agent calls it only when you tell it to. Those three (`init`, `story`, `merge`) are never offered to pablo's own
agent (`pablo agent`, the screen's compose view): it does not start works, run the
drafting pipeline or land its own drafts. There is also no `voice new` tool.

### agent

```
pablo agent --project <slug> [--new] "<message>"
pablo agent --project <slug> --tag-facts
```

Runs one session of pablo's own agent loop on the provider the config's `agent`
intent goes to (see `docs/configuration.md`): Claude through an `anthropic` provider,
or any OpenAI-compatible model with tool calls. With no cloud provider configured and
no `intents.agent` set, it runs on the local model and says so on stderr. Its system
prompt carries the work's policy and `STYLE.md`. Its tools are pablo's MCP tools and
nothing else, including `web_search` and `web_fetch` (see `docs/configuration.md`,
`web`): it researches from the work's saved notes and the web, and asks you for a
source rather than inventing one.

The transcript prints as it arrives, ending with the turns, time and cost (a model
pablo has no price for is named rather than counted as free). Each run is a fresh
conversation saved as provider-neutral JSONL in the work's `.pablo/sessions/`; the next
run resumes it (on any provider, so a session can move between the local model and
Claude), and `--new` starts a fresh one while the old file stays. A resumed Claude
session replays earlier tool turns without their thinking blocks. A session file saved
by an older pablo (the old Agent SDK's format) is reported as legacy, not resumable, and left
untouched; a new session starts instead. Only `pablo agent` saves and resumes; the
screen's compose view starts fresh each time. When the agent asks you a question, it
prints the choices and reads your answer from stdin (type a number to pick one).

Each turn also appends a receipt to the work's `.pablo/receipts.jsonl`: `intent` `agent`, `provider`,
`model`, tokens, `cost_usd` and `tool_calls` (the names of the tools the turn called).

`--tag-facts` tags every untagged bible and continuity fact as researched, invented
or author on a `plan/` branch. Chapters are never touched. The classifier runs on the
provider the `plan` intent goes to (see [configuration.md](configuration.md#default-and-intents)). With `--json` it returns
`{ok, provider: {id, model, credential}, entries[], result}`; `credential` is where the
key comes from (`env:ANTHROPIC_API_KEY`, `keychain:…`, `none`), never the key. Exit `0` on success, `2`
refused, `1` failed.

---

## Radio (experimental)

The `radio` output turns a work into an audio drama: scripts, cast voices, rendered
lines, mixes. These verbs are experimental and need Apple Silicon (the speech models
run on MLX) and [uv](https://docs.astral.sh/uv/) (`brew install uv`). The Python
side installs itself on first use, and only verbs that need it ever install it.
Rendering uses the GPU.

What that install fetches, and how it is pinned: the Python packages come from the
committed `packages/casting/uv.lock` (`uv sync --frozen`, every package checked
against its sha256 there). The speech engines' weights and the UTMOS scorer are
fetched at a fixed commit revision, and each load's receipt records the weights'
sha256. The other scorers' weights (Whisper, the aligner, ECAPA, Audiobox,
emotion2vec), the Stable Audio Open model behind generated sound cues, and any
`weights` you list in `casting.json` are fetched at the Hugging Face repo's current
revision when first used and then read from the Hugging Face cache.

| Verb | What it does |
|---|---|
| `pablo doctor [--json]` | reports the casting side's state, uv and config, and checks the writing side: the config file is found and valid, each provider the config routes to answers, the vault is a git repo, the search backend answers. Each failing line says how to fix it; exits 1 when a required check fails (a missing config file or search backend is a warning, not a failure). Never installs anything |
| `pablo audition --role R --describe "..." [-n 6] [--designer qwen3\|voxcpm2] [--traits '{...}'] [--seed S]` | renders candidate voices reading a test passage, scored. `audition --dry-run` installs and checks the casting side without loading a model |
| `pablo cast --role R --candidate n [--recast] [--notes "..."]` | freezes a candidate as a voice card in the shared library. `cast --auto --project <slug> [--episode N\|--all]` matches unbound roles to library voices; add `--design` to design voices for roles with no match. Synthetic voices only |
| `pablo describe_voice --describe "..." [--gender f\|m\|x] [--role R]` | normalises a `CAST:` description into the voice traits vocabulary with the deterministic mapper: the traits found, the phrases it could not normalise, and the designer instruct. Loads no model and writes nothing; the same function as the MCP tool |
| `pablo voices list [--auto-admitted] \| show <slug> \| retire <slug> [--reason "..."]` | the shared voice library; a retired voice still plays for stories already pinned to it |
| `pablo bind --project <slug> --role <NAME> --voice <slug>` | pins a script role to a library voice in the work's `cast.json` |
| `pablo perform --project <slug> --episode N [--engine chatterbox-turbo\|dia] [--json-lines]` | renders an episode's lines in their bound voices, retrying lines that fail the quality gates; refused while a role is uncast. `--stream` (with `--episode N` or `--all`) mixes and publishes as it goes, and never replaces a human mix: one that still fits is the one rendered, one that no longer fits is rebased onto the new take set (as `mix` does) |
| `pablo mix --project <slug> --episode N [--version k]` | mixes a performed episode with its sound cues into `epNN.m4a`; a mix saved in the mixer is kept, and after `fix` it is rebased onto the new takes (unchanged lines keep every edit; whatever could not be carried over is listed for review in the mixer, never dropped) |
| `pablo fix --project <slug> --episode N [--line I]` | re-records only the flagged lines, then remixes (a mix saved in the mixer keeps its edits: see `mix`). `--line I` re-records just that line (it needs an open flag); the episode's other flags stay open. After a role is rebound to another voice, `fix` runs only when every line of that role is flagged, and re-records them in the new voice |
| `pablo gate <take.wav> --line "..." --card <slug>` | scores one take against a card's quality gates; `gate calibrate` fits the thresholds |
| `pablo takes show <key> \| gc [--yes] --project <slug>` | inspects one take, or archives the takes no manifest uses (moved, never deleted) |
| `pablo takes line --project <slug> --episode N --line I` | every take a line has had across its versions (the one in use starred), to compare after a `fix` |
| `pablo takes choose <key> --project <slug> --episode N --line I` | puts an earlier take back on the line: writes the next version, remixes it, and a mix saved in the mixer is rebased onto it |
| `pablo review --project <slug> [--episode N]` | the review player (needs Google Chrome): play episodes, flag lines for `fix` |
| `pablo mixer --project <slug> --episode N [--version k] [--library DIR] [--export-notes]` | the mixer window (needs Google Chrome): edit the mix, Save writes the next mix version, Render saves (if edited), runs `pablo mix` on that version and reloads the window's audio; the window says whenever the audio on disk is older than the mix it shows. Right-click a cue clip to regenerate it: edit its description, or pick a variation (another recording, or the generator's); the new cue replaces the clip's source in the next mix version and its position, fades and gain stay. `--library DIR` is the library whose `cues/` hold the cue audio; `--export-notes` writes the episode's punch list without opening it. Its punch-list panel lists the open flags (yours and the automatic ones), flags a line as `pablo review` does, re-takes it with a reason (`fix --line`), and compares the line's takes and chooses one (`takes line`, `takes choose`); each re-take or choice remixes and reloads the window, so save mix edits first. The **Cast** button opens the Cast panel: each role with its description and bound voice; audition any library voice reading one of the role's lines, bind it (`bind`), or design a new voice from a description (`audition`, then `cast` a candidate and bind it). When a rebound role's lines were performed in the old voice, the panel offers to re-perform them (it flags those lines and runs `fix`; save mix edits first). A binding covers every episode of the work, so other performed episodes of that role are re-performed from their own mixers |

`perform`, `mix` and `fix` also accept `--output radio --unit N` in place of
`--episode N`. Check an episode's progress with `pablo status --for "episode N"`.

### Performing a narrated output

The `narrated` output's readings (`pablo write --output narrated --unit N`) are
performed and mixed by the same verbs, addressed as `--output narrated --unit N`.
A reading keeps its own casting state in `outputs/narrated/casting/` (`cast.json`,
`flags.json`, `renders/epNN/`), so a narrated unit never shares a voice binding,
a flag or a version with a radio episode of the same number.

```
pablo cast --auto --project <slug> --output narrated [--unit N]
pablo perform --project <slug> --output narrated --unit N
pablo mix --project <slug> --output narrated --unit N
pablo fix --project <slug> --output narrated --unit N [--line I]
pablo mixer --project <slug> --output narrated --unit N [--version k]
```

`cast --auto --output narrated` casts the narrator from the voice library (a
card whose traits list `narrator` scores highest); character voices are cast only
when a reading gives a character lines (`write --voices characters`). Without a
unit it casts every reading's roles. `perform` refuses a reading whose narrator
is not cast yet and names the `cast` command. A reading has no sound cues, so its
mix is the voices alone. `--stream` and `--all` stay the radio output's: a
narrated unit is performed one at a time. The pronunciation lexicon is the
output's own, `outputs/narrated/pronounce.md`.
