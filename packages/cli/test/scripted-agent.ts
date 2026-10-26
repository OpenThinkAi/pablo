/**
 * A scripted model for tests that drive pablo's real agent loop (AGT-2121): core's scripted `chat()` adapter, told per
 * message which of pablo's tools to call. On a fresh user message it calls every tool `callsFor(message)` names, in
 * one turn; once their results come back it answers with text, ending the session. A tool result whose body is
 * `ok: false`, or that the loop marked an error, makes the next `chat()` throw, so the session ends as a failed result
 * naming it. Nothing here reaches a model.
 */

import { createScriptedChatAdapter } from "@openthink/pablo-core";
import type { ChatEvent, ChatMessage, ChatRequest, ScriptedChatAdapter } from "@openthink/pablo-core";
import { adapterProvider } from "../src/harness/provider";
import type { HarnessProvider } from "../src/harness/provider";

export type ScriptedCall = readonly [string, Record<string, unknown>];

/** Every turn is the same function of the request; enough of them for any test run. */
const TURNS = 1000;

function refusal(messages: readonly ChatMessage[]): string | undefined {
  // The calls of the latest assistant turn and their results after it.
  let at = messages.length - 1;
  while (at >= 0 && messages[at]!.role === "tool") at -= 1;
  const assistant = messages[at];
  const names = new Map((assistant?.role === "assistant" ? (assistant.toolCalls ?? []) : []).map((call) => [call.id, call.name]));
  for (const message of messages.slice(at + 1)) {
    if (message.role !== "tool") continue;
    let body: { ok?: unknown; message?: unknown } = {};
    try {
      body = JSON.parse(message.content) as typeof body;
    } catch {
      // A plain-text result: an error the loop wrote.
    }
    if (message.isError === true || body.ok === false) {
      return `${names.get(message.toolCallId) ?? "a tool"} refused: ${typeof body.message === "string" ? body.message : message.content}`;
    }
  }
  return undefined;
}

export function scriptedAgent(
  callsFor: (message: string) => readonly ScriptedCall[],
  reply: (message: string) => string = () => "done",
): { adapter: ScriptedChatAdapter; provider: HarnessProvider; messages: string[] } {
  const messages: string[] = [];
  let current = "";
  let calls = 0;
  const turn = (request: ChatRequest): readonly ChatEvent[] => {
    const last = request.messages.at(-1);
    if (last?.role === "tool") {
      const refused = refusal(request.messages);
      if (refused !== undefined) throw new Error(refused);
      return [{ type: "text", text: reply(current) }];
    }
    current = last?.role === "user" ? last.content : "";
    messages.push(current);
    const planned = callsFor(current);
    if (planned.length === 0) return [{ type: "text", text: reply(current) }];
    return planned.map(([name, args]) => ({ type: "tool_call", call: { id: `call-${++calls}`, name, arguments: args } }));
  };
  const adapter = createScriptedChatAdapter({ turns: Array.from({ length: TURNS }, () => turn), id: "scripted-agent", model: "scripted-agent-model" });
  return { adapter, provider: adapterProvider(adapter, { local: true }), messages };
}
