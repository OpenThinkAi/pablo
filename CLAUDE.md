# pablo — agent guide

**pablo is a CLI that writes. It is not an app and has no screen.** The
conversation about a book happens in whatever agent Matt already likes (Claude
Code, Codex, pi); that agent drives pablo over the shell or `pablo mcp`. pablo
is the *manager* of the writing project: it knows the vault, the framework a
format follows, the author's voice, version control, and publishing, and hands
any agent a structured way in and out.

Two invariants:

1. **Prose is produced only through `pablo write`, on the configured local
   model.** The agent plans and discusses; it never drafts prose itself and
   never sends prose through its own context. pablo assembles the prompt,
   sends it to the configured writer (Gemma 4 for Matt, by default), writes
   the file, and returns a receipt.
2. **pablo enforces the framework.** A format is a stage machine (a chapter
   needs a beat, a beat needs acts, acts need a bible). A verb whose
   precondition is unmet is refused, naming exactly what is missing, so the
   agent can steer the author there instead of guessing.

**The canonical design doc is
`~/saltline-digital-vault/projects/ai-terminal/README.md`** (vault project id
`ai-terminal`). It holds the session model, the project layout, the full
verb table, the stage machines, the voice model, and the binding-decisions
table. Read it before any non-trivial change; this file deliberately does not
restate it. A change that contradicts a binding decision there amends the doc
in the same task or does not land.

Documents are the plain markdown files already in the `~/writing` vault. pablo
is a manager over that vault, never a replacement for it, and never a second
store.

**No markup, ever.** CriticMarkup and any other inline shorthand were
eliminated 2026-09-06. A chapter file is plain prose with frontmatter; edits
are a view (`pablo edit`, a ui-leaf surface), not a notation in the file.

## Layout

```
packages/core   @openthink/pablo-core — TTY-free, dependency-free. The
                document model, the markup module (used by the provider
                adapters' streaming/normalization path, not by any manuscript
                — no CriticMarkup is ever written to a vault file), the
                context-pack assembler, and the provider adapters
                (OpenAI-compatible, Anthropic).
packages/cli    @openthink/pablo — the `pablo` bin: argument parsing, verb
                dispatch, `--project` resolution, and (later) `pablo mcp`.
                Any new dependency the CLI needs goes here; core stays
                dependency-free.
```

`packages/core/test/tty-free.test.ts` enforces the split — it walks
`packages/core/src` and fails on any terminal import (`opentui`, `node:tty`,
`ink`, `blessed`) or on any dependency at all in core's manifest. There is no
terminal renderer in this repo any more; `packages/tui` (the opentui-based
screen) was retired 2026-09-06 along with the CriticMarkup/selection design it
implemented. See the design doc's `History` section for what carried over as
material (the pack assembler, the vault reader, the provider adapters, the
config loader) versus what was cut outright (the screen, the CriticMarkup
parser and renderer, span verbs, the review queue).

## The project

A **project is a vault directory** under `<vault>/novels|stories|essays/<slug>`,
with the writing vault's existing layout (`style/`, `bible/`, `outline/`,
`chapters/`, ...). `--project <slug>` resolves it: the vault is `PABLO_VAULT`
if set, else the nearest ancestor of the current directory holding a `style/`
directory. An unresolvable project is a refusal, exit code 2, naming every
path it tried — see `packages/cli/src/project.ts`.

pablo state that is not a document (last run, receipts, rates, share links)
lives in `<work>/.pablo/`, gitignored. Everything the author would want to
read is a markdown file in the vault, tracked by git.

## Verbs and exit codes

Every verb accepts `--project <slug>` and `--json`. Exit codes are the
contract every ticket builds on: **0** success, **2** refused (a framework
precondition — an unresolvable project, or later an unmet stage
precondition), **1** error (including "not implemented yet" for a verb whose
body has not landed). See the design doc's `Commands` table for what each verb
does and returns; `pablo --help` lists the P0 set.

## Build commands

```sh
bun install            # workspace install; commit the resulting bun.lock
bun run typecheck      # tsc --noEmit across packages/core and packages/cli
bun test               # all tests, both packages
bun run pablo          # run the CLI from source (bun run packages/cli/src/cli.ts)
```

Both `bun run typecheck` and `bun test` are `required_checks` in
`.stamp/config.yml`: `stamp merge` runs them against the merged tree and rolls
the merge back on a non-zero exit. There is no `build` step yet — the package
ships TypeScript that Bun runs directly. Add a `build` check to
`.stamp/config.yml` the moment that stops being true.

The published manifest is `packages/cli/package.json` (`@openthink/pablo`);
the root `package.json` is a private workspace shell with no version. Nothing
is published yet.

## Conventions

- **Git from code**: always `git -C <dir> add -- <paths>` and
  `git -C <dir> commit -m <msg> -- <paths>`, never `git add -A`. A git failure
  is a returned notice, never a thrown exception — a write to the vault that
  already landed on disk is never undone by git failing afterward.
- **Never write into `~/writing` from tests or from this repo's own tooling.**
  Tests exercise a synthetic fixture vault (`packages/core/test/fixtures/vault`,
  copied under `packages/cli/test/fixtures/`) with invented content — the real
  vault is private, this repo's GitHub mirror is public, and no manuscript
  content belongs in it. Anything that needs a throwaway vault on disk makes
  one in a temp directory and cleans it up.

## Stamp governance

The repo is **stamp-governed**, the same shape as `ui-leaf`: the canonical bare
repo lives on the Railway-hosted stamp server (`origin`), and GitHub
(`OpenThinkAi/pablo`, `github`) is a downstream mirror driven by the server's
post-receive hook via `.stamp/mirror.yml`.

- All merges to `main` go through `stamp review` then `stamp merge`, then
  `stamp push main`.
- **Never `git push github`.** The mirror is push-only from the server, and a
  direct push diverges it from `origin`. The GitHub Ruleset rejects it anyway.
- `.stamp/trusted-keys/` holds both of Matt's signing keys (personal and work),
  so a merge signed from either account verifies.

See [`AGENTS.md`](./AGENTS.md) for the full flow and the recovery paths.

<!-- stamp:begin (managed by `stamp init` — do not edit between markers) -->

## Stamp-protected repository — read AGENTS.md before any git operation

This repository is gated by [stamp-cli](https://github.com/OpenThinkAi/stamp-cli).
**Do not `git commit` directly to protected branches** (typically `main`)
**and do not `git push origin main`** of any commit you didn't produce via
`stamp merge`. The required flow is:

```sh
git checkout -b feature
# ... edit, commit on the feature branch ...
stamp review --diff main..feature       # all reviewers run in parallel
stamp status --diff main..feature       # gate check (exit 0 = open)
git checkout main
stamp merge feature --into main         # signs the merge
git push origin main                    # OR `stamp push main` if origin is a stamp server
```

Key commands: `stamp provision` — provision a new repo; `stamp review` — run reviewers; `stamp merge` — sign a merge; `stamp push` — push to a stamp server.

**The full reference is at [`AGENTS.md`](./AGENTS.md) at the repo root** —
read it before any git command. It covers the mode (server-gated vs.
local-only), what NOT to do, where things live, and how to recover when stamp
blocks you.

**One exception:** the very first commit that ADDS `.stamp/` + `AGENTS.md` +
`CLAUDE.md` to a fresh repo is allowed to land directly on the current branch
(there's nothing to review against). Recent `stamp init` runs do this commit
automatically. Every subsequent change goes through the stamp flow.

<!-- stamp:end -->

# Iterative Learning

Before non-trivial work in this repo, read what earlier agents left:

```
think brief --cortex pablo
```

When you discover a convention, invariant, prior decision, or gotcha worth
knowing next time:

```
think retro "<observation>" --cortex pablo
```
