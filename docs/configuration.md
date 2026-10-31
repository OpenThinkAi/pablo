# Configuration

pablo reads one file: `$XDG_CONFIG_HOME/pablo/config.json`, which is
`~/.config/pablo/config.json` unless you set `XDG_CONFIG_HOME`. It is where
your models are named. pablo has no built-in endpoint or model id: with no file there
are no providers, and a verb that needs a model refuses with a pointer to
`pablo init --config`, which writes a documented starter file (a local
OpenAI-compatible server and Anthropic, both to edit). A work can route its own
models on top of the file from its `pablo.json` (see
[Per-work providers and intents](#per-work-providers-and-intents)).

A mistake in the file (an unknown key kind, a bad URL, an API key written in plain
text) is reported by name the first time a command needs a model; nothing is sent.

## A complete example

```json
{
  "providers": {
    "local": {
      "endpoint": "http://127.0.0.1:1234/v1",
      "model": "qwen3-32b",
      "local": true,
      "timeoutMs": 120000,
      "temperature": 0.8
    },
    "anthropic": {
      "kind": "anthropic",
      "endpoint": "https://api.anthropic.com/v1",
      "model": "the-claude-model-id-you-use",
      "key": "keychain:anthropic-api-key"
    }
  },
  "default": "local",
  "intents": {
    "plan": "anthropic"
  },
  "web": {
    "search": { "backend": "searxng", "url": "http://127.0.0.1:8080" }
  },
  "editor": "nvim"
}
```

## `providers`

A map from a name you choose to one model endpoint. The names are yours: `local` and
`anthropic` in the examples are just names. Nothing is present until you add it.

| Field | Meaning | Default |
|---|---|---|
| `kind` | `"openai-compatible"`, `"anthropic"` or `"claude-code"` (Claude on your subscription, below) | `"openai-compatible"` |
| `endpoint` | Base URL, http or https (the `/chat/completions` or `/messages` path is added) | required |
| `model` | Model id the endpoint expects | required |
| `local` | `true` for a model on your own machine. Local providers get one request at a time and are preferred for drafting | `false` |
| `timeoutMs` | How long to wait with no tokens arriving before giving up | `60000` |
| `temperature` | Sampling temperature, 0 to 2, used by `write` when you don't pass `--temperature` | `0.8` |
| `thinking` | `false` tells a reasoning model not to think before it answers. On an OpenAI-compatible provider it sends `chat_template_kwargs.enable_thinking: false` (local servers: Qwen3, Gemma) and `thinking: {"type": "disabled"}` (hosted DeepSeek). On an `anthropic` provider it sends `thinking: {"type": "disabled"}`; left unset, no thinking parameter is sent and Claude behaves as before. Set it to `false` if a model fails with "only thinking" or `config test` reports it. A DeepSeek v4-pro route needs it, or `research distill` spends its whole budget reasoning | off for local OpenAI-compatible providers; unset otherwise |
| `tools` | OpenAI-compatible only: `false` for a server that cannot take native tool calls. A chat turn that offers tools is then refused with an error naming the provider, instead of being sent to a server that would ignore them | `true` |
| `key` | Where the API key is. See below | the environment |
| `binary` | `claude-code` only: the `claude` executable, a name looked up on `PATH` or a path. Set it in this file only | `"claude"` |

Common local endpoints: LM Studio `http://127.0.0.1:1234/v1`, Ollama
`http://127.0.0.1:11434/v1`, llama.cpp's server `http://127.0.0.1:8080/v1`.

### Claude on your subscription: `kind: "claude-code"`

A `claude-code` provider runs Claude through Claude Code's `claude -p` on your Claude
login, so its calls are paid by your Claude plan rather than an API key. It has no
`endpoint` and no `key`; its fields are `model` (required, any id `claude --model`
takes) and `binary` (default `claude`), plus `timeoutMs` (the whole turn, default
`600000`, since `claude -p` prints nothing until it is done). `temperature` and
`thinking` are accepted and not sent. `endpoint`, `key`, `local` and `"tools": true`
are refused.

```sh
pablo config set providers.claude-code.kind claude-code
pablo config set providers.claude-code.model the-claude-model-id-you-use
pablo config set intents.agent claude-code     # any intent can route to it
pablo config test
```

`pablo config show` lists it as `uses your Claude login (claude -p, subscription; no
API key)`. You need Claude Code installed and signed in (`claude auth login`, or
`/login` inside `claude`); a missing `claude` or a signed-out login is a refusal naming
that fix.

How it runs: one `claude -p` per model call, a new process each time. The
conversation so far is written into the prompt, which goes on stdin; pablo's system
prompt goes in a file. It runs in a new empty temp directory (removed afterwards),
never your vault, with every Claude Code tool switched off and none of your Claude
Code settings, hooks, plugins, skills, MCP servers or `CLAUDE.md` loaded:
`--tools ""`, `--disallowedTools` naming every built-in, `--strict-mcp-config
--mcp-config '{"mcpServers":{}}'`, `--setting-sources ""`, `--safe-mode`,
`--disable-slash-commands`, `--no-session-persistence`, `--permission-mode dontAsk`,
`--output-format json`. It takes no native tool calls, so pablo's agent loop lists its
own tools in the system prompt and reads each reply for a `{"tool", "arguments"}`
JSON call, which it checks and runs itself, as for any provider.

**Your API key is never used by it.** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL` and the Bedrock, Vertex and Foundry switches are removed from
`claude`'s environment, so a key in your shell cannot make it bill the API.
`CLAUDE_CODE_OAUTH_TOKEN` (a subscription token from `claude setup-token`) is kept.

Receipts record each call with `billing: "subscription"` and `cost_usd: 0`, and the
agent's cost line does not report it as an unpriced model. Your plan's own usage
limits still apply; when `claude` reports one, the call fails with its message.

A work's `pablo.json` may not add a `claude-code` provider, turn another provider into
one, or set `binary` (it names a program pablo runs); it may change `model` and
`timeoutMs` on one declared here, as on any remote provider.

## `web`

`web.search` names the backend `web_search` uses. With no `web.search` block,
`web_search` fails with "no search backend configured".

| Field | Meaning | Default |
|---|---|---|
| `backend` | `"searxng"` (self-hosted, no API key) | required |
| `url` | Base URL of the backend, http or https. pablo calls `<url>/search?format=json`; the SearXNG instance must list `json` under `search.formats` | required |
| `timeoutMs` | How long to wait for an answer | `15000` |

### API keys

pablo never accepts a key written in the config file. It reads it from one of these
places:

- **The environment.** A provider named `anthropic` reads `ANTHROPIC_API_KEY`; one
  named `my-cloud` reads `MY_CLOUD_API_KEY` (the name upper-cased, anything that is
  not a letter or digit turned into `_`, then `_API_KEY`).
- **A variable you name.** `"key": "env:WORK_ANTHROPIC_KEY"` reads that variable
  instead of the conventional one.
- **The macOS Keychain.** `"key": "keychain:<service>"` or
  `"keychain:<service>/<account>"` reads a generic password. Create one with
  `security add-generic-password -s anthropic-api-key -a "$USER" -w`.

## `default` and `intents`

pablo sends eight kinds of request. Each is an *intent*:

| Intent | Used by | Goes to, unless mapped |
|---|---|---|
| `draft` | `write` | the first local provider |
| `revise` | `revise` | the first local provider |
| `prose` | `prose` | the first local provider |
| `continuity` | the fact extraction `merge` runs | the first local provider |
| `plan` | `pablo story`'s premise, bible, acts and beats stages, the track choice, and `pablo agent --tag-facts` | the first non-local provider |
| `agent` | the built-in agent (`pablo agent`, the screen's compose view) | the first non-local provider |
| `check` | the critic that judges a branch (`critique`, `check --across`) | the `plan` mapping when `check` is unmapped, else the first non-local provider |
| `research` | `pablo story`'s research stage; `research distill` (`distill_facts`): research notes, raw, to period facts; `research plan` (`plan_research`): the period brief or thesis to a research checklist | the first non-local provider (map it to a local one to keep notes on this machine) |

If no provider of the wanted sort exists, the request goes to `default` (the first
provider unless you set it). With no provider at all it refuses, naming
`pablo init --config`. `intents` overrides the choice per intent. Every model
call pablo makes goes through one of these intents, to a provider of any kind; pablo
runs `claude -p` on your Claude login only for a provider you declare with
`kind: "claude-code"`.

**A provider whose key does not resolve is skipped.** A non-local provider with no key (its
environment variable is unset, or its Keychain item is missing) is passed over for the next
choice: the intent's mapping, then the other providers of the wanted sort, then `default`.
pablo says which one it skipped once per run, on stderr:
`pablo: skipped provider "anthropic" for the "research" intent (ANTHROPIC_API_KEY is not set); using "local" instead.`
A `local` provider needs no key and is never skipped. If every choice lacks a key, the first
is used anyway and the request fails naming the missing key. A keyless server on another
machine is not "local", so mark it `"local": true` to keep it from being skipped.

A setup with a local provider and no local model it should draft with must map the
four writing intents, or drafting goes to the local provider:

```json
{
  "providers": {
    "anthropic": { "kind": "anthropic", "endpoint": "https://api.anthropic.com/v1", "model": "the-claude-model-id-you-use" }
  },
  "default": "anthropic",
  "intents": { "draft": "anthropic", "revise": "anthropic", "prose": "anthropic", "continuity": "anthropic" }
}
```

pablo is designed around a local writer: the agent plans, and prose comes from a
model you run. A hosted model works for every step; it just costs per chapter.

### Per-work providers and intents

A work's `pablo.json` may carry its own `providers` and `intents`, in the same shape as
above. They are merged over this file for every command run on that work: a provider
entry changes only the fields it sets on the global one of the same name, a new name
adds a provider, and an intent mapping replaces the global one for that intent.
`default`, every provider's `key` and the rest stay global.

```json
{
  "title": "The Lighthouse",
  "slug": "lighthouse",
  "providers": {
    "lighthouse-qwen": { "endpoint": "http://127.0.0.1:8000/v1", "model": "qwen3-32b", "local": true }
  },
  "intents": { "draft": "lighthouse-qwen" }
}
```

`pablo.json` is committed with the work and can come from a co-author or a merged
branch, so it is trusted less than this file:

- `pablo.json` may not set `key` on any provider, not even an `env:<NAME>` or
  `keychain:...` reference. Every command refuses a work whose `pablo.json` has a
  `key` until it is removed, naming the provider. Keys are set in this file only. A
  provider the work overrides keeps the key of the global provider of the same name,
  as long as the work changes only what the request asks for (`model`, `timeoutMs`,
  `temperature`, `thinking`, `tools`). A provider the work adds has no key at all (the
  `<NAME>_API_KEY` convention does not apply to it), and neither does one whose
  `endpoint`, `kind` or `local` the work changes, even to another port on this machine:
  the key was set for the endpoint named here. Otherwise a committed file could choose
  which secret, any environment variable or Keychain item, is sent to a port on this
  machine. If a local server a work uses needs a key, declare that provider here with
  its `endpoint` and `key`, and override only its `model` from `pablo.json`. When a
  work's change drops a key that would have been sent (a Keychain item, or an `env:`
  variable that is set), pablo prints one line on stderr naming the provider and this
  fix. A non-local provider left without a key is skipped, and the stderr notice says this.
- A work may add a provider, or change any field of one, only on this machine
  (`127.0.0.1`, `localhost` or `::1`). On a remote provider (Anthropic, a hosted
  endpoint) it may change only `model`, `timeoutMs`, `temperature`, `thinking` and `tools`.
  Declare remote providers, and their keys, here, and route intents to them from
  `pablo.json`. That way only this file decides which host a key is sent to.

Routing `draft` to a hosted model from a work costs per chapter, as it does here.

### Per-work `think`

`pablo merge` ends with a `think sync` when the `think` CLI is installed. A scratch or
test work sets `"think": false` in its `pablo.json` to skip it (the step is reported
as `skipped`); `PABLO_NO_THINK=1` in the environment does the same for every work.
`think` is `true` when absent, and anything but `true` or `false` is refused.

### Per-work `realNames`

Distilled period facts are what the drafting model sees of a work's research. By
default they may name the real people and places in `research/`, so a story about a
real event can use them. A work that must keep those names out sets `realNames` in its
`pablo.json`:

```json
{ "title": "The Ice House", "slug": "ice-house", "realNames": false }
```

`realNames` is `true` when absent, and anything but `true` or `false` is refused.
`pablo resume` shows `realNames: false` when it is set and says nothing when it is
not. With it `false`, `pablo research distill` (the `distill_facts` tool) swaps each
research name in a distilled fact for the bible's invented one, mapped in
`research/names.md` (`| Research name | Bible name |`), and refuses, listing the
names, while any research name the agent lists has no mapping. A real name the agent
fails to list is not detected: review the `plan/` branch it writes. See `docs/commands.md`, `research`.

### The model behind `pablo agent` and `pablo story`

The built-in agent (`pablo agent`, `pablo story`, the screen's compose view) is pablo's
own tool loop. `pablo agent` and the compose view run on whichever provider the `agent`
intent goes to; `pablo story` runs its research stage on the `research` intent and its
premise, bible, acts and beats stages on `plan`. Each can be Claude
through an `anthropic` provider, Claude on your subscription through a `claude-code`
provider (its tools then go through the loop's text protocol), or any OpenAI-compatible
model with tool calls (Gemma 4 behind `mlx_lm` included). It needs that provider's key,
the same as any other request; your Claude Code login is used only by a `claude-code`
provider. With no non-local provider
configured, the agent runs on the local model.

## What leaves your machine

pablo has no telemetry, analytics or error reporting. Your vault is plain markdown in
git on your disk. Text leaves it only in these ways, all set by you:

| Where it goes | What is sent | When |
|---|---|---|
| The provider an intent routes to (table above) | `draft`, `revise`, `prose`: the assembled pack (voice, rules, the unit's slices; `write --dry-run` prints it). `continuity`: the merged unit's prose, to extract its facts. `plan`, `check`: plans, bible, beats and the branch being judged. `agent`: the conversation, the work's `STYLE.md` and every tool result (plans, bible, notes it reads, fetched pages). `research`: raw `research/` notes, the period brief or the thesis | Every model call. By default the writing intents go to the first local provider and `plan`, `check`, `agent` and `research` to the first non-local one: map them to a local provider to keep that text on this machine |
| The `web.search` backend, then its upstream engines | Search queries the agent model writes itself; they can paraphrase your plot or name your characters | Only when the agent calls `web_search`, and only with a `web.search` block. A SearXNG instance you run yourself keeps the queries off public instances |
| The sites `web_fetch` opens | A plain GET of a URL the agent model chose | Only when the agent calls `web_fetch` |
| The `think` CLI (`think -C writing`) | After a merge: one line naming the work's slug, the unit and its word count (`<slug>: drafted chapter N (<words> words)`, or `<slug>: revised radio episode N`), tagged `repo:<slug>`; never prose. `resume` asks it for a brief and sends nothing but the slug | Only when `think` is installed; `"think": false` or `PABLO_NO_THINK` turns it off. Where think keeps it (and whether it leaves the machine) is think's own configuration |

`neverSend` (default `research/` and `notes/`) keeps those paths out of drafting packs
only. `research distill` and `research plan` send `research/` to the `research`
intent's provider on purpose; see `docs/vault.md`.

Local copies pablo keeps, all gitignored under the work's `.pablo/` and never pruned:
receipts (`receipts.jsonl`, `casting/receipts.jsonl`), agent transcripts
(`.pablo/transcripts/`, each stage's full JSONL including tool results) and saved
sessions (`.pablo/sessions/`; `--new` starts another and leaves the old file).
Deleting a note or a research file from the work does not remove its copies there.
Delete those directories, or the files in them, to purge them. pablo never reads a
transcript back; a deleted session file only means `pablo agent` cannot resume that
conversation.

## The screen: `keys` and `editor`

`editor` is the command the screen runs when you edit a change in a review with
`e` (empty means `$EDITOR`, then `hx`); `v e` edits in the screen's own pane. `keys` overrides the screen's key bindings by action id; the
screen's settings view (`\`) edits them for you and writes them here.

`editModes` (`{ "focus": true, "typewriter": true }`) holds the editing pane's two modes, which the screen writes when you
toggle them with Ctrl+F (focus: dim all but the current paragraph) and Ctrl+T (typewriter: keep the cursor's line in the
middle of the pane); both are off when the entry is absent.

## Environment variables

| Variable | Effect |
|---|---|
| `PABLO_VAULT` | Use this vault instead of searching up from the current directory |
| `PABLO_HOME` | Where draft branches are checked out while being written (default `~/.cache/pablo`) |
| `XDG_CONFIG_HOME` | Moves the config directory |
| `XDG_STATE_HOME` | Where the receipts log goes when there is no vault (default `~/.local/state`) |
| `XDG_DATA_HOME` | Where the radio tools' Python environment goes |

## The radio tools: `casting.json`

The experimental radio commands read a separate file,
`$XDG_CONFIG_HOME/pablo/casting.json` (voice engines, model weights, the voice
library, pacing). `pablo doctor` shows what they found.
