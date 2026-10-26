/**
 * The planner role: the model pablo plans with (premise, bible, acts, beats),
 * and the critic that judges a branch (`critique`, `check --across`) and the
 * fact tagger (`agent --tag-facts`).
 *
 * A planner is an intent routed like every other model call (D-12, D-13): the
 * config's `intents` mapping, else the first cloud provider whose key
 * resolves, else the default provider. Any provider kind serves it — an
 * Anthropic provider, an OpenAI-compatible cloud endpoint or the local model.
 * There is no Claude-login path; with no cloud key anywhere the planner runs
 * on the default (local) provider. The planner never writes chapter prose.
 *
 * Every adapter that comes back is wrapped with receipts when a sink is given,
 * so a planner call is logged like any other model call (under its intent).
 */

import type { ReceiptSink } from "../pack/receipts";
import { withReceipts } from "../pack/receipts";
import type { PabloConfig } from "./config";
import type { ProvidersOptions } from "./registry";
import { createProviders } from "./registry";
import type { Adapter, Intent } from "./types";

/** The intent a planner call carries; map it in the config's `intents` to pick a provider. */
export const PLAN_INTENT: Intent = { name: "plan", kind: "planning" };

/** The intent for checks that judge a branch (`critique`, `check --across`); unmapped, it follows `plan`. */
export const CHECK_INTENT: Intent = { name: "check", kind: "planning" };

export interface PlannerOptions extends ProvidersOptions {
  /** Where receipts go; omit and the planner is unlogged (tests that do not care). */
  readonly receipts?: ReceiptSink | undefined;
  /** The intent this planner serves (receipts, and which mapping picks its provider); defaults to `plan`. An unmapped one uses the `plan` mapping. */
  readonly intent?: Intent | undefined;
}

export interface Planner {
  /** The provider id the intent routed to. */
  readonly provider: string;
  readonly adapter: Adapter;
}

/**
 * The intent whose route a planner call takes: its own when the config maps
 * it, else `plan`'s when that is mapped (so mapping `plan` once moves every
 * planning call), else its own unmapped route.
 */
function routingIntent(config: PabloConfig, intent: Intent): Intent {
  if (config.intents.has(intent.name) || !config.intents.has(PLAN_INTENT.name)) return intent;
  return { name: PLAN_INTENT.name, kind: intent.kind };
}

export function createPlanner(config: PabloConfig, options: PlannerOptions = {}): Planner {
  const intent = options.intent ?? PLAN_INTENT;
  const providers = createProviders(config, options);
  const provider = providers.route(routingIntent(config, intent));
  const adapter = providers.adapter(provider);
  const log = options.receipts;
  return { provider, adapter: log === undefined ? adapter : withReceipts(adapter, log, { intent: intent.name }) };
}
