import { expect, test } from "bun:test";
import { ProviderConfigError, createProviders, defaultConfig, parseConfig, route } from "../src/index";
import type { Intent, IntentKind } from "../src/index";

const intent = (kind: IntentKind, name: string = kind): Intent => ({ name, kind });

const withCloud = () =>
  parseConfig(
    JSON.stringify({
      providers: { anthropic: { endpoint: "https://api.anthropic.com/v1", model: "claude-opus-4-1" } },
    }),
  );

test("with no config, every intent goes to the local writer", () => {
  const config = defaultConfig();
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
  const config = parseConfig(
    JSON.stringify({
      providers: { anthropic: { endpoint: "https://api.anthropic.com/v1", model: "claude-opus-4-1" } },
      intents: { "period-check": "anthropic", "outline-act": "local" },
    }),
  );

  expect(route(config, intent("extraction", "period-check"))).toBe("anthropic");
  expect(route(config, intent("planning", "outline-act"))).toBe("local");
});

test("the registry answers with the adapter an intent routes to", () => {
  const providers = createProviders(withCloud());

  expect(providers.ids).toEqual(["local", "anthropic"]);
  expect(providers.adapterFor(intent("drafting")).id).toBe("local");
  expect(providers.adapterFor(intent("planning")).id).toBe("anthropic");
  expect(providers.adapter("local")).toBe(providers.adapter("local"));
});

test("asking for a provider that is not configured names the ones that are", () => {
  const providers = createProviders(defaultConfig());
  expect(() => providers.adapter("openai")).toThrow(ProviderConfigError);
  expect(() => providers.adapter("openai")).toThrow(/configured providers are local/);
});
