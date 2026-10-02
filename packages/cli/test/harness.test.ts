/**
 * The harness on the Claude Agent SDK (AGT-1552). Every session here is a fake
 * `HarnessQuery`: no test starts Claude, reaches the network, reads the
 * Keychain or reads the real config file. The fixture vault is a temp copy.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defaultConfig, parseConfig } from "@openthink/pablo-core";
import { main } from "../src/cli";
import { runAgent } from "../src/harness/agent";
import type { AgentContext } from "../src/harness/agent";
import { harnessAuth } from "../src/harness/auth";
import { harnessOptions } from "../src/harness/session";
import type { HarnessQuery, HarnessSpec } from "../src/harness/session";
import { allowedTools, harnessTools } from "../src/harness/tools";
import { formatEntry, transcriptEntries } from "../src/harness/transcript";
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
    projectPath: join(vault, "novels", "ice-house"),
    auth: harnessAuth(defaultConfig(), BASE_ENV, { env: {} }),
    ctx: { cwd: vault, env: BASE_ENV, stderr: { write: () => {} }, caller: "mcp" },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// AC 2 + AC 4: the session's configuration
// ---------------------------------------------------------------------------

/** Claude Code's built-ins that must never reach the harness: no shell, no file read/write, no subagents. */
const CODING_TOOLS = ["Bash", "Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "NotebookEdit", "Task", "Agent", "TodoWrite", "Skill"];

test("the allowed-tool list is WebSearch, WebFetch and pablo's MCP tools, nothing else", () => {
  const options = harnessOptions(spec());
  const pablo = mcpTools().map((tool) => `mcp__pablo__${tool.name}`);

  expect(options.tools).toEqual(["WebSearch", "WebFetch"]);
  expect(options.allowedTools).toEqual(["WebSearch", "WebFetch", ...pablo]);
  expect(options.allowedTools).toContain("mcp__pablo__resume");
  expect(options.allowedTools).toContain("mcp__pablo__status");
  for (const tool of CODING_TOOLS) expect(options.allowedTools).not.toContain(tool);
  expect(options.disallowedTools).toBeUndefined();
  // Anything off the list is refused, never prompted for.
  expect(options.permissionMode).toBe("dontAsk");
  expect(options.allowDangerouslySkipPermissions).toBeUndefined();
});

test("the default system prompt is replaced by pablo's", () => {
  const options = harnessOptions(spec());
  // A plain string replaces Claude Code's prompt; the preset object (or an append) would keep it.
  expect(typeof options.systemPrompt).toBe("string");
  const prompt = options.systemPrompt as string;
  expect(prompt).toStartWith("You are pablo");
  expect(prompt).toContain('"The Ice House"');
  expect(prompt).not.toContain("Claude Code");
});

test("nothing is loaded from disk: no settings, no CLAUDE.md, no user MCP servers, no saved session", () => {
  const options = harnessOptions(spec());
  expect(options.settingSources).toEqual([]);
  expect(options.strictMcpConfig).toBe(true);
  expect(options.persistSession).toBe(false);
  expect(Object.keys(options.mcpServers ?? {})).toEqual(["pablo"]);
  expect(options.cwd).toBe(join(vault, "novels", "ice-house"));
});

test("pablo's MCP tools are attached in-process and callable", async () => {
  const server = harnessOptions(spec()).mcpServers?.["pablo"];
  expect(server?.type).toBe("sdk");
  const instance = (server as { instance: McpServer }).instance;

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await instance.connect(serverSide);
  const client = new Client({ name: "harness-test", version: "0.0.0" });
  await client.connect(clientSide);
  try {
    const listed = (await client.listTools()).tools.map((tool) => tool.name);
    expect(listed).toEqual(mcpTools().map((tool) => tool.name));
    const called = await client.callTool({ name: "status", arguments: { project: "ice-house" } });
    const text = (called.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text)).toMatchObject({ premise: true });
  } finally {
    await client.close();
  }
});

test("a narrower tool list narrows both the allowed list and the attached server", () => {
  const only = harnessTools().filter((tool) => tool.name === "resume");
  const options = harnessOptions(spec({ tools: only }));
  expect(options.allowedTools).toEqual(["WebSearch", "WebFetch", "mcp__pablo__resume"]);
  expect(allowedTools([])).toEqual(["WebSearch", "WebFetch"]);
});

// ---------------------------------------------------------------------------
// AC 3 (unit level; the live proof is a manual smoke): which credential
// ---------------------------------------------------------------------------

test("with no key configured the session runs on the subscription, and a shell API key is stripped", () => {
  const auth = harnessAuth(defaultConfig(), { ...BASE_ENV, ANTHROPIC_API_KEY: "sk-shell", CLAUDE_CODE_USE_BEDROCK: "1" }, { env: {} });
  expect(auth.route).toBe("subscription");
  expect(auth.env["ANTHROPIC_API_KEY"]).toBeUndefined();
  expect(auth.env["CLAUDE_CODE_USE_BEDROCK"]).toBeUndefined();
  expect(auth.env["HOME"]).toBe(root);
  expect(auth.env["CLAUDE_AGENT_SDK_CLIENT_APP"]).toStartWith("pablo/");
  expect(auth.model).toBeUndefined();
  expect(harnessOptions(spec({ auth })).model).toBeUndefined();
});

test("an anthropic provider with no resolvable key still runs on the subscription", () => {
  const config = parseConfig(JSON.stringify({ providers: { anthropic: { kind: "anthropic" } } }));
  expect(harnessAuth(config, BASE_ENV, { env: {} }).route).toBe("subscription");
});

test("an Anthropic key in pablo's config overrides the subscription", () => {
  const config = parseConfig(
    JSON.stringify({ providers: { anthropic: { kind: "anthropic", key: "keychain:pablo-test/me", model: "claude-test-1" } } }),
  );
  const keychain = (service: string, account: string | undefined) => (service === "pablo-test" && account === "me" ? "sk-config" : "");
  const auth = harnessAuth(config, { ...BASE_ENV, ANTHROPIC_API_KEY: "sk-shell" }, { env: {}, keychain });

  expect(auth.route).toBe("api-key");
  expect(auth.env["ANTHROPIC_API_KEY"]).toBe("sk-config");
  expect(auth.model).toBe("claude-test-1");
  const options = harnessOptions(spec({ auth }));
  expect(options.env?.["ANTHROPIC_API_KEY"]).toBe("sk-config");
  expect(options.model).toBe("claude-test-1");
});

// ---------------------------------------------------------------------------
// AC 1: `pablo agent` runs one session headless and prints the transcript
// ---------------------------------------------------------------------------

const init = (apiKeySource = "none") =>
  ({
    type: "system",
    subtype: "init",
    model: "claude-test-1",
    apiKeySource,
    tools: ["WebSearch", "WebFetch", "mcp__pablo__status"],
    mcp_servers: [{ name: "pablo", status: "connected" }],
  }) as unknown as SDKMessage;
const assistant = (content: unknown[]) =>
  ({ type: "assistant", parent_tool_use_id: null, message: { content } }) as unknown as SDKMessage;
const toolResult = (id: string, text: string) =>
  ({
    type: "user",
    parent_tool_use_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] },
  }) as unknown as SDKMessage;
const success = (result: string) =>
  ({ type: "result", subtype: "success", is_error: false, result, num_turns: 2, duration_ms: 1500, total_cost_usd: 0.01 }) as unknown as SDKMessage;

/** A fake session that runs pablo's `status` tool for real, through the attached server. */
function fakeQuery(): { query: HarnessQuery; calls: { prompt: string; options: Options }[] } {
  const calls: { prompt: string; options: Options }[] = [];
  const query: HarnessQuery = async function* (params) {
    calls.push({ prompt: params.prompt, options: params.options });
    yield init();
    yield assistant([
      { type: "text", text: "Checking where the book stands." },
      { type: "tool_use", id: "t1", name: "mcp__pablo__status", input: { project: "ice-house" } },
    ]);
    const instance = (params.options.mcpServers?.["pablo"] as { instance: McpServer }).instance;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await instance.connect(serverSide);
    const client = new Client({ name: "fake-sdk", version: "0.0.0" });
    await client.connect(clientSide);
    const called = await client.callTool({ name: "status", arguments: { project: "ice-house" } });
    await client.close();
    yield toolResult("t1", (called.content as { text: string }[])[0]!.text);
    yield assistant([{ type: "text", text: "The bible is in; acts come next." }]);
    yield success("The bible is in; acts come next.");
  };
  return { query, calls };
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

test("pablo agent runs one session and prints the transcript", async () => {
  const { query, calls } = fakeQuery();
  const io = capture();
  const code = await runAgent({ project: "ice-house", message: "Where are we?", json: false }, io.ctx, { query, readConfig: noConfig });

  expect(code).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.prompt).toBe("Where are we?");
  expect(calls[0]!.options.cwd).toBe(join(vault, "novels", "ice-house"));
  expect(calls[0]!.options.env?.["ANTHROPIC_API_KEY"]).toBeUndefined();

  const lines = io.out().split("\n");
  expect(lines[0]).toBe("› Where are we?");
  expect(lines[1]).toBe("session: claude-test-1, credential none");
  expect(io.out()).toContain("pablo: Checking where the book stands.");
  expect(io.out()).toContain('  → status {"project":"ice-house"}');
  expect(io.out()).toContain('  ← {"premise":true');
  expect(io.out()).toContain("pablo: The bible is in; acts come next.");
  expect(io.out()).toContain("— done: 2 turn(s), 1.5s");
});

test("--json prints one object with the route, entries and result", async () => {
  const { query } = fakeQuery();
  const io = capture();
  const code = await runAgent({ project: "ice-house", message: "Where are we?", json: true }, io.ctx, { query, readConfig: noConfig });

  expect(code).toBe(0);
  const body = JSON.parse(io.out()) as { ok: boolean; route: string; entries: { kind: string }[]; result: { ok: boolean } };
  expect(body.ok).toBe(true);
  expect(body.route).toBe("subscription");
  expect(body.entries.map((entry) => entry.kind)).toEqual(["session", "assistant", "tool_call", "tool_result", "assistant", "result"]);
  expect(body.result.ok).toBe(true);
});

test("a key in the config reaches the session's environment", async () => {
  const { query, calls } = fakeQuery();
  const io = capture();
  const readConfig = () => JSON.stringify({ providers: { anthropic: { kind: "anthropic" } } });
  const code = await runAgent({ project: "ice-house", message: "Hi", json: false }, io.ctx, {
    query,
    readConfig,
    keys: { env: { ANTHROPIC_API_KEY: "sk-config" } },
  });
  expect(code).toBe(0);
  expect(calls[0]!.options.env?.["ANTHROPIC_API_KEY"]).toBe("sk-config");
  expect(io.out()).not.toContain("sk-config");
});

test("refusals: no project, no message, unknown project, no marker; the session never starts", async () => {
  const { query, calls } = fakeQuery();
  const cases = [
    { project: undefined, message: "Hi" },
    { project: "ice-house", message: undefined },
    { project: "ice-house", message: "   " },
    { project: "nope", message: "Hi" },
    { project: "no-marker", message: "Hi" },
  ];
  for (const args of cases) {
    const io = capture();
    expect(await runAgent({ ...args, json: false }, io.ctx, { query, readConfig: noConfig })).toBe(2);
    expect(io.err()).toStartWith("pablo:");
  }
  expect(calls).toHaveLength(0);
});

test("an error result exits 1 and prints the errors", async () => {
  const query: HarnessQuery = async function* () {
    yield { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 9, duration_ms: 10, total_cost_usd: 0, errors: ["too many turns"] } as unknown as SDKMessage;
  };
  const io = capture();
  expect(await runAgent({ project: "ice-house", message: "Hi", json: false }, io.ctx, { query, readConfig: noConfig })).toBe(1);
  expect(io.out()).toContain("— failed: 9 turn(s)");
  expect(io.out()).toContain("too many turns");
});

test("a session that fails to start exits 1 with the login hint", async () => {
  const query: HarnessQuery = async function* () {
    yield* [];
    throw new Error("Claude Code process exited with code 1");
  };
  const io = capture();
  expect(await runAgent({ project: "ice-house", message: "Hi", json: false }, io.ctx, { query, readConfig: noConfig })).toBe(1);
  expect(io.err()).toContain("exited with code 1");
  expect(io.err()).toContain("log in");
});

test("a stream with no result exits 1", async () => {
  const query: HarnessQuery = async function* () {
    yield init();
  };
  const io = capture();
  expect(await runAgent({ project: "ice-house", message: "Hi", json: false }, io.ctx, { query, readConfig: noConfig })).toBe(1);
  expect(io.err()).toContain("without a result");
});

test("`pablo agent` with no --project is refused before any session", async () => {
  expect(await main(["agent", "hello"], vault)).toBe(2);
});

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

test("stream noise and subagent frames map to nothing", () => {
  expect(transcriptEntries({ type: "stream_event" } as unknown as SDKMessage)).toEqual([]);
  expect(transcriptEntries({ type: "system", subtype: "status" } as unknown as SDKMessage)).toEqual([]);
  expect(
    transcriptEntries({ type: "assistant", parent_tool_use_id: "x", message: { content: [{ type: "text", text: "hi" }] } } as unknown as SDKMessage),
  ).toEqual([]);
});

test("long tool results are previewed on one line", () => {
  const line = formatEntry({ kind: "tool_result", id: "t", text: `a\n${"b".repeat(600)}`, isError: false });
  expect(line.split("\n")).toHaveLength(1);
  expect(line.endsWith("…")).toBe(true);
  expect(formatEntry({ kind: "tool_result", id: "t", text: "no", isError: true })).toBe("  ✗ no");
});
