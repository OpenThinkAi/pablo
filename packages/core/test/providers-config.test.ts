import { expect, test } from "bun:test";
import {
  DEFAULT_TIMEOUT_MS,
  NoModelConfiguredError,
  ProviderConfigError,
  configPath,
  defaultConfig,
  isLoopbackEndpoint,
  loadConfig,
  mergeProjectConfig,
  parseConfig,
  route,
} from "../src/index";
import { TEST_LOCAL_ENDPOINT, TEST_LOCAL_MODEL, TEST_LOCAL_PROVIDER } from "./local-config";

test("with no config file at all, pablo has no provider, no endpoint and no model", () => {
  const config = loadConfig({ readFile: () => undefined, path: "/nowhere/config.json" });

  expect(config.providers.size).toBe(0);
  expect(config.defaultProvider).toBe("");
  expect(() => route(config, { name: "draft", kind: "drafting" })).toThrow(NoModelConfiguredError);
  expect(() => route(config, { name: "draft", kind: "drafting" })).toThrow(/pablo init --config/);
});

test("a provider entry carries what the config names, with the 60s idle timeout by default", () => {
  const local = parseConfig(JSON.stringify({ providers: { local: TEST_LOCAL_PROVIDER } })).providers.get("local");

  expect(local?.endpoint).toBe(TEST_LOCAL_ENDPOINT);
  expect(local?.model).toBe(TEST_LOCAL_MODEL);
  expect(local?.local).toBe(true);
  expect(local?.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  expect(local?.key).toEqual({ from: "env", variable: "LOCAL_API_KEY" });
});

test("a provider entry with no endpoint or no model is refused by name", () => {
  expect(() => parseConfig(JSON.stringify({ providers: { local: { model: "m" } } }))).toThrow(/provider "local": "endpoint" must be set.*pablo init --config/s);
  expect(() => parseConfig(JSON.stringify({ providers: { local: { endpoint: "http://127.0.0.1:1/v1" } } }))).toThrow(/provider "local": "model" must be set/);
});

test("with no \"default\", the first provider is the default", () => {
  const config = parseConfig(JSON.stringify({ providers: { a: TEST_LOCAL_PROVIDER, b: TEST_LOCAL_PROVIDER } }));
  expect(config.defaultProvider).toBe("a");
});

test("the config file lives under XDG_CONFIG_HOME when one is set", () => {
  expect(configPath({ XDG_CONFIG_HOME: "/tmp/conf" })).toBe("/tmp/conf/pablo/config.json");
  expect(configPath({})).toMatch(/\/\.config\/pablo\/config\.json$/);
});

test("a config file names its providers in order", () => {
  const config = parseConfig(
    JSON.stringify({
      providers: {
        local: TEST_LOCAL_PROVIDER,
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
  const base = parseConfig(JSON.stringify({ providers: { local: TEST_LOCAL_PROVIDER } }));
  const text = JSON.stringify({ providers: { local: { endpoint: "http://127.0.0.1:8000/v1", timeoutMs: 5000 } } });
  // A work's pablo.json layers over the global file: an entry overrides only what it names.
  const local = mergeProjectConfig(base, text).providers.get("local");

  expect(local?.endpoint).toBe("http://127.0.0.1:8000/v1");
  expect(local?.timeoutMs).toBe(5000);
  expect(local?.model).toBe(TEST_LOCAL_MODEL);
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
  const config = parseConfig(JSON.stringify({ providers: { local: { ...TEST_LOCAL_PROVIDER, endpoint: "http://127.0.0.1:8002/v1/" } } }));
  expect(config.providers.get("local")?.endpoint).toBe("http://127.0.0.1:8002/v1");
});

test("a config file that is not JSON names the file it could not read", () => {
  expect(() => parseConfig("{ nope", "/tmp/pablo/config.json")).toThrow(/\/tmp\/pablo\/config\.json is not valid JSON/);
});

test("a provider's sampling temperature is read, inherited, and range-checked", () => {
  const config = parseConfig(JSON.stringify({ providers: { local: { ...TEST_LOCAL_PROVIDER, temperature: 0.6 } } }));
  expect(config.providers.get("local")?.temperature).toBe(0.6);
  expect(parseConfig(JSON.stringify({ providers: { local: TEST_LOCAL_PROVIDER } })).providers.get("local")?.temperature).toBeUndefined();
  expect(() => parseConfig(JSON.stringify({ providers: { local: { ...TEST_LOCAL_PROVIDER, temperature: 3 } } }))).toThrow(/"temperature" must be a number from 0 to 2/);
  expect(() => parseConfig(JSON.stringify({ providers: { local: { ...TEST_LOCAL_PROVIDER, temperature: "hot" } } }))).toThrow(/"temperature"/);
});

test("an old `readers` key in a config file is ignored, not an error", () => {
  const config = parseConfig(
    JSON.stringify({ readers: { atara: { github: "atara-test", name: "Atara Test", email: "atara@example.com" } } }),
  );
  expect("readers" in config).toBe(false);
  expect(() => parseConfig(JSON.stringify({ readers: [] }))).not.toThrow();
});

// AGT-2129 (D-13): a work's pablo.json routes its own models over the global config.

const GLOBAL = JSON.stringify({
  providers: {
    local: TEST_LOCAL_PROVIDER,
    anthropic: { kind: "anthropic", endpoint: "https://api.anthropic.com/v1", model: "test-anthropic-model", key: "keychain:anthropic-api-key" },
  },
  intents: { plan: "anthropic" },
});

function projectConfig(marker: Record<string, unknown>, global: string | undefined = GLOBAL) {
  const asked: string[] = [];
  const config = loadConfig({
    path: "/conf/pablo/config.json",
    readFile: () => global,
    projectDir: "/vault/novels/ice-house",
    readProjectFile: (path) => {
      asked.push(path);
      return JSON.stringify({ title: "Ice House", slug: "ice-house", ...marker });
    },
  });
  return { config, asked };
}

test("a work's pablo.json routes draft to a different provider than the global default", () => {
  const draft = { name: "draft", kind: "drafting" } as const;
  const globalOnly = loadConfig({ path: "/conf/pablo/config.json", readFile: () => GLOBAL });
  expect(route(globalOnly, draft)).toBe("local");

  const { config, asked } = projectConfig({
    providers: { "work-qwen": { endpoint: "http://127.0.0.1:8000/v1", model: "qwen3-32b", local: true, key: "env:WORK_QWEN_KEY" } },
    intents: { draft: "work-qwen" },
  });
  expect(asked).toEqual(["/vault/novels/ice-house/pablo.json"]);
  expect(route(config, draft)).toBe("work-qwen");
  expect(config.providers.get("work-qwen")?.key).toEqual({ from: "env", variable: "WORK_QWEN_KEY" });
  // The global config is still underneath: its provider and its intent stay.
  expect(config.intents.get("plan")).toBe("anthropic");
  expect(route(config, { name: "revise", kind: "revising" })).toBe("local");
});

test("a work's provider entry overrides only the fields it names, its key reference included", () => {
  const { config } = projectConfig({ providers: { anthropic: { model: "claude-sonnet-5" } }, intents: { draft: "anthropic" } });
  const anthropic = config.providers.get("anthropic");
  expect(anthropic?.model).toBe("claude-sonnet-5");
  expect(anthropic?.kind).toBe("anthropic");
  expect(anthropic?.key).toEqual({ from: "keychain", service: "anthropic-api-key", account: undefined });
  expect(config.intents.get("draft")).toBe("anthropic");
});

test("a work with no providers or intents, or no pablo.json, gets the global config", () => {
  expect(projectConfig({}).config.intents.get("plan")).toBe("anthropic");
  const none = loadConfig({ path: "/c.json", readFile: () => GLOBAL, projectDir: "/nowhere", readProjectFile: () => undefined });
  expect([...none.providers.keys()]).toEqual(["local", "anthropic"]);
});

test("a key written inline in pablo.json is refused without repeating it; env: and keychain: are accepted", () => {
  const inline = () => projectConfig({ providers: { anthropic: { key: "sk-ant-notarealkey" } } });
  expect(inline).toThrow(ProviderConfigError);
  expect(inline).toThrow(/\/vault\/novels\/ice-house\/pablo\.json: provider "anthropic".*env:<NAME>.*keychain:<service>/s);
  try {
    inline();
  } catch (error) {
    expect((error as Error).message).not.toContain("sk-ant-notarealkey");
  }
  expect(() => projectConfig({ providers: { anthropic: { key: "env:sk-ant-not a name" } } })).toThrow(/"env:<NAME>"/);
  const loopback = { endpoint: "http://127.0.0.1:8000/v1", model: "m" };
  expect(projectConfig({ providers: { work: { ...loopback, key: "env:WORK_SERVER_KEY" } } }).config.providers.get("work")?.key).toEqual({
    from: "env",
    variable: "WORK_SERVER_KEY",
  });
  expect(projectConfig({ providers: { work: { ...loopback, key: "keychain:work-key/me" } } }).config.providers.get("work")?.key).toEqual({
    from: "keychain",
    service: "work-key",
    account: "me",
  });
});

test("a work's intent must name a provider of the merged set", () => {
  expect(() => projectConfig({ intents: { draft: "nope" } })).toThrow(/pablo\.json: intent "draft" names no provider: nope/);
  expect(() => projectConfig({ providers: [] })).toThrow(/"providers" must be an object/);
});

test("a work cannot point a global provider's key at a host of its choosing", () => {
  // Without a key of its own the entry would inherit the global keychain reference.
  expect(() => projectConfig({ providers: { anthropic: { endpoint: "https://attacker.example/v1" } } })).toThrow(
    /provider "anthropic": a work may change only "model", "timeoutMs", "temperature", "thinking"/,
  );
  expect(() => projectConfig({ providers: { anthropic: { kind: "openai-compatible", endpoint: "https://attacker.example/v1", model: "m" } } })).toThrow(
    ProviderConfigError,
  );
  expect(() => projectConfig({ providers: { anthropic: { key: "env:GITHUB_TOKEN" } } })).toThrow(/"key" are set in the global config/);
  expect(() => projectConfig({ providers: { anthropic: { local: true } } })).toThrow(ProviderConfigError);
  // Moving the local writer off the machine is the same.
  expect(() => projectConfig({ providers: { local: { endpoint: "https://attacker.example/v1" } } })).toThrow(ProviderConfigError);
});

test("a work cannot add a provider on a remote endpoint, whatever key it names", () => {
  for (const key of [undefined, "env:AWS_SECRET_ACCESS_KEY", "keychain:anthropic-api-key"]) {
    expect(() =>
      projectConfig({ providers: { exfil: { endpoint: "https://attacker.example/v1", model: "m", ...(key === undefined ? {} : { key }) } } }),
    ).toThrow(/provider "exfil": a work may add only a provider on this machine.*global config/s);
  }
});

test("a work may define and change providers on this machine freely", () => {
  const { config } = projectConfig({
    providers: {
      local: { endpoint: "http://localhost:1234/v1", model: "qwen3-32b" },
      v6: { endpoint: "http://[::1]:8080/v1", model: "m", key: "keychain:local-server" },
    },
  });
  expect(config.providers.get("local")?.endpoint).toBe("http://localhost:1234/v1");
  expect(config.providers.get("v6")?.key).toEqual({ from: "keychain", service: "local-server", account: undefined });
  expect(isLoopbackEndpoint("http://127.0.0.2:8002/v1")).toBe(true);
  expect(isLoopbackEndpoint("http://127.0.0.1.attacker.example/v1")).toBe(false);
  expect(isLoopbackEndpoint("https://api.anthropic.com/v1")).toBe(false);
});

test("a work's pablo.json can be the only place providers come from: its first provider is the default", () => {
  const base = loadConfig({ readFile: () => undefined, path: "/nowhere/config.json" });
  const work = mergeProjectConfig(base, JSON.stringify({ providers: { local: TEST_LOCAL_PROVIDER } }), "pablo.json");
  expect(work.defaultProvider).toBe("local");
  expect(route(work, { name: "plan", kind: "planning" })).toBe("local");
  expect(route(work, { name: "draft", kind: "drafting" })).toBe("local");
});

test("an anthropic entry without an endpoint or model says pablo no longer fills them in", () => {
  expect(() => parseConfig(JSON.stringify({ providers: { anthropic: { kind: "anthropic", key: "env:ANTHROPIC_API_KEY" } } }))).toThrow(
    /"endpoint" and "model" must be set — pablo has no built-in endpoint or model \(not even for kind "anthropic"\)/,
  );
});
