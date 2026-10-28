/**
 * The provider configuration and its file.
 *
 * pablo has no built-in model (AGT-2131, D-13): with no config file there are
 * no providers, and a verb that needs a model refuses with a pointer to
 * `pablo init --config` (`NoModelConfiguredError`, thrown by `route`), which
 * writes a documented starter file. The file names providers and per-intent overrides;
 * it never contains a key, only where to find one (see `keys.ts`).
 *
 * Format — JSON at `$XDG_CONFIG_HOME/pablo/config.json`, else
 * `~/.config/pablo/config.json`. JSON because the core library has no
 * dependencies and a TOML parser would be the first one.
 *
 * ```json
 * {
 *   "default": "local",
 *   "providers": {
 *     "local":     { "endpoint": "http://127.0.0.1:8002/v1", "model": "my-local-model", "local": true },
 *     "anthropic": { "kind": "anthropic", "endpoint": "https://api.anthropic.com/v1", "model": "<model id>", "key": "env:ANTHROPIC_API_KEY" }
 *   },
 *   "intents": { "research": "anthropic" }
 * }
 * ```
 *
 * A work may route its own models (AGT-2129, decision D-13): its `pablo.json`
 * may carry `providers` and `intents` in the same shape, and
 * `loadConfig({ projectDir })` merges them over the global file — a provider
 * entry over the global one of the same name (fields it does not set are
 * kept, its key reference included), an intent over the global mapping.
 * pablo.json is trusted less than the global file: it may add or change
 * providers on this machine, but on a remote provider only `model`,
 * `timeoutMs`, `temperature`, `thinking` and `tools` (`checkWorkProvider`).
 * It may not set `key` at all (AGT-2228, decision D-4): keys are bound only in
 * the global file. A provider it overrides keeps the global entry's key unless
 * it changes the provider's `endpoint`, `kind` or `local` (AGT-2230): then, like
 * one it adds, it has none (`{ from: "none" }`), not even the `<ID>_API_KEY`
 * convention.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ProviderConfigError } from "./errors";
import { keySourceFor } from "./keys";
import { readWebConfig } from "../web/search";
import type { WebConfig } from "../web/search";
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
   * Whether the endpoint may think before it answers. `false` on an
   * OpenAI-compatible provider sends `chat_template_kwargs.enable_thinking` and
   * DeepSeek's `thinking: {type: "disabled"}`; on an `anthropic` provider it
   * sends `thinking: {type: "disabled"}` (unset sends nothing). Absent means off
   * for a local OpenAI-compatible endpoint and the server's own default otherwise.
   * Gemma 4 on mlx_lm thinks by default, and the thinking spends the same
   * `max_tokens` the answer needs: a one-sentence revise ran out mid-thought
   * and came back empty (2026-10-08). Off is also what the 2026-09-02
   * bake-off measured.
   */
  readonly thinking?: boolean;
  /**
   * Whether the endpoint takes native tool calls. `false` makes `chat()` refuse
   * a turn that offers tools with `ToolsDisabledError` (AGT-2117, D-12), for a
   * server whose template or parser has no tool support, rather than sending
   * tools it would ignore or mangle. Absent means tools are sent.
   */
  readonly tools?: boolean;
}

export interface PabloConfig {
  /** Insertion-ordered: routing picks "the first local" and "the first cloud" from here. */
  readonly providers: ReadonlyMap<string, ProviderConfig>;
  readonly defaultProvider: string;
  /** Intent name to provider id; an unmapped intent routes by its kind. */
  readonly intents: ReadonlyMap<string, string>;
  /** The `web` key: `web.search` names the `web_search` backend. Absent when not configured. */
  readonly web?: WebConfig;
}

export const DEFAULT_TIMEOUT_MS = 60_000;

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

/**
 * The out-of-box configuration: no providers at all. Nothing here names an
 * endpoint or a model; the author's config (or `pablo init --config`'s starter)
 * does. `route` refuses on it with `NoModelConfiguredError`.
 */
export function defaultConfig(): PabloConfig {
  return { providers: new Map(), defaultProvider: "", intents: new Map() };
}

/**
 * Options for the loaders. `allowIncomplete` lets a provider entry lack its
 * `endpoint` or `model`: `pablo config set` validates each edit with it, so a
 * provider can be built up one field at a time. Nothing routes on such a
 * config; the loaders every verb uses refuse the incomplete entry by name.
 */
export interface ParseOptions {
  readonly allowIncomplete?: boolean;
  /**
   * Told when a work's pablo.json repoints a global provider that had a key, so the merged provider has none
   * (AGT-2274). The default writes `keyDropNotice` to stderr, once per provider and file per process.
   */
  readonly onKeyDropped?: (dropped: DroppedKey) => void;
  /** Where an `env:` key is looked up to decide whether a dropped one mattered; defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
}

/** A global provider whose key a work's pablo.json dropped by changing its endpoint, kind or local flag. */
export interface DroppedKey {
  readonly provider: string;
  /** The pablo.json that repointed it. */
  readonly source: string;
  /** What it changed: some of "endpoint", "kind", "local". */
  readonly changed: readonly string[];
  /** The global key reference that is no longer sent: `env:<NAME>` or `keychain:<service>`. */
  readonly key: string;
}

/** The default one-line notice for a dropped key: which provider, why, and the fix. */
export function keyDropNotice(dropped: DroppedKey): string {
  const fields = dropped.changed.join(", ");
  const commands = dropped.changed.map((field) => `\`pablo config set providers.${dropped.provider}.${field} <value>\``).join(", ");
  return (
    `pablo: ${dropped.source} changes provider "${dropped.provider}"'s ${fields}, so its global key (${dropped.key}) is not sent ` +
    `and it has none. If that server needs a key, move the change to the global config, where keys are bound ` +
    `(${commands}, without --project), and drop it from ${dropped.source}.`
  );
}

const toldDropped = new Set<string>();

/** Parses the config file's text. */
export function parseConfig(text: string, source = "the config file", options: ParseOptions = {}): PabloConfig {
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
      providers.set(id, readProvider(id, entry, source, providers.get(id), options.allowIncomplete === true));
    }
  }

  const defaultProvider = readDefault(raw["default"], providers, source);
  const intents = readIntents(raw["intents"], providers, source);
  const web = readWebConfig(raw["web"], source);
  return { providers, defaultProvider, intents, web };
}

export interface LoadConfigOptions extends ParseOptions {
  /** Overrides the default location; tests and `--config` pass one. */
  readonly path?: string;
  readonly env?: Record<string, string | undefined>;
  /** Injected so tests never read the real file. Returns undefined when there is none. */
  readonly readFile?: (path: string) => string | undefined;
  /** The work whose `pablo.json` `providers` and `intents` are merged over the global file; absent means global only. */
  readonly projectDir?: string;
  /** Reads `<projectDir>/pablo.json`; injected by tests. Returns undefined when there is none. */
  readonly readProjectFile?: (path: string) => string | undefined;
}

/**
 * Reads the config file if there is one, and falls back to the default
 * configuration if not; with `projectDir`, the work's `pablo.json` routing is
 * merged over it (`mergeProjectConfig`).
 */
export function loadConfig(options: LoadConfigOptions = {}): PabloConfig {
  const path = options.path ?? configPath(options.env ?? process.env);
  const read = options.readFile ?? readFileIfPresent;
  const text = read(path);
  const global = text === undefined ? defaultConfig() : parseConfig(text, path, options);
  if (options.projectDir === undefined) return global;
  const projectPath = join(options.projectDir, "pablo.json");
  const projectText = (options.readProjectFile ?? readFileIfPresent)(projectPath);
  return projectText === undefined ? global : mergeProjectConfig(global, projectText, projectPath, options);
}

/**
 * Merges a work's `pablo.json` `providers` and `intents` over `base`. Only
 * those two keys are read; the rest of the marker is `readMarker`'s. A
 * provider entry is validated as the global file's are, except that it may
 * not set `key` (`refuseWorkKey`); an intent must name a provider of the
 * merged set.
 *
 * The global file is the author's own; `pablo.json` is committed and can
 * arrive from a co-author, a clone or a merged branch, so it is trusted less
 * (`checkWorkProvider`): it decides which provider each intent uses, but only
 * the global file decides which remote host a credential goes to.
 */
export function mergeProjectConfig(base: PabloConfig, text: string, source = "pablo.json", options: ParseOptions = {}): PabloConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ProviderConfigError(`pablo: ${source} is not valid JSON (${(error as Error).message})`);
  }
  if (!isRecord(raw)) throw new ProviderConfigError(`pablo: ${source} must contain a JSON object`);
  if (raw["providers"] === undefined && raw["intents"] === undefined) return base;

  const providers = new Map(base.providers);
  const rawProviders = raw["providers"];
  if (rawProviders !== undefined) {
    if (!isRecord(rawProviders)) throw new ProviderConfigError(`pablo: ${source}: "providers" must be an object`);
    for (const [id, entry] of Object.entries(rawProviders)) {
      const existing = providers.get(id);
      refuseWorkKey(id, entry, source);
      const read = readProvider(id, entry, source, existing, options.allowIncomplete === true);
      // Overriding a global provider keeps its key (readProvider inherits it); a provider the work adds has none,
      // and so does one whose endpoint, kind or local flag the work changes (`repoints`): the global key was bound
      // to the global endpoint, and a work must not send it to another port of its choosing (AGT-2230).
      const repointed = existing !== undefined && repoints(read, existing);
      const merged: ProviderConfig = existing === undefined || repointed ? { ...read, key: { from: "none" } } : read;
      checkWorkProvider(merged, existing, source);
      providers.set(id, merged);
      if (repointed) noticeDroppedKey(id, read, existing, source, options);
    }
  }
  const intents = new Map(base.intents);
  for (const [intent, id] of readIntents(raw["intents"], providers, source)) intents.set(intent, id);
  // A work may be the only place providers come from (no global file): the default is then its first.
  const defaultProvider = base.defaultProvider !== "" ? base.defaultProvider : (providers.keys().next().value ?? "");
  return { ...base, providers, intents, defaultProvider };
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
  allowIncomplete = false,
): ProviderConfig {
  const where = `${source}: provider "${id}"`;
  if (!isRecord(entry)) throw new ProviderConfigError(`pablo: ${where} must be an object`);

  const kind = entry["kind"] ?? existing?.kind ?? "openai-compatible";
  if (!ADAPTER_KINDS.includes(kind as AdapterKind)) {
    throw new ProviderConfigError(`pablo: ${where}: unknown "kind" — known kinds are ${ADAPTER_KINDS.join(", ")}`);
  }

  const rawEndpoint = entry["endpoint"] ?? existing?.endpoint;
  const rawModel = entry["model"] ?? existing?.model;
  if (!allowIncomplete && (rawEndpoint === undefined || rawModel === undefined)) {
    const missing = [rawEndpoint === undefined ? '"endpoint"' : "", rawModel === undefined ? '"model"' : ""].filter(Boolean).join(" and ");
    throw new ProviderConfigError(
      `pablo: ${where}: ${missing} must be set — pablo has no built-in endpoint or model (not even for kind "anthropic"). ` +
        `Run \`pablo init --config\` for a starter to copy, or \`pablo config set providers.${id}.<field> <value>\`.`,
    );
  }
  const endpoint = allowIncomplete && rawEndpoint === undefined ? "" : readEndpoint(rawEndpoint, where);
  const model = allowIncomplete && rawModel === undefined ? "" : readString(rawModel, `${where}: "model"`);
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

  const tools = entry["tools"] ?? existing?.tools;
  if (tools !== undefined && typeof tools !== "boolean") {
    throw new ProviderConfigError(`pablo: ${where}: "tools" must be true or false`);
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
    // An entry that names no key keeps the reference of the entry it overrides (a work's
    // pablo.json changing only a model must not drop the global keychain reference).
    key: rawKey === undefined && existing !== undefined ? existing.key : keySourceFor(id, rawKey, where),
    timeoutMs: rawTimeout,
    ...(rawTemperature === undefined ? {} : { temperature: rawTemperature }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(tools === undefined ? {} : { tools }),
  };
}

/** The fields a work may change on a provider whose endpoint is remote: none of them say where a request (and its key) goes. */
const WORK_SAFE_FIELDS = ["model", "timeoutMs", "temperature", "thinking", "tools"] as const;

/** `127.0.0.1` (any `127.x`), `localhost` or `::1`: a request to it never leaves the machine. */
export function isLoopbackEndpoint(endpoint: string): boolean {
  const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Refuses a `key` on a work's provider entry, whatever it names (AGT-2228,
 * D-4). Judged on the raw entry, not the merged provider, which legitimately
 * carries the global key. A key reference in a committed file would let it
 * choose which secret (any environment variable, any Keychain item) goes to
 * the endpoint it names.
 */
export function refuseWorkKey(id: string, entry: unknown, source: string): void {
  if (!isRecord(entry) || entry["key"] === undefined) return;
  throw new ProviderConfigError(
    `pablo: ${source}: provider "${id}": a work's pablo.json may not set "key". Keys are set in the global config ` +
      `(\`pablo config set providers.${id}.key env:<NAME>\` or \`keychain:<service>\`, without --project); ` +
      `a work's provider uses the key of the global provider of the same name, or none. Remove "key" from ${source}.`,
  );
}

/**
 * Says so when a repoint dropped a key that would have been sent (AGT-2274): a Keychain reference, or an
 * `env:` variable that is set. An unset variable (often the `<ID>_API_KEY` convention on a server that needs
 * no auth) sent nothing before either, so it gets no notice.
 */
function noticeDroppedKey(id: string, read: ProviderConfig, existing: ProviderConfig, source: string, options: ParseOptions): void {
  const key = existing.key;
  if (key.from === "none") return;
  if (key.from === "env" && !(options.env ?? process.env)[key.variable]) return;
  const changed = [
    read.endpoint !== existing.endpoint ? "endpoint" : "",
    read.kind !== existing.kind ? "kind" : "",
    read.local !== existing.local ? "local" : "",
  ].filter(Boolean);
  const dropped: DroppedKey = {
    provider: id,
    source,
    changed,
    key: key.from === "env" ? `env:${key.variable}` : `keychain:${key.service}${key.account === undefined ? "" : `/${key.account}`}`,
  };
  if (options.onKeyDropped !== undefined) return options.onKeyDropped(dropped);
  const told = `${source}\0${id}`;
  if (toldDropped.has(told)) return;
  toldDropped.add(told);
  process.stderr.write(`${keyDropNotice(dropped)}\n`);
}

/** Whether a work's entry changes where (or how) the global provider's requests go, rather than only what they ask. */
function repoints(read: ProviderConfig, existing: ProviderConfig): boolean {
  if (read.endpoint === "") return false; // incomplete (a `config set` in progress): nothing to judge yet
  return read.endpoint !== existing.endpoint || read.kind !== existing.kind || read.local !== existing.local;
}

function sameKey(a: KeySource, b: KeySource): boolean {
  if (a.from === "none" || b.from === "none") return a.from === b.from;
  return a.from === "env" && b.from === "env"
    ? a.variable === b.variable
    : a.from === "keychain" && b.from === "keychain" && a.service === b.service && a.account === b.account;
}

/**
 * Refuses a work's provider entry that would choose where a credential is
 * sent: a new provider on a remote endpoint, or a change to a remote
 * provider's `endpoint`, `kind`, `local` or `key`. Providers on loopback
 * endpoints (a local model server) are the work's to define and change,
 * except their key (`refuseWorkKey` has already refused one).
 */
function checkWorkProvider(merged: ProviderConfig, existing: ProviderConfig | undefined, source: string): void {
  const where = `pablo: ${source}: provider "${merged.id}"`;
  if (merged.endpoint === "") return; // incomplete (a `config set` in progress): no endpoint to judge yet
  const remote = !isLoopbackEndpoint(merged.endpoint);
  if (existing === undefined) {
    if (remote) {
      throw new ProviderConfigError(
        `${where}: a work may add only a provider on this machine (127.0.0.1, localhost or ::1), not ${merged.endpoint}. ` +
          `Declare a remote provider in the global config and route intents to it from pablo.json.`,
      );
    }
    return;
  }
  if (!remote && isLoopbackEndpoint(existing.endpoint)) return;
  const changed =
    merged.endpoint !== existing.endpoint || merged.kind !== existing.kind || merged.local !== existing.local || !sameKey(merged.key, existing.key);
  if (changed) {
    throw new ProviderConfigError(
      `${where}: a work may change only ${WORK_SAFE_FIELDS.map((f) => `"${f}"`).join(", ")} on a provider that is not on this machine; ` +
        `"endpoint", "kind", "local" and "key" are set in the global config.`,
    );
  }
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
  if (value === undefined) return providers.keys().next().value ?? "";
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
