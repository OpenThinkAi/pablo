/**
 * Which provider a harness session runs on (AGT-2121, decision D-12). The
 * session is pablo's own agent loop (`loop.ts`) over a provider's `chat()`,
 * so there is no Claude Code process to authenticate: the provider is chosen
 * the way every other model call's is, by routing an intent through pablo's
 * config (`createProviders(config).route`), and its key resolves the way every
 * provider's does (an env variable or a `keychain:` reference, never the
 * config file). A config with an Anthropic provider sends the session to
 * Claude through the native adapter; a `claude-code` provider (AGT-2281) runs
 * each turn as `claude -p` on the author's Claude login, with pablo's tools
 * through the loop's text protocol; a config with only the local writer runs
 * it on the local model.
 *
 * `agent` is the intent's name, so `"intents": { "agent": "<provider>" }` in
 * the config picks the provider; unmapped, it routes as planning does (the
 * first cloud provider, else the default).
 */

import { createProviders } from "@openthink/pablo-core";
import type { Adapter, Intent, PabloConfig, ProvidersOptions, SkippedProvider } from "@openthink/pablo-core";
import { keyReference } from "../config-verb";

/** The intent the agent loop's calls carry. */
export const AGENT_INTENT: Intent = { name: "agent", kind: "planning" };

export interface HarnessProvider {
  /** The provider the loop calls `chat()` on. */
  readonly adapter: Adapter;
  /** A local provider: its turns cost nothing. */
  readonly local: boolean;
  /** Where the key comes from, as the config names it (`env:ANTHROPIC_API_KEY`, `keychain:…`, `none`, `claude-login`): a source label, never the key. */
  readonly credential: string;
  /**
   * Whether the provider honours a forced `tool_choice` (`required` or a named
   * tool). Anthropic's newest models answer a forced choice with HTTP 400, so
   * on an Anthropic provider the loop steers from the prompt instead.
   */
  readonly forcedToolChoice: boolean;
  /** Providers the route passed over for want of a key (already announced on stderr by the registry). */
  readonly skipped: readonly SkippedProvider[];
}

/**
 * The provider an intent routes to, for a harness session: `agent` by default (AGT-2121), `research` or `plan`
 * for the story stages that run on those (AGT-2127). Throws the registry's error when the routed provider is not configured.
 */
export function harnessProvider(config: PabloConfig, options: ProvidersOptions = {}, intent: Intent = AGENT_INTENT): HarnessProvider {
  const providers = createProviders(config, options);
  const { provider: id, skipped } = providers.routed(intent);
  // `adapter(id)` throws the registry's error for an id the config lacks, so past it the entry exists.
  const adapter = providers.adapter(id);
  const provider = config.providers.get(id)!;
  return {
    adapter,
    local: provider.local,
    credential: provider.local ? "none" : keyReference(provider),
    forcedToolChoice: provider.kind !== "anthropic",
    skipped,
  };
}

/** A provider around an adapter the caller already has (a test's scripted adapter, an injected one). */
export function adapterProvider(adapter: Adapter, over: Partial<Omit<HarnessProvider, "adapter">> = {}): HarnessProvider {
  return { adapter, local: false, credential: "none", forcedToolChoice: true, skipped: [], ...over };
}

/** What to check when a session fails outside the loop: the provider the `agent` intent routed to. */
export function providerHint(provider: HarnessProvider): string {
  const key = provider.local ? "" : provider.credential === "claude-login" ? " and its Claude login (`claude auth login`)" : ` and its key (${provider.credential})`;
  return (
    `Check the "${provider.adapter.id}" provider${key}: \`pablo config show\` shows where the "agent" intent routes, ` +
    `\`pablo config set intents.agent <provider>\` picks another, and \`pablo config test\` then checks it.`
  );
}

/**
 * Whether to show the local-fallback notice: the intent routed to a local provider nobody asked for. Not when the
 * route passed over a cloud provider for want of a key, since the registry's skip notice already said so.
 */
export function shouldWarnLocal(provider: HarnessProvider, config: PabloConfig, intent: Intent = AGENT_INTENT): boolean {
  return provider.local && provider.skipped.length === 0 && !config.intents.has(intent.name);
}

/** Shown when no provider is mapped for the agent and the route fell to a local one. */
export const LOCAL_FALLBACK_NOTICE = (id: string, intent: string = AGENT_INTENT.name): string =>
  `pablo: no cloud provider is configured, so the ${intent === AGENT_INTENT.name ? "agent" : `"${intent}" step`} runs on the local model ("${id}"). To use Claude, add an anthropic provider (docs/configuration.md); to keep the local model and silence this, set intents.${intent}.`;
