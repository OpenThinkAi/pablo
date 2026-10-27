/**
 * The documented starter config `pablo init --config` writes (AGT-2131, D-13).
 *
 * pablo ships no endpoint and no model id (`core/src/providers`): a fresh
 * install has no providers, and every verb that needs a model refuses with a
 * pointer here. The starter is two examples to edit, not defaults: a local
 * OpenAI-compatible server and Anthropic. JSON has no comments, so each entry
 * carries an `_about` string that the loader ignores and `pablo config set`
 * keeps. It never holds a key, only where to find one.
 */

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "@openthink/pablo-core";

type Env = Record<string, string | undefined>;

export const STARTER_CONFIG = {
  _about:
    "pablo's model config. pablo has no built-in model: edit the two providers below (or delete one), then check with `pablo config test`. " +
    "A key is never written here, only where to find it: \"env:NAME\" or \"keychain:service/account\". " +
    "`intents` maps each intent to a provider; an unmapped one goes to the first local provider (writing) or the first cloud one (planning). " +
    "`pablo config show` prints the merged result; a work's pablo.json may override providers and intents. See docs/configuration.md.",
  default: "local",
  providers: {
    local: {
      _about:
        "A model on this machine behind an OpenAI-compatible server (LM Studio :1234, Ollama :11434, llama.cpp :8080, mlx_lm :8002). " +
        "Set endpoint to its base URL (with /v1) and model to the id it serves. local: true serializes requests and prefers it for drafting.",
      kind: "openai-compatible",
      endpoint: "http://127.0.0.1:1234/v1",
      model: "your-model-id",
      local: true,
    },
    anthropic: {
      _about:
        "Claude through Anthropic's API. Set model to a model id from your account. Export ANTHROPIC_API_KEY, or point key at the Keychain: \"keychain:<service>/<account>\".",
      kind: "anthropic",
      endpoint: "https://api.anthropic.com/v1",
      model: "your-claude-model-id",
      key: "env:ANTHROPIC_API_KEY",
    },
  },
  intents: {
    plan: "anthropic",
    check: "anthropic",
    research: "anthropic",
    agent: "anthropic",
    draft: "local",
    revise: "local",
    prose: "local",
    continuity: "local",
  },
} as const;

export interface StarterResult {
  readonly ok: boolean;
  readonly path: string;
  readonly message: string;
}

/** Text of the starter file; also what the test parses back through the real loader. */
export function starterConfigText(): string {
  return `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`;
}

/** Writes the starter to the global config path unless a file is already there (never overwrites). */
export function writeStarterConfig(env: Env): StarterResult {
  const path = configPath(env);
  if (existsSync(path)) {
    return { ok: false, path, message: `pablo: init --config: ${path} already exists; edit it with \`pablo config set\` (nothing was changed)` };
  }
  const text = starterConfigText();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, text);
  renameSync(temp, path);
  return {
    ok: true,
    path,
    message:
      `pablo: wrote a starter config to ${path}. Set the model ids in it (\`pablo config set providers.local.model <id>\`), ` +
      `then run \`pablo config test\`.`,
  };
}

/** The line `pablo init` adds when the machine has no global config yet; undefined when there is one. */
export function missingConfigNotice(env: Env): string | undefined {
  return existsSync(configPath(env))
    ? undefined
    : `pablo: no model is configured yet (${configPath(env)} does not exist). Run \`pablo init --config\` to write a documented starter config.`;
}

/** Appended to a human `--dry-run` pack preview when no model is configured: the pack renders, only the wait estimate is missing. */
export const NO_WAIT_ESTIMATE_NOTE = "No model is configured, so there is no wait estimate. `pablo init --config` writes a starter config.";
