# AGENTS.md

Guidance for AI agents working in this repository.

<!-- stamp:begin (managed by `stamp init` — do not edit between markers) -->

## Stamp-protected repository — agent instructions (READ THIS BEFORE ANY GIT COMMAND)

**You — the AI agent reading this — are required to use the stamp flow for any
change to this repository's protected branches (typically `main`).** Direct
`git commit` to `main` and direct `git push origin main` are explicit
violations of this repo's process, even though the remote will technically
accept them.

The remote does not reject unsigned pushes (this is local-only / advisory mode
— see "How enforcement works here" below). That means **enforcement is on you,
not the server**. Bypassing the stamp flow because "the push will succeed
anyway" is the most common failure mode and is exactly what this notice exists
to prevent.

### The required workflow for every change to a protected branch

```sh
git checkout -b feature
# ...edit, commit, repeat on the feature branch...

stamp review --diff main..feature       # all configured reviewers run in parallel
stamp status --diff main..feature       # exit 0 if every required reviewer approved

# When green:
git checkout main
stamp merge feature --into main         # signs an Ed25519 attestation into the merge trailer
git push origin main                    # plain git push — remote accepts anything,
                                        # but the merge commit now carries a verifiable signature
```

If a reviewer returns `changes_requested`, read its prose in the `stamp review`
output (or via `stamp log --reviews --limit 1`), fix on the feature branch,
commit, and re-review. Verdicts are bound to `(base_sha, head_sha)`, so a new
commit invalidates prior approvals.

### What you must NOT do

- **Do not** `git commit` directly to `main`. Always work on a feature branch.
- **Do not** `git push origin main` of a commit that wasn't produced by `stamp merge`.
- **Do not** use `--no-verify` to skip hooks.
- **Do not** edit `.stamp/config.yml` or `.stamp/reviewers/*.md` outside the stamp
  review/merge cycle. Those changes go through the same reviewer gate.
- **Do not** rationalize bypassing the gate because "this is local-only mode
  so it doesn't matter." The mode describes who enforces the gate
  (server vs. agent discipline), not whether the gate exists. **The gate exists.**

### The one exception: the bootstrap commit

When `stamp init` runs on a repo that doesn't have stamp installed yet, the
commit that ADDS `.stamp/` + `AGENTS.md` + `CLAUDE.md` is a chicken-and-egg
case — there is no prior trusted state to review against, so `stamp review`
has no meaningful base. That single commit is allowed to land directly on the
current branch. Recent versions of stamp-cli handle this commit automatically
inside `stamp init`; if you're working with an older version, make exactly
that one commit + push by hand and then go through the stamp flow for
everything afterward. **This exception is for the literal first stamp commit
only**, not for any subsequent change to `.stamp/` or any other code.

### How enforcement works here (and why you have to be the enforcer)

This repo's origin is a public forge (GitHub / GitLab / etc.) directly, not a
stamp server with a pre-receive hook. So:

- The remote will accept any push, including unsigned ones, force-pushes, and
  direct GitHub web-UI merges.
- The reviewer prompts and config in `.stamp/` are committed code-as-policy,
  not server-enforced rules.
- **The agent following these instructions is the gate.**

If the operator wants real server-side enforcement, they need to migrate to a
stamp server: deploy [stamp-cli's server image](./docs/quickstart-server.md),
repoint `origin` at it, configure GitHub as a downstream mirror with a Ruleset
locking direct pushes, and regenerate this guidance via
`stamp init --mode server-gated`. Until that happens, the rules above are
mandatory but unenforced — your job is to follow them anyway.

`stamp verify <sha>` works on any clone to validate a merge commit's
attestation, so the audit trail is preserved even without server-side rejection.

### Where things live

- `.stamp/config.yml` — branch rules (which reviewers are required, optional `required_checks`)
- `.stamp/reviewers/*.md` — reviewer prompt files
- `.stamp/trusted-keys/*.pub` — Ed25519 public keys (would be enforced by a server hook if one existed)
- `~/.stamp/keys/ed25519{,.pub}` — your local signing keypair

### Knowing when to stop the review loop (diminishing returns)

Each `stamp review` run is non-trivial — reviewer LLM calls, your context, and amend
churn to fix what they flag. After 2–3 rounds the value tapers. A useful pattern:

- **Round 1** catches structure (real bugs, missing rollback, wrong source of truth).
- **Round 2** catches consistency (code dup, conflicting defaults, broken back-compat).
- **Round 3** typically surfaces only stylistic polish (comma placement, comment
  wording, JSDoc rot — things no end user will ever notice).

**Heuristic:** if every reviewer's request includes phrases like "minor", "nit",
"not blocking", or "cosmetic", apply the fixes and re-run review **only because
verdicts are SHA-bound and need refreshing** — then merge. Don't iterate further looking
for more issues. By round 4 you're paying full LLM cost for marginal value, and reviewers
will sometimes invent new categories of nit just to fill the response.

Exception: if any reviewer returns `denied` (not `changes_requested`), the change has a
structural problem regardless of round number — keep iterating until the denial is
addressed or the design is reconsidered.

<!-- stamp:end -->
