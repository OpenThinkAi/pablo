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

These are the rules pablo gives its own built-in agent; follow them and you will work
the way the tool expects.

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
   `pablo merge` or in the screen. `merge` is deliberately not an MCP tool.
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

`pablo mcp` serves 31 tools. The ones a writing session uses:

| Tool | Does |
|---|---|
| `resume` | Where the work stands and what is next. Call it first |
| `status` | The stages, or with `for`, whether one unit can be drafted |
| `timeline` | The bible's timeline as of a date |
| `save` | Write the premise, acts, beats or a bible file, validated and committed |
| `write` / `draft_chapter` / `draft_unit` | Draft one unit on the writer model; returns the branch and a receipt, never the prose |
| `revise_passage` | Revise a passage on the writer model; the result lands on a `revise/` branch for the author |
| `revise` | The same, but returns the candidate text instead of committing it |
| `check` | Tells, banned names and provenance gaps in the drafted text |
| `critique` | Comment on a change branch: continuity contradictions, things mentioned before their date, voice tells |
| `read` / `search` | Read a file in the work, or search it |
| `output` | List or add outputs (novel, story, radio) |
| `publish` | Compile the drafted text into one file |
| `voice_list` / `voice_show` / `voice_flag` / `voice_exemplar` / `voice_rule` | Inspect and grow the voice |
| `prose` | One-off copy in a named voice, outside any work |

The rest (`promote`, `migrate`, `bind`, and the radio tools `audition`, `cast`,
`voices`, `perform`, `mix`, `fix`, `describe_voice`) are covered in
[commands.md](commands.md). Each tool's own description says what it takes.

## The built-in agent

pablo also ships its own agent, Claude configured as pablo: its system prompt is the
rules above, the work's judgement policy and the work's `QWEN.md`, and its only tools
are pablo's plus web search. It uses your Claude Code login, or an Anthropic key from
your config (see [configuration.md](configuration.md#claude-for-pablo-agent-and-pablo-story)).

- `pablo agent --project <slug> "<message>"` runs one turn in the terminal and keeps
  the conversation for the next run (`--new` starts over).
- `a c` in the screen (bare `pablo`) opens the same conversation as a view.
- `pablo story "<prompt>"` runs the whole pipeline unattended, from premise to a
  published draft, accepting each step as it goes; `--review` stops at each branch
  for you instead.
