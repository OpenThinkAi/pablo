/**
 * `pablo doctor`'s writing side (AGT-2146, D-16): the checks a writer needs
 * before the first draft, beside the casting report.
 *
 * - the config file is found (absent is a warning: pablo has no built-in model) and parses;
 * - every provider the config routes to answers (`config test`'s one tiny request);
 * - the vault is found and is a git repo;
 * - the search backend answers (absent is a warning: research then has no web).
 *
 * Every line that is not ok says how to fix it. `ok` is false, and the verb
 * exits non-zero, when any check with status `fail` exists; a `warn` never
 * fails the run. Everything that touches the machine is a seam on
 * `WritingDoctorDeps`, so tests use temp dirs and fakes: no model, no network.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { configPath, createSearchBackend, loadConfig, ProviderConfigError } from "@openthink/pablo-core";
import type { PabloConfig, SearchBackend } from "@openthink/pablo-core";
import { configTest, realConfigTestDeps } from "./config-verb";
import type { ConfigTestDeps } from "./config-verb";
import { findVault } from "./project";

type Env = Record<string, string | undefined>;

export type CheckStatus = "ok" | "warn" | "fail";

export interface WritingCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** How to fix it; present on every `warn` and `fail`. */
  readonly fix?: string;
}

export interface WritingDoctorDeps {
  readonly env: Env;
  readonly cwd: string;
  readonly configTestDeps: ConfigTestDeps;
  /** Whether `dir` is inside a git work tree. */
  readonly isGitRepo: (dir: string) => boolean;
  /** The search backend for a config's `web` block; undefined when none is configured. */
  readonly searchBackend: (config: PabloConfig) => SearchBackend | undefined;
}

export function realWritingDoctorDeps(env: Env, cwd: string): WritingDoctorDeps {
  return {
    env,
    cwd,
    configTestDeps: realConfigTestDeps(),
    isGitRepo: (dir) => spawnSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" }).stdout?.trim() === "true",
    searchBackend: (config) => createSearchBackend(config.web),
  };
}

export interface WritingDoctorResult {
  readonly ok: boolean;
  readonly checks: readonly WritingCheck[];
}

export async function runWritingDoctor(deps: WritingDoctorDeps): Promise<WritingDoctorResult> {
  const checks: WritingCheck[] = [];
  const file = configPath(deps.env);

  // Config.
  let config: PabloConfig | undefined;
  try {
    config = loadConfig({ env: deps.env });
    checks.push(
      existsSync(file)
        ? { name: "config", status: "ok", detail: file }
        : {
            name: "config",
            status: "warn",
            detail: `no config file at ${file}; pablo has no built-in model`,
            fix: "run `pablo init --config` to write a documented starter config, then `pablo config set` to fill in the model ids",
          },
    );
  } catch (error) {
    const message = error instanceof ProviderConfigError ? error.message : (error as Error).message;
    checks.push({ name: "config", status: "fail", detail: message, fix: `fix or delete ${file}, then run \`pablo config show\`` });
  }

  // Providers.
  if (config !== undefined && config.providers.size === 0) {
    checks.push({
      name: "providers",
      status: "fail",
      detail: "no provider is configured, so no verb that needs a model can run",
      fix: "run `pablo init --config` (or `pablo config set providers.<id>.endpoint <url>` and `.model <id>`), then `pablo config test`",
    });
  } else if (config !== undefined) {
    const test = await configTest({ env: deps.env }, deps.configTestDeps);
    const body = test.body as { providers?: Record<string, { ok: boolean; error?: string }> };
    for (const [id, state] of Object.entries(body.providers ?? {})) {
      checks.push(
        state.ok
          ? { name: `provider ${id}`, status: "ok", detail: "answered" }
          : {
              name: `provider ${id}`,
              status: "fail",
              detail: state.error ?? "no answer",
              fix: `start the server or set its key, then run \`pablo config test\`; \`pablo config show\` lists where "${id}" points`,
            },
      );
    }
  }

  // Vault.
  const vault = findVault(deps.cwd, deps.env);
  if (!vault.ok) {
    checks.push({
      name: "vault",
      status: "fail",
      detail: vault.message,
      fix: "run pablo inside your writing vault, or set PABLO_VAULT to its path",
    });
  } else {
    checks.push(
      deps.isGitRepo(vault.path)
        ? { name: "vault git", status: "ok", detail: `${vault.path} is a git repo` }
        : {
            name: "vault git",
            status: "fail",
            detail: `${vault.path} is not a git repo`,
            fix: `run \`git -C ${vault.path} init\`; pablo keeps every draft and edit branch in the vault's history`,
          },
    );
  }

  // Search backend.
  const backend = config === undefined ? undefined : deps.searchBackend(config);
  if (config !== undefined && backend === undefined) {
    checks.push({
      name: "search",
      status: "warn",
      detail: "no search backend configured; web research is off",
      fix: 'add "web": { "search": { "backend": "searxng", "url": "<base url>" } } to the config file',
    });
  } else if (backend !== undefined) {
    try {
      await backend.search("pablo", { limit: 1 });
      checks.push({ name: "search", status: "ok", detail: `${backend.name} answered` });
    } catch (error) {
      checks.push({
        name: "search",
        status: "fail",
        detail: (error as Error).message,
        fix: `check that the ${backend.name} instance is running and its URL in "web.search.url" is right`,
      });
    }
  }

  return { ok: checks.every((c) => c.status !== "fail"), checks };
}

/** The writing section of the plain-text report. */
export function writingDoctorText(result: WritingDoctorResult): string {
  const lines = [`writing: ${result.ok ? "ok" : "problems found"}`];
  for (const c of result.checks) {
    const mark = c.status === "ok" ? "ok  " : c.status === "warn" ? "warn" : "FAIL";
    lines.push(`  ${mark} ${c.name}: ${c.detail}`);
    if (c.fix !== undefined) lines.push(`       fix: ${c.fix}`);
  }
  return lines.join("\n");
}
