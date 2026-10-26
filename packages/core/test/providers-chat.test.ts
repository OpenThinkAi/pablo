import { describe, expect, test } from "bun:test";
import {
  type Adapter,
  type ChatEvent,
  type ChatRequest,
  createScriptedChatAdapter,
  ProviderResponseError,
} from "../src";

const TOOL = {
  name: "read_file",
  description: "Read one vault file.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
} as const;

async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("chat() types and the scripted adapter", () => {
  test("a tool conversation round-trips through the neutral types", async () => {
    const adapter = createScriptedChatAdapter({
      turns: [
        [
          { type: "text", text: "Let me look." },
          { type: "tool_call", call: { id: "call_1", name: "read_file", arguments: { path: "bible/ned.md" } } },
          { type: "done", usage: { inputTokens: 120, outputTokens: 18 } },
        ],
        (request) => {
          const last = request.messages.at(-1);
          const result = last?.role === "tool" ? last.content : "nothing";
          return [{ type: "text", text: `Ned is ${result}.` }];
        },
      ],
    });

    const first: ChatRequest = {
      system: "You are pablo.",
      messages: [{ role: "user", content: "Who is Ned?" }],
      tools: [TOOL],
      toolChoice: "auto",
    };
    const turn1 = await collect(adapter.chat(first));
    expect(turn1.map((event) => event.type)).toEqual(["text", "tool_call", "done"]);
    const call = turn1.find((event) => event.type === "tool_call");
    if (call?.type !== "tool_call") throw new Error("expected a tool call");

    const second: ChatRequest = {
      ...first,
      messages: [
        ...first.messages,
        { role: "assistant", content: "Let me look.", toolCalls: [call.call] },
        { role: "tool", toolCallId: call.call.id, content: "the lighthouse keeper" },
      ],
    };
    const turn2 = await collect(adapter.chat(second));
    expect(turn2).toEqual([
      { type: "text", text: "Ned is the lighthouse keeper." },
      { type: "done", usage: { inputTokens: undefined, outputTokens: undefined } },
    ]);

    expect(adapter.requests).toEqual([first, second]);
  });

  test("a stream ends at its first done", async () => {
    const adapter = createScriptedChatAdapter({
      turns: [
        [
          { type: "done", usage: { inputTokens: 1, outputTokens: 2 } },
          { type: "text", text: "never seen" },
        ],
      ],
    });
    const events = await collect(adapter.chat({ system: "", messages: [], tools: [] }));
    expect(events).toEqual([{ type: "done", usage: { inputTokens: 1, outputTokens: 2 } }]);
  });

  test("calling past the script is a named error", async () => {
    const adapter = createScriptedChatAdapter({ turns: [] });
    await expect(collect(adapter.chat({ system: "", messages: [], tools: [] }))).rejects.toBeInstanceOf(
      ProviderResponseError,
    );
  });

  test("an aborted request stops the stream", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    const adapter = createScriptedChatAdapter({ turns: [[{ type: "text", text: "hi" }]] });
    await expect(
      collect(adapter.chat({ system: "", messages: [], tools: [], signal: controller.signal })),
    ).rejects.toThrow("stopped");
  });

  test("it is an Adapter, and the other methods refuse", async () => {
    const adapter: Adapter = createScriptedChatAdapter({ turns: [] });
    expect(adapter.chat).toBeDefined();
    await expect(adapter.extractFacts({ text: "", instruction: "" })).rejects.toBeInstanceOf(ProviderResponseError);
  });

  test("toolChoice can name one tool", () => {
    const request: ChatRequest = { system: "", messages: [], tools: [TOOL], toolChoice: { name: "read_file" } };
    expect(request.toolChoice).toEqual({ name: "read_file" });
  });
});
