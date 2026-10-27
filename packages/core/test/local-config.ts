/**
 * A config with one local OpenAI-compatible provider, for tests that need a
 * provider to route to. pablo itself ships none (AGT-2131): `defaultConfig()`
 * has no providers, so a test that wants one says so here.
 */
import { parseConfig } from "../src/index";
import type { PabloConfig } from "../src/index";

export const TEST_LOCAL_ENDPOINT = "http://127.0.0.1:8002/v1";
export const TEST_LOCAL_MODEL = "test-local-model";
export const TEST_ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1";
export const TEST_ANTHROPIC_MODEL = "test-anthropic-model";

/** The provider entry itself, for a config document that spreads it in. */
export const TEST_LOCAL_PROVIDER = { endpoint: TEST_LOCAL_ENDPOINT, model: TEST_LOCAL_MODEL, local: true } as const;

export function localConfig(): PabloConfig {
  return parseConfig(JSON.stringify({ providers: { local: TEST_LOCAL_PROVIDER } }));
}

/**
 * `parseConfig` for tests written when pablo had built-in defaults: a `local`
 * entry is laid over the test local provider, and an `anthropic`-kind entry
 * without an endpoint or model gets the test ones, so a test names only what
 * it is about.
 */
export function parseWithTestDefaults(text: string, source?: string): PabloConfig {
  const raw = JSON.parse(text) as { providers?: Record<string, Record<string, unknown>> };
  const providers: Record<string, Record<string, unknown>> = { local: { ...TEST_LOCAL_PROVIDER, ...raw.providers?.["local"] } };
  for (const [id, entry] of Object.entries(raw.providers ?? {})) {
    if (id === "local") continue;
    providers[id] =
      entry["kind"] === "anthropic"
        ? { endpoint: TEST_ANTHROPIC_ENDPOINT, model: TEST_ANTHROPIC_MODEL, ...entry }
        : entry;
  }
  return parseConfig(JSON.stringify({ ...raw, providers }), source);
}
