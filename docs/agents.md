# Using pablo from an agent

pablo is built to be driven by the coding agent you already use: Claude Code, Codex,
or anything else that speaks MCP or can run shell commands. You talk to the agent
about the book; the agent asks pablo where things stand, saves the plan you agree
on, and has pablo write the prose.

> **If you are an AI agent setting pablo up for someone:** follow
> [getting-started.md](getting-started.md) for the install, model and vault, then
> connect pablo as below. `CLAUDE.md` and `AGENTS.md` in this repository are for
> agents *developing* pablo; you can ignore them.

## Connect it

`pablo mcp` is a stdio MCP server. It finds the vault the same way the CLI does, so
either start your agent inside the vault or set `PABLO_VAULT`.

**Claude Code.** Put this in `.mcp.json` at the root of your vault and start
`claude` there:

```json
{
  "mcpServers": {
    "pablo": { "command": "pablo", "args": ["mcp"] }
  }
}
```

**Codex.** In `~/.codex/config.toml`:

```toml
[mcp_servers.pablo]
command = "pablo"
args = ["mcp"]
env = { PABLO_VAULT = "/Users/you/writing" }
```

**Any other agent.** Every command takes `--json` and prints one JSON object. Exit
code `0` is success, `2` is a refusal whose body lists what is `missing`, `1` is an
error. That is the whole contract.

## How to drive it

These are the rules pablo gives its own built-in agent. `pablo mcp` also sends them
to your agent as the server's instructions when it connects, so an MCP client gets
them without reading this page.

0. **Call `guide` first.** `pablo guide` (the `guide` tool) lists the tracks and
   outputs; with a track and an output it returns the path from creating the work
   to publishing it, with the command for each step. See [guide](commands.md#guide).
1. **Start with `resume`.** It returns where the work stands: the core's stages,
   each output's progress, branches waiting for review, open decisions, and `next`.
2. **Never write the book's prose yourself.** Plan, research, decide and ask in the
   conversation; every sentence of prose comes from `write` (or `revise`), which
   sends one prompt to the configured writer model. Don't paste prose into `save`.
3. **Save planning through pablo.** When you and the author agree on a premise, acts,
   beats or a bible file, call `save` so it lands where the framework reads it and is
   committed. Over MCP, `save` takes the content in `file`.
4. **Treat refusals as directions.** A `write` or `status --for` that comes back
   `{ok: false, missing: [...]}` is telling you what to plan next. Steer the author
   there; don't work around it.
5. **Leave acceptance to the author.** Every change lands on a branch (`draft/`,
   `revise/`, `plan/`). Tell the author what is waiting; they accept it with
   `pablo merge` or in the screen. The `merge` tool is for when the author has
   read the branch and tells your agent to accept it, never on the agent's own call.
6. **Ask about the author's calls, assume the rest.** Plot direction, a character's
   fate or motive, and any open `[pick]` are theirs. For everything else proceed with
   a stated assumption, and batch your questions.
7. **Tag facts.** When you record a fact, say whether it was `researched` (with the
   source), `invented`, or decided by the `author`.

A typical session:

```
you:    pick up The Lighthouse
agent:  resume → "chapter 2 is next; its beat has no POV yet"
you:    Ada again. The inspector should almost catch her.
agent:  save beats (updated row 2) → status --for "chapter 2" → ready
agent:  write chapter 2 → "draft/ch02 is waiting: 340 words, check found nothing"
you:    (reads it, then) pablo merge --project lighthouse draft/ch02
```

## The tools

`pablo mcp` serves about thirty tools; your agent's tool list shows the current set. The ones a writing session uses:

| Tool | Does |
|---|---|
| `resume` | Where the work stands and what is next. Call it first |
| `status` | The stages, or with `for`, whether one unit can be drafted |
| `timeline` | The bible's timeline as of a date |
| `save` | Write the premise, acts, beats or a bible file, validated and committed |
| `write` (`draft_chapter`, `draft_unit` are deprecated aliases, removed next release) | Draft one unit on the writer model; returns the branch and a receipt, never the prose |
| `revise` (`revise_passage` is a deprecated alias for `revise` with `branch`, removed next release) | Revise a passage on the writer model; with `branch` the result lands on a `revise/` branch for the author |
| `revise` | The same, but returns the candidate text instead of committing it |
| `check` | Tells, banned names and provenance gaps in the drafted text |
| `critique` | Comment on a change branch: continuity contradictions, things mentioned before their date, voice tells |
| `read` / `search` | Read a file in the work, or search it |
| `web_search` / `web_fetch` | Search the web through pablo's configured backend (SearXNG; set `web.search` in the config, see `docs/configuration.md`), and read one page as markdown with its URL and retrieval date. pablo's own tools: an agent does not need its own WebSearch/WebFetch, and `web_search` fails with a clear message when no backend is set |
| `init` | Start a new work: a slug, a title, and a track (core only) or the novel output |
| `story` | Write a whole story from a prompt, end to end (or resume a run with `project`) |
| `output` / `output_add` | List, remove or re-plan outputs / add one (novel, story, screenplay, radio) once the core is at beats |
| `merge` | Accept a draft branch onto main, when the author says so |
| `publish` | Compile the drafted text into one file |
| `voice_list` / `voice_show` / `voice_flag` / `voice_exemplar` / `voice_rule` / `voice_edit` / `voice_remove` / `voice_use` | Inspect and grow the voice: list rules with ids, add, edit or remove one, add a named voice to a work |
| `prose` | One-off copy in a named voice, outside any work |

The rest (`promote`, `migrate`, `bind`, and the radio tools `audition`, `cast`,
`voices`, `perform`, `mix`, `fix`, `describe_voice`) are covered in
[commands.md](commands.md). Each tool's own description says what it takes.

## The built-in agent

pablo also ships its own agent: its own tool loop on the model the `agent` intent goes
to (Claude, or any OpenAI-compatible model with tool calls), configured as pablo. Its
system prompt is the rules above, the work's judgement policy and the work's
`STYLE.md`, and its only tools are pablo's (see
[configuration.md](configuration.md#the-model-behind-pablo-agent-and-pablo-story)).
`critique` and `check --across` run on the `check` intent and `pablo agent --tag-facts`
on `plan`; no model call goes through a Claude Code login or `claude -p`.

- `pablo agent --project <slug> "<message>"` runs one conversation in the terminal.
- `a c` in the screen (bare `pablo`) opens the same conversation as a view.
- `pablo story "<prompt>"` runs the whole pipeline unattended, from premise to a
  published draft, accepting each step as it goes; `--review` stops at each branch
  for you instead.
