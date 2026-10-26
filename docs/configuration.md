# Configuration

pablo reads one file: `$XDG_CONFIG_HOME/pablo/config.json`, which is
`~/.config/pablo/config.json` unless you set `XDG_CONFIG_HOME`. It is optional. With
no file, pablo uses one provider called `local`: an OpenAI-compatible server at
`http://127.0.0.1:8002/v1`, model `mlx-community/gemma-4-31b-it-4bit`. A work can
route its own models on top of it from its `pablo.json` (see
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
      "key": "keychain:anthropic-api-key"
    }
  },
  "default": "local",
  "intents": {
    "plan": "anthropic"
  },
  "readers": {
    "sam": { "github": "sam-reads", "name": "Sam Lee", "email": "sam@example.com" }
  },
  "web": {
    "search": { "backend": "searxng", "url": "http://127.0.0.1:8080" }
  },
  "editor": "nvim"
}
```

## `providers`

A map from a name you choose to one model endpoint. The built-in `local` provider is
always present; an entry named `local` changes only the fields it sets.

| Field | Meaning | Default |
|---|---|---|
| `kind` | `"openai-compatible"` or `"anthropic"` | `"openai-compatible"` |
| `endpoint` | Base URL, http or https (the `/chat/completions` or `/messages` path is added) | required for openai-compatible; `https://api.anthropic.com/v1` for anthropic |
| `model` | Model id the endpoint expects | required for openai-compatible; `claude-opus-5` for anthropic |
| `local` | `true` for a model on your own machine. Local providers get one request at a time and are preferred for drafting | `false` |
| `timeoutMs` | How long to wait with no tokens arriving before giving up | `60000` |
| `temperature` | Sampling temperature, 0 to 2, used by `write` when you don't pass `--temperature` | `0.8` |
| `thinking` | OpenAI-compatible only: `false` sends the switch that stops a reasoning model (Qwen3 and similar) from thinking before it answers. Set it to `false` if a local model times out with "only thinking" | off for local providers |
| `tools` | OpenAI-compatible only: `false` for a server that cannot take native tool calls. A chat turn that offers tools is then refused with an error naming the provider, instead of being sent to a server that would ignore them | `true` |
| `key` | Where the API key is. See below | the environment |

Common local endpoints: LM Studio `http://127.0.0.1:1234/v1`, Ollama
`http://127.0.0.1:11434/v1`, llama.cpp's server `http://127.0.0.1:8080/v1`.

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

pablo sends seven kinds of request. Each is an *intent*:

| Intent | Used by | Goes to, unless mapped |
|---|---|---|
| `draft` | `write` | the first local provider |
| `revise` | `revise` | the first local provider |
| `prose` | `prose` | the first local provider |
| `continuity` | the fact extraction `merge` runs | the first local provider |
| `plan` | the critic (`critique`, `check --across`) and the built-in agent's helpers | the first non-local provider |
| `agent` | the built-in agent (`pablo agent`, `pablo story`, the screen's compose view) | the first non-local provider |
| `research` | `research distill` (`distill_facts`): research notes, raw, to period facts; `research plan` (`plan_research`): the period brief or thesis to a research checklist | the first non-local provider (map it to a local one to keep notes on this machine) |

If no provider of the wanted sort exists, the request goes to `default` (which is
`"local"` unless you set it). `intents` overrides the choice per intent.

Because the built-in `local` provider always exists, **a setup with no local model
must map the four writing intents**, or drafting still goes to `127.0.0.1:8002`:

```json
{
  "providers": { "anthropic": { "kind": "anthropic" } },
  "default": "anthropic",
  "intents": { "draft": "anthropic", "revise": "anthropic", "prose": "anthropic", "continuity": "anthropic" }
}
```

pablo is designed around a local writer: the agent plans, and prose comes from a
model you run. A hosted model works for every step; it just costs per chapter.

### Per-work providers and intents

A work's `pablo.json` may carry its own `providers` and `intents`, in the same shape as
above. They are merged over this file for every command run on that work: a provider
entry changes only the fields it sets on the global one of the same name (its key
reference included), a new name adds a provider, and an intent mapping replaces the
global one for that intent. `default`, `readers` and the rest stay global.

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

- `key` is `env:<NAME>` or `keychain:...`, never the key itself. Every command
  refuses a work whose `pablo.json` holds a key until it is removed.
- A work may add a provider, or change any field of one, only on this machine
  (`127.0.0.1`, `localhost` or `::1`). On a remote provider (Anthropic, a hosted
  endpoint) it may change only `model`, `timeoutMs`, `temperature`, `thinking` and `tools`.
  Declare remote providers, and their keys, here, and route intents to them from
  `pablo.json`. That way only this file decides which host a key is sent to.

Routing `draft` to a hosted model from a work costs per chapter, as it does here.

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
own tool loop, and it runs on whichever provider the `agent` intent goes to: Claude
through an `anthropic` provider, or any OpenAI-compatible model with tool calls
(Gemma 4 behind `mlx_lm` included). It needs that provider's key, the same as any
other request; your Claude Code login is not used. With no non-local provider
configured, the agent runs on the local model.

## `readers`

People you share chapters with (see [readers.md](readers.md)). The key is the name
you pass to `pablo share --reader`; lowercase letters, digits and hyphens.

| Field | Meaning |
|---|---|
| `github` | Their GitHub username; they are invited to the reading repo |
| `name`, `email` | Used as the author of the commits their suggestions become |

## The screen: `keys` and `editor`

`editor` is the command the screen runs to edit a file by hand (empty means
`$EDITOR`, then `hx`). `keys` overrides the screen's key bindings by action id; the
screen's settings view (`\`) edits them for you and writes them here.

## Environment variables

| Variable | Effect |
|---|---|
| `PABLO_VAULT` | Use this vault instead of searching up from the current directory |
| `PABLO_HOME` | Where draft branches are checked out while being written (default `~/.cache/pablo`) |
| `XDG_CONFIG_HOME` | Moves the config directory |
| `XDG_STATE_HOME` | Where a reader's fetched rounds go (default `~/.local/state`) |
| `XDG_DATA_HOME` | Where the radio tools' Python environment goes |

## The radio tools: `casting.json`

The experimental radio commands read a separate file,
`$XDG_CONFIG_HOME/pablo/casting.json` (voice engines, model weights, the voice
library, pacing). `pablo doctor` shows what they found.
