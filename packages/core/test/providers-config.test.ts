import { expect, test } from "bun:test";
import {
  DEFAULT_LOCAL_ENDPOINT,
  DEFAULT_TIMEOUT_MS,
  ProviderConfigError,
  configPath,
  defaultConfig,
  isLoopbackEndpoint,
  loadConfig,
  parseConfig,
  route,
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

test("a provider's sampling temperature is read, inherited, and range-checked", () => {
  const config = parseConfig(JSON.stringify({ providers: { local: { temperature: 0.6 } } }));
  expect(config.providers.get("local")?.temperature).toBe(0.6);
  expect(defaultConfig().providers.get("local")?.temperature).toBeUndefined();
  expect(() => parseConfig(JSON.stringify({ providers: { local: { temperature: 3 } } }))).toThrow(/"temperature" must be a number from 0 to 2/);
  expect(() => parseConfig(JSON.stringify({ providers: { local: { temperature: "hot" } } }))).toThrow(/"temperature"/);
});

test("the config's readers are parsed, validated, and empty by default", () => {
  expect(defaultConfig().readers.size).toBe(0);
  const config = parseConfig(
    JSON.stringify({ readers: { atara: { github: "atara-test", name: "Atara Test", email: "atara@example.com" } } }),
  );
  expect(config.readers.get("atara")).toEqual({ github: "atara-test", name: "Atara Test", email: "atara@example.com" });
  const bad = (readers: unknown): void => {
    expect(() => parseConfig(JSON.stringify({ readers }))).toThrow(ProviderConfigError);
  };
  bad([]);
  bad({ "Bad Name": { github: "a", name: "A", email: "a@b.c" } });
  bad({ atara: { github: "-flag", name: "A", email: "a@b.c" } });
  bad({ atara: { github: "a", name: "", email: "a@b.c" } });
  bad({ atara: { github: "a", name: "A" } });
  bad({ atara: { github: "a", name: "A\nB", email: "a@b.c" } });
  bad({ atara: { github: "a", name: " A", email: "a@b.c" } });
  bad({ atara: { github: "a", name: "A", email: "a@b.c\nX: y" } });
  bad({ atara: { github: "a", name: "A", email: "not-an-email" } });
  bad({ atara: { github: "a", name: "A", email: "a b@c.d" } });
});

// AGT-2129 (D-13): a work's pablo.json routes its own models over the global config.

const GLOBAL = JSON.stringify({
  providers: { anthropic: { kind: "anthropic", key: "keychain:anthropic-api-key" } },
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
