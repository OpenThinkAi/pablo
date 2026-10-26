/**
 * pablo's own agent loop (AGT-2120, D-12). Every session here runs on the
 * scripted fake adapter: no test opens a socket, starts a process or reads a
 * config file.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createScriptedChatAdapter } from "@openthink/pablo-core";
import type { Adapter, ChatEvent, ChatMessage, ScriptedTurn } from "@openthink/pablo-core";
import { askAuthorTool } from "../src/harness/ask-author";
import { DEFAULT_MAX_TURNS, parseTextToolCalls, runLoop, textProtocolPrompt } from "../src/harness/loop";
import type { LoopSpec } from "../src/harness/loop";
import { harnessTools } from "../src/harness/tools";
import { formatEntry } from "../src/harness/transcript";
import type { TranscriptEntry } from "../src/harness/transcript";
import type { McpToolSpec, VerbContext } from "../src/verbs";

const ctx: VerbContext = { cwd: "/nowhere", env: {}, stderr: { write: () => {} }, caller: "mcp" };

/** A tool that records what it was run with. */
function recordingTool(name: string, body: unknown = { ok: true }): { readonly spec: McpToolSpec; readonly runs: unknown[] } {
  const runs: unknown[] = [];
  const spec: McpToolSpec = {
    name,
    description: `The ${name} tool.`,
    args: z.object({ title: z.string(), count: z.number().int().optional() }),
    async run(args, _ctx) {
      runs.push(args);
      return { body, exitCode: 0 };
    },
  };
  return { spec, runs };
}

const call = (id: string, name: string, args: Record<string, unknown>): ChatEvent => ({ type: "tool_call", call: { id, name, arguments: args } });
const text = (value: string): ChatEvent => ({ type: "text", text: value });
const done = (inputTokens?: number, outputTokens?: number): ChatEvent => ({ type: "done", usage: { inputTokens, outputTokens } });

function scripted(turns: readonly ScriptedTurn[], model = "scripted-model") {
  return createScriptedChatAdapter({ turns, model });
}

async function collect(
  message: string,
  spec: LoopSpec,
  history: readonly ChatMessage[] = [],
): Promise<{ readonly entries: TranscriptEntry[]; readonly messages: readonly ChatMessage[] }> {
  const entries: TranscriptEntry[] = [];
  const run = runLoop(message, spec, history);
  for (;;) {
    const next = await run.next();
    if (next.done) return { entries, messages: next.value };
    entries.push(next.value);
  }
}

const resultOf = (entries: readonly TranscriptEntry[]) => entries.find((entry): entry is Extract<TranscriptEntry, { kind: "result" }> => entry.kind === "result");

describe("runLoop", () => {
  test("AC1+AC2: model -> tool call -> result -> model -> final answer, as transcript entries", async () => {
    const status = recordingTool("status", { core: { premise: true } });
    const adapter = scripted([
      [text("Let me look."), call("c1", "status", { title: "ice-house" }), done(100, 10)],
      [text("The premise is in place."), done(200, 20)],
    ]);
    const { entries, messages } = await collect("where are we?", { adapter, system: "You are pablo", tools: [status.spec], ctx });

    expect(entries.map((entry) => entry.kind)).toEqual(["session", "assistant", "tool_call", "tool_result", "assistant", "result"]);
    expect(entries[0]).toEqual({ kind: "session", model: "scripted-model", apiKeySource: "none", tools: ["status"] });
    expect(entries[2]).toEqual({ kind: "tool_call", id: "c1", tool: "status", input: { title: "ice-house" } });
    expect(entries[3]).toEqual({ kind: "tool_result", id: "c1", text: JSON.stringify({ core: { premise: true } }), isError: false });
    const result = resultOf(entries);
    expect(result).toMatchObject({ ok: true, text: "The premise is in place.", turns: 2, errors: [] });
    expect(status.runs).toEqual([{ title: "ice-house" }]);

    // The tool call and its result went back to the model as history, after the user's message.
    expect(adapter.requests).toHaveLength(2);
    expect(adapter.requests[0]!.system).toBe("You are pablo");
    expect(adapter.requests[0]!.messages).toEqual([{ role: "user", content: "where are we?" }]);
    expect(adapter.requests[1]!.messages).toEqual([
      { role: "user", content: "where are we?" },
      { role: "assistant", content: "Let me look.", toolCalls: [{ id: "c1", name: "status", arguments: { title: "ice-house" } }] },
      { role: "tool", toolCallId: "c1", content: JSON.stringify({ core: { premise: true } }) },
    ]);
    // The returned conversation is what the next message continues from.
    expect(messages).toHaveLength(4);
    expect(messages[3]).toEqual({ role: "assistant", content: "The premise is in place." });

    // Every tool is offered every turn, as JSON Schema from its zod shape.
    for (const request of adapter.requests) {
      expect(request.tools.map((tool) => tool.name)).toEqual(["status"]);
      expect(request.tools[0]!.parameters).toMatchObject({ type: "object", required: ["title"] });
    }
    // The consumers of the SDK transcript read the loop's entries unchanged.
    for (const entry of entries) expect(typeof formatEntry(entry)).toBe("string");
    expect(formatEntry(entries[2]!)).toBe('  → status {"title":"ice-house"}');
  });

  test("AC1: ask_author works unchanged — the loop awaits the tool while the author answers", async () => {
    let asked: string | undefined;
    const ask = askAuthorTool(async (q) => {
      asked = q.question;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return "the river";
    });
    const adapter = scripted([
      [call("q1", "ask_author", { question: "Which route does she take?", options: ["the river", "the ridge"], why: "plot direction" })],
      (request) => {
        const answer = request.messages.find((m) => m.role === "tool");
        return [text(`She takes ${answer === undefined ? "?" : (JSON.parse(answer.content) as { answer: string }).answer}.`)];
      },
    ]);
    const { entries } = await collect("plan the crossing", { adapter, system: "s", tools: [ask], ctx });
    expect(asked).toBe("Which route does she take?");
    expect(entries[2]).toMatchObject({ kind: "tool_result", id: "q1", isError: false });
    expect(resultOf(entries)?.text).toBe("She takes the river.");
  });

  test("a call to a tool the turn did not offer is refused back to the model, never run", async () => {
    const status = recordingTool("status");
    const adapter = scripted([[call("c1", "Write", { path: "chapters/01.md", content: "prose" })], [text("Understood.")]]);
    const { entries } = await collect("write chapter one", { adapter, system: "s", tools: [status.spec], ctx });
    expect(entries[2]).toEqual({ kind: "tool_result", id: "c1", text: 'unknown tool "Write"; the tools on offer are: status', isError: true });
    expect(status.runs).toEqual([]);
    expect(adapter.requests[1]!.messages[2]).toEqual({ role: "tool", toolCallId: "c1", content: 'unknown tool "Write"; the tools on offer are: status', isError: true });
    expect(resultOf(entries)?.ok).toBe(true);
  });

  test("arguments are validated against the tool's own schema before it runs", async () => {
    const status = recordingTool("status");
    const adapter = scripted([[call("c1", "status", { count: "two" })], [text("Noted.")]]);
    const { entries } = await collect("check", { adapter, system: "s", tools: [status.spec], ctx });
    const refused = entries[2];
    expect(refused).toMatchObject({ kind: "tool_result", id: "c1", isError: true });
    if (refused?.kind === "tool_result") {
      expect(refused.text).toContain("invalid arguments for status");
      expect(refused.text).toContain("title");
    }
    expect(status.runs).toEqual([]);
  });

  test("a tool that throws becomes an error result and the session goes on; a refusal stays data", async () => {
    const crash: McpToolSpec = {
      name: "crash",
      description: "Throws.",
      args: z.object({}),
      run: async () => {
        throw new Error("disk on fire");
      },
    };
    const refuse: McpToolSpec = {
      name: "refuse",
      description: "Refuses.",
      args: z.object({}),
      run: async () => ({ body: { ok: false, code: 2, message: "no premise yet" }, exitCode: 2 }),
    };
    const adapter = scripted([[call("a", "crash", {}), call("b", "refuse", {})], [text("Both seen.")]]);
    const { entries } = await collect("go", { adapter, system: "s", tools: [crash, refuse], ctx });
    expect(entries[2]).toEqual({ kind: "tool_result", id: "a", text: "disk on fire", isError: true });
    expect(entries[4]).toEqual({ kind: "tool_result", id: "b", text: JSON.stringify({ ok: false, code: 2, message: "no premise yet" }), isError: false });
    expect(resultOf(entries)).toMatchObject({ ok: true, text: "Both seen." });
  });

  test("the turn cap ends the session as a failed result", async () => {
    const status = recordingTool("status");
    const forever: ScriptedTurn = [call("c", "status", { title: "x" })];
    const adapter = scripted([forever, forever, forever, forever]);
    const { entries } = await collect("loop", { adapter, system: "s", tools: [status.spec], ctx, maxTurns: 3 });
    const result = resultOf(entries);
    expect(result).toMatchObject({ ok: false, text: "", turns: 3 });
    expect(result?.errors[0]).toContain("turn cap (3 turns)");
    expect(adapter.requests).toHaveLength(3);
    expect(DEFAULT_MAX_TURNS).toBeGreaterThan(3);
  });

  test("AC3: a turn that needed a tool call and got none is re-prompted once with the text protocol", async () => {
    const status = recordingTool("status", { stage: "premise" });
    const adapter = scripted([
      [text("I would check the status now.")],
      [text('Sure:\n```json\n{"tool": "status", "arguments": {"title": "ice-house", "count": 1}}\n```')],
      [text("Checked.")],
    ]);
    const { entries } = await collect("check in", { adapter, system: "s", tools: [status.spec], ctx, toolChoice: "required" });

    // Only the first turn is forced; the re-prompt carries no tools on the wire and the tools in the prompt.
    expect(adapter.requests[0]).toMatchObject({ toolChoice: "required" });
    expect(adapter.requests[0]!.tools).toHaveLength(1);
    expect(adapter.requests[1]!.tools).toEqual([]);
    expect(adapter.requests[1]!.toolChoice).toBeUndefined();
    const reprompt = adapter.requests[1]!.messages.at(-1);
    expect(reprompt).toMatchObject({ role: "user" });
    expect(reprompt?.content).toBe(textProtocolPrompt(adapter.requests[0]!.tools, "required"));
    expect(reprompt?.content).toContain("- status: The status tool.");
    // The parsed call ran like a native one, with validated arguments, and the native path resumed.
    expect(status.runs).toEqual([{ title: "ice-house", count: 1 }]);
    expect(entries.map((entry) => entry.kind)).toEqual(["session", "assistant", "tool_call", "tool_result", "assistant", "result"]);
    expect(entries[2]).toEqual({ kind: "tool_call", id: "text-2-1", tool: "status", input: { title: "ice-house", count: 1 } });
    expect(adapter.requests[2]!.toolChoice).toBe("auto");
    expect(adapter.requests[2]!.tools).toHaveLength(1);
    expect(resultOf(entries)).toMatchObject({ ok: true, text: "Checked.", turns: 3 });
  });

  test("AC3: a named tool choice says which tool; a reply that still names none fails the session", async () => {
    const status = recordingTool("status");
    const adapter = scripted([[text("No thanks.")], [text("I really would rather not.")]]);
    const { entries } = await collect("check in", { adapter, system: "s", tools: [status.spec], ctx, toolChoice: { name: "status" } });
    expect(adapter.requests[1]!.messages.at(-1)?.content).toContain("You must call `status`.");
    expect(adapter.requests).toHaveLength(2);
    const result = resultOf(entries);
    expect(result).toMatchObject({ ok: false, text: "", turns: 2 });
    expect(result?.errors[0]).toContain("after a text re-prompt still named none");
    expect(result?.errors[0]).toContain("I really would rather not.");
    expect(status.runs).toEqual([]);
  });

  test("a provider that refuses a forced choice gets auto on the wire, the requirement in the system prompt, and the re-prompt backing it", async () => {
    const status = recordingTool("status");
    const adapter = scripted([
      [text("Let me think.")],
      [text('```json\n{"tool": "status", "arguments": {"title": "x"}}\n```')],
      [text("Done.")],
    ]);
    const { entries } = await collect("check in", { adapter, system: "s", tools: [status.spec], ctx, toolChoice: { name: "status" }, forcedToolChoice: false });
    expect(adapter.requests[0]!.toolChoice).toBe("auto");
    expect(adapter.requests[0]!.system).toBe("s\n\nThis step needs a tool call: answer by calling `status`.");
    expect(adapter.requests[1]!.system).toBe("s");
    expect(adapter.requests[2]!.system).toBe("s");
    expect(status.runs).toEqual([{ title: "x" }]);
    expect(resultOf(entries)).toMatchObject({ ok: true, text: "Done." });

    const required = scripted([[call("c", "status", { title: "y" })], [text("ok")]]);
    await collect("m", { adapter: required, system: "s", tools: [status.spec], ctx, toolChoice: "required", forcedToolChoice: false });
    expect(required.requests[0]!.toolChoice).toBe("auto");
    expect(required.requests[0]!.system).toContain("answer by calling one of your tools");
  });

  test("with tool choice auto, a text-only first turn is the final answer", async () => {
    const adapter = scripted([[text("Nothing to do.")]]);
    const { entries } = await collect("hi", { adapter, system: "s", tools: [recordingTool("status").spec], ctx });
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0]!.toolChoice).toBe("auto");
    expect(resultOf(entries)).toMatchObject({ ok: true, text: "Nothing to do.", turns: 1 });
  });

  test("AC4: cost is usage times the per-model price table; a local provider costs nothing", async () => {
    const turns: ScriptedTurn[] = [[call("c", "status", { title: "x" }), done(1000, 500)], [text("ok"), done(2000, 100)]];
    const tools = [recordingTool("status").spec];
    const priced = await collect("m", { adapter: scripted(turns, "claude-opus-5-5"), system: "s", tools, ctx });
    // 3000 input tokens at $4/M + 600 output tokens at $20/M.
    expect(resultOf(priced.entries)?.costUsd).toBeCloseTo(0.012 + 0.012, 10);

    const dated = await collect("m", { adapter: scripted(turns, "claude-opus-5-5-20260401"), system: "s", tools, ctx });
    expect(resultOf(dated.entries)?.costUsd).toBeCloseTo(0.024, 10);

    const local = await collect("m", { adapter: scripted(turns, "claude-opus-5-5"), system: "s", tools, ctx, local: true });
    expect(resultOf(local.entries)?.costUsd).toBe(0);

    const unknown = await collect("m", { adapter: scripted(turns, "mlx-community/gemma-4-31b-it-4bit"), system: "s", tools, ctx });
    expect(resultOf(unknown.entries)?.costUsd).toBe(0);
    // Unpriced is not free: the result names the model so the transcript says the cost is incomplete.
    expect(resultOf(unknown.entries)?.unpricedModel).toBe("mlx-community/gemma-4-31b-it-4bit");
    expect(formatEntry(resultOf(unknown.entries)!)).toContain("no price for mlx-community/gemma-4-31b-it-4bit");
    expect(resultOf(local.entries)?.unpricedModel).toBeUndefined();
    expect(resultOf(priced.entries)?.unpricedModel).toBeUndefined();
    const silent = await collect("m", { adapter: scripted([[text("ok")]], "house-model"), system: "s", tools, ctx });
    expect(resultOf(silent.entries)?.unpricedModel).toBeUndefined(); // no usage reported, nothing left out

    const custom = await collect("m", { adapter: scripted(turns, "house-model"), system: "s", tools, ctx, prices: { "house-model": { inputPerMillion: 1, outputPerMillion: 1 } } });
    expect(resultOf(custom.entries)?.costUsd).toBeCloseTo(0.0036, 10);
    expect(formatEntry(resultOf(custom.entries)!)).toContain("$0.0036");
  });

  test("a provider failure ends the session as a failed result with the turns so far", async () => {
    const adapter = scripted([
      [call("c", "status", { title: "x" }), done(10, 10)],
      () => {
        throw new Error("the model at http://127.0.0.1:8002/v1 sent nothing for 60s");
      },
    ]);
    const { entries, messages } = await collect("m", { adapter, system: "s", tools: [recordingTool("status").spec], ctx });
    const result = resultOf(entries);
    expect(result).toMatchObject({ ok: false, turns: 2 });
    expect(result?.errors).toEqual(["the model at http://127.0.0.1:8002/v1 sent nothing for 60s"]);
    expect(messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "c" });
  });

  test("a provider with no chat() is a failed result naming it", async () => {
    const adapter: Adapter = {
      id: "old-local",
      model: "writer",
      preferredOutput: "text",
      async *complete() {},
      proposeEdit: () => Promise.reject(new Error("unused")),
      extractFacts: () => Promise.reject(new Error("unused")),
    };
    const { entries } = await collect("m", { adapter, system: "s", tools: [], ctx });
    expect(entries.map((entry) => entry.kind)).toEqual(["session", "result"]);
    expect(resultOf(entries)?.errors[0]).toContain('provider "old-local" cannot run an agent session (it has no chat()). Map the "agent" intent');
  });

  test("a conversation continues from the returned history", async () => {
    const adapter = scripted([[text("Hello.")], [text("Still here.")]]);
    const spec: LoopSpec = { adapter, system: "s", tools: [], ctx };
    const first = await collect("hi", spec);
    const second = await collect("still there?", spec, first.messages);
    expect(adapter.requests[1]!.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello." },
      { role: "user", content: "still there?" },
    ]);
    expect(adapter.requests[1]!.tools).toEqual([]);
    expect(adapter.requests[1]!.toolChoice).toBeUndefined();
    expect(second.messages).toHaveLength(4);
  });

  test("the session entry carries the credential and the model override", async () => {
    const adapter = scripted([[text("ok")]]);
    const { entries } = await collect("m", { adapter, system: "s", tools: [], ctx, credential: "ANTHROPIC_API_KEY", model: "claude-opus-5-5", maxTokens: 4096, temperature: 0.2, timeoutMs: 1000 });
    expect(entries[0]).toEqual({ kind: "session", model: "claude-opus-5-5", apiKeySource: "ANTHROPIC_API_KEY", tools: [] });
    expect(adapter.requests[0]).toMatchObject({ model: "claude-opus-5-5", maxTokens: 4096, temperature: 0.2, timeoutMs: 1000 });
  });

  test("two tools with one name are refused before the session starts", async () => {
    const adapter = scripted([[text("ok")]]);
    const a = recordingTool("status").spec;
    await expect(collect("m", { adapter, system: "s", tools: [a, { ...a }], ctx })).rejects.toThrow('two tools named "status"');
  });
});

/** Claude Code's built-ins (and the generic file writers) that must never be on offer: no shell, no file read/write, no subagents. */
const CODING_TOOLS = ["Bash", "Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "NotebookEdit", "Task", "Agent", "TodoWrite", "Skill", "WebSearch", "WebFetch", "write_file", "edit_file"];

test("the loop offers exactly the tools it was handed — pablo's own, no built-ins, nothing that writes prose into the book", async () => {
  const tools = harnessTools(async () => "ok");
  const adapter = scripted([[text("ok")]]);
  const { entries } = await collect("m", { adapter, system: "s", tools, ctx });
  const offered = adapter.requests[0]!.tools.map((tool) => tool.name);
  expect(offered).toEqual(tools.map((tool) => tool.name));
  expect((entries[0] as Extract<TranscriptEntry, { kind: "session" }>).tools).toEqual(offered);
  expect(offered).toContain("ask_author");
  expect(offered).toContain("resume");
  for (const name of CODING_TOOLS) expect(offered).not.toContain(name);
});

describe("parseTextToolCalls", () => {
  test("reads a fenced object, an array, bare JSON, and the name aliases", () => {
    expect(parseTextToolCalls('```json\n{"tool": "status", "arguments": {"title": "x"}}\n```')).toEqual([{ name: "status", arguments: { title: "x" } }]);
    expect(parseTextToolCalls('Here:\n```\n[{"name": "a", "args": {}}, {"tool": "b", "parameters": {"k": 1}}]\n```')).toEqual([
      { name: "a", arguments: {} },
      { name: "b", arguments: { k: 1 } },
    ]);
    expect(parseTextToolCalls('I will call {"tool": "status", "input": {"title": "y"}} now.')).toEqual([{ name: "status", arguments: { title: "y" } }]);
    expect(parseTextToolCalls('{"tool": "status"}')).toEqual([{ name: "status", arguments: {} }]);
  });

  test("names nothing for prose, broken JSON, a missing name or non-object arguments", () => {
    expect(parseTextToolCalls("I would rather not.")).toEqual([]);
    expect(parseTextToolCalls('```json\n{"tool": "status", "arguments": {\n```')).toEqual([]);
    expect(parseTextToolCalls('{"arguments": {"title": "x"}}')).toEqual([]);
    expect(parseTextToolCalls('{"tool": "status", "arguments": "title=x"}')).toEqual([]);
    expect(parseTextToolCalls('{"tool": "", "arguments": {}}')).toEqual([]);
  });
});
