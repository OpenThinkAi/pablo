/**
 * A config with one local OpenAI-compatible provider, for tests that need a
 * provider to route to. pablo itself ships none (AGT-2131): `defaultConfig()`
 * has no providers, so a test that wants one says so here.
 */
import { afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "@openthink/pablo-core";
import type { PabloConfig } from "@openthink/pablo-core";

export const TEST_LOCAL_PROVIDER = { endpoint: "http://127.0.0.1:8002/v1", model: "test-local-model", local: true } as const;

export function localConfig(): PabloConfig {
  return parseConfig(JSON.stringify({ providers: { local: TEST_LOCAL_PROVIDER } }));
}

/** Writes a config with the local test provider to `<xdgHome>/pablo/config.json`. */
export function writeLocalConfig(xdgHome: string): void {
  mkdirSync(join(xdgHome, "pablo"), { recursive: true });
  writeFileSync(join(xdgHome, "pablo", "config.json"), JSON.stringify({ providers: { local: TEST_LOCAL_PROVIDER } }));
}

/**
 * Points this process's XDG_CONFIG_HOME at a fresh temp dir holding the local
 * test provider, for tests whose code under test reads the ambient environment.
 * The machine's real ~/.config/pablo is never read.
 */
export function useLocalConfigHome(): void {
  const home = mkdtempSync(join(tmpdir(), "pablo-test-xdg-"));
  const previous = process.env["XDG_CONFIG_HOME"];
  writeLocalConfig(home);
  process.env["XDG_CONFIG_HOME"] = home;
  afterAll(() => {
    if (previous === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = previous;
    rmSync(home, { recursive: true, force: true });
  });
}

const TEST_ANTHROPIC = { endpoint: "https://api.anthropic.com/v1", model: "test-anthropic-model" } as const;

/**
 * Config text for tests written when pablo had built-in defaults: a `local`
 * entry is laid over the test local provider, and an `anthropic`-kind entry
 * without an endpoint or model gets the test ones.
 */
export function configTextWithTestDefaults(text: string): string {
  const raw = JSON.parse(text) as { providers?: Record<string, Record<string, unknown>> };
  const providers: Record<string, Record<string, unknown>> = { local: { ...TEST_LOCAL_PROVIDER, ...raw.providers?.["local"] } };
  for (const [id, entry] of Object.entries(raw.providers ?? {})) {
    if (id !== "local") providers[id] = entry["kind"] === "anthropic" ? { ...TEST_ANTHROPIC, ...entry } : entry;
  }
  return JSON.stringify({ ...raw, providers });
}

export function parseWithTestDefaults(text: string, source?: string): PabloConfig {
  return parseConfig(configTextWithTestDefaults(text), source);
}
