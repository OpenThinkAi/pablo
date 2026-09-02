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
import { ProviderConfigError } from "./errors";
import type { KeyLookup } from "./keys";
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
  /** The provider an intent routes to, before any adapter is built. */
  route(intent: Intent): string;
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
}

/**
 * Where an intent goes: an explicit mapping in the config wins; otherwise
 * planning takes the first cloud provider and drafting, revising and
 * extraction take the first local one. Either falls back to the default, so a
 * config with only local providers routes everything there.
 */
export function route(config: PabloConfig, intent: Intent): string {
  const mapped = config.intents.get(intent.name);
  if (mapped !== undefined) return mapped;

  const wantLocal = intent.kind !== "planning";
  for (const provider of config.providers.values()) {
    if (provider.local === wantLocal) return provider.id;
  }
  return config.defaultProvider;
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
    let resolved: string | undefined;
    let looked = false;

    const built = ADAPTERS[provider.kind]({
      provider,
      meter: meterFor(provider),
      gate: gateFor(provider),
      key: () => {
        if (!looked) {
          resolved = resolveKey(provider.key, options.keys);
          looked = true;
        }
        return resolved;
      },
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    adapters.set(id, built);
    return built;
  };

  return {
    ids: [...config.providers.keys()],
    route: (intent) => route(config, intent),
    adapter,
    adapterFor: (intent) => adapter(route(config, intent)),
    rates: (id) => meterFor(configFor(id)).rates(),
  };
}
