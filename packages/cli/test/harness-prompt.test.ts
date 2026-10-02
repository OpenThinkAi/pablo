/**
 * The harness's system prompt (AGT-1553): pablo's role, the work's judgement
 * policy and its `QWEN.md` rules. The assembler is pure; the loader reads a
 * temp copy of the fixture vault and the shipped `policies/`. Every session is
 * a fake `HarnessQuery`: nothing here starts Claude or reaches the network.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { defaultConfig } from "@openthink/pablo-core";
import { runAgent } from "../src/harness/agent";
import { harnessAuth } from "../src/harness/auth";
import { DEFAULT_POLICY, harnessSystemPrompt, loadPromptWork, POLICIES_DIR, stripWriterOnly } from "../src/harness/prompt";
import type { PromptWork } from "../src/harness/prompt";
import { harnessOptions } from "../src/harness/session";
import type { HarnessQuery } from "../src/harness/session";
import { readMarker } from "../src/marker";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pablo-harness-prompt-test-"));
const vault = join(root, "vault");
cpSync(FIXTURE_VAULT, vault, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const BASE_ENV = { PABLO_VAULT: vault, PATH: "/usr/bin:/bin", HOME: root, XDG_CONFIG_HOME: join(root, "config") };

/** A second work in the temp vault, named for a policy, with its own invented rules. */
function work(slug: string, marker: Record<string, unknown>, rules?: string): string {
  const dir = join(vault, "novels", slug);
  cpSync(join(vault, "novels", "ice-house"), dir, { recursive: true });
  writeFileSync(join(dir, "pablo.json"), JSON.stringify({ format: "novel", title: "The Salt Ledger", slug, ...marker }));
  if (rules === undefined) rmSync(join(dir, "QWEN.md"));
  else writeFileSync(join(dir, "QWEN.md"), rules);
  return dir;
}

const RULES = [
  "# The Salt Ledger",
  "",
  "## Ground rules (set by the author)",
  "",
  "1. The lighthouse keeper never leaves the island on the page.",
  "",
  "<!-- writer-only -->",
  "## Sentence music",
  "",
  "Short sentences when the fog comes in.",
  "<!-- /writer-only -->",
  "",
  "## Point of view",
  "",
  "- Close third, Wren throughout.",
  "",
].join("\n");

const base: PromptWork = { title: "The Salt Ledger", format: "novel", slug: "salt-ledger" };

// ---------------------------------------------------------------------------
// AC 1: the pure assembler
// ---------------------------------------------------------------------------

test("the prompt is role, then the policy, then the work's rules", () => {
  const prompt = harnessSystemPrompt({ ...base, policy: { name: "test-policy", text: "Research the tides.\n" }, rules: RULES });

  expect(prompt).toStartWith('You are pablo, the agent that writes stories with its author. You are working on "The Salt Ledger"');
  const role = prompt.indexOf("You are pablo");
  const policy = prompt.indexOf('<judgement_policy name="test-policy">\nResearch the tides.\n</judgement_policy>');
  const rules = prompt.indexOf('<work_rules source="QWEN.md">\n# The Salt Ledger');
  expect(role).toBe(0);
  expect(policy).toBeGreaterThan(role);
  expect(rules).toBeGreaterThan(policy);
  expect(prompt).toContain("1. The lighthouse keeper never leaves the island on the page.");
  expect(prompt).toContain("- Close third, Wren throughout.");
  expect(prompt).toEndWith("</work_rules>");
  expect(prompt).not.toContain("Claude Code");
});

test("no policy named means the minimal default; no rules means no rules section", () => {
  const prompt = harnessSystemPrompt(base);
  expect(prompt).toContain(`<judgement_policy name="default">\n${DEFAULT_POLICY.text}\n</judgement_policy>`);
  expect(prompt).not.toContain("<work_rules");
  expect(harnessSystemPrompt({ ...base, rules: "  \n" })).not.toContain("<work_rules");
});

test("the assembler is pure: the same inputs give the same prompt", () => {
  const input = { ...base, rules: RULES };
  expect(harnessSystemPrompt(input)).toBe(harnessSystemPrompt(input));
});

test("writer-only sections of QWEN.md never reach the harness", () => {
  const prompt = harnessSystemPrompt({ ...base, rules: RULES });
  expect(prompt).not.toContain("Sentence music");
  expect(prompt).not.toContain("fog");
  expect(prompt).not.toContain("writer-only");

  expect(stripWriterOnly("keep\n<!--writer-only-->\ndrop\n<!-- /writer-only -->\nkeep too")).toBe("keep\n\nkeep too");
  // An unclosed fence drops to the end rather than leaking.
  expect(stripWriterOnly("keep\n<!-- writer-only -->\ndrop\nand drop")).toBe("keep");
  expect(stripWriterOnly("a\n<!-- writer-only -->x<!-- /writer-only -->\nb\n<!-- writer-only -->y<!-- /writer-only -->\nc")).toBe("a\n\nb\n\nc");
});

// ---------------------------------------------------------------------------
// AC 2: the shipped historical-fiction policy
// ---------------------------------------------------------------------------

test("pablo ships policies/historical-fiction.md with the harness doc's judgement policy", () => {
  const text = readFileSync(join(POLICIES_DIR, "historical-fiction.md"), "utf8");
  // Research public facts, with citations, tagged researched.
  expect(text).toMatch(/Research public, checkable facts/);
  expect(text).toContain("cite the source");
  expect(text).toContain("`researched`");
  // Invent private lives, tagged invented.
  expect(text).toMatch(/Invent the private lives/);
  expect(text).toContain("`invented`");
  // Ask on the author's calls.
  expect(text).toMatch(/Ask the author when the call is theirs/);
  expect(text).toContain("`[pick]`");
  // Otherwise proceed with a stated assumption.
  expect(text).toMatch(/Proceed with a stated assumption/);
  // Never put research names in anything the writer sees.
  expect(text).toMatch(/put a name from `research\/` into anything the writer sees/);
  expect(text).toMatch(/`invented` fact be presented as history/);
});

// ---------------------------------------------------------------------------
// The `policy` field and the loader
// ---------------------------------------------------------------------------

test("pablo.json's optional policy is read; a non-name value is refused naming the key", () => {
  const named = work("policy-named", { policy: "historical-fiction" }, RULES);
  const read = readMarker(named);
  expect(read.ok && read.marker.policy).toBe("historical-fiction");

  const none = readMarker(join(vault, "novels", "ice-house"));
  expect(none.ok && none.marker.policy).toBeUndefined();

  for (const [slug, policy] of [["policy-path", "../secrets"], ["policy-number", 3], ["policy-empty", ""], ["policy-upper", "Gothic"]] as const) {
    const bad = readMarker(work(slug, { policy }, RULES));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.code).toBe(2);
      expect(bad.message).toContain('"policy"');
    }
  }
});

test("the loader reads the named policy and the work's QWEN.md", () => {
  const dir = work("loader-hf", { policy: "historical-fiction" }, RULES);
  const marker = readMarker(dir);
  if (!marker.ok) throw new Error(marker.message);
  const loaded = loadPromptWork(dir, marker.marker, "loader-hf");
  if (!loaded.ok) throw new Error(loaded.message);

  expect(loaded.work.policy?.name).toBe("historical-fiction");
  expect(loaded.work.policy?.text).toBe(readFileSync(join(POLICIES_DIR, "historical-fiction.md"), "utf8"));
  expect(loaded.work.rules).toBe(RULES);
  expect(loaded.work.title).toBe("The Salt Ledger");
});

test("the loader: no policy and no QWEN.md give the default and no rules", () => {
  const dir = work("loader-bare", {});
  const marker = readMarker(dir);
  if (!marker.ok) throw new Error(marker.message);
  const loaded = loadPromptWork(dir, marker.marker, "loader-bare");
  if (!loaded.ok) throw new Error(loaded.message);
  expect(loaded.work.policy).toBeUndefined();
  expect(loaded.work.rules).toBeUndefined();
  expect(harnessSystemPrompt(loaded.work)).toContain('<judgement_policy name="default">');
});

test("a policy pablo does not ship is refused, naming the ones it does", () => {
  const dir = work("loader-unknown", { policy: "space-opera" }, RULES);
  const marker = readMarker(dir);
  if (!marker.ok) throw new Error(marker.message);
  const loaded = loadPromptWork(dir, marker.marker, "loader-unknown");
  expect(loaded.ok).toBe(false);
  if (!loaded.ok) {
    expect(loaded.code).toBe(2);
    expect(loaded.message).toContain('"space-opera"');
    expect(loaded.message).toContain("historical-fiction");
  }
});

// ---------------------------------------------------------------------------
// AC 3: the session uses the assembled prompt
// ---------------------------------------------------------------------------

test("harnessOptions passes the assembled prompt as the session's system prompt", () => {
  const w: PromptWork = { ...base, policy: { name: "p", text: "Ask about the tides." }, rules: RULES };
  const options = harnessOptions({
    work: w,
    projectPath: join(vault, "novels", "ice-house"),
    auth: harnessAuth(defaultConfig(), BASE_ENV, { env: {} }),
    ctx: { cwd: vault, env: BASE_ENV, stderr: { write: () => {} }, caller: "mcp" },
  });
  expect(options.systemPrompt).toBe(harnessSystemPrompt(w));
});

function recordingQuery(): { query: HarnessQuery; calls: Options[] } {
  const calls: Options[] = [];
  const query: HarnessQuery = async function* (params) {
    calls.push(params.options);
    yield { type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, duration_ms: 1, total_cost_usd: 0 } as unknown as SDKMessage;
  };
  return { query, calls };
}

const quiet = () => ({ cwd: vault, env: BASE_ENV, stdout: { write: () => {} }, stderr: { write: () => {} } });

test("pablo agent runs the session on the work's policy and rules", async () => {
  work("agent-hf", { policy: "historical-fiction" }, RULES);
  const { query, calls } = recordingQuery();
  const code = await runAgent({ project: "agent-hf", message: "Where are we?", json: false }, quiet(), { query, readConfig: () => undefined });

  expect(code).toBe(0);
  const prompt = calls[0]!.systemPrompt as string;
  expect(prompt).toStartWith("You are pablo");
  expect(prompt).toContain('<judgement_policy name="historical-fiction">');
  expect(prompt).toContain("Research public, checkable facts");
  expect(prompt).toContain("The lighthouse keeper never leaves the island on the page.");
  expect(prompt).not.toContain("Sentence music");
});

test("pablo agent with an unshipped policy is refused before any session", async () => {
  work("agent-unknown", { policy: "space-opera" }, RULES);
  const { query, calls } = recordingQuery();
  let err = "";
  const ctx = { ...quiet(), stderr: { write: (t: string) => void (err += t) } };
  expect(await runAgent({ project: "agent-unknown", message: "Hi", json: false }, ctx, { query, readConfig: () => undefined })).toBe(2);
  expect(err).toContain('"space-opera"');
  expect(calls).toHaveLength(0);
});
