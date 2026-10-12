# Contributing

Issues and pull requests are welcome on [GitHub](https://github.com/OpenThinkAi/pablo).
Bug reports with the command you ran, its output, and `pablo --version` are the most
useful thing you can send.

## How changes land

The GitHub repository is a mirror. The canonical repository is gated by
[stamp](https://github.com/OpenThinkAi/stamp-cli): every change to `main` passes a set
of automated reviewers and the required checks, then is merged with a signed
attestation and pushed to the mirror. A pull request on GitHub is therefore never
merged with GitHub's button; when one is accepted, the maintainer lands it through
that gate.

`AGENTS.md` and `CLAUDE.md` describe that flow and the codebase for maintainers and
their agents.

## Develop

```sh
bun install
bun run typecheck
bun test
bun run pablo --help          # the CLI from source
```

The radio tools' Python side has its own tests, which need [uv](https://docs.astral.sh/uv/):

```sh
cd packages/casting && uv run --frozen pytest -q
```

Those three (typecheck, `bun test`, the Python tests) are the required checks.

The packages:

| Package | npm | What |
|---|---|---|
| `packages/cli` | `@openthink/pablo` | The `pablo` command, the MCP server and the built-in agent |
| `packages/core` | `@openthink/pablo-core` | The prompt assembler, provider adapters and document model; no dependencies, no terminal code |
| `packages/tui` | `@openthink/pablo-tui` | The full-terminal screen |
| `packages/casting` | (bundled into the cli) | The radio tools' Python side |

Tests never touch a real vault: they use the synthetic one in
`packages/cli/test/fixtures/vault`, or a temporary directory. Keep it that way; no
manuscript content belongs in this repository.

## Releasing

The three npm packages release together at one version.

1. Bump `version` in all three `packages/*/package.json` (they must match; the
   release fails otherwise) and run `bun install` so `bun.lock` records it.
   `pablo --version`, the MCP server's version and the agent's client id all read
   `packages/cli/package.json`. The casting package has its own version and is not
   bumped.
2. Land the bump on `main`.
3. Run the `release` workflow from the GitHub Actions tab (manual, `main` only). It
   typechecks and tests, then publishes core, tui and cli in that order with npm
   Trusted Publishing (OIDC, with provenance, no token), skipping any package whose
   version is already published. A pre-release version such as `0.3.0-rc.1` is
   published under the `rc` tag instead of `latest`. A `v<version>` tag also triggers
   it if tags are mirrored, and the tag must equal the version.

Each package needs this repository's `release.yml` set as its Trusted Publisher on
npmjs.com before its first automated publish.

Every release also gets a documentation pass: check README.md and `docs/` against
what the release actually does.
