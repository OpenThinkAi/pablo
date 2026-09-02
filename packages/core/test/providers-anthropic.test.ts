/**
 * The Anthropic adapter, against an in-process fake speaking the Messages API's
 * SSE shape. Nothing here reaches the network or the Keychain: the key resolver
 * is injected, and the only key any test knows is the string "not-a-real-key".
 */

import { afterEach, expect, test } from "bun:test";
import {
  DEFAULT_ANTHROPIC_ENDPOINT,
  DEFAULT_ANTHROPIC_MODEL,
  EndpointHung,
  ProviderConfigError,
  ProviderResponseError,
  RateMeter,
  createAnthropicAdapter,
  createProviders,
  parseConfig,
} from "../src/index";
import type {
  Adapter,
  AnthropicOutputPath,
  CompletionEvent,
  CompletionStats,
  Document,
  Intent,
  ProviderConfig,
} from "../src/index";

// ---------------------------------------------------------------- the fake

interface RecordedRequest {
  readonly body: Record<string, unknown>;
  readonly apiKey: string | null;
  readonly version: string | null;
}

interface FakeOptions {
  /** `text_delta` chunks, streamed from a text block. */
  readonly text?: readonly string[];
  /** A `tool_use` block whose arguments arrive as `input_json_delta` fragments. */
  readonly tool?: { readonly name: string; readonly input: unknown; readonly pieces?: number };
  /** A `thinking` block ahead of everything else, which the adapter must drop. */
  readonly thinking?: string;
  readonly usage?: { readonly input_tokens: number; readonly output_tokens: number };
  readonly gapMs?: number;
  readonly silent?: boolean;
  readonly status?: number;
  readonly errorBody?: string;
  readonly stopReason?: string;
  readonly stopCategory?: string;
}

interface FakeAnthropic {
  readonly url: string;
  readonly requests: readonly RecordedRequest[];
  stop(): void;
}

const encoder = new TextEncoder();
const running: FakeAnthropic[] = [];

afterEach(() => {
  while (running.length > 0) running.pop()?.stop();
});

function endpoint(options: FakeOptions = {}): FakeAnthropic {
  const requests: RecordedRequest[] = [];
  const gapMs = options.gapMs ?? 2;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests.push({
        body: (await request.json()) as Record<string, unknown>,
        apiKey: request.headers.get("x-api-key"),
        version: request.headers.get("anthropic-version"),
      });

      if (options.status !== undefined) {
        return new Response(options.errorBody ?? "upstream said no", { status: options.status });
      }

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          if (options.silent) return;
          const send = (type: string, payload: object) =>
            controller.enqueue(
              encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`),
            );

          send("message_start", {
            message: { usage: { input_tokens: options.usage?.input_tokens ?? 0, output_tokens: 0 } },
          });

          let index = 0;
          if (options.thinking !== undefined) {
            send("content_block_start", { index, content_block: { type: "thinking", thinking: "" } });
            send("content_block_delta", { index, delta: { type: "thinking_delta", thinking: options.thinking } });
            send("content_block_stop", { index });
            index += 1;
          }

          if (options.text !== undefined) {
            send("content_block_start", { index, content_block: { type: "text", text: "" } });
            for (const chunk of options.text) {
              await Bun.sleep(gapMs);
              send("content_block_delta", { index, delta: { type: "text_delta", text: chunk } });
            }
            send("content_block_stop", { index });
            index += 1;
          }

          if (options.tool !== undefined) {
            send("content_block_start", {
              index,
              content_block: { type: "tool_use", id: "toolu_fake", name: options.tool.name, input: {} },
            });
            for (const piece of split(JSON.stringify(options.tool.input), options.tool.pieces ?? 3)) {
              await Bun.sleep(gapMs);
              send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: piece } });
            }
            send("content_block_stop", { index });
          }

          send("message_delta", {
            delta: {
              stop_reason: options.stopReason ?? (options.tool ? "tool_use" : "end_turn"),
              ...(options.stopCategory === undefined
                ? {}
                : { stop_details: { type: "refusal", category: options.stopCategory } }),
            },
            usage: { output_tokens: options.usage?.output_tokens ?? 0 },
          });
          send("message_stop", {});
          controller.close();
        },
      });

      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });

  const fake: FakeAnthropic = {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    stop: () => server.stop(true),
  };
  running.push(fake);
  return fake;
}

/** Splits a string into `count` roughly equal pieces, so JSON arrives in fragments. */
function split(text: string, count: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / count));
  const pieces: string[] = [];
  for (let at = 0; at < text.length; at += size) pieces.push(text.slice(at, at + size));
  return pieces.length === 0 ? [""] : pieces;
}

// ------------------------------------------------------------- the fixtures

const KEY = "not-a-real-key";
const revise: Intent = { name: "tighten", kind: "revising" };
const document: Document = { path: "/tmp/chapter-01.md", text: "The valley kept time in its own way." };
const span = { start: 0, end: document.text.length };

function configFor(url: string, extra: Record<string, unknown> = {}) {
  return parseConfig(
    JSON.stringify({ providers: { anthropic: { kind: "anthropic", endpoint: url, ...extra } } }),
  );
}

function adapterAt(url: string, extra: Record<string, unknown> = {}): Adapter {
  return createProviders(configFor(url, extra), { keys: { env: { ANTHROPIC_API_KEY: KEY } } }).adapter(
    "anthropic",
  );
}

/** The registry has no `output` knob; the bake-off builds each path directly, as here. */
function adapterWithOutput(url: string, output: AnthropicOutputPath): Adapter {
  const provider = configFor(url).providers.get("anthropic") as ProviderConfig;
  return createAnthropicAdapter({ provider, meter: new RateMeter(), key: () => KEY, output });
}

async function drain(events: AsyncIterable<CompletionEvent>): Promise<{ text: string; stats: CompletionStats }> {
  let text = "";
  let stats: CompletionStats | undefined;
  for await (const event of events) {
    if (event.type === "token") text += event.text;
    else stats = event.stats;
  }
  if (!stats) throw new Error("the stream ended without a done event");
  return { text, stats };
}

// ------------------------------------------------------------------- tests

test("a config entry of kind anthropic needs only a key: the endpoint and model come with it", () => {
  const config = parseConfig(
    JSON.stringify({
      providers: { anthropic: { kind: "anthropic", key: "keychain:ANTHROPIC_API_KEY_PERSONAL/mattpardini" } },
      intents: { "period-check": "anthropic" },
    }),
  );

  const provider = config.providers.get("anthropic");
  expect(provider?.endpoint).toBe(DEFAULT_ANTHROPIC_ENDPOINT);
  expect(provider?.model).toBe(DEFAULT_ANTHROPIC_MODEL);
  expect(provider?.local).toBe(false);
  expect(provider?.key).toEqual({
    from: "keychain",
    service: "ANTHROPIC_API_KEY_PERSONAL",
    account: "mattpardini",
  });
  expect(config.intents.get("period-check")).toBe("anthropic");
});

test("a completion streams its text and reports what the Messages API measured", async () => {
  const fake = endpoint({
    text: ["The ", "valley ", "kept"],
    thinking: "dropped on the floor",
    usage: { input_tokens: 41, output_tokens: 3 },
    gapMs: 6,
  });

  const { text, stats } = await drain(adapterAt(fake.url).complete({ prompt: "write a line" }));

  expect(text).toBe("The valley kept");
  expect(stats.tokensRead).toBe(41);
  expect(stats.tokensWritten).toBe(3);
  expect(stats.timeToFirstTokenMs).toBeGreaterThan(0);
  expect(stats.elapsedMs).toBeGreaterThanOrEqual(stats.timeToFirstTokenMs);
  expect(stats.tokensPerSecond).toBeGreaterThan(0);

  const sent = fake.requests[0];
  expect(sent?.apiKey).toBe(KEY);
  expect(sent?.version).toBe("2023-06-01");
  expect(sent?.body["model"]).toBe(DEFAULT_ANTHROPIC_MODEL);
  expect(sent?.body["stream"]).toBe(true);
  expect(sent?.body["max_tokens"]).toBe(16_000);
  expect(sent?.body["messages"]).toEqual([{ role: "user", content: "write a line" }]);
  expect(String(sent?.body["system"])).toContain("cannot write files");
  // Sampling parameters are rejected by current models; none is sent unasked.
  expect(sent?.body).not.toHaveProperty("temperature");
});

test("a native tool call becomes a proposal against the span it was asked about", async () => {
  const fake = endpoint({
    thinking: "considering",
    tool: { name: "propose_edit", input: { variants: ["The valley kept its own time."] }, pieces: 5 },
    usage: { input_tokens: 120, output_tokens: 14 },
  });

  const proposal = await adapterAt(fake.url).proposeEdit({
    intent: revise,
    instruction: "tighten it",
    document,
    span,
  });

  expect(proposal.variants).toEqual(["The valley kept its own time."]);
  expect(proposal.span).toEqual(span);
  expect(proposal.intent).toBe(revise);
  expect(proposal.providerId).toBe("anthropic");
  expect(proposal.model).toBe(DEFAULT_ANTHROPIC_MODEL);

  const sent = fake.requests[0]?.body ?? {};
  const tools = sent["tools"] as { name: string; strict: boolean; input_schema: Record<string, unknown> }[];
  expect(tools[0]?.name).toBe("propose_edit");
  expect(tools[0]?.strict).toBe(true);
  expect(tools[0]?.input_schema["additionalProperties"]).toBe(false);
  expect(sent["tool_choice"]).toEqual({ type: "tool", name: "propose_edit" });
});

test("several variants come back from one tool call", async () => {
  const fake = endpoint({
    tool: { name: "propose_edit", input: { variants: ["one", "two", "three", "four"] } },
  });

  const proposal = await adapterAt(fake.url).proposeEdit({
    intent: revise,
    instruction: "three ways",
    document,
    span,
    variants: 3,
  });

  expect(proposal.variants).toEqual(["one", "two", "three"]);
  expect(fake.requests).toHaveLength(1);
  expect(String((fake.requests[0]?.body["messages"] as { content: string }[])[0]?.content)).toContain(
    "3 different replacements",
  );
});

test("fewer replacements than were asked for is an error, not a short list", async () => {
  const fake = endpoint({ tool: { name: "propose_edit", input: { variants: ["only one"] } } });

  const failed = await adapterAt(fake.url)
    .proposeEdit({ intent: revise, instruction: "three ways", document, span, variants: 3 })
    .catch((error: unknown) => error);

  expect(failed).toBeInstanceOf(ProviderResponseError);
  expect((failed as Error).message).toContain("where 3 were asked for");
});

test("prose where a tool call was required is a named error", async () => {
  const fake = endpoint({ text: ["Certainly! Here is a tightened version:"] });

  const failed = await adapterAt(fake.url)
    .proposeEdit({ intent: revise, instruction: "tighten it", document, span })
    .catch((error: unknown) => error);

  expect(failed).toBeInstanceOf(ProviderResponseError);
  expect((failed as Error).message).toContain("prose instead of a propose_edit call");
});

test("facts come back from the extract_facts tool", async () => {
  const fake = endpoint({
    tool: { name: "extract_facts", input: { facts: ["Ada owns the press", " ", "The vintage is 1919"] } },
  });

  const facts = await adapterAt(fake.url).extractFacts({
    text: "a paragraph",
    instruction: "people and dates stated as true",
  });

  expect(facts).toEqual(["Ada owns the press", "The vintage is 1919"]);
  expect((fake.requests[0]?.body["tool_choice"] as Record<string, unknown>)["name"]).toBe("extract_facts");
});

test("the CriticMarkup path is validated before it is parsed, then resolved to the replacement", async () => {
  const fake = endpoint({ text: ["The valley kept {~~time in its own way~>its own time~~}."] });

  const proposal = await adapterWithOutput(fake.url, "criticmarkup").proposeEdit({
    intent: revise,
    instruction: "tighten it",
    document,
    span,
  });

  expect(proposal.variants).toEqual(["The valley kept its own time."]);
  expect(String((fake.requests[0]?.body["messages"] as { content: string }[])[0]?.content)).toContain(
    "CriticMarkup",
  );
  expect(fake.requests[0]?.body).not.toHaveProperty("tools");
});

test("CriticMarkup that proposes nothing is refused by the conformance gate", async () => {
  const fake = endpoint({ text: ["The valley kept its own time."] });

  const failed = await adapterWithOutput(fake.url, "criticmarkup")
    .proposeEdit({ intent: revise, instruction: "tighten it", document, span })
    .catch((error: unknown) => error);

  expect(failed).toBeInstanceOf(ProviderResponseError);
  expect((failed as Error).message).toContain("no CriticMarkup marks");
});

test("a mangled substitution is refused by the conformance gate", async () => {
  const fake = endpoint({ text: ["The valley kept {++its own time++}, not time ~> its own way."] });

  const failed = await adapterWithOutput(fake.url, "criticmarkup")
    .proposeEdit({ intent: revise, instruction: "tighten it", document, span })
    .catch((error: unknown) => error);

  expect(failed).toBeInstanceOf(ProviderResponseError);
  expect((failed as Error).message).toContain("~> outside a substitution");
});

test("no key is one error naming both ways to supply one, and nothing is sent", async () => {
  const fake = endpoint({ text: ["never reached"] });
  const providers = createProviders(configFor(fake.url), { keys: { env: {} } });

  const failed = await drain(providers.adapter("anthropic").complete({ prompt: "hello" })).catch(
    (error: unknown) => error,
  );

  expect(failed).toBeInstanceOf(ProviderConfigError);
  const message = (failed as Error).message;
  expect(message).toContain("ANTHROPIC_API_KEY");
  expect(message).toContain('"key": "keychain:<service>[/<account>]"');
  expect(message).not.toContain(KEY);
  expect(fake.requests).toHaveLength(0);
});

test("a refusal is a named error, not an empty answer", async () => {
  const fake = endpoint({ stopReason: "refusal", stopCategory: "cyber" });

  const failed = await drain(adapterAt(fake.url).complete({ prompt: "hello" })).catch((error: unknown) => error);

  expect(failed).toBeInstanceOf(ProviderResponseError);
  expect((failed as Error).message).toContain("a refusal (cyber)");
});

test("an HTTP error answers with its status and the endpoint's own words", async () => {
  const fake = endpoint({ status: 429, errorBody: '{"error":{"message":"rate limit"}}' });

  const failed = await drain(adapterAt(fake.url).complete({ prompt: "hello" })).catch((error: unknown) => error);

  expect(failed).toBeInstanceOf(ProviderResponseError);
  expect((failed as ProviderResponseError).status).toBe(429);
  expect((failed as Error).message).toContain("rate limit");
});

test("an endpoint that sends nothing becomes EndpointHung, not a wait", async () => {
  const fake = endpoint({ silent: true });

  const failed = await drain(adapterAt(fake.url, { timeoutMs: 120 }).complete({ prompt: "hello?" })).catch(
    (error: unknown) => error,
  );

  expect(failed).toBeInstanceOf(EndpointHung);
  expect((failed as EndpointHung).timeoutMs).toBe(120);
  expect((failed as Error).message).toContain(fake.url);
});

test("an edit on a span the document does not have never reaches the endpoint", async () => {
  const fake = endpoint();

  await expect(
    adapterAt(fake.url).proposeEdit({
      intent: revise,
      instruction: "tighten it",
      document,
      span: { start: 0, end: 900 },
    }),
  ).rejects.toThrow(RangeError);
  expect(fake.requests).toHaveLength(0);
});
