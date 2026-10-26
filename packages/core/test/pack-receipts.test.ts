import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assemblePack,
  createProviders,
  createScriptedChatAdapter,
  fileReceiptSink,
  parseConfig,
  receiptsPath,
  withReceipts,
} from "../src/index";
import type { Adapter, Document, Intent, Receipt, SpanEditInputs } from "../src/index";
import { startFakeEndpoint } from "./fake-endpoint";
import type { FakeEndpoint } from "./fake-endpoint";

const running: FakeEndpoint[] = [];
const temps: string[] = [];

afterEach(() => {
  while (running.length > 0) running.pop()?.stop();
  while (temps.length > 0) rmSync(temps.pop() ?? "", { recursive: true, force: true });
});

function tempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "pablo-receipts-"));
  temps.push(dir);
  return dir;
}

const document: Document = {
  path: "novels/ice-house/chapters/01-the-last-full-cut.md",
  text: ["The pond rang under the horse.", "The hoist chain took up.", "She wrote the number down."].join("\n\n"),
};

const span = { start: document.text.indexOf("The hoist"), end: document.text.indexOf("The hoist") + 24 };

const inputs: SpanEditInputs = {
  document,
  span,
  instruction: "cut this by a third",
  style: [{ path: "style/prose.md", text: "Straight quotes, never curly." }],
};

const intent: Intent = { name: "tighten", kind: "revising" };

function adapterAt(url: string): Adapter {
  const config = parseConfig(JSON.stringify({ providers: { local: { endpoint: url, model: "fake-writer" } } }));
  return createProviders(config, { keys: { env: {} } }).adapter("local");
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of events) void _event;
}

test("a streamed completion writes a fully measured receipt", async () => {
  const fake = startFakeEndpoint({
    tokens: ["a ", "tighter ", "paragraph"],
    gapMs: 5,
    usage: { prompt_tokens: 412, completion_tokens: 3 },
  });
  running.push(fake);

  const pack = assemblePack("spanEdit", inputs);
  const log: Receipt[] = [];
  const adapter = withReceipts(adapterAt(fake.url), (receipt) => void log.push(receipt), { pack, intent: "tighten" });

  await drain(adapter.complete({ prompt: pack.prompt, maxTokens: 400, temperature: 0.8 }));

  expect(log).toHaveLength(1);
  const receipt = log[0];
  expect(receipt?.measurement).toBe("stream");
  expect(receipt?.prompt_hash).toBe(pack.hash);
  expect(receipt?.pack_kind).toBe("spanEdit");
  expect(receipt?.slices.map((slice) => slice.name)).toEqual(pack.slices.map((slice) => slice.name));
  expect(receipt?.slices[0]?.tokens).toBe(pack.slices[0]?.tokens ?? -1);
  expect(receipt?.provider).toBe("local");
  expect(receipt?.model).toBe("fake-writer");
  expect(receipt?.params).toEqual({ max_tokens: 400, temperature: 0.8 });
  expect(receipt?.tokens_read).toBe(412);
  expect(receipt?.tokens_written).toBe(3);
  expect(receipt?.ttft_ms).toBeGreaterThan(0);
  expect(receipt?.gen_tok_s).toBeGreaterThan(0);
  expect(receipt?.wall_ms).toBeGreaterThan(0);
  expect(receipt?.error).toBeNull();
  expect(receipt?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test("a proposal's receipt is keyed to the span it replaces", async () => {
  const fake = startFakeEndpoint({ tokens: ["the ", "chain ", "took ", "up"] });
  running.push(fake);

  const pack = assemblePack("spanEdit", inputs);
  const log: Receipt[] = [];
  const adapter = withReceipts(adapterAt(fake.url), (receipt) => void log.push(receipt), { pack });

  const proposal = await adapter.proposeEdit({
    intent,
    instruction: inputs.instruction,
    context: pack.context,
    document,
    span,
    variants: 2,
  });

  expect(proposal.variants).toHaveLength(2);
  expect(log).toHaveLength(1);
  expect(log[0]?.intent).toBe("tighten");
  expect(log[0]?.proposal).toEqual({ path: document.path, start: span.start, end: span.end, variants: 2 });
  expect(log[0]?.params["variants"]).toBe(2);
  expect(log[0]?.prompt_hash).toBe(pack.hash);
  // A wrapper cannot see the stream the adapter runs inside `proposeEdit`, and
  // says so rather than presenting an estimate as a measurement.
  expect(log[0]?.measurement).toBe("wall");
  expect(log[0]?.ttft_ms).toBeNull();
  expect(log[0]?.gen_tok_s).toBeNull();
  expect(log[0]?.tokens_read).toBe(pack.totalTokens);
  expect(log[0]?.tokens_written).toBeGreaterThan(0);
});

test("a failed call still leaves a receipt, and the error propagates", async () => {
  const fake = startFakeEndpoint({ status: 503, errorBody: "the writer is loading a model" });
  running.push(fake);

  const log: Receipt[] = [];
  const adapter = withReceipts(adapterAt(fake.url), (receipt) => void log.push(receipt));

  await expect(drain(adapter.complete({ prompt: "write a line" }))).rejects.toThrow();
  expect(log).toHaveLength(1);
  expect(log[0]?.error).toContain("503");
  expect(log[0]?.measurement).toBe("wall");
  expect(log[0]?.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
});

test("a sink that throws never costs the caller its proposal", async () => {
  const fake = startFakeEndpoint({ tokens: ["ok"] });
  running.push(fake);

  const seen: unknown[] = [];
  const adapter = withReceipts(
    adapterAt(fake.url),
    () => {
      throw new Error("disk full");
    },
    { onLogError: (error) => void seen.push(error) },
  );

  await drain(adapter.complete({ prompt: "write a line" }));
  expect(seen).toHaveLength(1);
});

test("receipts land one JSON object per line at <vault>/.pablo/receipts.jsonl", () => {
  const vault = tempVault();
  const path = receiptsPath(vault);
  expect(path).toBe(join(vault, ".pablo", "receipts.jsonl"));

  const sink = fileReceiptSink(vault);
  const receipt: Receipt = {
    at: "2026-09-02T00:00:00.000Z",
    intent: "tighten",
    pack_kind: "spanEdit",
    prompt_hash: "a".repeat(64),
    slices: [{ name: "style", tokens: 12, source: "style/prose.md" }],
    provider: "local",
    model: "fake-writer",
    params: { temperature: 0.8 },
    tokens_read: 412,
    tokens_written: 3,
    ttft_ms: 900,
    gen_tok_s: 30.5,
    wall_ms: 3000,
    measurement: "stream",
    proposal: { path: "novels/ice-house/chapters/01-the-last-full-cut.md", start: 0, end: 10, variants: 1 },
    error: null,
  };

  void sink(receipt);
  void sink({ ...receipt, intent: "draft" });

  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0] ?? "{}")).toEqual(receipt);
  expect((JSON.parse(lines[1] ?? "{}") as Receipt).intent).toBe("draft");
});

test("a receipt records the seed beside the temperature, and the prompt hash is still the pack's alone", async () => {
  const fake = startFakeEndpoint({ tokens: ["a"], usage: { prompt_tokens: 4, completion_tokens: 1 } });
  running.push(fake);

  const pack = assemblePack("spanEdit", inputs);
  const log: Receipt[] = [];
  const adapter = withReceipts(adapterAt(fake.url), (receipt) => void log.push(receipt), { pack, intent: "draft" });

  await drain(adapter.complete({ prompt: pack.prompt, temperature: 0.8, seed: 42 }));
  await drain(adapter.complete({ prompt: pack.prompt, temperature: 0.3 }));

  expect(log[0]?.params).toEqual({ temperature: 0.8, seed: 42 });
  expect(log[1]?.params).toEqual({ temperature: 0.3 });
  expect(log[0]?.prompt_hash).toBe(pack.hash);
  expect(log[1]?.prompt_hash).toBe(pack.hash);
});

// ---------------------------------------------------------------------------
// chat() through the wrapper (AGT-2120): forwarded, one receipt per turn
// ---------------------------------------------------------------------------

test("chat() is forwarded through the wrapper and each turn writes a receipt with the reported usage", async () => {
  let clock = 1000;
  const now = () => clock;
  const scripted = createScriptedChatAdapter({
    id: "local",
    model: "gemma",
    turns: [
      () => {
        clock += 50; // the endpoint takes 50ms to send its first byte
        return [
          { type: "text", text: "Let me look." },
          { type: "tool_call", call: { id: "c1", name: "status", arguments: { title: "x" } } },
          { type: "done", usage: { inputTokens: 300, outputTokens: 12 } },
        ];
      },
      [{ type: "text", text: "Done." }],
    ],
  });
  const log: Receipt[] = [];
  const adapter = withReceipts(scripted, (receipt) => void log.push(receipt), { intent: "agent", now, clock: () => new Date(0) });
  expect(adapter.chat).toBeDefined();

  const events: string[] = [];
  const request = { system: "You are pablo", messages: [{ role: "user" as const, content: "hi" }], tools: [], timeoutMs: 5000 };
  for await (const event of adapter.chat!(request)) {
    events.push(event.type);
    clock += 10; // 10ms per event on the way out
  }
  expect(events).toEqual(["text", "tool_call", "done"]);
  expect(scripted.requests).toHaveLength(1);

  await drain(adapter.chat!({ ...request, messages: [...request.messages, { role: "assistant", content: "Let me look." }] }));
  expect(log).toHaveLength(2);
  expect(log[0]).toMatchObject({
    intent: "agent",
    provider: "local",
    model: "gemma",
    measurement: "stream",
    tokens_read: 300,
    tokens_written: 12,
    ttft_ms: 50,
    wall_ms: 80,
    gen_tok_s: null,
    params: { timeout_ms: 5000 },
    error: null,
    pack_kind: null,
    slices: [],
  });
  expect(log[0]?.prompt_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(log[1]?.prompt_hash).not.toBe(log[0]?.prompt_hash); // a different history hashes differently
  // The scripted fake reports no usage on a turn with no explicit `done`: null, never a guess.
  expect(log[1]).toMatchObject({ tokens_read: null, tokens_written: null });
});

test("a chat() turn that throws writes an error receipt and rethrows; a wrapped adapter with no chat() has none", async () => {
  const scripted = createScriptedChatAdapter({
    turns: [
      () => {
        throw new Error("sent nothing for 60s");
      },
    ],
  });
  const log: Receipt[] = [];
  const adapter = withReceipts(scripted, (receipt) => void log.push(receipt));
  await expect(drain(adapter.chat!({ system: "", messages: [{ role: "user", content: "hi" }], tools: [] }))).rejects.toThrow("sent nothing for 60s");
  expect(log[0]).toMatchObject({ intent: "chat", measurement: "wall", error: "Error: sent nothing for 60s" });

  const chatless: Adapter = { ...scripted, chat: undefined } as unknown as Adapter;
  delete (chatless as { chat?: unknown }).chat;
  expect(withReceipts(chatless, () => {}).chat).toBeUndefined();
});
