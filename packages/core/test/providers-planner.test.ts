/**
 * The planner role: subscription (`claude -p`) by default, an Anthropic key in
 * the config overrides, every call receipted. The runner is a fake; no test
 * starts `claude`, reaches the network or reads the Keychain.
 */

import { expect, test } from "bun:test";
import { claudeCredential, createPlanner, parseConfig, defaultConfig, ProviderResponseError, subscriptionEnv, claudeArgs } from "../src/index";
import type { ClaudeRun, ClaudeRunner, Receipt } from "../src/index";

const reply = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    is_error: false,
    result: "Act one opens on the ferry.",
    modelUsage: { "claude-haiku-x": { outputTokens: 2 }, "claude-opus-x": { outputTokens: 40 } },
    usage: { input_tokens: 120, output_tokens: 42 },
    ...over,
  });

function fakeRunner(stdout = reply(), exitCode = 0): { runner: ClaudeRunner; runs: ClaudeRun[] } {
  const runs: ClaudeRun[] = [];
  return {
    runs,
    runner: async (run) => {
      runs.push(run);
      return { stdout, stderr: "", exitCode };
    },
  };
}

async function text(adapter: { complete(r: { prompt: string }): AsyncIterable<{ type: string; text?: string }> }, prompt: string) {
  let out = "";
  for await (const event of adapter.complete({ prompt })) if (event.type === "token") out += event.text;
  return out;
}

const withKeyedAnthropic = () => parseConfig(JSON.stringify({ providers: { anthropic: { kind: "anthropic" } } }));
const failFetch = (async () => {
  throw new Error("the network must not be touched");
}) as unknown as typeof fetch;

test("with no config the planner runs claude -p on the subscription", async () => {
  const { runner, runs } = fakeRunner();
  const planner = createPlanner(defaultConfig(), { claude: { runner, env: { PATH: "/bin" } }, fetch: failFetch });

  expect(planner.route).toBe("subscription");
  expect(await text(planner.adapter, "Plan act one.")).toBe("Act one opens on the ferry.");
  expect(runs).toHaveLength(1);
  expect(runs[0]!.argv.slice(0, 3)).toEqual(["claude", "-p", "--tools"]);
  expect(runs[0]!.stdin).toBe("Plan act one.");
  expect(runs[0]!.argv).not.toContain("Plan act one.");
});

test("a configured anthropic provider with no key still plans on the subscription", () => {
  const { runner } = fakeRunner();
  const planner = createPlanner(withKeyedAnthropic(), { keys: { env: {} }, claude: { runner } });
  expect(planner.route).toBe("subscription");
});

test("an Anthropic key in the config overrides the subscription", async () => {
  const { runner, runs } = fakeRunner();
  const planner = createPlanner(withKeyedAnthropic(), {
    keys: { env: { ANTHROPIC_API_KEY: "not-a-real-key" } },
    claude: { runner },
    fetch: failFetch,
  });

  expect(planner.route).toBe("api-key");
  expect(planner.adapter.id).toBe("anthropic");
  await expect(text(planner.adapter, "x")).rejects.toThrow();
  expect(runs).toHaveLength(0);
});

test("the intents map can point the planner at a named anthropic provider", () => {
  const config = parseConfig(
    JSON.stringify({
      providers: { a: { kind: "anthropic", key: "keychain:svc/acct" }, b: { kind: "anthropic" } },
      intents: { plan: "b" },
    }),
  );
  const planner = createPlanner(config, { keys: { env: { B_API_KEY: "not-a-real-key" }, keychain: () => "unused" } });
  expect(planner.route).toBe("api-key");
  expect(planner.adapter.id).toBe("b");
});

test("the subscription env drops every credential that would outrank the login", () => {
  const env = subscriptionEnv({
    PATH: "/bin",
    ANTHROPIC_API_KEY: "k",
    ANTHROPIC_BASE_URL: "https://x",
    CLAUDE_CODE_USE_BEDROCK: "1",
    ANTHROPIC_BEDROCK_BASE_URL: "https://y",
    CLAUDE_CODE_OAUTH_TOKEN: "oat",
  });
  expect(env).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "oat" });
});

test("the child's env carries no API key even when the shell has one", async () => {
  const { runner, runs } = fakeRunner();
  const planner = createPlanner(defaultConfig(), { claude: { runner, env: { ANTHROPIC_API_KEY: "k", HOME: "/h" } } });
  await text(planner.adapter, "x");
  expect(runs[0]!.env).toEqual({ HOME: "/h" });
});

test("model and system prompt go on the argv", () => {
  expect(claudeArgs("claude-opus-x", "Be a planner.").slice(-4)).toEqual(["--system-prompt", "Be a planner.", "--model", "claude-opus-x"]);
  expect(claudeArgs(undefined, undefined)).not.toContain("--model");
});

test("every planner call is receipted, success and failure", async () => {
  const receipts: Receipt[] = [];
  const ok = fakeRunner();
  const planner = createPlanner(defaultConfig(), { receipts: (r) => void receipts.push(r), claude: { runner: ok.runner } });
  await text(planner.adapter, "Plan.");

  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({
    intent: "plan",
    provider: "claude-cli",
    tokens_read: 120,
    tokens_written: 42,
    measurement: "stream",
    error: null,
  });

  const bad = fakeRunner("not json", 1);
  const failing = createPlanner(defaultConfig(), { receipts: (r) => void receipts.push(r), claude: { runner: bad.runner } });
  await expect(text(failing.adapter, "Plan.")).rejects.toThrow(ProviderResponseError);
  expect(receipts).toHaveLength(2);
  expect(receipts[1]!.error).toMatch(/no JSON/);
});

test("an is_error reply and an empty reply are named failures", async () => {
  const errored = createPlanner(defaultConfig(), { claude: { runner: fakeRunner(reply({ is_error: true, result: "Not logged in" })).runner } });
  await expect(text(errored.adapter, "x")).rejects.toThrow(/Not logged in/);
  const empty = createPlanner(defaultConfig(), { claude: { runner: fakeRunner(reply({ result: "" })).runner } });
  await expect(text(empty.adapter, "x")).rejects.toThrow(/no content/);
});

test("the planner refuses to edit or extract", async () => {
  const planner = createPlanner(defaultConfig(), { claude: { runner: fakeRunner().runner } });
  await expect(planner.adapter.extractFacts({ text: "t", instruction: "i" })).rejects.toThrow(/never edits/);
});

test("claudeCredential is the planner's choice, shared with the harness", () => {
  expect(claudeCredential(defaultConfig(), { env: { ANTHROPIC_API_KEY: "sk-shell" } })).toEqual({ route: "subscription" });
  const keyed = claudeCredential(withKeyedAnthropic(), { env: { ANTHROPIC_API_KEY: "sk-test" } });
  expect(keyed.route).toBe("api-key");
  expect(keyed.route === "api-key" ? keyed.key : undefined).toBe("sk-test");
  expect(keyed.route === "api-key" ? keyed.provider.id : undefined).toBe("anthropic");
});
