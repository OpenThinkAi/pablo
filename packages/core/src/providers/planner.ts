/**
 * The planner role: the model pablo plans with (premise, bible, acts, beats).
 *
 * Claude on Matt's subscription (`claude -p`) by default. An Anthropic provider
 * in pablo's config whose key resolves overrides that and the call goes to the
 * API instead; with no key anywhere, the subscription still works. Which
 * provider counts as the planner's: the one the `plan` intent maps to, else the
 * first `anthropic`-kind provider. The planner never writes chapter prose.
 *
 * Every adapter that comes back is wrapped with receipts when a sink is given,
 * so a planner call is logged like any other model call (intent `plan`).
 */

import type { ReceiptSink } from "../pack/receipts";
import { withReceipts } from "../pack/receipts";
import type { PabloConfig } from "./config";
import type { ClaudeCliAdapterOptions } from "./claude-cli";
import { createClaudeCliAdapter } from "./claude-cli";
import type { ProvidersOptions } from "./registry";
import { createProviders } from "./registry";
import { resolveKey } from "./keys";
import type { Adapter, Intent } from "./types";

/** The intent a planner call carries; map it in the config's `intents` to pick a provider. */
export const PLAN_INTENT: Intent = { name: "plan", kind: "planning" };

export interface PlannerOptions extends ProvidersOptions {
  /** Where receipts go; omit and the planner is unlogged (tests that do not care). */
  readonly receipts?: ReceiptSink | undefined;
  /** The subscription path's settings and injected runner. */
  readonly claude?: ClaudeCliAdapterOptions | undefined;
}

export type PlannerRoute = "api-key" | "subscription";

export interface Planner {
  readonly route: PlannerRoute;
  readonly adapter: Adapter;
}

/** The anthropic-kind provider the planner may use, if the config has one. */
function planningProviderId(config: PabloConfig): string | undefined {
  const mapped = config.intents.get(PLAN_INTENT.name);
  if (mapped !== undefined) return config.providers.get(mapped)?.kind === "anthropic" ? mapped : undefined;
  for (const provider of config.providers.values()) if (provider.kind === "anthropic") return provider.id;
  return undefined;
}

export function createPlanner(config: PabloConfig, options: PlannerOptions = {}): Planner {
  const id = planningProviderId(config);
  const provider = id === undefined ? undefined : config.providers.get(id);

  let route: PlannerRoute = "subscription";
  let adapter: Adapter;
  if (provider !== undefined && resolveKey(provider.key, options.keys) !== undefined) {
    route = "api-key";
    adapter = createProviders(config, options).adapter(provider.id);
  } else {
    adapter = createClaudeCliAdapter(options.claude);
  }

  const log = options.receipts;
  return { route, adapter: log === undefined ? adapter : withReceipts(adapter, log, { intent: PLAN_INTENT.name }) };
}
