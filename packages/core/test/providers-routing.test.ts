import { expect, test } from "bun:test";
import { NoModelConfiguredError, ProviderConfigError, defaultConfig, createProviders, mergeProjectConfig, resolveRoute, route } from "../src/index";
import type { Intent, IntentKind } from "../src/index";
import { localConfig, parseWithTestDefaults } from "./local-config";

const intent = (kind: IntentKind, name: string = kind): Intent => ({ name, kind });

const withCloud = () =>
  parseWithTestDefaults(
    JSON.stringify({
      providers: { anthropic: { endpoint: "https://api.anthropic.com/v1", model: "claude-opus-4-1" } },
    }),
  );

test("with no config, every intent goes to the local writer", () => {
  const config = localConfig();
  for (const kind of ["planning", "drafting", "revising", "extraction"] as const) {
    expect(route(config, intent(kind))).toBe("local");
  }
});

test("once a cloud provider is configured, planning goes there and the rest stay local", () => {
  const config = withCloud();
  expect(route(config, intent("planning"))).toBe("anthropic");
  expect(route(config, intent("drafting"))).toBe("local");
  expect(route(config, intent("revising"))).toBe("local");
  expect(route(config, intent("extraction"))).toBe("local");
});

test("an intent named in the config overrides its kind's default", () => {
  const config = parseWithTestDefaults(
    JSON.stringify({
      providers: { anthropic: { endpoint: "https://api.anthropic.com/v1", model: "claude-opus-4-1" } },
      intents: { "period-check": "anthropic", "outline-act": "local" },
    }),
  );

  expect(route(config, intent("extraction", "period-check"))).toBe("anthropic");
  expect(route(config, intent("planning", "outline-act"))).toBe("local");
});

test("the registry answers with the adapter an intent routes to", () => {
  const providers = createProviders(withCloud(), { keys: { env: { ANTHROPIC_API_KEY: "k" } } });

  expect(providers.ids).toEqual(["local", "anthropic"]);
  expect(providers.adapterFor(intent("drafting")).id).toBe("local");
  expect(providers.adapterFor(intent("planning")).id).toBe("anthropic");
  expect(providers.adapter("local")).toBe(providers.adapter("local"));
});

test("asking for a provider that is not configured names the ones that are", () => {
  const providers = createProviders(localConfig());
  expect(() => providers.adapter("openai")).toThrow(ProviderConfigError);
  expect(() => providers.adapter("openai")).toThrow(/configured providers are local/);
});

// AGT-2127: route() passes over a provider whose key does not resolve.

const twoClouds = () =>
  parseWithTestDefaults(
    JSON.stringify({
      providers: { anthropic: { kind: "anthropic" }, backup: { kind: "anthropic", key: "env:BACKUP_KEY" } },
      intents: { research: "anthropic" },
    }),
  );

test("a mapped provider with no key is skipped for the next usable cloud provider, and the skip is named", () => {
  const providers = createProviders(twoClouds(), { keys: { env: { BACKUP_KEY: "k" } }, onSkip: () => {} });
  const routed = providers.routed(intent("planning", "research"));
  expect(routed.provider).toBe("backup");
  expect(routed.skipped).toEqual([{ provider: "anthropic", intent: "research", reason: "ANTHROPIC_API_KEY is not set" }]);
});

test("with no cloud key at all the intent falls back to the default, and with a key nothing is skipped", () => {
  const none = createProviders(twoClouds(), { keys: { env: {} }, onSkip: () => {} });
  expect(none.route(intent("planning", "research"))).toBe("local");
  expect(none.routed(intent("planning", "research")).skipped.map((s) => s.provider)).toEqual(["anthropic", "backup"]);

  const keyed = createProviders(twoClouds(), { keys: { env: { ANTHROPIC_API_KEY: "k" } }, onSkip: () => {} });
  expect(keyed.routed(intent("planning", "research"))).toEqual({ provider: "anthropic", skipped: [] });
});

test("a local provider needs no key, and a skip is announced once per intent and provider", () => {
  const told: string[] = [];
  const providers = createProviders(twoClouds(), { keys: { env: {} }, onSkip: (s, to) => void told.push(`${s.intent}:${s.provider}->${to}`) });
  expect(providers.route(intent("drafting"))).toBe("local");
  providers.route(intent("planning", "research"));
  providers.route(intent("planning", "research"));
  expect(told).toEqual(["research:anthropic->local", "research:backup->local"]);
});

test("when every candidate lacks a key the first is returned so the adapter reports the real problem", () => {
  const config = parseWithTestDefaults(JSON.stringify({ providers: { anthropic: { kind: "anthropic" } }, default: "anthropic" }));
  const routed = createProviders(config, { keys: { env: {} }, onSkip: () => {} }).routed(intent("planning"));
  expect(routed).toEqual({ provider: "anthropic", skipped: [] });
});

test("the pure route() and resolveRoute() without a key check never skip", () => {
  expect(route(twoClouds(), intent("planning", "research"))).toBe("anthropic");
  expect(resolveRoute(twoClouds(), intent("planning")).skipped).toEqual([]);
});

test("with no provider configured at all, resolveRoute refuses with NoModelConfiguredError instead of naming a missing id", () => {
  for (const kind of ["planning", "drafting", "revising", "extraction"] as const) {
    expect(() => resolveRoute(defaultConfig(), intent(kind))).toThrow(NoModelConfiguredError);
  }
  expect(() => createProviders(defaultConfig()).adapterFor(intent("drafting"))).toThrow(/pablo init --config/);
});

// AGT-2230: a provider with no key because a work's pablo.json added or repointed it says what to do about it.
test("a keyless work provider's skip reason names the global config fix", () => {
  const config = mergeProjectConfig(
    twoClouds(),
    JSON.stringify({ providers: { mine: { endpoint: "http://127.0.0.1:8100/v1", model: "m", local: false } }, intents: { research: "mine" } }),
  );
  const routed = createProviders(config, { keys: { env: { ANTHROPIC_API_KEY: "k" } }, onSkip: () => {} }).routed(intent("planning", "research"));
  expect(routed.provider).toBe("anthropic");
  expect(routed.skipped).toHaveLength(1);
  const reason = routed.skipped[0]?.reason ?? "";
  expect(reason).toMatch(/^it has no key: a provider a work's pablo\.json adds, or whose endpoint, kind or local flag it changes, never does/);
  expect(reason).toContain('declare "mine" with its endpoint and "key" in the global config');
  expect(reason).toContain("`pablo config set providers.mine.key env:<NAME>`, without --project");
});
