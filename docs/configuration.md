# Configuration

pablo reads one file: `$XDG_CONFIG_HOME/pablo/config.json`, which is
`~/.config/pablo/config.json` unless you set `XDG_CONFIG_HOME`. It is optional. With
no file, pablo uses one provider called `local`: an OpenAI-compatible server at
`http://127.0.0.1:8002/v1`, model `mlx-community/gemma-4-31b-it-4bit`.

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
| `key` | Where the API key is. See below | the environment |

Common local endpoints: LM Studio `http://127.0.0.1:1234/v1`, Ollama
`http://127.0.0.1:11434/v1`, llama.cpp's server `http://127.0.0.1:8080/v1`.

### API keys

pablo never accepts a key written in the config file. It reads it from one of two
places:

- **The environment.** A provider named `anthropic` reads `ANTHROPIC_API_KEY`; one
  named `my-cloud` reads `MY_CLOUD_API_KEY` (the name upper-cased, anything that is
  not a letter or digit turned into `_`, then `_API_KEY`).
- **The macOS Keychain.** `"key": "keychain:<service>"` or
  `"keychain:<service>/<account>"` reads a generic password. Create one with
  `security add-generic-password -s anthropic-api-key -a "$USER" -w`.

## `default` and `intents`

pablo sends five kinds of request. Each is an *intent*:

| Intent | Used by | Goes to, unless mapped |
|---|---|---|
| `draft` | `write` | the first local provider |
| `revise` | `revise` | the first local provider |
| `prose` | `prose` | the first local provider |
| `continuity` | the fact extraction `merge` runs | the first local provider |
| `plan` | the critic (`critique`, `check --across`) and the built-in agent's helpers | the first non-local provider |

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

### Claude for `pablo agent` and `pablo story`

The built-in agent (`pablo agent`, `pablo story`) runs Claude through the Claude Agent
SDK. It uses your Claude Code login by default. If an `anthropic` provider has a key
that resolves, it uses that key instead. These commands need one or the other.

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

## `tray`

`{"tray": {"autoUpdate": false}}` stops the reader's tray from updating pablo by
itself.

## Environment variables

| Variable | Effect |
|---|---|
| `PABLO_VAULT` | Use this vault instead of searching up from the current directory |
| `PABLO_HOME` | Where draft branches are checked out while being written (default `~/.cache/pablo`) |
| `XDG_CONFIG_HOME` | Moves the config directory |
| `XDG_STATE_HOME` | Where a reader's fetched rounds go (default `~/.local/state`) |
| `XDG_DATA_HOME` | Where the radio tools' Python environment goes |
| `PABLO_TRAY=0` | Run the tray without its menu-bar icon |
| `PABLO_TRAY_POLL_SECONDS` | How often the tray checks GitHub, 30 to 60 |

## The radio tools: `casting.json`

The experimental radio commands read a separate file,
`$XDG_CONFIG_HOME/pablo/casting.json` (voice engines, model weights, the voice
library, pacing). `pablo doctor` shows what they found.
