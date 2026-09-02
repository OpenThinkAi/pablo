/**
 * Where a provider's API key comes from. Two forms, and no third:
 *
 * - the environment, by convention: `<PROVIDER>_API_KEY` (`ANTHROPIC_API_KEY`);
 * - the macOS Keychain, named in the config file as
 *   `"key": "keychain:<service>[/<account>]"`.
 *
 * A key written into the config file is rejected at load. Resolved keys are
 * returned to the adapter that sends them and are never logged, put in an
 * error message, or written back out.
 */

import { ProviderConfigError } from "./errors";

export type KeySource =
  | { readonly from: "env"; readonly variable: string }
  | { readonly from: "keychain"; readonly service: string; readonly account: string | undefined };

const KEYCHAIN_PREFIX = "keychain:";

/** `local` becomes `LOCAL_API_KEY`, `anthropic` becomes `ANTHROPIC_API_KEY`. */
export function envVariableFor(providerId: string): string {
  return `${providerId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_API_KEY`;
}

/**
 * The key source for a provider: the `keychain:` reference from its config
 * entry, or the environment variable its id implies.
 */
export function keySourceFor(providerId: string, configured?: string, where = "the config file"): KeySource {
  if (configured === undefined) return { from: "env", variable: envVariableFor(providerId) };
  if (!configured.startsWith(KEYCHAIN_PREFIX)) {
    throw new ProviderConfigError(
      `pablo: ${where}: "key" must not hold the key itself. Either set the ${envVariableFor(providerId)} ` +
        `environment variable and drop "key", or point at the Keychain: "key": "keychain:<service>[/<account>]".`,
    );
  }
  const reference = configured.slice(KEYCHAIN_PREFIX.length);
  const separator = reference.indexOf("/");
  const service = separator === -1 ? reference : reference.slice(0, separator);
  const account = separator === -1 ? undefined : reference.slice(separator + 1);
  if (service === "" || account === "") {
    throw new ProviderConfigError(
      `pablo: ${where}: "key" must read "keychain:<service>" or "keychain:<service>/<account>", not "${configured}".`,
    );
  }
  return { from: "keychain", service, account };
}

/** Reads a generic password out of the login Keychain. Arguments are passed as an array; no shell. */
export function readKeychain(service: string, account: string | undefined): string {
  const cmd = ["security", "find-generic-password", "-s", service];
  if (account !== undefined) cmd.push("-a", account);
  cmd.push("-w");

  const result = Bun.spawnSync({ cmd, stdout: "pipe", stderr: "pipe" });
  const key = result.stdout.toString().trim();
  if (result.exitCode !== 0 || key === "") {
    const named = account === undefined ? `service "${service}"` : `service "${service}", account "${account}"`;
    throw new ProviderConfigError(
      `pablo: no Keychain item for ${named} (security exited ${result.exitCode}). ` +
        `Add it, or point "key" at an item that exists.`,
    );
  }
  return key;
}

export interface KeyLookup {
  readonly env: Record<string, string | undefined>;
  readonly keychain: (service: string, account: string | undefined) => string;
}

/**
 * Resolves a key, or returns undefined when the environment has none — a local
 * endpoint needs no key and must not be blocked by asking for one.
 */
export function resolveKey(source: KeySource, lookup: Partial<KeyLookup> = {}): string | undefined {
  if (source.from === "env") return (lookup.env ?? process.env)[source.variable] || undefined;
  return (lookup.keychain ?? readKeychain)(source.service, source.account);
}
