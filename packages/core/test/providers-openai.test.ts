import { afterEach, expect, test } from "bun:test";
import { EndpointHung, PREFERRED_OUTPUT, ProviderResponseError, createProviders, parseConfig } from "../src/index";
import type { CompletionStats, Document, Intent, Providers } from "../src/index";
import { startFakeEndpoint } from "./fake-endpoint";
import type { FakeEndpoint, FakeEndpointOptions } from "./fake-endpoint";

const running: FakeEndpoint[] = [];

afterEach(() => {
  while (running.length > 0) running.pop()?.stop();
});

function endpoint(options: FakeEndpointOptions = {}): FakeEndpoint {
  const fake = startFakeEndpoint(options);
  running.push(fake);
  return fake;
}

function providersAt(url: string, local: Record<string, unknown> = {}): Providers {
  const config = parseConfig(JSON.stringify({ providers: { local: { endpoint: url, model: "fake-writer", ...local } } }));
  return createProviders(config, { keys: { env: {} } });
}

async function drain(events: AsyncIterable<{ type: string }>): Promise<{ text: string; stats: CompletionStats }> {
  let text = "";
  let stats: CompletionStats | undefined;
  for await (const event of events as AsyncIterable<import("../src/index").CompletionEvent>) {
    if (event.type === "token") text += event.text;
    else stats = event.stats;
  }
  if (!stats) throw new Error("the stream ended without a done event");
  return { text, stats };
}

const revise: Intent = { name: "tighten", kind: "revising" };

test("a completion streams its tokens and reports what it measured", async () => {
  const fake = endpoint({ tokens: ["The ", "valley ", "kept"], gapMs: 8, usage: { prompt_tokens: 16, completion_tokens: 3 } });
  const { text, stats } = await drain(providersAt(fake.url).adapter("local").complete({ prompt: "write a line" }));

  expect(text).toBe("The valley kept");
  expect(stats.tokensRead).toBe(16);
  expect(stats.tokensWritten).toBe(3);
  expect(stats.timeToFirstTokenMs).toBeGreaterThan(0);
  expect(stats.elapsedMs).toBeGreaterThanOrEqual(stats.timeToFirstTokenMs);
  expect(stats.tokensPerSecond).toBeGreaterThan(0);

  const body = fake.requests[0]?.body ?? {};
  expect(body["stream"]).toBe(true);
  expect(body["model"]).toBe("fake-writer");
  expect(body["messages"]).toEqual([{ role: "user", content: "write a line" }]);
});

test("three requests to a local endpoint run one at a time", async () => {
  const fake = endpoint({ tokens: ["a", "b", "c"], gapMs: 15 });
  const adapter = providersAt(fake.url).adapter("local");

  await Promise.all([0, 1, 2].map(() => drain(adapter.complete({ prompt: "one of three" }))));

  expect(fake.requests).toHaveLength(3);
  for (let index = 1; index < fake.requests.length; index += 1) {
    const previous = fake.requests[index - 1];
    const current = fake.requests[index];
    expect(current?.startedAt ?? 0).toBeGreaterThanOrEqual(previous?.endedAt ?? 0);
  }
});

test("an endpoint that sends nothing becomes a named error, not a wait", async () => {
  const fake = endpoint({ silent: true });
  const adapter = providersAt(fake.url, { timeoutMs: 120 }).adapter("local");

  const hung = await drain(adapter.complete({ prompt: "hello?" })).catch((error: unknown) => error);

  expect(hung).toBeInstanceOf(EndpointHung);
  const error = hung as EndpointHung;
  expect(error.endpoint).toBe(fake.url);
  expect(error.timeoutMs).toBe(120);
  expect(error.elapsedMs).toBeGreaterThanOrEqual(120);
  expect(error.message).toContain(fake.url);
  expect(error.message).toMatch(/is the server running\?/);
});

test("a request may raise the timeout above the provider's", async () => {
  const fake = endpoint({ tokens: ["slow"], gapMs: 60 });
  const adapter = providersAt(fake.url, { timeoutMs: 20 }).adapter("local");

  const { text } = await drain(adapter.complete({ prompt: "take your time", timeoutMs: 1_000 }));
  expect(text).toBe("slow");
});

test("each endpoint keeps a rolling rate for the wait estimate", async () => {
  const fake = endpoint({ tokens: ["a", "b"], gapMs: 10, usage: { prompt_tokens: 40, completion_tokens: 2 } });
  const providers = providersAt(fake.url);
  const adapter = providers.adapter("local");

  expect(providers.rates("local")).toEqual({ promptTokensPerSecond: undefined, outputTokensPerSecond: undefined, samples: 0 });

  await drain(adapter.complete({ prompt: "first" }));
  await drain(adapter.complete({ prompt: "second" }));

  const rates = providers.rates("local");
  expect(rates.samples).toBe(2);
  expect(rates.promptTokensPerSecond ?? 0).toBeGreaterThan(0);
  expect(rates.outputTokensPerSecond ?? 0).toBeGreaterThan(0);
});

test("an edit comes back as a proposal against the span it was asked about", async () => {
  const fake = endpoint({ tool: { arguments: { replacement: "  The valley kept its own time.\n" } } });
  const document: Document = { path: "/tmp/chapter-01.md", text: "The valley kept time in its own way." };
  const proposal = await providersAt(fake.url)
    .adapter("local")
    .proposeEdit({ intent: revise, instruction: "tighten it", document, span: { start: 0, end: 36 } });

  expect(proposal.variants).toEqual(["The valley kept its own time."]);
  expect(proposal.span).toEqual({ start: 0, end: 36 });
  expect(proposal.intent).toBe(revise);
  expect(proposal.providerId).toBe("local");
  expect(proposal.model).toBe("fake-writer");

  const prompt = (fake.requests[0]?.body["messages"] as { content: string }[])[0]?.content ?? "";
  expect(prompt).toContain("The valley kept time in its own way.");
  expect(prompt).toContain("tighten it");
});

test("the tool path forces propose_edit and does not stream", async () => {
  const fake = endpoint({ tool: { arguments: { replacement: "A tighter line." } } });
  const document: Document = { path: "/tmp/chapter-01.md", text: "A line that could be tighter." };

  const proposal = await providersAt(fake.url)
    .adapter("local")
    .proposeEdit({ intent: revise, instruction: "tighten it", document, span: { start: 0, end: 29 }, output: "tool" });

  expect(proposal.variants).toEqual(["A tighter line."]);
  const body = fake.requests[0]?.body ?? {};
  expect(body["stream"]).toBeUndefined();
  expect(body["tool_choice"]).toEqual({ type: "function", function: { name: "propose_edit" } });
  const tools = body["tools"] as { function: { name: string } }[];
  expect(tools.map((tool) => tool.function.name)).toEqual(["propose_edit"]);
});

test("an adapter declares the structured path it takes by default", async () => {
  const fake = endpoint({ tool: { arguments: { replacement: "either way" } } });
  const adapter = providersAt(fake.url).adapter("local");
  const document: Document = { path: "/tmp/chapter-01.md", text: "one two three" };

  expect(adapter.preferredOutput).toBe(PREFERRED_OUTPUT);
  await adapter.proposeEdit({ intent: revise, instruction: "anything", document, span: { start: 0, end: 3 } });

  const usedTools = fake.requests[0]?.body["tools"] !== undefined;
  expect(usedTools).toBe(PREFERRED_OUTPUT === "tool");
});

test("the text path takes CriticMarkup and applies it, so the proposal is the accepted text", async () => {
  const fake = endpoint({ tokens: ["{~~The valley kept time in its own way.", "~>The valley kept its own time.~~}"], gapMs: 2 });
  const document: Document = { path: "/tmp/chapter-01.md", text: "The valley kept time in its own way." };

  const proposal = await providersAt(fake.url)
    .adapter("local")
    .proposeEdit({ intent: revise, instruction: "tighten it", document, span: { start: 0, end: 36 }, output: "text" });

  expect(proposal.variants).toEqual(["The valley kept its own time."]);
  const prompt = (fake.requests[0]?.body["messages"] as { content: string }[])[0]?.content ?? "";
  expect(prompt).toContain("{~~old text~>new text~~}");
  expect(fake.requests[0]?.body["tools"]).toBeUndefined();
});

test("the text path refuses an answer that carries no proposal", async () => {
  const fake = endpoint({ tokens: ["Sure! Here is a tighter version of that line."], gapMs: 1 });
  const document: Document = { path: "/tmp/chapter-01.md", text: "one two three" };

  const failure = await providersAt(fake.url)
    .adapter("local")
    .proposeEdit({ intent: revise, instruction: "tighten it", document, span: { start: 0, end: 3 }, output: "text" })
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(ProviderResponseError);
  expect((failure as Error).message).toContain("does not conform");
  expect((failure as Error).message).toContain("proposes nothing");
});

test("the text path refuses a mangled substitution rather than writing it into the manuscript", async () => {
  const fake = endpoint({ tokens: ["{~~one~>two~~} and a stray ~> arrow"], gapMs: 1 });
  const document: Document = { path: "/tmp/chapter-01.md", text: "one two three" };

  const failure = await providersAt(fake.url)
    .adapter("local")
    .proposeEdit({ intent: revise, instruction: "tighten it", document, span: { start: 0, end: 3 }, output: "text" })
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(ProviderResponseError);
  expect((failure as Error).message).toContain("~> outside a substitution");
});

test("a tool request answered with prose is a named error, not a proposal", async () => {
  const fake = endpoint({ toolRefusal: "I would rewrite it like this instead." });
  const document: Document = { path: "/tmp/chapter-01.md", text: "one two three" };

  const failure = await providersAt(fake.url)
    .adapter("local")
    .proposeEdit({ intent: revise, instruction: "tighten it", document, span: { start: 0, end: 3 }, output: "tool" })
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(ProviderResponseError);
  expect((failure as Error).message).toContain("no propose_edit tool call");
});

test("a tool call whose arguments are not JSON is a named error", async () => {
  const fake = endpoint({ tool: { arguments: '{"replacement": "unterminated' } });
  const document: Document = { path: "/tmp/chapter-01.md", text: "one two three" };

  const failure = await providersAt(fake.url)
    .adapter("local")
    .proposeEdit({ intent: revise, instruction: "tighten it", document, span: { start: 0, end: 3 }, output: "tool" })
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(ProviderResponseError);
  expect((failure as Error).message).toContain("not valid JSON");
});

test("asking for variants sends one request per variant", async () => {
  const fake = endpoint({ tool: { arguments: { replacement: "a line" } } });
  const document: Document = { path: "/tmp/chapter-01.md", text: "one two three" };
  const proposal = await providersAt(fake.url)
    .adapter("local")
    .proposeEdit({ intent: revise, instruction: "three ways", document, span: { start: 0, end: 3 }, variants: 3 });

  expect(proposal.variants).toHaveLength(3);
  expect(fake.requests).toHaveLength(3);
});

test("an edit on a span the document does not have never reaches the endpoint", async () => {
  const fake = endpoint();
  const document: Document = { path: "/tmp/chapter-01.md", text: "short" };

  await expect(
    providersAt(fake.url)
      .adapter("local")
      .proposeEdit({ intent: revise, instruction: "tighten it", document, span: { start: 0, end: 900 } }),
  ).rejects.toThrow(RangeError);
  expect(fake.requests).toHaveLength(0);
});

test("extracted facts come back one per line, without the model's bullets", async () => {
  const fake = endpoint({ tokens: ["- Ada owns the press\n", "* The vintage is 1919\n", "\n", "3. Bob limps"], gapMs: 1 });
  const facts = await providersAt(fake.url)
    .adapter("local")
    .extractFacts({ text: "a paragraph", instruction: "people and dates stated as true", output: "text" });

  expect(facts).toEqual(["Ada owns the press", "The vintage is 1919", "Bob limps"]);
});

test("the extract_facts tool call carries an anchor per fact, and drops items with no fact", async () => {
  const fake = endpoint({
    tool: {
      name: "extract_facts",
      arguments: {
        facts: [
          {
            fact: "Ada owns the press",
            entities: ["Ada", 7],
            story_time: "day 1, dawn",
            certainty: "stated",
            anchor: "Ada owns the press",
          },
          { fact: "   ", anchor: "nothing" },
          { fact: "Bob limps" },
        ],
      },
    },
  });

  const adapter = providersAt(fake.url).adapter("local");
  const facts = await adapter.extractFactsWithAnchors!({
    text: "Ada owns the press. Bob limps.",
    instruction: "everything a later chapter could contradict",
  });

  expect(facts).toEqual([
    {
      fact: "Ada owns the press",
      entities: ["Ada"],
      storyTime: "day 1, dawn",
      certainty: "stated",
      anchor: "Ada owns the press",
    },
    { fact: "Bob limps", entities: [], storyTime: undefined, certainty: undefined, anchor: undefined },
  ]);
  expect(await adapter.extractFacts({ text: "a paragraph", instruction: "facts", output: "tool" })).toEqual([
    "Ada owns the press",
    "Bob limps",
  ]);
});

test("an endpoint that answers with an error says so, with its status", async () => {
  const fake = endpoint({ status: 503, errorBody: "model is loading" });

  const failure = await drain(providersAt(fake.url).adapter("local").complete({ prompt: "hello" })).catch(
    (error: unknown) => error,
  );

  expect(failure).toBeInstanceOf(ProviderResponseError);
  expect((failure as ProviderResponseError).status).toBe(503);
  expect((failure as Error).message).toContain("model is loading");
});

test("a key is sent to a cloud provider and never invented for a local one", async () => {
  const fake = endpoint({ tokens: ["ok"], gapMs: 1 });
  const config = parseConfig(
    JSON.stringify({
      providers: { local: { endpoint: fake.url }, cloudy: { endpoint: fake.url, model: "cloud-model" } },
    }),
  );
  const providers = createProviders(config, { keys: { env: { CLOUDY_API_KEY: "not-a-real-key" } } });

  await drain(providers.adapter("cloudy").complete({ prompt: "hello" }));
  await drain(providers.adapter("local").complete({ prompt: "hello" }));

  expect(fake.requests[0]?.authorization).toBe("Bearer not-a-real-key");
  expect(fake.requests[1]?.authorization).toBeNull();
});
