/**
 * pablo's own agent loop (AGT-2120, decision D-12): model -> tool calls ->
 * results -> model, until the model answers with no tool call or the turn
 * cap is reached, on any provider with `chat()` — the local Gemma behind
 * mlx_lm, any OpenAI-compatible endpoint, or Claude through the native
 * adapter. It is what every harness session runs on: `runHarness`
 * (`session.ts`) and the compose view's composer (`compose.ts`) both call it
 * (AGT-2121).
 *
 * What it emits is the existing `TranscriptEntry` stream (`transcript.ts`):
 * `session` first, then `assistant` text, `tool_call` and `tool_result` per
 * call, and exactly one `result`, so `formatEntry`, `composeEvents` and
 * `story`'s result check read every session the same way. Tool names are
 * plain (`resume`), exactly as the model calls them.
 *
 * The loop has no built-in tools and never adds one: the only tools the model
 * can call are the `McpToolSpec`s it was handed, each of which writes through
 * a pablo verb onto a branch. There is no shell, no file read or write, and
 * nothing that takes prose from the model and puts it in the book — prose is
 * produced only through `pablo write` on the configured writer (invariant 1 in
 * `CLAUDE.md`). Every call is checked here before it runs: the name must be
 * one the turn offered and the arguments must pass the tool's own zod schema
 * (`parseToolArguments`); the adapters only check the wire shape. A call that
 * fails either check goes back to the model as an error result, never to
 * `run`. Each tool's `run()` is awaited in order, so a tool that blocks on the
 * author (`ask_author`, AGT-1560) holds the loop until the answer comes, as
 * the SDK's tool call did.
 *
 * Text-protocol fallback (mirrors `novel/continuity.ts`'s `extractWithFallback`):
 * when the turn needed a tool call (`toolChoice` was `required` or named) and
 * the model answered with none — mlx_lm ignores `tool_choice` — the loop
 * re-prompts once, with no tools on the wire and the tool list in the prompt,
 * asking for one JSON object `{"tool", "arguments"}`; the reply is parsed and
 * run like a native call. A reply that still names no tool ends the session as
 * a failed result naming what the model said.
 *
 * Forced tool choice: Anthropic's newest models answer a forced `tool_choice`
 * (`required` or a named tool) with HTTP 400. A spec with `forcedToolChoice:
 * false` (the harness sets it for an Anthropic provider) sends `auto` on the
 * wire and steers from the prompt instead, with one line in the first turn's
 * system prompt; the text-protocol re-prompt still backs it up.
 *
 * Cost (`result.costUsd`) is the turns' reported usage times core's per-model
 * price table (`costUsd`); a local provider costs 0. A model the table does not
 * know costs 0 too, but the result names it (`unpricedModel`) so the transcript
 * says the cost is incomplete rather than reading as free. Provider failures (an endpoint that hangs, `tools: false`, a
 * provider with no `chat()`) end the session as a failed result rather than a
 * throw, so a caller sees them in the transcript with the turns and cost so far.
 */

import { costUsd, priceFor, withReceipts } from "@openthink/pablo-core";
import type { Adapter, ReceiptSink, ChatEvent, ChatMessage, ChatRequest, ChatUsage, JsonSchemaTool, PriceTable, ToolCall, ToolChoice } from "@openthink/pablo-core";
import type { McpToolSpec, VerbContext } from "../verbs";
import { parseToolArguments, toJsonSchemaTools } from "./tool-schema";
import type { TranscriptEntry } from "./transcript";

/** Turns (model calls) a session may take before it is stopped as unfinished. */
export const DEFAULT_MAX_TURNS = 40;

export interface LoopSpec {
  /** The provider the session runs on; it must have `chat()`. */
  readonly adapter: Adapter;
  /** pablo's system prompt (`harnessSystemPrompt`). */
  readonly system: string;
  /** The tools on offer, every turn: pablo's specs (plus `ask_author` and the session's plan tools). Names must be unique. */
  readonly tools: readonly McpToolSpec[];
  /** What the tools resolve projects against. */
  readonly ctx: VerbContext;
  readonly maxTurns?: number;
  /**
   * The first turn's tool choice; later turns are always `auto`. `required` or
   * a tool name makes the first turn one that needs a call, which arms the
   * text-protocol re-prompt when none comes.
   */
  readonly toolChoice?: ToolChoice;
  /**
   * Whether the provider honours a forced `toolChoice`; default true. False
   * sends `auto` and asks for the call in the system prompt instead
   * (Anthropic's newest models refuse a forced choice with HTTP 400).
   */
  readonly forcedToolChoice?: boolean;
  /** A local provider: the session costs nothing. */
  readonly local?: boolean;
  /** Overrides the default per-model price table. */
  readonly prices?: PriceTable;
  /** Shown in the `session` entry as the credential: a source label (`env:ANTHROPIC_API_KEY`, `none`), never the key. */
  readonly credential?: string;
  /** Overrides the adapter's configured model. */
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  /**
   * Where each turn's receipt goes (AGT-2191): intent, provider, model, tokens,
   * cost and the names of the tools the turn called. Absent, the loop keeps none.
   */
  readonly receipts?: { readonly sink: ReceiptSink; readonly intent: string };
}

type ResultEntry = Extract<TranscriptEntry, { kind: "result" }>;

/** A tool call parsed from a text-protocol reply, before it gets an id. */
export interface TextToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const ANSWER_PREVIEW = 200;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "nothing";
  return flat.length > ANSWER_PREVIEW ? `${flat.slice(0, ANSWER_PREVIEW)}…` : flat;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The re-prompt sent when a turn needed a tool call and got none: the tools
 * again, as text this time, and the one shape the reply may take.
 */
export function textProtocolPrompt(tools: readonly JsonSchemaTool[], choice: ToolChoice | undefined): string {
  const must = typeof choice === "object" ? `You must call \`${choice.name}\`.` : "You must call one of the tools listed below.";
  const listed = tools.map((tool) => `- ${tool.name}: ${tool.description}\n  parameters: ${JSON.stringify(tool.parameters)}`);
  return [
    `Your reply made no tool call, but this step needs one. ${must}`,
    "Answer with exactly one JSON object inside a ```json fence and nothing else:",
    "```json",
    '{"tool": "<name>", "arguments": { ... }}',
    "```",
    "Tools:",
    ...listed,
  ].join("\n");
}

function toTextToolCall(value: unknown): TextToolCall | undefined {
  if (!isRecord(value)) return undefined;
  const name = value["tool"] ?? value["name"];
  if (typeof name !== "string" || name.trim() === "") return undefined;
  const args = value["arguments"] ?? value["args"] ?? value["parameters"] ?? value["input"] ?? {};
  if (!isRecord(args)) return undefined;
  return { name: name.trim(), arguments: args };
}

/**
 * The tool calls in a text-protocol reply: the first fenced block (or, with
 * no fence, the outermost braces) that parses as a `{"tool", "arguments"}`
 * object or an array of them. Empty when the reply names no tool.
 */
export function parseTextToolCalls(text: string): readonly TextToolCall[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(match[1] ?? "");
  if (candidates.length === 0) {
    const open = text.search(/[[{]/);
    const close = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (open >= 0 && close > open) candidates.push(text.slice(open, close + 1));
  }
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate.trim());
    } catch {
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const calls = items.map(toTextToolCall).filter((call): call is TextToolCall => call !== undefined);
    if (calls.length > 0) return calls;
  }
  return [];
}

/** The system-prompt line that asks for a tool call when the wire cannot force one. */
function steerLine(choice: ToolChoice): string {
  return typeof choice === "object"
    ? `This step needs a tool call: answer by calling \`${choice.name}\`.`
    : "This step needs a tool call: answer by calling one of your tools, not with text.";
}

interface Turn {
  readonly text: string;
  readonly calls: readonly ToolCall[];
  readonly usage: ChatUsage;
}

/** One `chat()` turn drained: its text, its calls in order, and what it cost. */
async function drainTurn(chat: (request: ChatRequest) => AsyncIterable<ChatEvent>, request: ChatRequest): Promise<Turn> {
  let text = "";
  const calls: ToolCall[] = [];
  let usage: ChatUsage = { inputTokens: undefined, outputTokens: undefined };
  for await (const event of chat(request)) {
    switch (event.type) {
      case "text":
        text += event.text;
        break;
      case "tool_call":
        calls.push(event.call);
        break;
      case "done":
        usage = event.usage;
        break;
    }
  }
  return { text, calls, usage };
}

/**
 * One message through the loop. Yields the session's transcript entries as
 * they happen and returns the conversation after this message (the history
 * plus this turn's messages), which the next `runLoop` call takes as its
 * `history` so a conversation keeps its context between messages.
 */
export async function* runLoop(
  message: string,
  spec: LoopSpec,
  history: readonly ChatMessage[] = [],
): AsyncGenerator<TranscriptEntry, readonly ChatMessage[], undefined> {
  const byName = new Map<string, McpToolSpec>();
  for (const tool of spec.tools) {
    if (byName.has(tool.name)) throw new Error(`pablo: the agent loop was offered two tools named "${tool.name}"`);
    byName.set(tool.name, tool);
  }
  const jsonTools = toJsonSchemaTools(spec.tools);
  const offered = [...byName.keys()];
  const now = spec.now ?? (() => Date.now());
  const started = now();
  const maxTurns = spec.maxTurns ?? DEFAULT_MAX_TURNS;
  const model = spec.model ?? spec.adapter.model;
  const adapter =
    spec.receipts === undefined
      ? spec.adapter
      : withReceipts(spec.adapter, spec.receipts.sink, {
          intent: spec.receipts.intent,
          cost: (usage, modelId) => costUsd(usage, modelId, { local: spec.local, prices: spec.prices }),
        });
  const chat = adapter.chat?.bind(adapter);
  const needsCall = spec.toolChoice !== undefined && spec.toolChoice !== "auto" && spec.toolChoice !== "none";
  // A provider that refuses a forced choice gets `auto` on the wire and the requirement in the prompt.
  const steer = needsCall && spec.forcedToolChoice === false;
  const firstChoice: ToolChoice = steer ? "auto" : (spec.toolChoice ?? "auto");
  const firstSystem = steer ? `${spec.system}\n\n${steerLine(spec.toolChoice!)}` : spec.system;

  let turns = 0;
  let cost = 0;
  let unpriced: string | undefined;
  const result = (ok: boolean, text: string, errors: readonly string[]): ResultEntry => ({
    kind: "result",
    ok,
    text,
    turns,
    durationMs: now() - started,
    costUsd: cost,
    ...(unpriced === undefined ? {} : { unpricedModel: unpriced }),
    errors,
  });

  yield { kind: "session", model, apiKeySource: spec.credential ?? "none", tools: offered };

  const messages: ChatMessage[] = [...history, { role: "user", content: message }];
  if (chat === undefined) {
    yield result(false, "", [`pablo: provider "${spec.adapter.id}" cannot run an agent session (it has no chat()). Map the "agent" intent to an openai-compatible or anthropic provider in pablo's config; \`pablo config show\` lists them.`]);
    return messages;
  }

  async function execute(call: ToolCall): Promise<{ readonly text: string; readonly isError: boolean }> {
    const tool = byName.get(call.name);
    if (tool === undefined) {
      return { text: `unknown tool "${call.name}"; the tools on offer are: ${offered.join(", ")}`, isError: true };
    }
    const parsed = parseToolArguments(tool, call.arguments);
    if (!parsed.ok) return { text: parsed.error, isError: true };
    try {
      const outcome = await tool.run(parsed.args, spec.ctx);
      return { text: JSON.stringify(outcome.body), isError: false };
    } catch (error) {
      return { text: messageOf(error), isError: true };
    }
  }

  let textProtocol = false;
  while (turns < maxTurns) {
    turns += 1;
    const first = turns === 1;
    // A snapshot: the history keeps growing after this request is sent, and an adapter (or a test) may hold onto it.
    const request: ChatRequest = {
      system: first ? firstSystem : spec.system,
      messages: [...messages],
      tools: textProtocol ? [] : jsonTools,
      ...(textProtocol || jsonTools.length === 0 ? {} : { toolChoice: first ? firstChoice : "auto" }),
      ...(spec.model === undefined ? {} : { model: spec.model }),
      ...(spec.maxTokens === undefined ? {} : { maxTokens: spec.maxTokens }),
      ...(spec.temperature === undefined ? {} : { temperature: spec.temperature }),
      ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
      ...(spec.signal === undefined ? {} : { signal: spec.signal }),
    };

    let turn: Turn;
    try {
      turn = await drainTurn(chat, request);
    } catch (error) {
      yield result(false, "", [messageOf(error)]);
      return messages;
    }
    cost += costUsd(turn.usage, model, { local: spec.local, prices: spec.prices });
    const reported = (turn.usage.inputTokens ?? 0) + (turn.usage.outputTokens ?? 0) > 0;
    if (spec.local !== true && reported && priceFor(model, spec.prices) === undefined) unpriced = model;

    let calls: readonly ToolCall[] = turn.calls;
    if (textProtocol) {
      // The reply is the protocol's JSON, not something the author reads: it becomes tool_call entries, not an assistant line.
      calls = parseTextToolCalls(turn.text).map((call, i) => ({ id: `text-${turns}-${i + 1}`, name: call.name, arguments: call.arguments }));
      if (calls.length === 0) {
        messages.push({ role: "assistant", content: turn.text });
        yield result(false, "", [`the model made no tool call, and after a text re-prompt still named none — it answered with ${preview(turn.text)}. Route the "agent" intent to a model that supports tool calls (\`pablo config show\` lists the providers), or rephrase the request.`]);
        return messages;
      }
      textProtocol = false;
    } else if (turn.text.trim() !== "") {
      yield { kind: "assistant", text: turn.text };
    }
    messages.push({ role: "assistant", content: turn.text, ...(calls.length === 0 ? {} : { toolCalls: calls }) });

    if (calls.length === 0) {
      if (first && needsCall) {
        textProtocol = true;
        messages.push({ role: "user", content: textProtocolPrompt(jsonTools, spec.toolChoice) });
        continue;
      }
      yield result(true, turn.text, []);
      return messages;
    }

    for (const call of calls) {
      yield { kind: "tool_call", id: call.id, tool: call.name, input: call.arguments };
      const outcome = await execute(call);
      yield { kind: "tool_result", id: call.id, text: outcome.text, isError: outcome.isError };
      messages.push({ role: "tool", toolCallId: call.id, content: outcome.text, ...(outcome.isError ? { isError: true } : {}) });
    }
  }

  yield result(false, "", [`the session reached its turn cap (${maxTurns} turns) without a final answer. Send a follow-up message to let it carry on, or narrow the request to one step.`]);
  return messages;
}
