# pablo

**pablo is a CLI that writes.** It is not an app and has no screen. The conversation
about a book happens in whatever agent you already like (Claude Code, Codex, pi);
that agent drives pablo over the shell or `pablo mcp`. pablo is the *manager* of the
writing project: it knows the vault, the framework a format follows, the author's
voice, version control, and publishing, and hands any agent a structured way in and
out so it is competent on the project in one call.

Two invariants:

1. **Prose is produced only through `pablo write`, on the configured local model.**
   The agent plans and decides; it never drafts prose itself.
2. **pablo enforces the framework.** A chapter needs a beat, a beat needs acts, acts
   need a bible. Ask for something whose preconditions are unmet and pablo says
   exactly which one is missing.

No markup, ever — a chapter file is plain prose with frontmatter; edits are a view,
not a notation.

Canonical design doc (session model, project layout, stage machines, voice model,
binding decisions): `~/saltline-digital-vault/projects/ai-terminal/README.md`
(vault project id `ai-terminal`).

## Status

P0 in progress: the repo reshape and CLI skeleton landed 2026-09-06. `packages/tui`
(the earlier terminal-renderer design) is retired; see `CLAUDE.md`'s `Layout` section
and the design doc's `History` for what carried over.

## Install / run

```sh
bun install
bun run typecheck
bun test
bun run pablo --help          # or: bun run packages/cli/src/cli.ts --help
```

`pablo` is `packages/cli` (`@openthink/pablo`), which depends on
`packages/core` (`@openthink/pablo-core`) — a TTY-free, dependency-free library:
the document model, the markup module the provider adapters use for
normalization, the context-pack assembler, and the OpenAI-compatible and
Anthropic adapters.

## Commands

Every verb accepts `--project <slug>` and `--json`. `--project` resolves to
`<vault>/<kind>/<slug>` (kind: `novels`, `stories`, `essays`); the vault is
`PABLO_VAULT` if set, else the nearest ancestor of the current directory holding a
`style/` directory. Exit codes: `0` ok, `2` refused (a framework precondition,
including an unresolvable project), `1` error.

| Command | Does | Returns |
|---|---|---|
| `pablo init <format> <slug> "<Title>"` | scaffold from the format's template, write the marker, commit | the project summary |
| `pablo resume --project <slug>` | the structured summary: stage per part, last event, open decisions, next step | `{format, stages, last, open, next}` |
| `pablo status --project <slug> [--for chapter 3]` | the same, or the preconditions for one target and which are unmet | `{ready, missing[]}` |
| `pablo write --project <slug> --chapter N [--words W] [--scenes S] [--variants V]` | the prose call: check, pack, send, write, rituals | `{path, receipt, rituals[]}` or `{refused, missing[]}` |
| `pablo save --project <slug> --stage acts\|outline\|bible/... < file` | the agent's planning output saved through pablo so the framework sees it | `{path, stage}` |
| `pablo check --project <slug> [--file F]` | the tells check and provenance check on prose | `{tells[], unprovenanced[]}` |
| `pablo dry-run ...` | any write or revise, assembled and priced, nothing sent | the pack, slice by slice |
| `pablo mcp` | serve all of the above as MCP tools, same schemas | |
| *later* `revise`, `voice`, `edit`, `share`, `notes`, `publish` | P1/P2 — the voice loop, local editing, sharing, publishing | |

Everything past the skeleton (parsing, `--help`, `--project` resolution) is a stub
today: each verb prints "not implemented yet" and exits 1. See the design doc's
`Commands` table for the full return shapes and the `Build order` section for what
ships next.

## Project layout

A project is a vault directory:

```
<vault>/
  style/               the shared voice: prose.md, anti-tells.md
  novels/<slug>/
    pablo.json         the project marker
    bible/, outline/, chapters/, continuity.md, notes/, research/, feedback/
  stories/<slug>/
  essays/<slug>/
```

Full layout and the `pablo.json` shape are in the design doc's `The project`
section. pablo state that is not a document (receipts, share links) lives in
`<work>/.pablo/`, gitignored — everything an author would want to read is
markdown in the vault, tracked by git.

## Contributing

Read `CLAUDE.md` and `AGENTS.md` before any change — this repo is stamp-governed
(`stamp review` → `stamp merge` → `stamp push`), and `CLAUDE.md`'s conventions
section covers the git-from-code rule and the fixture-vault-only rule for tests.
