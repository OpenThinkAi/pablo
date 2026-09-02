/**
 * The provider configuration and its file.
 *
 * pablo runs with no config file at all: the default is the local writer on
 * `127.0.0.1:8002`, no key. A file adds named providers and per-intent
 * overrides; it never contains a key, only where to find one (see `keys.ts`).
 *
 * Format — JSON at `$XDG_CONFIG_HOME/pablo/config.json`, else
 * `~/.config/pablo/config.json`. JSON because the core library has no
 * dependencies and a TOML parser would be the first one.
 *
 * ```json
 * {
 *   "default": "local",
 *   "providers": {
 *     "local":     { "endpoint": "http://127.0.0.1:8002/v1", "model": "mlx-community/gemma-4-31b-it-4bit", "local": true },
 *     "anthropic": { "endpoint": "https://api.anthropic.com/v1", "model": "claude-opus-4-1", "kind": "openai-compatible",
 *                    "key": "keychain:ANTHROPIC_API_KEY_PERSONAL/mattpardini" }
 *   },
 *   "intents": { "research": "anthropic" }
 * }
 * ```
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProviderConfigError } from "./errors";
import { keySourceFor } from "./keys";
import type { KeySource } from "./keys";

/** Which adapter drives a provider. `anthropic` (AGT-1206) registers here next. */
export type AdapterKind = "openai-compatible";

const ADAPTER_KINDS: readonly AdapterKind[] = ["openai-compatible"];

export interface ProviderConfig {
  readonly id: string;
  /** Base URL including the version prefix, no trailing slash: `http://127.0.0.1:8002/v1`. */
  readonly endpoint: string;
  readonly model: string;
  readonly kind: AdapterKind;
  /** Local endpoints are serialized (one request in flight) and preferred for drafting. */
  readonly local: boolean;
  readonly key: KeySource;
  /** Idle timeout before the endpoint is declared hung. */
  readonly timeoutMs: number;
}

export interface PabloConfig {
  /** Insertion-ordered: routing picks "the first local" and "the first cloud" from here. */
  readonly providers: ReadonlyMap<string, ProviderConfig>;
  readonly defaultProvider: string;
  /** Intent name to provider id; an unmapped intent routes by its kind. */
  readonly intents: ReadonlyMap<string, string>;
}

export const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:8002/v1";
export const DEFAULT_LOCAL_MODEL = "mlx-community/gemma-4-31b-it-4bit";
export const DEFAULT_TIMEOUT_MS = 60_000;

/** Where `loadConfig` looks when it is not told otherwise. */
export function configPath(env: Record<string, string | undefined> = process.env): string {
  const base = env["XDG_CONFIG_HOME"];
  return base ? join(base, "pablo", "config.json") : join(homedir(), ".config", "pablo", "config.json");
}

/** The out-of-box configuration: the local writer, no key, nothing to set up. */
export function defaultConfig(): PabloConfig {
  const local: ProviderConfig = {
    id: "local",
    endpoint: DEFAULT_LOCAL_ENDPOINT,
    model: DEFAULT_LOCAL_MODEL,
    kind: "openai-compatible",
    local: true,
    key: keySourceFor("local"),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  return {
    providers: new Map([[local.id, local]]),
    defaultProvider: local.id,
    intents: new Map(),
  };
}

/** Parses the config file's text. The default config is merged under it, so `local` always exists. */
export function parseConfig(text: string, source = "the config file"): PabloConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ProviderConfigError(`pablo: ${source} is not valid JSON (${(error as Error).message})`);
  }
  if (!isRecord(raw)) throw new ProviderConfigError(`pablo: ${source} must contain a JSON object`);

  const providers = new Map(defaultConfig().providers);
  const rawProviders = raw["providers"];
  if (rawProviders !== undefined) {
    if (!isRecord(rawProviders)) throw new ProviderConfigError(`pablo: ${source}: "providers" must be an object`);
    for (const [id, entry] of Object.entries(rawProviders)) {
      providers.set(id, readProvider(id, entry, source, providers.get(id)));
    }
  }

  const defaultProvider = readDefault(raw["default"], providers, source);
  const intents = readIntents(raw["intents"], providers, source);
  return { providers, defaultProvider, intents };
}

export interface LoadConfigOptions {
  /** Overrides the default location; tests and `--config` pass one. */
  readonly path?: string;
  readonly env?: Record<string, string | undefined>;
  /** Injected so tests never read the real file. Returns undefined when there is none. */
  readonly readFile?: (path: string) => string | undefined;
}

/** Reads the config file if there is one, and falls back to the default configuration if not. */
export function loadConfig(options: LoadConfigOptions = {}): PabloConfig {
  const path = options.path ?? configPath(options.env ?? process.env);
  const read = options.readFile ?? readFileIfPresent;
  const text = read(path);
  return text === undefined ? defaultConfig() : parseConfig(text, path);
}

function readFileIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ProviderConfigError(`pablo: cannot read ${path} (${(error as Error).message})`);
  }
}

function readProvider(
  id: string,
  entry: unknown,
  source: string,
  existing: ProviderConfig | undefined,
): ProviderConfig {
  const where = `${source}: provider "${id}"`;
  if (!isRecord(entry)) throw new ProviderConfigError(`pablo: ${where} must be an object`);

  const endpoint = readEndpoint(entry["endpoint"] ?? existing?.endpoint, where);
  const model = readString(entry["model"] ?? existing?.model, `${where}: "model"`);
  const kind = entry["kind"] ?? existing?.kind ?? "openai-compatible";
  if (!ADAPTER_KINDS.includes(kind as AdapterKind)) {
    throw new ProviderConfigError(`pablo: ${where}: unknown "kind" — known kinds are ${ADAPTER_KINDS.join(", ")}`);
  }
  const local = entry["local"] ?? existing?.local ?? false;
  if (typeof local !== "boolean") throw new ProviderConfigError(`pablo: ${where}: "local" must be true or false`);

  const rawTimeout = entry["timeoutMs"] ?? existing?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
    throw new ProviderConfigError(`pablo: ${where}: "timeoutMs" must be a positive number of milliseconds`);
  }

  const rawKey = entry["key"];
  if (rawKey !== undefined && typeof rawKey !== "string") {
    throw new ProviderConfigError(`pablo: ${where}: "key" must be a string`);
  }

  return {
    id,
    endpoint,
    model,
    kind: kind as AdapterKind,
    local,
    key: keySourceFor(id, rawKey, where),
    timeoutMs: rawTimeout,
  };
}

function readEndpoint(value: unknown, where: string): string {
  const endpoint = readString(value, `${where}: "endpoint"`);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ProviderConfigError(`pablo: ${where}: "endpoint" is not a URL: ${endpoint}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderConfigError(`pablo: ${where}: "endpoint" must be http or https, not ${url.protocol}`);
  }
  return endpoint.replace(/\/+$/, "");
}

function readDefault(value: unknown, providers: ReadonlyMap<string, ProviderConfig>, source: string): string {
  if (value === undefined) return "local";
  const id = readString(value, `${source}: "default"`);
  if (!providers.has(id)) throw new ProviderConfigError(`pablo: ${source}: "default" names no provider: ${id}`);
  return id;
}

function readIntents(
  value: unknown,
  providers: ReadonlyMap<string, ProviderConfig>,
  source: string,
): ReadonlyMap<string, string> {
  if (value === undefined) return new Map();
  if (!isRecord(value)) throw new ProviderConfigError(`pablo: ${source}: "intents" must be an object`);
  const intents = new Map<string, string>();
  for (const [intent, id] of Object.entries(value)) {
    const providerId = readString(id, `${source}: intent "${intent}"`);
    if (!providers.has(providerId)) {
      throw new ProviderConfigError(`pablo: ${source}: intent "${intent}" names no provider: ${providerId}`);
    }
    intents.set(intent, providerId);
  }
  return intents;
}

function readString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProviderConfigError(`pablo: ${where} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
