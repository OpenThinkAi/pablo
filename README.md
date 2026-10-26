# pablo

**pablo is a CLI that writes.** It manages a writing project (a novel, a short story)
the way a build tool manages code: it knows the plan, your style guide, what has been
written and what comes next, and it refuses to draft anything whose plan is missing.
You talk about the book with whatever agent you already use (Claude Code, Codex, or
pablo's own); the agent drives pablo; pablo sends one carefully assembled prompt per
chapter to a model you choose, usually one running on your own machine.

```
$ pablo status --project lighthouse --for "chapter 1"
chapter 1: not ready
  bible/timeline.md has no row dated 1911 or earlier

$ pablo write --project lighthouse --chapter 1
wrote chapters/01-the-fall.md (333 words) on branch draft/ch01
```

Two rules shape everything:

1. **Prose comes only from `pablo write`.** The agent plans, researches and asks; it
   never drafts the book itself. pablo assembles the prompt from your style guide, the
   work's rules, the beat, the timeline and the continuity ledger, and you can see
   every slice of it with `--dry-run` before anything is sent.
2. **pablo enforces the plan.** A chapter needs a beat, a beat needs acts, acts need a
   premise, and the timeline must say what exists by the chapter's date. Ask for
   something whose plan is missing and pablo says exactly what is missing.

Your work stays yours: a vault of plain markdown in git. Every change pablo makes to
the manuscript lands on a branch you read and accept. No markup ever goes into a
chapter.

## Status

Early. pablo is built and used daily by one author on macOS, and is now open for
others to try. The novel workflow (plan, write, review, check, publish) is the solid
part. Expect rough edges, and please [open an issue](https://github.com/OpenThinkAi/pablo/issues)
when you hit one.

Also in the box, less mature: one-shot short stories (`pablo story`), a full-terminal
screen with review mode, reader rounds over GitHub (currently tied to one GitHub
organization), and an experimental radio-drama pipeline that needs Apple Silicon.

## Install

```sh
bun add -g @openthink/pablo         # needs Bun 1.1+ (https://bun.sh)
bun pm -g trust @openthink/ui-leaf  # lets the window helper install
```

You also need git and a model: any OpenAI-compatible server (LM Studio, Ollama,
llama.cpp, MLX) or an Anthropic API key.

## Documentation

- **[Getting started](docs/getting-started.md):** install, a model, a vault, and a
  first chapter in about fifteen minutes.
- **[Using pablo from an agent](docs/agents.md):** connect Claude Code or Codex over
  MCP, and the rules an agent should follow.
- **[The vault](docs/vault.md):** every file, the `pablo.json` marker, and what pablo
  checks before it drafts.
- **[Configuration](docs/configuration.md):** models, keys, routing, readers.
- **[Command reference](docs/commands.md):** every command and flag.
- **[Sharing with readers](docs/readers.md):** reading rounds, the reader's installer.

A starter vault to copy is in [`examples/starter-vault`](examples/starter-vault).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development, tests, and how changes land.

## License

MIT
