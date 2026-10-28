/**
 * The Anthropic adapter's `chat()` (AGT-2118, D-12), driven through the
 * adapter's injected `fetch` seam: each turn's response is a fixture in the
 * Messages API's streamed SSE shape (`fixtures/anthropic-chat/turn-N.sse`),
 * cut into small chunks so frames straddle reads. Nothing here opens a socket,
 * reads the Keychain, or calls a model.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  type ChatEvent,
  type ChatMessage,
  type ChatRequest,
  createAnthropicAdapter,
  ProviderResponseError,
  type ProviderConfig,
  RateMeter,
  ToolsDisabledError,
} from "../src/index";
import { parseWithTestDefaults } from "./local-config";

const FIXTURES = join(import.meta.dir, "fixtures", "anthropic-chat");
const KEY = "not-a-real-key";

const READ_FILE = {
  name: "read_file",
  description: "Read one vault file.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
} as const;

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly headers: Headers;
}

/** A fake HTTP seam: answers each request with the next SSE body, in 41-byte chunks. */
function fakeFetch(bodies: readonly string[]): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  let next = 0;
  const fake = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    sent.push({
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: new Headers(init?.headers),
    });
    const body = bodies[next];
    next += 1;
    if (body === undefined) throw new Error(`the fake has ${bodies.length} response(s) and was asked again`);
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let at = 0; at < bytes.length; at += 41) controller.enqueue(bytes.slice(at, at + 41));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: fake as typeof fetch, sent };
}

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

function adapterWith(fetchSeam: typeof fetch, extra: Record<string, unknown> = {}) {
  const config = parseWithTestDefaults(
    JSON.stringify({
      providers: { anthropic: { kind: "anthropic", endpoint: "https://api.example.test/v1", ...extra } },
    }),
  );
  const provider = config.providers.get("anthropic") as ProviderConfig;
  const adapter = createAnthropicAdapter({ provider, meter: new RateMeter(), key: () => KEY, fetch: fetchSeam });
  if (adapter.chat === undefined) throw new Error("the Anthropic adapter has no chat()");
  return { adapter, chat: adapter.chat.bind(adapter) };
}

async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** The text events joined, so a test does not depend on how the stream was chunked. */
function textOf(events: readonly ChatEvent[]): string {
  return events.map((event) => (event.type === "text" ? event.text : "")).join("");
}

test("a two-turn tool conversation: ids out, tool results and thinking back, usage reported", async () => {
  const seam = fakeFetch([fixture("turn-1.sse"), fixture("turn-2.sse")]);
  const { chat } = adapterWith(seam.fetch);

  const history: ChatMessage[] = [{ role: "user", content: "Who is Ned?" }];
  const first: ChatRequest = { system: "You are pablo's agent.", messages: history, tools: [READ_FILE] };
  const one = await collect(chat(first));

  expect(textOf(one)).toBe("Let me check the bible.");
  const calls = one.filter((event) => event.type === "tool_call");
  expect(calls).toEqual([
    { type: "tool_call", call: { id: "toolu_01FixtureRead", name: "read_file", arguments: { path: "bible/ned.md" } } },
  ]);
  expect(one.at(-1)).toEqual({ type: "done", usage: { inputTokens: 812, outputTokens: 64 } });
  // Text arrives before the call, as the model produced them.
  expect(one.findIndex((event) => event.type === "tool_call")).toBeGreaterThan(
    one.findIndex((event) => event.type === "text"),
  );

  const request1 = seam.sent[0];
  expect(request1?.url).toBe("https://api.example.test/v1/messages");
  expect(request1?.headers.get("x-api-key")).toBe(KEY);
  expect(request1?.headers.get("anthropic-version")).toBe("2023-06-01");
  expect(request1?.body["system"]).toBe("You are pablo's agent.");
  expect(request1?.body["stream"]).toBe(true);
  expect(request1?.body["messages"]).toEqual([{ role: "user", content: [{ type: "text", text: "Who is Ned?" }] }]);
  expect(request1?.body["tools"]).toEqual([
    { name: "read_file", description: "Read one vault file.", input_schema: READ_FILE.parameters },
  ]);
  expect(request1?.body["tool_choice"]).toEqual({ type: "auto" });
  expect(request1?.body).not.toHaveProperty("temperature");

  // The loop runs the tool and replays the turn as neutral history.
  history.push(
    { role: "assistant", content: "Let me check the bible.", toolCalls: calls.map((event) => event.call) },
    { role: "tool", toolCallId: "toolu_01FixtureRead", content: "Ned keeps the lighthouse on the point." },
  );
  const two = await collect(chat({ ...first, messages: history }));

  expect(textOf(two)).toBe("Ned keeps the lighthouse.");
  expect(two.some((event) => event.type === "tool_call")).toBe(false);
  expect(two.at(-1)).toEqual({ type: "done", usage: { inputTokens: 905, outputTokens: 21 } });

  expect(seam.sent[1]?.body["messages"]).toEqual([
    { role: "user", content: [{ type: "text", text: "Who is Ned?" }] },
    {
      role: "assistant",
      // The turn goes back exactly as the API sent it: its thinking block and
      // signature first, then the text, then the tool_use with its id.
      content: [
        { type: "thinking", thinking: "", signature: "EqQBCkgIBRABGAIiQFixtureSignatureOne" },
        { type: "text", text: "Let me check the bible." },
        { type: "tool_use", id: "toolu_01FixtureRead", name: "read_file", input: { path: "bible/ned.md" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_01FixtureRead", content: "Ned keeps the lighthouse on the point." },
      ],
    },
  ]);
});

test("a history this adapter did not produce is rebuilt from the neutral turns, results grouped", async () => {
  const seam = fakeFetch([fixture("turn-2.sse")]);
  const { chat } = adapterWith(seam.fetch);

  await collect(
    chat({
      system: "s",
      tools: [READ_FILE],
      messages: [
        { role: "user", content: "Compare Ned and Ada." },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_a", name: "read_file", arguments: { path: "bible/ned.md" } },
            { id: "call_b", name: "read_file", arguments: { path: "bible/ada.md" } },
          ],
        },
        { role: "tool", toolCallId: "call_a", content: "Ned keeps the lighthouse." },
        { role: "tool", toolCallId: "call_b", content: "no such file", isError: true },
        { role: "user", content: "Use what you found." },
      ],
    }),
  );

  expect(seam.sent[0]?.body["messages"]).toEqual([
    { role: "user", content: [{ type: "text", text: "Compare Ned and Ada." }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_a", name: "read_file", input: { path: "bible/ned.md" } },
        { type: "tool_use", id: "call_b", name: "read_file", input: { path: "bible/ada.md" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_a", content: "Ned keeps the lighthouse." },
        { type: "tool_result", tool_use_id: "call_b", content: "no such file", is_error: true },
        { type: "text", text: "Use what you found." },
      ],
    },
  ]);
});

test("tool choice maps to the Messages API's own, and a turn with no tools sends neither field", async () => {
  const seam = fakeFetch(Array.from({ length: 4 }, () => fixture("turn-2.sse")));
  const { chat } = adapterWith(seam.fetch);
  const base = { system: "s", messages: [{ role: "user" as const, content: "hi" }] };

  await collect(chat({ ...base, tools: [READ_FILE], toolChoice: "required" }));
  await collect(chat({ ...base, tools: [READ_FILE], toolChoice: "none" }));
  await collect(chat({ ...base, tools: [READ_FILE], toolChoice: { name: "read_file" } }));
  await collect(chat({ ...base, tools: [], toolChoice: "auto" }));

  expect(seam.sent.map((sent) => sent.body["tool_choice"])).toEqual([
    { type: "any" },
    { type: "none" },
    { type: "tool", name: "read_file" },
    undefined,
  ]);
  expect(seam.sent[3]?.body).not.toHaveProperty("tools");
});

test("tool-call arguments that are not a JSON object are a named error, not a call", async () => {
  const broken = fixture("turn-1.sse").replace('le/ned.md\\"}', 'le/ned.md\\"');
  const { chat } = adapterWith(fakeFetch([broken]).fetch);

  const run = collect(chat({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [READ_FILE] }));
  await expect(run).rejects.toBeInstanceOf(ProviderResponseError);
});

test("an assistant turn with nothing in it is refused before anything is sent", async () => {
  const seam = fakeFetch([fixture("turn-2.sse")]);
  const { chat } = adapterWith(seam.fetch);

  const run = collect(
    chat({
      system: "s",
      tools: [],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "" },
        { role: "user", content: "again" },
      ],
    }),
  );
  await expect(run).rejects.toThrow("no text and no tool calls");
  expect(seam.sent).toHaveLength(0);
});

test('a provider configured with "tools": false refuses a turn that offers tools, and sends nothing', async () => {
  const seam = fakeFetch([fixture("turn-2.sse")]);
  const { chat } = adapterWith(seam.fetch, { tools: false });

  const run = collect(chat({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [READ_FILE] }));
  await expect(run).rejects.toBeInstanceOf(ToolsDisabledError);
  expect(seam.sent).toHaveLength(0);

  // A turn with no tools still goes through.
  const events = await collect(chat({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [] }));
  expect(textOf(events)).toBe("Ned keeps the lighthouse.");
});

test('"thinking": false sends a disabled thinking param on chat(); unset sends none', async () => {
  const request: ChatRequest = { system: "s", messages: [{ role: "user", content: "hi" }], tools: [READ_FILE] };
  const on = fakeFetch([fixture("turn-2.sse")]);
  await collect(adapterWith(on.fetch).chat(request));
  const off = fakeFetch([fixture("turn-2.sse")]);
  await collect(adapterWith(off.fetch, { thinking: false }).chat(request));

  expect(on.sent[0]?.body).not.toHaveProperty("thinking");
  expect(off.sent[0]?.body["thinking"]).toEqual({ type: "disabled" });
});
