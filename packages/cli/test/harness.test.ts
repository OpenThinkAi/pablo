/**
 * The harness (AGT-1552) on pablo's own agent loop (AGT-2121, D-12). Every
 * session here is the real loop on a scripted model, or a fake
 * `HarnessQuery`: no test reaches a model or the network, reads the Keychain
 * or reads the real config file. The fixture vault is a temp copy.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScriptedChatAdapter, defaultConfig, parseConfig } from "@openthink/pablo-core";
import type { ScriptedChatAdapter } from "@openthink/pablo-core";
import { main } from "../src/cli";
import { runAgent } from "../src/harness/agent";
import type { AgentContext } from "../src/harness/agent";
import { adapterProvider, AGENT_INTENT, harnessProvider, providerHint } from "../src/harness/provider";
import { loopSpec } from "../src/harness/session";
import type { HarnessQuery, HarnessSpec } from "../src/harness/session";
import { harnessTools } from "../src/harness/tools";
import { formatEntry } from "../src/harness/transcript";
import { mcpTools } from "../src/mcp";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pablo-harness-test-"));
const vault = join(root, "vault");
cpSync(FIXTURE_VAULT, vault, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const BASE_ENV = { PABLO_VAULT: vault, PATH: "/usr/bin:/bin", HOME: root, XDG_CONFIG_HOME: join(root, "config") };
const noConfig = () => undefined;

function spec(over: Partial<HarnessSpec> = {}): HarnessSpec {
  return {
    work: { title: "The Ice House", format: "novel", slug: "ice-house" },
    provider: adapterProvider(createScriptedChatAdapter({ turns: [] })),
    ctx: { cwd: vault, env: BASE_ENV, stderr: { write: () => {} }, caller: "mcp" },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The session's configuration
// ---------------------------------------------------------------------------

/** Coding tools that must never reach the harness: no shell, no file read/write, no subagents. */
const CODING_TOOLS = ["Bash", "Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "NotebookEdit", "Task", "Agent", "TodoWrite", "Skill"];

test("the session offers pablo's tools by their plain names, and nothing else", () => {
  const tools = loopSpec(spec()).tools.map((tool) => tool.name);
  expect(tools).toEqual(mcpTools().map((tool) => tool.name));
  expect(tools).toContain("resume");
  expect(tools).toContain("status");
  for (const tool of CODING_TOOLS) expect(tools).not.toContain(tool);
  for (const tool of tools) expect(tool).not.toStartWith("mcp__");
});

test("the research checklist tools reach the session by their plain names", () => {
  const tools = loopSpec(spec()).tools.map((tool) => tool.name);
  for (const name of ["plan_research", "waive_research_item", "link_research_item", "save_research"]) expect(tools).toContain(name);
});

test("the system prompt is pablo's", () => {
  const prompt = loopSpec(spec()).system;
  expect(prompt).toStartWith("You are pablo");
  expect(prompt).toContain('"The Ice House"');
  expect(prompt).not.toContain("Claude Code");
});

test("a narrower tool list narrows what is offered", () => {
  const only = harnessTools().filter((tool) => tool.name === "resume");
  expect(loopSpec(spec({ tools: only })).tools.map((tool) => tool.name)).toEqual(["resume"]);
});

// ---------------------------------------------------------------------------
// Which provider: the agent intent, routed through pablo's config
// ---------------------------------------------------------------------------

test("with only the default config the session runs on the local writer, with no key and no cost", () => {
  const provider = harnessProvider(defaultConfig(), { keys: { env: {} } });
  expect(provider.adapter.id).toBe("local");
  expect(provider).toMatchObject({ local: true, credential: "none", forcedToolChoice: true });
  expect(loopSpec(spec({ provider }))).toMatchObject({ local: true, credential: "none" });
});

test("an anthropic provider takes the agent intent; its credential is the key's source, never the key", () => {
  const config = parseConfig(
    JSON.stringify({ providers: { anthropic: { kind: "anthropic", key: "keychain:pablo-test/me", model: "claude-test-1" } } }),
  );
  const keychain = (service: string, account: string | undefined) => (service === "pablo-test" && account === "me" ? "sk-config" : "");
  const provider = harnessProvider(config, { keys: { env: {}, keychain } });
  expect(provider.adapter.id).toBe("anthropic");
  expect(provider.adapter.model).toBe("claude-test-1");
  expect(provider.credential).toBe("keychain:pablo-test/me");
  expect(JSON.stringify(provider)).not.toContain("sk-config");
  // Anthropic's newest models refuse a forced tool_choice; the loop steers from the prompt there.
  expect(provider.forcedToolChoice).toBe(false);
});

test("an explicit agent intent wins over the default route", () => {
  const config = parseConfig(JSON.stringify({ providers: { anthropic: { kind: "anthropic" } }, intents: { [AGENT_INTENT.name]: "local" } }));
  expect(harnessProvider(config, { keys: { env: {} } }).adapter.id).toBe("local");
});

// ---------------------------------------------------------------------------
// `pablo agent` runs one session headless and prints the transcript
// ---------------------------------------------------------------------------

/** A scripted model that checks the book with pablo's `status` tool (run for real by the loop), then answers. */
function statusModel(): ScriptedChatAdapter {
  return createScriptedChatAdapter({
    model: "claude-test-1",
    turns: [
      [
        { type: "text", text: "Checking where the book stands." },
        { type: "tool_call", call: { id: "t1", name: "status", arguments: { project: "ice-house" } } },
      ],
      [{ type: "text", text: "The bible is in; acts come next." }],
    ],
  });
}

function capture(): { ctx: AgentContext; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    ctx: { cwd: vault, env: BASE_ENV, stdout: { write: (t) => void (out += t) }, stderr: { write: (t) => void (err += t) } },
    out: () => out,
    err: () => err,
  };
}

test("pablo agent runs one session on the loop and prints the transcript", async () => {
  const model = statusModel();
  const io = capture();
  const code = await runAgent({ project: "ice-house", message: "Where are we?", json: false }, io.ctx, { provider: adapterProvider(model), readConfig: noConfig });

  expect(code).toBe(0);
  expect(model.requests).toHaveLength(2);
  expect(model.requests[0]!.messages).toEqual([{ role: "user", content: "Where are we?" }]);

  const lines = io.out().split("\n");
  expect(lines[0]).toBe("› Where are we?");
  expect(lines[1]).toBe("session: claude-test-1, credential none");
  expect(io.out()).toContain("pablo: Checking where the book stands.");
  expect(io.out()).toContain('  → status {"project":"ice-house"}');
  expect(io.out()).toContain('  ← {"core":{"premise":true');
  expect(io.out()).toContain("pablo: The bible is in; acts come next.");
  expect(io.out()).toContain("— done: 2 turn(s)");
});

test("--json prints one object with the provider, entries and result", async () => {
  const io = capture();
  const code = await runAgent({ project: "ice-house", message: "Where are we?", json: true }, io.ctx, { provider: adapterProvider(statusModel()), readConfig: noConfig });

  expect(code).toBe(0);
  const body = JSON.parse(io.out()) as { ok: boolean; provider: unknown; entries: { kind: string }[]; result: { ok: boolean } };
  expect(body.ok).toBe(true);
  expect(body.provider).toEqual({ id: "scripted", model: "claude-test-1", credential: "none" });
  expect(body.entries.map((entry) => entry.kind)).toEqual(["session", "assistant", "tool_call", "tool_result", "assistant", "result"]);
  expect(body.result.ok).toBe(true);
});

test("the config's agent provider is the one the session runs on; a missing key fails the session naming where to put it", async () => {
  const io = capture();
  const readConfig = () => JSON.stringify({ providers: { anthropic: { kind: "anthropic" } } });
  const code = await runAgent({ project: "ice-house", message: "Hi", json: false }, io.ctx, { readConfig, keys: { env: {}, keychain: () => "" } });
  expect(code).toBe(1);
  expect(io.out()).toContain("credential env:ANTHROPIC_API_KEY");
  expect(io.out()).toContain('provider "anthropic" has no API key, so nothing was sent');
});

test("with no cloud provider configured the agent says it runs on the local model; a mapped agent intent does not", async () => {
  const unmapped = capture();
  // The default config routes the agent to `local`; its first request fails (nothing listens in a test), which is fine here.
  await runAgent({ project: "ice-house", message: "Hi", json: false }, unmapped.ctx, { readConfig: () => JSON.stringify({ providers: { local: { endpoint: "http://127.0.0.1:9/v1" } } }) });
  expect(unmapped.err()).toContain('no cloud provider is configured, so the agent runs on the local model ("local")');

  const mapped = capture();
  await runAgent({ project: "ice-house", message: "Hi", json: false }, mapped.ctx, { readConfig: () => JSON.stringify({ providers: { local: { endpoint: "http://127.0.0.1:9/v1" } }, intents: { agent: "local" } }) });
  expect(mapped.err()).not.toContain("no cloud provider");

  const fresh = capture();
  await runAgent({ project: "ice-house", message: "Hi", json: false, new: true }, fresh.ctx, { provider: adapterProvider(statusModel()), readConfig: noConfig });
  expect(fresh.err()).toContain("starting a session on");
  expect(fresh.err()).not.toContain("--new");
});

test("the provider hint names how to see, change and test the agent's route", () => {
  const hint = providerHint(adapterProvider(statusModel(), { credential: "env:ANTHROPIC_API_KEY" }));
  expect(hint).toContain('Check the "scripted" provider and its key (env:ANTHROPIC_API_KEY)');
  expect(hint).toContain("`pablo config show`");
  expect(hint).toContain("`pablo config set intents.agent <provider>`");
});

test("refusals: no project, no message, unknown project, no marker; the session never starts", async () => {
  const model = statusModel();
  const cases = [
    { project: undefined, message: "Hi" },
    { project: "ice-house", message: undefined },
    { project: "ice-house", message: "   " },
    { project: "nope", message: "Hi" },
    { project: "no-marker", message: "Hi" },
  ];
  for (const args of cases) {
    const io = capture();
    expect(await runAgent({ ...args, json: false }, io.ctx, { provider: adapterProvider(model), readConfig: noConfig })).toBe(2);
    expect(io.err()).toStartWith("pablo:");
  }
  expect(model.requests).toHaveLength(0);
});

test("a session that hits the turn cap exits 1 and says what to do next", async () => {
  const looping = createScriptedChatAdapter({
    turns: Array.from({ length: 50 }, (_, i) => [{ type: "tool_call" as const, call: { id: `t${i}`, name: "status", arguments: { project: "ice-house" } } }]),
  });
  const io = capture();
  expect(await runAgent({ project: "ice-house", message: "Hi", json: false }, io.ctx, { provider: adapterProvider(looping), readConfig: noConfig })).toBe(1);
  expect(io.out()).toContain("— failed: 40 turn(s)");
  expect(io.out()).toContain("turn cap (40 turns) without a final answer. Send a follow-up message");
});

test("a session that fails outside the loop exits 1 with the provider hint", async () => {
  const query: HarnessQuery = async function* () {
    yield* [];
    throw new Error("socket closed");
  };
  const io = capture();
  expect(await runAgent({ project: "ice-house", message: "Hi", json: false }, io.ctx, { query, provider: adapterProvider(statusModel()), readConfig: noConfig })).toBe(1);
  expect(io.err()).toContain("socket closed");
  expect(io.err()).toContain('Check the "scripted" provider');
  expect(io.err()).toContain("pablo config test");
});

test("a stream with no result exits 1", async () => {
  const query: HarnessQuery = async function* () {
    yield { kind: "session", model: "m", apiKeySource: "none", tools: [] };
  };
  const io = capture();
  expect(await runAgent({ project: "ice-house", message: "Hi", json: false }, io.ctx, { query, provider: adapterProvider(statusModel()), readConfig: noConfig })).toBe(1);
  expect(io.err()).toContain("without a result");
});

test("`pablo agent` with no --project is refused before any session", async () => {
  expect(await main(["agent", "hello"], vault)).toBe(2);
});

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

test("a session entry prints the model, the credential label and the tools", () => {
  expect(formatEntry({ kind: "session", model: "m-1", apiKeySource: "env:ANTHROPIC_API_KEY", tools: ["resume", "status"] })).toBe(
    "session: m-1, credential env:ANTHROPIC_API_KEY\n  tools: resume, status",
  );
});

test("a result whose model has no price says the cost is incomplete rather than reading as free", () => {
  const line = formatEntry({ kind: "result", ok: true, text: "", turns: 2, durationMs: 1000, costUsd: 0, unpricedModel: "gpt-x", errors: [] });
  expect(line).toBe("— done: 2 turn(s), 1.0s, $0.0000 (no price for gpt-x; its turns are not counted)");
});

test("long tool results are previewed on one line", () => {
  const line = formatEntry({ kind: "tool_result", id: "t", text: `a\n${"b".repeat(600)}`, isError: false });
  expect(line.split("\n")).toHaveLength(1);
  expect(line.endsWith("…")).toBe(true);
  expect(formatEntry({ kind: "tool_result", id: "t", text: "no", isError: true })).toBe("  ✗ no");
});
