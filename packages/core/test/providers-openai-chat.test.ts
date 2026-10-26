/**
 * `chat()` on the OpenAI-compatible adapter (AGT-2117, D-12), driven through a
 * fake `fetch` seam that replays recorded SSE streams. No socket is opened and
 * no model is ever called.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ChatEvent,
  type ChatRequest,
  createProviders,
  EndpointHung,
  parseConfig,
  ProviderConfigError,
  ProviderResponseError,
  ToolsDisabledError,
} from "../src";

const FIXTURES = join(import.meta.dir, "fixtures", "chat");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

interface Seam {
  readonly fetch: typeof fetch;
  readonly bodies: Record<string, unknown>[];
}

/**
 * A `fetch` that answers every request with `stream`, delivered in pieces of
 * `piece` bytes so SSE frames are split mid-event the way a socket splits them.
 */
function seam(stream: string, options: { piece?: number; status?: number; silent?: boolean } = {}): Seam {
  const bodies: Record<string, unknown>[] = [];
  const fake = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (options.status !== undefined) return new Response(stream, { status: options.status });
    const bytes = new TextEncoder().encode(stream);
    const piece = options.piece ?? 37;
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (options.silent === true) return new Promise(() => {});
        if (offset >= bytes.length) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + piece));
        offset += piece;
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: fake as typeof fetch, bodies };
}

function adapterWith(fake: Seam, local: Record<string, unknown> = {}) {
  const config = parseConfig(
    JSON.stringify({ providers: { local: { endpoint: "http://127.0.0.1:9/v1", model: "gemma-4", local: true, ...local } } }),
  );
  const adapter = createProviders(config, { fetch: fake.fetch, keys: { env: {} } }).adapter("local");
  if (adapter.chat === undefined) throw new Error("the openai-compatible adapter has no chat()");
  return { chat: adapter.chat.bind(adapter) };
}

async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const TOOLS = [
  {
    name: "read_file",
    description: "Read one vault file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "search_vault",
    description: "Search the vault.",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
  },
] as const;

const REQUEST: ChatRequest = {
  system: "You are pablo's agent.",
  messages: [{ role: "user", content: "Who is Ned?" }],
  tools: TOOLS,
};

/** SSE for a stream of chunk objects, the way both servers frame them. */
function sse(...chunks: unknown[]): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n";
}
const delta = (value: Record<string, unknown>, finish: string | null = null) => ({
  choices: [{ index: 0, delta: value, finish_reason: finish }],
});

describe("openai-compatible chat()", () => {
  test("an mlx_lm 0.31.3 Gemma 4 stream: text, then each whole tool call with its id, then usage", async () => {
    const fake = seam(fixture("mlx-lm-0.31.3-gemma4-tool-calls.sse"));
    const events = await collect(adapterWith(fake).chat(REQUEST));

    const text = events.flatMap((event) => (event.type === "text" ? [event.text] : [])).join("");
    expect(text).toBe("I'll check the bible entry and the last chapter.");
    expect(events.filter((event) => event.type !== "text")).toEqual([
      { type: "tool_call", call: { id: "3f0c6d0e-8a51-4f7e-bb0e-0f5d2c9a8e11", name: "read_file", arguments: { path: "bible/ned.md" } } },
      {
        type: "tool_call",
        call: { id: "a7b2e914-1c3d-4f55-9e0a-6b8d7f2c4e33", name: "search_vault", arguments: { query: 'lighthouse "keeper"', limit: 3 } },
      },
      { type: "done", usage: { inputTokens: 412, outputTokens: 57 } },
    ]);
    // Text arrives before the calls, as the model produced it.
    expect(events.findIndex((event) => event.type === "tool_call")).toBeGreaterThan(
      events.map((event) => event.type).lastIndexOf("text"),
    );
  });

  test("an OpenAI delta stream: argument fragments are assembled per index before a call is emitted", async () => {
    const fake = seam(fixture("openai-delta-tool-calls.sse"), { piece: 11 });
    const events = await collect(adapterWith(fake).chat(REQUEST));

    expect(events).toEqual([
      { type: "tool_call", call: { id: "call_Qx7aK2mP9", name: "read_file", arguments: { path: "bible/ned.md" } } },
      { type: "tool_call", call: { id: "call_Lm3bR8tY2", name: "search_vault", arguments: { query: 'lighthouse "keeper"', limit: 3 } } },
      { type: "done", usage: { inputTokens: 388, outputTokens: 44 } },
    ]);
  });

  test("the request carries system, the whole history and the tools", async () => {
    const fake = seam(sse(delta({ role: "assistant", content: "He keeps the light." }, "stop")));
    await collect(
      adapterWith(fake).chat({
        ...REQUEST,
        toolChoice: "required",
        maxTokens: 300,
        temperature: 0.2,
        messages: [
          { role: "user", content: "Who is Ned?" },
          { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read_file", arguments: { path: "bible/ned.md" } }] },
          { role: "tool", toolCallId: "call_1", content: "Ned keeps the lighthouse." },
          { role: "assistant", content: "Checking chapter one too.", toolCalls: [{ id: "call_2", name: "read_file", arguments: { path: "chapters/01.md" } }] },
          { role: "tool", toolCallId: "call_2", content: "no such file", isError: true },
        ],
      }),
    );

    const body = fake.bodies[0] ?? {};
    expect(body["model"]).toBe("gemma-4");
    expect(body["stream"]).toBe(true);
    expect(body["stream_options"]).toEqual({ include_usage: true });
    expect(body["max_tokens"]).toBe(300);
    expect(body["temperature"]).toBe(0.2);
    expect(body["chat_template_kwargs"]).toEqual({ enable_thinking: false });
    expect(body["tool_choice"]).toBe("required");
    expect(body["tools"]).toEqual(
      TOOLS.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
    );
    expect(body["messages"]).toEqual([
      { role: "system", content: "You are pablo's agent." },
      { role: "user", content: "Who is Ned?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"bible/ned.md"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "Ned keeps the lighthouse." },
      {
        role: "assistant",
        content: "Checking chapter one too.",
        tool_calls: [{ id: "call_2", type: "function", function: { name: "read_file", arguments: '{"path":"chapters/01.md"}' } }],
      },
      { role: "tool", tool_call_id: "call_2", content: "Error: no such file" },
    ]);
  });

  test("tool_choice defaults to auto and a named choice maps to the function form", async () => {
    const fake = seam(sse(delta({ content: "ok" }, "stop")));
    const { chat } = adapterWith(fake);
    await collect(chat(REQUEST));
    await collect(chat({ ...REQUEST, toolChoice: { name: "read_file" } }));
    expect(fake.bodies[0]?.["tool_choice"]).toBe("auto");
    expect(fake.bodies[1]?.["tool_choice"]).toEqual({ type: "function", function: { name: "read_file" } });
  });

  test("a turn with no tools sends neither tools nor tool_choice, and streams plain text", async () => {
    const fake = seam(sse(delta({ content: "Hello" }), delta({ content: " there." }, "stop"), { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }));
    const events = await collect(adapterWith(fake).chat({ ...REQUEST, tools: [] }));
    expect(events).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: " there." },
      { type: "done", usage: { inputTokens: 9, outputTokens: 2 } },
    ]);
    expect(fake.bodies[0]).not.toHaveProperty("tools");
    expect(fake.bodies[0]).not.toHaveProperty("tool_choice");
  });

  test("usage is undefined when the endpoint reports none", async () => {
    const fake = seam(sse(delta({ content: "hi" }, "stop")));
    const events = await collect(adapterWith(fake).chat(REQUEST));
    expect(events.at(-1)).toEqual({ type: "done", usage: { inputTokens: undefined, outputTokens: undefined } });
  });

  test("text after a call keeps the order the model produced", async () => {
    const fake = seam(
      sse(
        delta({ content: "First." }),
        delta({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.md"}' } }] }),
        delta({ content: "Then." }, "stop"),
      ),
    );
    const events = await collect(adapterWith(fake).chat(REQUEST));
    expect(events.map((event) => (event.type === "tool_call" ? event.call.id : event.type))).toEqual(["text", "c1", "text", "done"]);
  });

  test("whole calls all numbered 0 are told apart by their ids", async () => {
    const fake = seam(
      sse(
        delta({ tool_calls: [{ index: 0, id: "a", function: { name: "read_file", arguments: '{"path":"a.md"}' } }] }),
        delta({ tool_calls: [{ index: 0, id: "b", function: { name: "read_file", arguments: '{"path":"b.md"}' } }] }, "tool_calls"),
      ),
    );
    const calls = (await collect(adapterWith(fake).chat(REQUEST))).flatMap((event) => (event.type === "tool_call" ? [event.call] : []));
    expect(calls).toEqual([
      { id: "a", name: "read_file", arguments: { path: "a.md" } },
      { id: "b", name: "read_file", arguments: { path: "b.md" } },
    ]);
  });

  test("a call with no id gets one, and empty arguments are an empty object", async () => {
    const fake = seam(sse(delta({ tool_calls: [{ function: { name: "read_file", arguments: "" } }] }, "tool_calls")));
    const calls = (await collect(adapterWith(fake).chat(REQUEST))).flatMap((event) => (event.type === "tool_call" ? [event.call] : []));
    expect(calls).toEqual([{ id: "call_1", name: "read_file", arguments: {} }]);
  });

  test("arguments that are not a JSON object are a named error", async () => {
    const broken = seam(sse(delta({ tool_calls: [{ index: 0, id: "c", function: { name: "read_file", arguments: '{"path": ' } }] }, "tool_calls")));
    const error = await collect(adapterWith(broken).chat(REQUEST)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderResponseError);
    expect((error as Error).message).toContain("read_file call whose arguments are not valid JSON");

    const list = seam(sse(delta({ tool_calls: [{ index: 0, id: "c", function: { name: "read_file", arguments: "[1]" } }] }, "tool_calls")));
    const listError = await collect(adapterWith(list).chat(REQUEST)).catch((caught: unknown) => caught);
    expect((listError as Error).message).toContain("not an object");
  });

  test("an HTTP error is a ProviderResponseError with the status", async () => {
    const fake = seam("model not loaded", { status: 503 });
    const error = await collect(adapterWith(fake).chat(REQUEST)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderResponseError);
    expect((error as ProviderResponseError).status).toBe(503);
  });

  test("a silent endpoint becomes EndpointHung", async () => {
    const fake = seam("", { silent: true });
    const error = await collect(adapterWith(fake, { timeoutMs: 40 }).chat(REQUEST)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EndpointHung);
  });

  test("a turn spent only thinking names the fix", async () => {
    const fake = seam(sse(delta({ reasoning: "Hmm, Ned..." }), delta({}, "length")));
    const error = await collect(adapterWith(fake, { thinking: true }).chat(REQUEST)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderResponseError);
    expect((error as Error).message).toContain('"thinking": false');
  });
});

describe('the "tools": false provider flag', () => {
  test("chat() refuses a turn that offers tools, before any request is sent", async () => {
    const fake = seam(sse(delta({ content: "never" }, "stop")));
    const error = await collect(adapterWith(fake, { tools: false }).chat(REQUEST)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ToolsDisabledError);
    expect(error).toBeInstanceOf(ProviderConfigError);
    expect((error as Error).message).toContain('provider "local" is configured with "tools": false');
    expect(fake.bodies).toHaveLength(0);
  });

  test("a turn with no tools still goes through", async () => {
    const fake = seam(sse(delta({ content: "fine" }, "stop")));
    const events = await collect(adapterWith(fake, { tools: false }).chat({ ...REQUEST, tools: [] }));
    expect(events[0]).toEqual({ type: "text", text: "fine" });
  });

  test("the config reads it and refuses a non-boolean", () => {
    const config = parseConfig(JSON.stringify({ providers: { local: { endpoint: "http://127.0.0.1:9/v1", model: "m", tools: false } } }));
    expect(config.providers.get("local")?.tools).toBe(false);
    expect(() =>
      parseConfig(JSON.stringify({ providers: { local: { endpoint: "http://127.0.0.1:9/v1", model: "m", tools: "no" } } })),
    ).toThrow('"tools" must be true or false');
  });
});
