# Changelog

Notable changes per release of `@openthink/pablo`, `@openthink/pablo-core` and
`@openthink/pablo-tui` (they release together at one version). The newest is first.

## Unreleased

### Breaking

- **A work's `pablo.json` may no longer set `key` on any provider** (not even an
  `env:<NAME>` or `keychain:...` reference). Every command refuses such a work, naming
  the provider, until `key` is removed. Keys are set only in the global
  `~/.config/pablo/config.json`: declare the provider there with its `endpoint` and
  `key` (`pablo config set providers.<id>.key env:<NAME>`, without `--project`), and
  override only its `model` from `pablo.json`.
- **A provider a work's `pablo.json` adds has no key**, not even the `<ID>_API_KEY`
  convention. **Neither does a global provider whose `endpoint`, `kind` or `local` the
  work changes**, even to another port on this machine: the global key stays with the
  global endpoint. A non-local provider left without a key is skipped, and the stderr
  notice says how to give it one. Changing only `model`, `timeoutMs`, `temperature`,
  `thinking` or `tools` keeps the key.

### Changed

- `@openthink/ui-leaf` is pinned to an exact version (`1.6.0`), so `bun pm -g trust
  @openthink/ui-leaf` covers only the ui-leaf a pablo release names. The trust step is
  now documented as optional (only `read`, `review` and `mixer` need it).
- The release workflow packs the tarballs in an unprivileged job and publishes them
  from a job that checks out and installs nothing, in the `npm-release` environment.
- Docs: `docs/configuration.md` gains "What leaves your machine" (each destination,
  what it is sent, and the local copies under `.pablo/`); `neverSend` is described as
  what it is, a guard on drafting packs; `docs/commands.md` says how the radio side's
  packages and weights are pinned.
