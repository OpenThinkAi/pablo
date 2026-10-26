/**
 * The planner role (D-12, D-13): an intent routed like every other model call,
 * on any provider kind, every call receipted. There is no `claude -p` path.
 * The local model is an in-process fake endpoint; cloud providers get a fetch
 * that fails, so no test reaches the network or reads the Keychain.
 */

import { expect, test } from "bun:test";
import { CHECK_INTENT, createPlanner, parseConfig, defaultConfig } from "../src/index";
import type { Receipt } from "../src/index";
import { startFakeEndpoint } from "./fake-endpoint";

async function text(adapter: { complete(r: { prompt: string }): AsyncIterable<{ type: string; text?: string }> }, prompt: string) {
  let out = "";
  for await (const event of adapter.complete({ prompt })) if (event.type === "token") out += event.text;
  return out;
}

const failFetch = (async () => {
  throw new Error("the network must not be touched");
}) as unknown as typeof fetch;
const quiet = { onSkip: () => {} };

test("with no cloud provider the planner runs on the default (local) provider", async () => {
  const fake = startFakeEndpoint({ tokens: ["Act one ", "opens on the ferry."] });
  try {
    const config = parseConfig(JSON.stringify({ providers: { local: { endpoint: fake.url, model: "fake-writer" } } }));
    const planner = createPlanner(config, { keys: { env: {} } });
    expect(planner.provider).toBe("local");
    expect(await text(planner.adapter, "Plan act one.")).toBe("Act one opens on the ferry.");
    expect(fake.requests).toHaveLength(1);
  } finally {
    fake.stop();
  }
});

test("an anthropic provider whose key resolves takes the planner", () => {
  const config = parseConfig(JSON.stringify({ providers: { anthropic: { kind: "anthropic" } } }));
  const planner = createPlanner(config, { keys: { env: { ANTHROPIC_API_KEY: "not-a-real-key" } }, fetch: failFetch });
  expect(planner.provider).toBe("anthropic");
  expect(planner.adapter.id).toBe("anthropic");
});

test("an anthropic provider with no key is skipped, not a Claude-login fallback", () => {
  const config = parseConfig(JSON.stringify({ providers: { anthropic: { kind: "anthropic" } } }));
  const skipped: string[] = [];
  const planner = createPlanner(config, { keys: { env: {} }, onSkip: (s) => void skipped.push(s.provider) });
  expect(planner.provider).toBe("local");
  expect(skipped).toEqual(["anthropic"]);
});

test("the plan intent can map to an OpenAI-compatible cloud provider", () => {
  const config = parseConfig(
    JSON.stringify({
      providers: {
        anthropic: { kind: "anthropic" },
        cloud: { endpoint: "https://api.example.com/v1", model: "big-planner", key: "env:CLOUD_KEY" },
      },
      intents: { plan: "cloud" },
    }),
  );
  const planner = createPlanner(config, { keys: { env: { ANTHROPIC_API_KEY: "a", CLOUD_KEY: "c" } }, fetch: failFetch, ...quiet });
  expect(planner.provider).toBe("cloud");
});

test("check follows the plan mapping until it is mapped itself", () => {
  const providers = {
    a: { kind: "anthropic", key: "env:A_KEY" },
    b: { kind: "anthropic", key: "env:B_KEY" },
  };
  const keys = { env: { A_KEY: "x", B_KEY: "y" } };
  const planOnly = parseConfig(JSON.stringify({ providers, intents: { plan: "b" } }));
  expect(createPlanner(planOnly, { keys, intent: CHECK_INTENT }).provider).toBe("b");
  const both = parseConfig(JSON.stringify({ providers, intents: { plan: "b", check: "a" } }));
  expect(createPlanner(both, { keys, intent: CHECK_INTENT }).provider).toBe("a");
  expect(createPlanner(both, { keys }).provider).toBe("b");
});

test("every planner call is receipted under its intent", async () => {
  const fake = startFakeEndpoint({ usage: { prompt_tokens: 120, completion_tokens: 42 } });
  try {
    const config = parseConfig(JSON.stringify({ providers: { local: { endpoint: fake.url, model: "fake-writer" } } }));
    const receipts: Receipt[] = [];
    await text(createPlanner(config, { receipts: (r) => void receipts.push(r) }).adapter, "Plan.");
    await text(createPlanner(config, { receipts: (r) => void receipts.push(r), intent: CHECK_INTENT }).adapter, "Judge.");
    expect(receipts.map((r) => [r.intent, r.provider, r.error])).toEqual([
      ["plan", "local", null],
      ["check", "local", null],
    ]);
  } finally {
    fake.stop();
  }
});

test("the default config builds a planner without touching a key", () => {
  expect(createPlanner(defaultConfig(), { keys: { env: {} } }).provider).toBe("local");
});
