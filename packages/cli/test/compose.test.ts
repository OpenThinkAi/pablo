/**
 * The compose view's session (AGT-1566): `createComposer` over a fake `ComposeQuery`. No test starts Claude, reaches
 * the network, reads the Keychain or the real config file; the fixture vault is a temp copy.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defaultConfig } from "@openthink/pablo-core";
import type { ComposeEvent } from "@openthink/pablo-tui";
import { harnessAuth } from "../src/harness/auth";
import { composeSpec } from "../src/cli";
import { composeEvents, createComposer } from "../src/harness/compose";
import type { ComposeQuery } from "../src/harness/compose";
import { harnessOptions } from "../src/harness/session";
import type { HarnessSpec } from "../src/harness/session";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pablo-compose-test-"));
const vault = join(root, "vault");
cpSync(FIXTURE_VAULT, vault, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const BASE_ENV = { PABLO_VAULT: vault, PATH: "/usr/bin:/bin", HOME: root, XDG_CONFIG_HOME: join(root, "config") };
const spec = (): HarnessSpec => ({
  work: { title: "The Ice House", format: "novel", slug: "ice-house" },
  projectPath: join(vault, "novels", "ice-house"),
  auth: harnessAuth(defaultConfig(), BASE_ENV, { env: {} }),
  ctx: { cwd: vault, env: BASE_ENV, stderr: { write: () => {} }, caller: "mcp" },
});

const init = () => ({ type: "system", subtype: "init", session_id: "sess-42", model: "claude-test-1", apiKeySource: "none", tools: [], mcp_servers: [] }) as unknown as SDKMessage;
const assistant = (content: unknown[]) => ({ type: "assistant", parent_tool_use_id: null, message: { content } }) as unknown as SDKMessage;
const toolResult = (id: string, text: string) =>
  ({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } }) as unknown as SDKMessage;
const success = (result: string) => ({ type: "result", subtype: "success", is_error: false, result, num_turns: 1, duration_ms: 10, total_cost_usd: 0 }) as unknown as SDKMessage;

async function collect(stream: AsyncIterable<ComposeEvent>): Promise<ComposeEvent[]> {
  const out: ComposeEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

/** A fake session: one init, then for each user message pulled from the prompt a scripted turn. Records what it saw. */
function fakeSession(onMessage: (text: string, n: number) => SDKMessage[]) {
  const seen = { started: 0, options: [] as Options[], messages: [] as string[], ended: false };
  const query: ComposeQuery = async function* (params) {
    seen.started++;
    seen.options.push(params.options);
    yield init();
    let n = 0;
    try {
      for await (const message of params.prompt as AsyncIterable<SDKUserMessage>) {
        const text = message.message.content as string;
        seen.messages.push(text);
        yield* onMessage(text, ++n);
      }
    } finally {
      seen.ended = true;
    }
  };
  return { query, seen };
}

test("a turn streams the session id, pablo's text, the tool call under its display name, its result, and ends at the result", async () => {
  const { query } = fakeSession((text) => [
    assistant([{ type: "text", text: `heard ${text}` }, { type: "tool_use", id: "t1", name: "mcp__pablo__resume", input: { project: "ice-house" } }]),
    toolResult("t1", "bible done"),
    success("done"),
  ]);
  const composer = createComposer(spec, query);
  expect(await collect(composer.send("where are we?"))).toEqual([
    { kind: "session", id: "sess-42" },
    { kind: "assistant", text: "heard where are we?" },
    { kind: "tool_call", id: "t1", tool: "resume", input: { project: "ice-house" } },
    { kind: "tool_result", id: "t1", text: "bible done", isError: false },
    { kind: "result", ok: true, errors: [] },
  ]);
  composer.close?.();
});

test("one session carries every message: the second send continues the same query, in this process", async () => {
  const { query, seen } = fakeSession((text, n) => [assistant([{ type: "text", text: `turn ${n}: ${text}` }]), success("ok")]);
  const composer = createComposer(spec, query);
  const first = await collect(composer.send("one"));
  const second = await collect(composer.send("two"));
  expect(seen.started).toBe(1);
  expect(seen.messages).toEqual(["one", "two"]);
  expect(first.at(-2)).toEqual({ kind: "assistant", text: "turn 1: one" });
  expect(second).toEqual([{ kind: "assistant", text: "turn 2: two" }, { kind: "result", ok: true, errors: [] }]); // the id is announced once
  composer.close?.();
  await new Promise((r) => setTimeout(r, 10));
  expect(seen.ended).toBe(true);
});

test("the session is configured as pablo: the harness options, nothing else", async () => {
  const { query, seen } = fakeSession(() => [success("ok")]);
  const composer = createComposer(spec, query);
  await collect(composer.send("hi"));
  const options = seen.options[0]!;
  expect(options.tools).toEqual(["WebSearch", "WebFetch"]);
  expect(options.persistSession).toBe(false);
  expect(options.permissionMode).toBe("dontAsk");
  expect(options.cwd).toBe(join(vault, "novels", "ice-house"));
  composer.close?.();
});

test("a failed result carries the reasons; a stream that throws is an error with the login hint, and the next message starts afresh", async () => {
  let starts = 0;
  const query: ComposeQuery = async function* () {
    starts++;
    if (starts === 1) throw new Error("401 not logged in");
    yield init();
    yield { type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"], num_turns: 1, duration_ms: 1, total_cost_usd: 0 } as unknown as SDKMessage;
  };
  const composer = createComposer(spec, query);
  await expect(collect(composer.send("hi"))).rejects.toThrow(/pablo's session failed \(401 not logged in\).*claude/);
  expect((await collect(composer.send("again"))).at(-1)).toEqual({ kind: "result", ok: false, errors: ["boom"] });
  expect(starts).toBe(2);
});

test("a spec that cannot be built (no credential) surfaces as an error on the first message, not at construction", async () => {
  const composer = createComposer(() => { throw new Error("no key"); }, fakeSession(() => []).query);
  await expect(collect(composer.send("hi"))).rejects.toThrow(/no key/);
});

test("composeEvents maps only what the screen draws; hooks and stream noise map to nothing", () => {
  expect(composeEvents({ type: "system", subtype: "status" } as unknown as SDKMessage)).toEqual([]);
  expect(composeEvents(init())).toEqual([{ kind: "session", id: "sess-42" }]);
});

test("ask_author in the compose session: the card reaches the screen mid-turn, the answer resumes the tool call", async () => {
  // A fake session that calls the attached ask_author tool for real, through the in-process MCP server.
  const query: ComposeQuery = async function* (params) {
    yield init();
    for await (const _message of params.prompt as AsyncIterable<SDKUserMessage>) {
      yield assistant([{ type: "tool_use", id: "t1", name: "mcp__pablo__ask_author", input: {} }]);
      const instance = (params.options.mcpServers?.["pablo"] as { instance: McpServer }).instance;
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await instance.connect(serverSide);
      const client = new Client({ name: "fake-sdk", version: "0.0.0" });
      await client.connect(clientSide);
      const called = await client.callTool({ name: "ask_author", arguments: { question: "Does Cora know?", options: ["yes", "no"], why: "it changes chapter 4" } });
      await client.close();
      yield toolResult("t1", (called.content as { text: string }[])[0]!.text);
      yield success("ok");
    }
  };
  const composer = createComposer(spec, query);
  const events: ComposeEvent[] = [];
  for await (const event of composer.send("plan chapter 4")) {
    events.push(event);
    if (event.kind === "question") {
      expect(event).toEqual({ kind: "question", id: "q1", question: "Does Cora know?", options: ["yes", "no"], why: "it changes chapter 4" });
      composer.answer?.(event.id, "2");
    }
  }
  expect(events.map((e) => e.kind)).toEqual(["session", "tool_call", "question", "tool_result", "result"]);
  const answered = events.find((e) => e.kind === "tool_result") as Extract<ComposeEvent, { kind: "tool_result" }>;
  expect(JSON.parse(answered.text)).toMatchObject({ ok: true, answer: "no" });
  composer.close?.();
});

test("the screen's session is built like pablo agent's: the work's policy and QWEN.md reach the system prompt, and a refusal is an error", () => {
  const dir = join(vault, "novels", "ice-house");
  const plain = composeSpec(dir, vault, BASE_ENV);
  expect(plain.work).toMatchObject({ title: "The Ice House", format: "novel", slug: "ice-house" });
  expect(plain.work.rules).toBe(readFileSync(join(dir, "QWEN.md"), "utf8"));
  expect(plain.projectPath).toBe(dir);
  expect(plain.auth.route).toBe("subscription");

  const marker = join(dir, "pablo.json");
  const original = readFileSync(marker, "utf8");
  try {
    writeFileSync(marker, JSON.stringify({ ...JSON.parse(original), policy: "historical-fiction" }));
    const historical = composeSpec(dir, vault, BASE_ENV);
    expect(historical.work.policy?.name).toBe("historical-fiction");
    expect(harnessOptions(historical).systemPrompt as string).toContain(historical.work.policy!.text.trim().split("\n")[0]!);

    writeFileSync(marker, JSON.stringify({ ...JSON.parse(original), policy: "no-such-policy" }));
    expect(() => composeSpec(dir, vault, BASE_ENV)).toThrow(/does not ship/);
  } finally {
    writeFileSync(marker, original);
  }
  expect(() => composeSpec(join(vault, "novels", "no-marker"), vault, BASE_ENV)).toThrow();
});
