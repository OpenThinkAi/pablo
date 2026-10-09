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
 *     "anthropic": { "kind": "anthropic", "key": "keychain:ANTHROPIC_API_KEY_PERSONAL/mattpardini" }
 *   },
 *   "intents": { "research": "anthropic" },
 *   "readers": { "atara": { "github": "atara-login", "name": "Atara Example", "email": "atara@example.com" } }
 * }
 * ```
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProviderConfigError } from "./errors";
import { keySourceFor } from "./keys";
import type { KeySource } from "./keys";

/** Which adapter drives a provider: an OpenAI-compatible endpoint, or Anthropic's Messages API. */
export type AdapterKind = "openai-compatible" | "anthropic";

const ADAPTER_KINDS: readonly AdapterKind[] = ["openai-compatible", "anthropic"];

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
  /** Sampling temperature `write` sends when `--temperature` is not given; absent means write's own default. */
  readonly temperature?: number;
  /**
   * Whether an OpenAI-compatible endpoint may think before it answers. Absent
   * means off for a local endpoint and the server's own default otherwise.
   * Gemma 4 on mlx_lm thinks by default, and the thinking spends the same
   * `max_tokens` the answer needs: a one-sentence revise ran out mid-thought
   * and came back empty (2026-10-08). Off is also what the 2026-09-02
   * bake-off measured.
   */
  readonly thinking?: boolean;
}

/**
 * A reader of the author's chapters (AGT-1582): who `pablo share --reader <name>`
 * sends a round to. `github` is the login the PR review is requested from;
 * `name` and `email` are who the reader's suggestions are authored as when
 * `notes pull` turns them into commits.
 */
export interface ReaderConfig {
  readonly github: string;
  readonly name: string;
  readonly email: string;
}

/** A reader's config key: becomes part of a branch name (`round/<reader>-<date>`), so it is a plain slug. */
const READER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A GitHub login: alphanumerics and single hyphens, never starting with one (it is passed as a CLI argument). */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface PabloConfig {
  /** Insertion-ordered: routing picks "the first local" and "the first cloud" from here. */
  readonly providers: ReadonlyMap<string, ProviderConfig>;
  readonly defaultProvider: string;
  /** Intent name to provider id; an unmapped intent routes by its kind. */
  readonly intents: ReadonlyMap<string, string>;
  /** Readers by name (the `readers` key of the config file); empty when there are none. */
  readonly readers: ReadonlyMap<string, ReaderConfig>;
}

export const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:8002/v1";
export const DEFAULT_LOCAL_MODEL = "mlx-community/gemma-4-31b-it-4bit";
export const DEFAULT_TIMEOUT_MS = 60_000;

export const DEFAULT_ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1";
/**
 * The latest generally available model at build time (2026-09-02), read from
 * the current model list rather than recalled. A config entry may name another.
 */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";

/**
 * What `kind` implies when an entry does not say. Anthropic has one endpoint
 * and a known current model, so `{ "kind": "anthropic", "key": "keychain:..." }`
 * is a complete provider — a key and a toggle, which is the requirement.
 */
const KIND_DEFAULTS: Record<AdapterKind, { endpoint?: string; model?: string }> = {
  "openai-compatible": {},
  anthropic: { endpoint: DEFAULT_ANTHROPIC_ENDPOINT, model: DEFAULT_ANTHROPIC_MODEL },
};

/**
 * The directory pablo's own files (config, and — AGT-1240 — the global
 * `voices/` directory) live under: `$XDG_CONFIG_HOME/pablo`, else
 * `~/.config/pablo`. A sibling of `configPath` rather than a `dirname()` of
 * it, so a caller that only wants the directory says so.
 */
export function configDir(env: Record<string, string | undefined> = process.env): string {
  const base = env["XDG_CONFIG_HOME"];
  return base ? join(base, "pablo") : join(homedir(), ".config", "pablo");
}

/** Where `loadConfig` looks when it is not told otherwise. */
export function configPath(env: Record<string, string | undefined> = process.env): string {
  return join(configDir(env), "config.json");
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
    readers: new Map(),
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
  const readers = readReaders(raw["readers"], source);
  return { providers, defaultProvider, intents, readers };
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

  const kind = entry["kind"] ?? existing?.kind ?? "openai-compatible";
  if (!ADAPTER_KINDS.includes(kind as AdapterKind)) {
    throw new ProviderConfigError(`pablo: ${where}: unknown "kind" — known kinds are ${ADAPTER_KINDS.join(", ")}`);
  }
  const defaults = KIND_DEFAULTS[kind as AdapterKind];

  const endpoint = readEndpoint(entry["endpoint"] ?? existing?.endpoint ?? defaults.endpoint, where);
  const model = readString(entry["model"] ?? existing?.model ?? defaults.model, `${where}: "model"`);
  const local = entry["local"] ?? existing?.local ?? false;
  if (typeof local !== "boolean") throw new ProviderConfigError(`pablo: ${where}: "local" must be true or false`);

  const rawTimeout = entry["timeoutMs"] ?? existing?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout <= 0) {
    throw new ProviderConfigError(`pablo: ${where}: "timeoutMs" must be a positive number of milliseconds`);
  }

  const rawTemperature = entry["temperature"] ?? existing?.temperature;
  if (
    rawTemperature !== undefined &&
    (typeof rawTemperature !== "number" || !Number.isFinite(rawTemperature) || rawTemperature < 0 || rawTemperature > 2)
  ) {
    throw new ProviderConfigError(`pablo: ${where}: "temperature" must be a number from 0 to 2`);
  }

  const thinking = entry["thinking"] ?? existing?.thinking;
  if (thinking !== undefined && typeof thinking !== "boolean") {
    throw new ProviderConfigError(`pablo: ${where}: "thinking" must be true or false`);
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
    ...(rawTemperature === undefined ? {} : { temperature: rawTemperature }),
    ...(thinking === undefined ? {} : { thinking }),
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

function readReaders(value: unknown, source: string): ReadonlyMap<string, ReaderConfig> {
  if (value === undefined) return new Map();
  if (!isRecord(value)) throw new ProviderConfigError(`pablo: ${source}: "readers" must be an object`);
  const readers = new Map<string, ReaderConfig>();
  for (const [name, entry] of Object.entries(value)) {
    const where = `${source}: reader "${name}"`;
    if (!READER_NAME.test(name)) {
      throw new ProviderConfigError(`pablo: ${where}: the name must be lowercase letters, digits and hyphens`);
    }
    if (!isRecord(entry)) throw new ProviderConfigError(`pablo: ${where} must be an object`);
    const github = readString(entry["github"], `${where}: "github"`);
    if (!GITHUB_LOGIN.test(github)) throw new ProviderConfigError(`pablo: ${where}: "github" is not a GitHub login: ${github}`);
    const readerName = readString(entry["name"], `${where}: "name"`);
    const email = readString(entry["email"], `${where}: "email"`);
    // Both end up in git identity arguments (`notes pull`): no control characters, newlines or surrounding space.
    if (/[\u0000-\u001f\u007f]/.test(readerName) || readerName !== readerName.trim()) {
      throw new ProviderConfigError(`pablo: ${where}: "name" must be one line with no control characters or surrounding space`);
    }
    if (!/^[^\s@<>,;:"'\\]+@[^\s@<>,;:"'\\]+\.[^\s@<>,;:"'\\]+$/.test(email)) {
      throw new ProviderConfigError(`pablo: ${where}: "email" is not an email address`);
    }
    readers.set(name, { github, name: readerName, email });
  }
  return readers;
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
