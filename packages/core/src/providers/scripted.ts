/**
 * A fake `Adapter` whose `chat()` replays scripted turns, for tests of anything
 * that drives a tool conversation (the agent loop, D-12). It never opens a
 * socket or starts a process, so a test built on it can never call a real
 * model.
 *
 * Each `chat()` call takes the next turn from the script and records the
 * request it was given, so a test can assert both what the model "said" and
 * what history and tools the caller sent it. A turn is either a fixed list of
 * events or a function of the request, for a reply that depends on a tool
 * result. A turn that does not end in `done` gets one appended with empty
 * usage, so the stream always ends the way a real adapter's does.
 *
 * `complete`, `proposeEdit` and `extractFacts` throw: this adapter exists only
 * to exercise `chat()`.
 */

import { ProviderResponseError } from "./errors";
import type { Adapter, ChatEvent, ChatRequest, CompletionEvent, OutputMode, Proposal } from "./types";

export type ScriptedTurn = readonly ChatEvent[] | ((request: ChatRequest) => readonly ChatEvent[]);

export interface ScriptedChatAdapterOptions {
  readonly turns: readonly ScriptedTurn[];
  readonly id?: string;
  readonly model?: string;
  readonly preferredOutput?: OutputMode;
}

export interface ScriptedChatAdapter extends Adapter {
  chat(request: ChatRequest): AsyncIterable<ChatEvent>;
  /** Every request `chat()` received, in order. */
  readonly requests: readonly ChatRequest[];
}

export function createScriptedChatAdapter(options: ScriptedChatAdapterOptions): ScriptedChatAdapter {
  const id = options.id ?? "scripted";
  const requests: ChatRequest[] = [];
  let next = 0;

  function unsupported(method: string): never {
    throw new ProviderResponseError(id, `the scripted adapter does not implement ${method}`);
  }

  return {
    id,
    model: options.model ?? "scripted-model",
    preferredOutput: options.preferredOutput ?? "tool",
    requests,

    async *chat(request: ChatRequest): AsyncIterable<ChatEvent> {
      requests.push(request);
      const turn = options.turns[next];
      if (turn === undefined) {
        throw new ProviderResponseError(id, `the script has ${options.turns.length} turn(s) and chat() was called again`);
      }
      next += 1;
      const events = typeof turn === "function" ? turn(request) : turn;
      let done = false;
      for (const event of events) {
        if (request.signal?.aborted === true) throw request.signal.reason;
        yield event;
        if (event.type === "done") {
          done = true;
          break;
        }
      }
      if (!done) yield { type: "done", usage: { inputTokens: undefined, outputTokens: undefined } };
    },

    async *complete(): AsyncIterable<CompletionEvent> {
      unsupported("complete");
    },
    async proposeEdit(): Promise<Proposal> {
      return unsupported("proposeEdit");
    },
    async extractFacts(): Promise<readonly string[]> {
      return unsupported("extractFacts");
    },
  };
}
