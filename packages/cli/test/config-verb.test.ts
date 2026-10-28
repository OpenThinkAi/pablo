import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Adapter, CompletionEvent } from "@openthink/pablo-core";
import { configSet, configShow, configTest } from "../src/config-verb";

// Every test points XDG_CONFIG_HOME at a temp dir: the real ~/.config/pablo is never read or written.
function scope(withConfig?: object, withProject?: object) {
  const root = mkdtempSync(join(tmpdir(), "pablo-config-verb-"));
  const xdg = join(root, "xdg");
  const projectDir = join(root, "work");
  mkdirSync(projectDir, { recursive: true });
  if (withConfig) {
    mkdirSync(join(xdg, "pablo"), { recursive: true });
    writeFileSync(join(xdg, "pablo", "config.json"), JSON.stringify(withConfig));
  }
  if (withProject) writeFileSync(join(projectDir, "pablo.json"), JSON.stringify(withProject));
  return { env: { XDG_CONFIG_HOME: xdg }, projectDir, globalFile: join(xdg, "pablo", "config.json"), projectFile: join(projectDir, "pablo.json") };
}

const GLOBAL = {
  providers: {
    local: { endpoint: "http://127.0.0.1:8002/v1", model: "test-local-model", local: true },
    anthropic: { kind: "anthropic", endpoint: "https://api.anthropic.com/v1", model: "test-claude", key: "keychain:ANTHROPIC_KEY/matt" },
  },
  intents: { research: "anthropic" },
};

test("show: no file prints no providers and points at the starter config", () => {
  const s = scope();
  const r = configShow({ env: s.env });
  expect(r.exitCode).toBe(0);
  expect(r.text).toContain("default: (none)");
  expect(r.text).toContain("pablo init --config");
  expect(r.text).toContain("draft -> (none) (by kind)");
  expect(r.text).not.toContain("127.0.0.1");
});

test("show: merged providers, key as reference only, project overrides", () => {
  const s = scope(GLOBAL, { providers: { anthropic: { model: "claude-sonnet-x" } }, intents: { draft: "anthropic" } });
  const r = configShow({ env: { ...s.env, ANTHROPIC_KEY: "sk-secret-value" }, projectDir: s.projectDir });
  expect(r.exitCode).toBe(0);
  expect(r.text).toContain("key=keychain:ANTHROPIC_KEY/matt");
  expect(r.text).toContain("model=claude-sonnet-x");
  expect(r.text).toContain("draft -> anthropic\n");
  expect(r.text).toContain("research -> anthropic");
  // The agent loop's intent is listed too; unmapped, it routes by kind to the cloud provider.
  expect(r.text).toContain("agent -> anthropic (by kind)");
  expect(r.text).toContain("check -> anthropic (by kind)");
  expect(JSON.stringify(r.body)).not.toContain("sk-secret-value");
  const global = configShow({ env: s.env });
  expect(global.text).toContain("draft -> local (by kind)");
});

test("show: a broken config is a refusal, not a crash", () => {
  const s = scope();
  mkdirSync(join(s.env.XDG_CONFIG_HOME, "pablo"), { recursive: true });
  writeFileSync(s.globalFile, "{nope");
  const r = configShow({ env: s.env });
  expect(r.exitCode).toBe(2);
  expect(r.text).toContain("not valid JSON");
});

test("set: writes global config, creating the file, and show reflects it", () => {
  const s = scope();
  // A provider is built up one field at a time: it need not be complete until a verb routes to it.
  expect(configSet({ env: s.env }, "providers.cloud.kind", "anthropic").exitCode).toBe(0);
  expect(configShow({ env: s.env }).exitCode).toBe(2);
  expect(configShow({ env: s.env }).text).toContain('provider "cloud": "endpoint" and "model" must be set');
  expect(configSet({ env: s.env }, "providers.cloud.endpoint", "https://api.anthropic.com/v1").exitCode).toBe(0);
  expect(configSet({ env: s.env }, "providers.cloud.model", "test-claude").exitCode).toBe(0);
  expect(configSet({ env: s.env }, "providers.cloud.key", "env:MY_KEY").exitCode).toBe(0);
  expect(configSet({ env: s.env }, "intents.research", "cloud").exitCode).toBe(0);
  expect(configSet({ env: s.env }, "providers.cloud.temperature", "0.5").exitCode).toBe(0);
  expect(configSet({ env: s.env }, "default", "cloud").exitCode).toBe(0);
  const written = JSON.parse(readFileSync(s.globalFile, "utf8"));
  expect(written.providers.cloud).toEqual({ kind: "anthropic", endpoint: "https://api.anthropic.com/v1", model: "test-claude", key: "env:MY_KEY", temperature: 0.5 });
  expect(written.intents.research).toBe("cloud");
  expect(configShow({ env: s.env }).text).toContain("default: cloud");
});

test("set --project edits pablo.json and keeps its other keys", () => {
  const s = scope(GLOBAL, { format: "novel", name: "x" });
  const r = configSet({ env: s.env, projectDir: s.projectDir }, "intents.draft", "anthropic");
  expect(r.exitCode).toBe(0);
  const written = JSON.parse(readFileSync(s.projectFile, "utf8"));
  expect(written).toEqual({ format: "novel", name: "x", intents: { draft: "anthropic" } });
  expect(existsSync(s.globalFile)).toBe(true);
  expect(JSON.parse(readFileSync(s.globalFile, "utf8"))).toEqual(GLOBAL);
});

test("set refuses an inline key and writes nothing", () => {
  const s = scope(GLOBAL);
  const r = configSet({ env: s.env }, "providers.anthropic.key", "sk-ant-abc123");
  expect(r.exitCode).toBe(2);
  expect(r.text).not.toContain("sk-ant-abc123");
  expect(JSON.parse(readFileSync(s.globalFile, "utf8"))).toEqual(GLOBAL);
});

test("set refuses an intent naming no provider, a bad number, unknown paths, and default in a work", () => {
  const s = scope(GLOBAL, { format: "novel" });
  const g = { env: s.env };
  expect(configSet(g, "intents.draft", "ghost").exitCode).toBe(2);
  expect(configSet(g, "providers.anthropic.timeoutMs", "soon").exitCode).toBe(2);
  expect(configSet(g, "readers.x", "y").exitCode).toBe(2);
  expect(configSet(g, "providers.anthropic.bogus", "y").exitCode).toBe(2);
  expect(configSet(g, "intents.draft", undefined).exitCode).toBe(2);
  expect(configSet({ env: s.env, projectDir: s.projectDir }, "default", "anthropic").exitCode).toBe(2);
  expect(JSON.parse(readFileSync(s.projectFile, "utf8"))).toEqual({ format: "novel" });
});

test("set refuses a work repointing a remote provider's endpoint", () => {
  const s = scope(GLOBAL, { format: "novel" });
  const r = configSet({ env: s.env, projectDir: s.projectDir }, "providers.anthropic.endpoint", "https://evil.example/v1");
  expect(r.exitCode).toBe(2);
  expect(JSON.parse(readFileSync(s.projectFile, "utf8"))).toEqual({ format: "novel" });
});

function fakeAdapter(id: string, fail?: string): Adapter {
  return {
    id,
    model: "m",
    preferredOutput: "tool",
    async *complete(): AsyncIterable<CompletionEvent> {
      if (fail) throw new Error(fail);
      yield { type: "token", text: "ok" };
      yield { type: "done", stats: { timeToFirstTokenMs: 1, elapsedMs: 1, tokensRead: 1, tokensWritten: 1, tokensPerSecond: 1 } };
    },
    proposeEdit: async () => {
      throw new Error("unused");
    },
    extractFacts: async () => [],
  };
}

test("test: one request per mapped intent, ok/error per provider, exit 1 on any error", async () => {
  const s = scope({
    providers: { anthropic: { kind: "anthropic", endpoint: "https://api.anthropic.com/v1", model: "test-claude", key: "env:K" }, other: { endpoint: "http://127.0.0.1:9/v1", model: "m" } },
    intents: { research: "anthropic", draft: "other", revise: "other" },
  });
  const calls: string[] = [];
  const deps = {
    adapterFor: (_c: unknown, id: string) => {
      calls.push(id);
      return fakeAdapter(id, id === "other" ? "connection refused" : undefined);
    },
  };
  const r = await configTest({ env: s.env }, deps as never);
  expect(calls).toEqual(["anthropic", "other", "other"]);
  expect(r.exitCode).toBe(1);
  expect(r.text).toContain("anthropic: ok");
  expect(r.text).toContain("other: error");
  expect(r.text).toContain("connection refused");
});

test("test: with no provider configured it refuses and points at the starter config", async () => {
  const r = await configTest({ env: scope().env }, { adapterFor: () => fakeAdapter("x") });
  expect(r.exitCode).toBe(2);
  expect(r.text).toContain("pablo init --config");
});

test("test: all ok exits 0; with no mapped intents it checks the default route", async () => {
  const s = scope({ providers: GLOBAL.providers });
  const calls: string[] = [];
  const r = await configTest({ env: s.env }, { adapterFor: (_c, id) => (calls.push(id), fakeAdapter(id)) });
  expect(calls).toEqual(["local"]);
  expect(r.exitCode).toBe(0);
  expect(r.body["ok"]).toBe(true);
});

test("CLI end to end against a temp XDG_CONFIG_HOME", () => {
  const s = scope();
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const run = (...args: string[]) => Bun.spawnSync(["bun", "run", cli, "config", ...args], { env: { ...process.env, ...s.env } });
  expect(JSON.parse(run("show", "--json").stdout.toString()).providers).toEqual([]);
  for (const [path, value] of [["kind", "anthropic"], ["endpoint", "https://api.anthropic.com/v1"], ["model", "test-claude"]] as const) {
    expect(run("set", `providers.cloud.${path}`, value).exitCode).toBe(0);
  }
  const show = run("show", "--json");
  expect(show.exitCode).toBe(0);
  expect(JSON.parse(show.stdout.toString()).providers.map((p: { id: string }) => p.id)).toEqual(["cloud"]);
  expect(run("bogus").exitCode).toBe(2);
});

test("test: a billing/credit error is named plainly", async () => {
  const s = scope({ providers: GLOBAL.providers });
  const r = await configTest({ env: s.env }, { adapterFor: (_c: unknown, id: string) => fakeAdapter(id, "Your credit balance is too low to access the Anthropic API") } as never);
  expect(r.exitCode).toBe(1);
  expect(r.text).toContain("billing/credit problem");
});
