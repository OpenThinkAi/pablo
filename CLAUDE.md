# pablo — agent guide

`pablo` is an AI-native terminal tool for writing and composition. **It is not a
text editor.** Selection is the only noun: you select a span of a manuscript and
tag it, prompt on it, or replace it, and the model's answer comes back as a
proposal you accept, reject, or edit in place.

**Invariant 1 — the model has no write tool. The model proposes; the app
applies.** Every accepted proposal is written to disk by the app and the view
re-renders from the file. The model never reports that it wrote anything,
because it cannot. Any design that hands a provider adapter, a tool schema, or a
model response the ability to write files is wrong, whatever it is called.

**The canonical design doc is
`~/saltline-digital-vault/projects/ai-terminal/README.md`** (vault project id
`ai-terminal`). It holds the interaction model, the CriticMarkup contract, the
context-pack requirements, the provider/routing decisions, the binding-decisions
table, and the P0/P1/P2 build order. Read it before any non-trivial change; this
file deliberately does not restate it. A change that contradicts a binding
decision there amends the doc in the same task or does not land.

Documents are the plain markdown files already in the `~/writing` vault. pablo
is a view over that vault, never a replacement for it, and never a second store.

## Layout

```
packages/core   @openthink/pablo-core — TTY-free. Document + span model, and
                (as P0 lands) the CriticMarkup parser, proposal type, provider
                adapters, and the map. No terminal dependency, ever.
packages/tui    @openthink/pablo — the opentui renderer and the `pablo` bin.
                Everything that touches a terminal lives here.
```

The core/tui split is load-bearing, not tidiness: the core is testable without a
TTY (which is where the proposal-format work runs), and a renderer swap later
touches nothing important. `packages/core/test/tty-free.test.ts` enforces it —
it walks `packages/core/src` and fails on any import matching
`opentui|node:tty|ink|blessed`, and on any dependency in core's manifest. If that
test fails, the code belongs in `packages/tui`.

## The context pack

`packages/core/src/pack` assembles every prompt pablo sends. Two rules that are
easy to break by accident:

- **Assembly is pure.** `assemblePack(kind, inputs)` reads no files, calls no
  model and asks no clock, so the same inputs give the same bytes and the same
  `sha256` hash. Disk lives in `pack/vault.ts`, which turns a vault into inputs;
  anything that needs I/O during assembly belongs there instead.
- **Nothing shrinks silently.** Over budget, the pack reports every truncation
  and every drop as a `SliceAdjustment` and marks the seam in the prompt.

**Receipts are written to `<vault>/.pablo/receipts.jsonl`** — the *writing*
vault's root, not this repo. That path must be in the vault's own `.gitignore`:
it is machine state, it grows without bound, and it is not part of the
manuscript. pablo never edits the vault's `.gitignore` itself, so a new vault
needs the line added by hand:

```
# in ~/writing/.gitignore
.pablo/
```

## Build commands

```sh
bun install            # workspace install; commit the resulting bun.lock
bun run typecheck      # tsc --noEmit across both packages (root tsconfig.json)
bun test               # all tests in both packages
bun run pablo          # run the CLI from source
```

Both `bun run typecheck` and `bun test` are `required_checks` in
`.stamp/config.yml`: `stamp merge` runs them against the merged tree and rolls
the merge back on a non-zero exit. There is no `build` step yet — both packages
ship TypeScript that Bun runs directly. Add a `build` check to
`.stamp/config.yml` the moment that stops being true.

The published manifest is `packages/tui/package.json` (`@openthink/pablo`); the
root `package.json` is a private workspace shell with no version. Nothing is
published yet.

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
