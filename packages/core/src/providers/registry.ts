/**
 * The set of configured providers, and which one an intent goes to.
 *
 * Gates and rate meters are keyed by endpoint, not by provider id: two config
 * entries pointing at the same local server share one queue and one measured
 * rate. Adding a provider kind (the Anthropic adapter) is an entry in
 * `ADAPTERS` and nothing else — the routing and queueing above it are
 * provider-neutral.
 */

import { createAnthropicAdapter } from "./anthropic";
import type { AdapterKind, PabloConfig, ProviderConfig } from "./config";
import { NoModelConfiguredError, ProviderConfigError } from "./errors";
import type { KeyLookup, KeySource } from "./keys";
import { resolveKey } from "./keys";
import type { OpenAiAdapterOptions } from "./openai";
import { createOpenAiAdapter } from "./openai";
import { Gate } from "./queue";
import type { EndpointRates } from "./rates";
import { RateMeter } from "./rates";
import type { Adapter, Intent } from "./types";

/** Every adapter factory takes the same options; the registry only needs that shape. */
type AdapterFactory = (options: OpenAiAdapterOptions) => Adapter;

const ADAPTERS: Record<AdapterKind, AdapterFactory> = {
  "openai-compatible": createOpenAiAdapter,
  anthropic: createAnthropicAdapter,
};

export interface Providers {
  readonly ids: readonly string[];
  /** The provider an intent routes to, before any adapter is built; skips (and says so) a provider whose key does not resolve. */
  route(intent: Intent): string;
  /** `route`, with the providers it passed over. */
  routed(intent: Intent): Routed;
  adapter(id: string): Adapter;
  adapterFor(intent: Intent): Adapter;
  /** What this provider's endpoint has been measured doing, for wait estimates. */
  rates(id: string): EndpointRates;
}

export interface ProvidersOptions {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Injected in tests so no test reads the real environment or Keychain. */
  readonly keys?: Partial<KeyLookup>;
  /**
   * Told once per intent and provider when `route` passes over a provider whose
   * key does not resolve. The default writes one line to stderr.
   */
  readonly onSkip?: (skipped: SkippedProvider, fellBackTo: string) => void;
}

/** The default skip notice: which provider was passed over, why, and where the intent went instead. */
export function skipNotice(skipped: SkippedProvider, fellBackTo: string): string {
  return (
    `pablo: skipped provider "${skipped.provider}" for the "${skipped.intent}" intent (${skipped.reason}); ` +
    `using "${fellBackTo}" instead. Set the key (docs/configuration.md) to use it.`
  );
}

/** A provider route() passed over because its key does not resolve. */
export interface SkippedProvider {
  readonly provider: string;
  readonly intent: string;
  /** Why, in words, without the key: "ANTHROPIC_API_KEY is not set". */
  readonly reason: string;
}

/** Where an intent went, and every provider passed over to get there. */
export interface Routed {
  readonly provider: string;
  readonly skipped: readonly SkippedProvider[];
}

/** Returns why a provider cannot be used right now, or undefined when it can. */
export type Unusable = (provider: ProviderConfig) => string | undefined;

/**
 * Where an intent goes, in order: the config's explicit mapping, then the first
 * provider of the kind's locality (planning wants a cloud one, everything else
 * a local one), then the default. A candidate `unusable` rejects is skipped and
 * recorded; when every candidate is rejected the first one is returned anyway,
 * so the adapter reports the real problem at request time instead of routing
 * to nothing. Without `unusable` nothing is skipped.
 */
export function resolveRoute(config: PabloConfig, intent: Intent, unusable?: Unusable): Routed {
  const candidates: string[] = [];
  const mapped = config.intents.get(intent.name);
  if (mapped !== undefined) candidates.push(mapped);
  const wantLocal = intent.kind !== "planning";
  for (const provider of config.providers.values()) {
    if (provider.local === wantLocal) candidates.push(provider.id);
  }
  if (config.defaultProvider !== "") candidates.push(config.defaultProvider);
  if (candidates.length === 0) throw new NoModelConfiguredError(intent.name);

  const skipped: SkippedProvider[] = [];
  const tried = new Set<string>();
  for (const id of candidates) {
    if (tried.has(id)) continue;
    tried.add(id);
    const provider = config.providers.get(id);
    const reason = unusable === undefined || provider === undefined ? undefined : unusable(provider);
    if (reason === undefined) return { provider: id, skipped };
    skipped.push({ provider: id, intent: intent.name, reason });
  }
  return { provider: candidates[0] as string, skipped: [] };
}

/** The provider an intent routes to by configuration alone, with no key check. */
export function route(config: PabloConfig, intent: Intent): string {
  return resolveRoute(config, intent).provider;
}

export function createProviders(config: PabloConfig, options: ProvidersOptions = {}): Providers {
  const gates = new Map<string, Gate>();
  const meters = new Map<string, RateMeter>();
  const adapters = new Map<string, Adapter>();

  const meterFor = (provider: ProviderConfig): RateMeter => {
    const existing = meters.get(provider.endpoint);
    if (existing) return existing;
    const meter = new RateMeter();
    meters.set(provider.endpoint, meter);
    return meter;
  };

  const gateFor = (provider: ProviderConfig): Gate | undefined => {
    if (!provider.local) return undefined;
    const existing = gates.get(provider.endpoint);
    if (existing) return existing;
    const gate = new Gate();
    gates.set(provider.endpoint, gate);
    return gate;
  };

  // One key lookup per provider: the Keychain is a subprocess, and route() asks before the adapter does.
  interface Lookup {
    readonly value: string | undefined;
    readonly problem: string | undefined;
    readonly error?: Error;
  }
  const keys = new Map<string, Lookup>();
  const lookup = (provider: ProviderConfig): Lookup => {
    const known = keys.get(provider.id);
    if (known) return known;
    let found: Lookup;
    try {
      const value = resolveKey(provider.key, options.keys);
      found = { value, problem: value === undefined ? describeMissing(provider.key) : undefined };
    } catch (error) {
      found = { value: undefined, problem: (error as Error).message.replace(/^pablo: /, ""), error: error as Error };
    }
    keys.set(provider.id, found);
    return found;
  };
  const keyOf = (provider: ProviderConfig): string | undefined => {
    const found = lookup(provider);
    // A Keychain item that is missing is an error for the caller that sends the request, as before.
    if (found.error !== undefined) throw found.error;
    return found.value;
  };
  // A local provider needs no key; any other is unusable without one.
  const unusable: Unusable = (provider) => (provider.local ? undefined : lookup(provider).problem);
  const told = new Set<string>();

  const configFor = (id: string): ProviderConfig => {
    const provider = config.providers.get(id);
    if (!provider) {
      throw new ProviderConfigError(
        `pablo: no provider called "${id}" — configured providers are ${[...config.providers.keys()].join(", ")}`,
      );
    }
    return provider;
  };

  const adapter = (id: string): Adapter => {
    const existing = adapters.get(id);
    if (existing) return existing;

    const provider = configFor(id);

    const built = ADAPTERS[provider.kind]({
      provider,
      meter: meterFor(provider),
      gate: gateFor(provider),
      key: () => keyOf(provider),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    adapters.set(id, built);
    return built;
  };

  const routed = (intent: Intent): Routed => {
    const result = resolveRoute(config, intent, unusable);
    for (const skip of result.skipped) {
      const id = `${skip.intent}\0${skip.provider}`;
      if (told.has(id)) continue;
      told.add(id);
      (options.onSkip ?? ((s, to) => void process.stderr.write(`${skipNotice(s, to)}\n`)))(skip, result.provider);
    }
    return result;
  };

  return {
    ids: [...config.providers.keys()],
    route: (intent) => routed(intent).provider,
    routed,
    adapter,
    adapterFor: (intent) => adapter(routed(intent).provider),
    rates: (id) => meterFor(configFor(id)).rates(),
  };
}

function describeMissing(source: KeySource): string {
  if (source.from === "none") return "it has no key (a provider a work's pablo.json defines never does)";
  return source.from === "env" ? `${source.variable} is not set` : `no Keychain item for "${source.service}"`;
}
