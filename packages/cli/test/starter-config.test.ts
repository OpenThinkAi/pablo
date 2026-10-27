import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NoModelConfiguredError, createProviders, defaultConfig, loadConfig, parseConfig, route } from "@openthink/pablo-core";
import { configSet, configShow } from "../src/config-verb";
import { VERBS } from "../src/verbs";
import { missingConfigNotice, starterConfigText, writeStarterConfig } from "../src/starter-config";

// AGT-2131 (D-13): pablo ships no endpoint or model; `init --config` writes a documented starter.
// Every test points XDG_CONFIG_HOME at a temp dir: the real ~/.config/pablo is never read or written.

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

function tempHome(): { xdg: string; env: Record<string, string>; file: string } {
  const xdg = mkdtempSync(join(tmpdir(), "pablo-starter-"));
  return { xdg, env: { XDG_CONFIG_HOME: xdg }, file: join(xdg, "pablo", "config.json") };
}

function runCli(args: string[], env: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(["bun", "run", CLI, ...args], { env: { ...process.env, ...env } });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode };
}

test("with no config, no provider exists and every route refuses with a pointer to pablo init --config", () => {
  const h = tempHome();
  const config = loadConfig({ env: h.env });
  expect(config.providers.size).toBe(0);
  expect(() => route(config, { name: "draft", kind: "drafting" })).toThrow(NoModelConfiguredError);
  expect(() => createProviders(defaultConfig()).adapterFor({ name: "prose", kind: "copy" })).toThrow(/pablo init --config/);
});

test("the starter parses through the real loader, holds no key, and names no model of ours", () => {
  const config = parseConfig(starterConfigText());
  expect([...config.providers.keys()]).toEqual(["local", "anthropic"]);
  expect(config.providers.get("local")?.local).toBe(true);
  expect(config.providers.get("anthropic")?.kind).toBe("anthropic");
  // A reference to where the key lives, never a key.
  expect(config.providers.get("anthropic")?.key).toEqual({ from: "env", variable: "ANTHROPIC_API_KEY" });
  expect(starterConfigText()).not.toMatch(/sk-ant|gemma|qwen/i);
  // It documents itself: JSON has no comments, so the loader-ignored _about strings carry them.
  expect(JSON.parse(starterConfigText())._about).toContain("pablo config test");
  // Routing works on it: writing goes to the local example, planning to the cloud one.
  expect(route(config, { name: "draft", kind: "drafting" })).toBe("local");
  expect(route(config, { name: "plan", kind: "planning" })).toBe("anthropic");
});

test("writeStarterConfig creates the file once and never overwrites an existing one", () => {
  const h = tempHome();
  const first = writeStarterConfig(h.env);
  expect(first.ok).toBe(true);
  expect(first.path).toBe(h.file);
  expect(readFileSync(h.file, "utf8")).toBe(starterConfigText());

  writeFileSync(h.file, '{"providers":{}}');
  const second = writeStarterConfig(h.env);
  expect(second.ok).toBe(false);
  expect(second.message).toContain("already exists");
  expect(readFileSync(h.file, "utf8")).toBe('{"providers":{}}');
});

test("the written starter is editable with config set and shown by config show; _about notes survive", () => {
  const h = tempHome();
  writeStarterConfig(h.env);
  expect(configSet({ env: h.env }, "providers.local.model", "my-model").exitCode).toBe(0);
  const shown = configShow({ env: h.env });
  expect(shown.text).toContain("model=my-model");
  expect(shown.text).toContain("draft -> local");
  expect(JSON.parse(readFileSync(h.file, "utf8")).providers.local._about).toContain("OpenAI-compatible");
});

test("missingConfigNotice appears only while there is no config file", () => {
  const h = tempHome();
  expect(missingConfigNotice(h.env)).toContain("pablo init --config");
  writeStarterConfig(h.env);
  expect(missingConfigNotice(h.env)).toBeUndefined();
});

test("CLI: pablo init --config needs no vault, writes the starter, and refuses to overwrite", () => {
  const h = tempHome();
  const cwd = mkdtempSync(join(tmpdir(), "pablo-no-vault-"));
  const result = Bun.spawnSync(["bun", "run", CLI, "init", "--config"], { cwd, env: { ...process.env, ...h.env, PABLO_VAULT: "" } });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain(h.file);
  expect(existsSync(h.file)).toBe(true);

  const again = runCli(["init", "--config", "--json"], h.env);
  expect(again.exitCode).toBe(2);
  expect(JSON.parse(again.stderr.trim() || again.stdout.trim()).ok).toBe(false);
});

test("CLI: a model verb with no config refuses (exit 2) pointing at pablo init --config; a dry run still previews the pack", () => {
  const h = tempHome();
  const dir = mkdtempSync(join(tmpdir(), "pablo-nomodel-"));
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const env = { ...h.env, PABLO_VAULT: vault };

  const write = runCli(["write", "--project", "ice-house", "--chapter", "2"], env);
  expect(write.exitCode).toBe(2);
  expect(write.stderr + write.stdout).toContain("pablo init --config");

  // A dry run sends nothing: the pack renders without a model, minus the wait estimate.
  const dry = runCli(["write", "--project", "ice-house", "--chapter", "2", "--dry-run"], env);
  expect(dry.exitCode).toBe(0);
  expect(dry.stdout).toContain("drafting pack");
  expect(dry.stdout).toContain("no wait estimate");
  expect(runCli(["write", "--project", "ice-house", "--chapter", "2", "--dry-run", "--json"], env).exitCode).toBe(0);
});

test("CLI: help and the MCP tool descriptions say the configured writer model, never local or Gemma", () => {
  const help = runCli(["--help"], tempHome().env).stdout;
  expect(help).toContain("pablo init --config");
  expect(help).toContain("configured writer model");
  expect(help).not.toMatch(/local model|Gemma|local writer/);
});

test("no verb or MCP tool description names the local model, Gemma or the local writer", () => {
  for (const verb of VERBS) {
    for (const tool of verb.mcpTools ?? [verb]) expect(tool.description).not.toMatch(/local model|Gemma|local writer|configured local/);
  }
});
