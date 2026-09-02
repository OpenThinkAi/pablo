import { expect, test } from "bun:test";
import {
  DEFAULT_LOCAL_ENDPOINT,
  DEFAULT_TIMEOUT_MS,
  ProviderConfigError,
  configPath,
  defaultConfig,
  loadConfig,
  parseConfig,
} from "../src/index";

test("with no config file at all, pablo talks to the local writer with no key", () => {
  const config = loadConfig({ readFile: () => undefined, path: "/nowhere/config.json" });
  const local = config.providers.get("local");

  expect(config.providers.size).toBe(1);
  expect(config.defaultProvider).toBe("local");
  expect(local?.endpoint).toBe(DEFAULT_LOCAL_ENDPOINT);
  expect(local?.local).toBe(true);
  expect(local?.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  expect(local?.key).toEqual({ from: "env", variable: "LOCAL_API_KEY" });
});

test("the config file lives under XDG_CONFIG_HOME when one is set", () => {
  expect(configPath({ XDG_CONFIG_HOME: "/tmp/conf" })).toBe("/tmp/conf/pablo/config.json");
  expect(configPath({})).toMatch(/\/\.config\/pablo\/config\.json$/);
});

test("a config file adds providers and keeps the local default underneath", () => {
  const config = parseConfig(
    JSON.stringify({
      providers: {
        anthropic: { endpoint: "https://api.anthropic.com/v1", model: "claude-opus-4-1", key: "keychain:ANTHROPIC_API_KEY_PERSONAL/mattpardini" },
      },
      intents: { research: "anthropic" },
    }),
  );

  expect([...config.providers.keys()]).toEqual(["local", "anthropic"]);
  expect(config.defaultProvider).toBe("local");
  expect(config.intents.get("research")).toBe("anthropic");
  expect(config.providers.get("anthropic")?.key).toEqual({
    from: "keychain",
    service: "ANTHROPIC_API_KEY_PERSONAL",
    account: "mattpardini",
  });
  expect(config.providers.get("anthropic")?.local).toBe(false);
});

test("a provider entry overrides only the fields it names", () => {
  const config = parseConfig(JSON.stringify({ providers: { local: { endpoint: "http://127.0.0.1:8000/v1", timeoutMs: 5000 } } }));
  const local = config.providers.get("local");

  expect(local?.endpoint).toBe("http://127.0.0.1:8000/v1");
  expect(local?.timeoutMs).toBe(5000);
  expect(local?.model).toBe(defaultConfig().providers.get("local")?.model);
  expect(local?.local).toBe(true);
});

test("a key written into the config file is rejected, naming both allowed forms", () => {
  expect(() => parseConfig(JSON.stringify({ providers: { anthropic: { endpoint: "https://api.anthropic.com/v1", model: "claude-opus-4-1", key: "sk-ant-notarealkey" } } }))).toThrow(
    ProviderConfigError,
  );
  expect(() => parseConfig(JSON.stringify({ providers: { anthropic: { endpoint: "https://api.anthropic.com/v1", model: "claude-opus-4-1", key: "sk-ant-notarealkey" } } }))).toThrow(
    /ANTHROPIC_API_KEY environment variable.*keychain:<service>\[\/<account>\]/s,
  );
});

test("a config that names a provider that does not exist is rejected", () => {
  expect(() => parseConfig(JSON.stringify({ default: "openai" }))).toThrow(/"default" names no provider/);
  expect(() => parseConfig(JSON.stringify({ intents: { research: "openai" } }))).toThrow(/names no provider/);
});

test("an endpoint that is not an http URL is rejected", () => {
  expect(() => parseConfig(JSON.stringify({ providers: { odd: { endpoint: "file:///etc/passwd", model: "m" } } }))).toThrow(
    /must be http or https/,
  );
  expect(() => parseConfig(JSON.stringify({ providers: { odd: { endpoint: "not a url", model: "m" } } }))).toThrow(/is not a URL/);
});

test("a trailing slash on an endpoint does not become a double slash in the request path", () => {
  const config = parseConfig(JSON.stringify({ providers: { local: { endpoint: "http://127.0.0.1:8002/v1/" } } }));
  expect(config.providers.get("local")?.endpoint).toBe("http://127.0.0.1:8002/v1");
});

test("a config file that is not JSON names the file it could not read", () => {
  expect(() => parseConfig("{ nope", "/tmp/pablo/config.json")).toThrow(/\/tmp\/pablo\/config\.json is not valid JSON/);
});
