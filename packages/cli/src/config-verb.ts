/**
 * `pablo config show|set|test` (AGT-2130, D-13): find, edit and check the model
 * config without reading the docs.
 *
 * - `show [--project <slug>]` prints the merged providers and the intent
 *   routing. A key is shown as its reference (`env:NAME`, `keychain:svc/acct`),
 *   never as a value: this module never calls `resolveKey`.
 * - `set <path> <value> [--project <slug>]` edits `config.json` (global) or the
 *   work's `pablo.json`. The edited file is validated by the same loaders that
 *   read it before it is written, so a bad edit is refused and changes nothing.
 * - `test` sends one tiny request per mapped intent and reports ok or error per
 *   provider. The adapter lookup is a seam (`ConfigTestDeps.adapterFor`), so no
 *   test touches a model.
 *
 * Every file path comes from `env` (`XDG_CONFIG_HOME`) or the project
 * directory: nothing here reads a hard-coded location.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  configPath,
  createProviders,
  loadConfig,
  mergeProjectConfig,
  parseConfig,
  NoModelConfiguredError,
  ProviderConfigError,
  route,
} from "@openthink/pablo-core";
import type { Adapter, Intent, PabloConfig, ProviderConfig, ProvidersOptions } from "@openthink/pablo-core";

type Env = Record<string, string | undefined>;

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_REFUSED = 2;

export interface ConfigResult {
  readonly exitCode: number;
  readonly body: Record<string, unknown>;
  readonly text: string;
}

/** The intents pablo routes today, with the kind that decides where an unmapped one goes. */
const KNOWN_INTENTS: readonly Intent[] = [
  { name: "plan", kind: "planning" },
  { name: "draft", kind: "drafting" },
  { name: "revise", kind: "revising" },
  { name: "prose", kind: "copy" },
  { name: "continuity", kind: "extraction" },
  { name: "research", kind: "planning" },
  { name: "agent", kind: "planning" },
  { name: "check", kind: "planning" },
];

const NUMBER_FIELDS = new Set(["timeoutMs", "temperature"]);
const BOOLEAN_FIELDS = new Set(["local", "thinking"]);
const PROVIDER_FIELDS = ["kind", "endpoint", "model", "local", "key", "timeoutMs", "temperature", "thinking"] as const;

function refuse(message: string): ConfigResult {
  return { exitCode: EXIT_REFUSED, body: { ok: false, message }, text: message };
}

function failure(error: unknown): ConfigResult {
  if (error instanceof ProviderConfigError) return refuse(error.message);
  throw error;
}

/** A key as the config names it: never its value. */
export function keyReference(provider: ProviderConfig): string {
  const key = provider.key;
  if (key.from === "none") return "none";
  if (key.from === "env") return `env:${key.variable}`;
  return key.account === undefined ? `keychain:${key.service}` : `keychain:${key.service}/${key.account}`;
}

function readIfPresent(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export interface ConfigScope {
  readonly env: Env;
  /** The work's directory when `--project` was given. */
  readonly projectDir?: string;
}

function loadMerged(scope: ConfigScope): PabloConfig {
  return loadConfig({ env: scope.env, ...(scope.projectDir === undefined ? {} : { projectDir: scope.projectDir }) });
}

export function configShow(scope: ConfigScope): ConfigResult {
  let config: PabloConfig;
  try {
    config = loadMerged(scope);
  } catch (error) {
    return failure(error);
  }
  const globalFile = configPath(scope.env);
  const providers = [...config.providers.values()].map((p) => ({
    id: p.id,
    kind: p.kind,
    endpoint: p.endpoint,
    model: p.model,
    local: p.local,
    key: keyReference(p),
    timeoutMs: p.timeoutMs,
    ...(p.temperature === undefined ? {} : { temperature: p.temperature }),
    ...(p.thinking === undefined ? {} : { thinking: p.thinking }),
  }));
  const seen = new Set<string>();
  const intents: { intent: string; provider: string; mapped: boolean }[] = [];
  for (const [intent, provider] of config.intents) {
    seen.add(intent);
    intents.push({ intent, provider, mapped: true });
  }
  for (const known of KNOWN_INTENTS) {
    if (seen.has(known.name)) continue;
    // With no provider configured an unmapped intent routes nowhere: show that rather than refuse the whole listing.
    let provider = "(none)";
    try {
      provider = route(config, known);
    } catch (error) {
      if (!(error instanceof NoModelConfiguredError)) throw error;
    }
    intents.push({ intent: known.name, provider, mapped: false });
  }
  const body = {
    ok: true,
    file: globalFile,
    ...(scope.projectDir === undefined ? {} : { project: join(scope.projectDir, "pablo.json") }),
    default: config.defaultProvider,
    providers,
    intents,
  };
  const lines = [
    `config: ${globalFile}${existsSync(globalFile) ? "" : " (not present: no model configured; `pablo init --config` writes a starter)"}`,
    ...(scope.projectDir === undefined ? [] : [`project: ${join(scope.projectDir, "pablo.json")}`]),
    `default: ${config.defaultProvider === "" ? "(none)" : config.defaultProvider}`,
    "",
    "providers:",
    ...providers.map((p) => {
      const extra = [
        p.temperature === undefined ? "" : ` temperature=${p.temperature}`,
        p.thinking === undefined ? "" : ` thinking=${p.thinking}`,
      ].join("");
      return `  ${p.id}  ${p.kind}${p.local ? " local" : ""}  ${p.endpoint}  model=${p.model}  key=${p.key}  timeoutMs=${p.timeoutMs}${extra}`;
    }),
    "",
    "intents:",
    ...intents.map((i) => `  ${i.intent} -> ${i.provider}${i.mapped ? "" : " (by kind)"}`),
  ];
  return { exitCode: EXIT_OK, body, text: lines.join("\n") };
}

function coerce(field: string, raw: string, where: string): unknown {
  if (NUMBER_FIELDS.has(field)) {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) throw new ProviderConfigError(`pablo: ${where}: "${field}" must be a number, not "${raw}"`);
    return n;
  }
  if (BOOLEAN_FIELDS.has(field)) {
    if (raw !== "true" && raw !== "false") throw new ProviderConfigError(`pablo: ${where}: "${field}" must be true or false, not "${raw}"`);
    return raw === "true";
  }
  return raw;
}

const SET_USAGE =
  "pablo config set <path> <value> [--project <slug>]: <path> is default, intents.<intent> or providers.<id>.<field> " +
  `(fields: ${PROVIDER_FIELDS.join(", ")}); --project edits the work's pablo.json instead of the global config`;

/** Applies `path = value` to a parsed config document. Pure; throws `ProviderConfigError` on a path pablo does not edit. */
export function applySet(doc: Record<string, unknown>, path: string, value: string, project: boolean): void {
  const parts = path.split(".");
  const head = parts[0];
  if (head === "default" && parts.length === 1) {
    if (project) throw new ProviderConfigError(`pablo: "default" is set in the global config, not a work's pablo.json (drop --project)`);
    doc["default"] = value;
    return;
  }
  if (head === "intents" && parts.length === 2 && parts[1] !== "") {
    const intents = (doc["intents"] ??= {}) as Record<string, unknown>;
    intents[parts[1] as string] = value;
    return;
  }
  if (head === "providers" && parts.length === 3 && parts[1] !== "") {
    const field = parts[2] as string;
    if (!(PROVIDER_FIELDS as readonly string[]).includes(field)) {
      throw new ProviderConfigError(`pablo: unknown provider field "${field}" — ${SET_USAGE}`);
    }
    const providers = (doc["providers"] ??= {}) as Record<string, unknown>;
    const entry = (providers[parts[1] as string] ??= {}) as Record<string, unknown>;
    entry[field] = coerce(field, value, `provider "${parts[1]}"`);
    return;
  }
  throw new ProviderConfigError(`pablo: cannot set "${path}" — ${SET_USAGE}`);
}

export function configSet(scope: ConfigScope, path: string | undefined, value: string | undefined): ConfigResult {
  if (path === undefined || value === undefined) return refuse(`pablo: config set needs a path and a value — ${SET_USAGE}`);
  const project = scope.projectDir !== undefined;
  const file = project ? join(scope.projectDir as string, "pablo.json") : configPath(scope.env);
  try {
    const existing = readIfPresent(file);
    let doc: Record<string, unknown> = {};
    if (existing !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing);
      } catch (error) {
        throw new ProviderConfigError(`pablo: ${file} is not valid JSON (${(error as Error).message}); fix it by hand first`);
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ProviderConfigError(`pablo: ${file} must contain a JSON object`);
      }
      doc = parsed as Record<string, unknown>;
    }
    applySet(doc, path, value, project);
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    // Validate with the loaders that will read it; nothing is written when they refuse.
    // `allowIncomplete`: a provider is built up one field at a time, so a missing endpoint or model is
    // fine here; every verb that routes to it refuses it by name.
    const lenient = { allowIncomplete: true };
    if (project) mergeProjectConfig(loadConfig({ env: scope.env, ...lenient }), text, file, lenient);
    else parseConfig(text, file, lenient);
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    writeFileSync(temp, text);
    renameSync(temp, file);
    return { exitCode: EXIT_OK, body: { ok: true, file, path, value }, text: `set ${path} = ${value} in ${file}` };
  } catch (error) {
    return failure(error);
  }
}

export interface ConfigTestDeps {
  /** The adapter that serves a provider id. Real: `createProviders(config).adapter`; tests inject a fake. */
  readonly adapterFor: (config: PabloConfig, providerId: string) => Adapter;
}

export function realConfigTestDeps(options: ProvidersOptions = {}): ConfigTestDeps {
  return { adapterFor: (config, id) => createProviders(config, options).adapter(id) };
}

const PING_PROMPT = "Reply with the single word: ok";
const PING_TIMEOUT_MS = 20_000;
/**
 * A reasoning model spends part of this on thinking before it writes "ok"; 8
 * tokens made a working DeepSeek v4-pro read as broken. Generous enough to
 * think a little, small enough that the probe stays cheap.
 */
const PING_MAX_TOKENS = 1024;

const BILLING_ERROR = /credit balance|insufficient[_ ](?:quota|funds|credit)|billing|payment required|quota exceeded|\b402\b/i;

/** A provider's error, with billing/credit trouble named plainly (AGT-2198) so it is not read as a bad key or a down server. */
export const BILLING_LABEL = "billing/credit problem";

export function describeProviderError(message: string): string {
  return BILLING_ERROR.test(message) ? `${BILLING_LABEL}: ${message} (add credit or change plan with the provider)` : message;
}

export async function configTest(scope: ConfigScope, deps: ConfigTestDeps): Promise<ConfigResult> {
  let config: PabloConfig;
  try {
    config = loadMerged(scope);
  } catch (error) {
    return failure(error);
  }
  if (config.providers.size === 0) return failure(new NoModelConfiguredError());
  // One request per mapped intent; with none mapped, the default route is the one thing to check.
  const targets: { intent: string; provider: string }[] = [...config.intents].map(([intent, provider]) => ({ intent, provider }));
  if (targets.length === 0) targets.push({ intent: "(default)", provider: config.defaultProvider });

  const results: { intent: string; provider: string; ok: boolean; error?: string }[] = [];
  for (const target of targets) {
    try {
      const adapter = deps.adapterFor(config, target.provider);
      for await (const event of adapter.complete({ prompt: PING_PROMPT, maxTokens: PING_MAX_TOKENS, timeoutMs: PING_TIMEOUT_MS })) {
        if (event.type === "done") break;
      }
      results.push({ ...target, ok: true });
    } catch (error) {
      results.push({ ...target, ok: false, error: describeProviderError((error as Error).message) });
    }
  }

  const providers = new Map<string, { ok: boolean; error?: string }>();
  for (const r of results) {
    const prior = providers.get(r.provider);
    if (prior === undefined || (prior.ok && !r.ok)) providers.set(r.provider, { ok: r.ok, ...(r.error === undefined ? {} : { error: r.error }) });
  }
  const allOk = results.every((r) => r.ok);
  const lines = [
    ...results.map((r) => `  ${r.intent} -> ${r.provider}: ${r.ok ? "ok" : `error: ${r.error}`}`),
    "",
    ...[...providers].map(([id, s]) => `${id}: ${s.ok ? "ok" : "error"}`),
  ];
  return {
    exitCode: allOk ? EXIT_OK : EXIT_ERROR,
    body: { ok: allOk, results, providers: Object.fromEntries(providers) },
    text: lines.join("\n"),
  };
}

