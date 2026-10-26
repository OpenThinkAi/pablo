/**
 * The compose view's session (AGT-1566): one long-lived harness conversation behind the screen's `Composer` seam
 * (packages/tui/src/compose.ts). The tui knows nothing about providers or the loop; the cli builds this and passes it
 * to `runScreen`, the way it passes the project.
 *
 * A conversation is pablo's agent loop (AGT-2121) run once per message, each run given the conversation the previous
 * one returned, so the session keeps its context between turns without persisting anything to disk. `send` yields
 * the events of one turn and ends at its result. The session runs in this process, so leaving the compose view loses
 * nothing; `close` ends it with the screen.
 *
 * The seam is `HarnessQuery`, the same as `pablo agent`'s: a test passes a fake query or a scripted provider, and
 * nothing in `bun test` reaches a model.
 */

import { randomUUID } from "node:crypto";
import type { ChatMessage } from "@openthink/pablo-core";
import type { Composer, ComposeEvent } from "@openthink/pablo-tui";
import type { AskAuthor } from "./ask-author";
import { providerHint } from "./provider";
import type { HarnessProvider } from "./provider";
import { loopQuery, runHarness } from "./session";
import type { HarnessQuery, HarnessSpec } from "./session";
import type { TranscriptEntry } from "./transcript";

/** One transcript entry as the screen's event; the loop's own `session` entry is not one (the composer sends its id). */
export function composeEvent(entry: TranscriptEntry): ComposeEvent | undefined {
  switch (entry.kind) {
    case "session": return undefined;
    case "assistant": return entry;
    case "tool_call": return entry;
    case "tool_result": return entry;
    case "result": return { kind: "result", ok: entry.ok, errors: entry.errors };
  }
}

/**
 * The seam's implementation. `spec` may be a function so a missing credential surfaces in the conversation, as an
 * error on the first message, rather than before the screen opens. The session gets `ask_author`: a question the
 * model asks reaches the screen as a `question` event in the turn's stream, and `answer` resolves it (a number picks
 * an option, as in `pablo agent`).
 */
export function createComposer(spec: HarnessSpec | (() => HarnessSpec), query: HarnessQuery = loopQuery): Composer {
  // The conversation so far; undefined until the first message starts one.
  let conversation: { readonly spec: HarnessSpec; history: readonly ChatMessage[] } | undefined;
  let stream: AsyncGenerator<TranscriptEntry, readonly ChatMessage[] | void, undefined> | undefined;
  let provider: HarnessProvider | undefined;
  // Events that do not come from the loop's stream (question cards), and the questions waiting for an answer.
  const side: ComposeEvent[] = [];
  let wakeSide: (() => void) | undefined;
  const asked = new Map<string, { options: readonly string[]; resolve: (answer: string) => void; reject: (error: Error) => void }>();
  let asks = 0;

  const ask: AskAuthor = (q) =>
    new Promise<string>((resolve, reject) => {
      const id = `q${++asks}`;
      asked.set(id, { options: q.options, resolve, reject });
      side.push({ kind: "question", id, question: q.question, options: q.options, why: q.why });
      wakeSide?.();
    });

  const reset = () => {
    void stream?.return(undefined);
    conversation = undefined;
    stream = undefined;
    for (const waiting of asked.values()) waiting.reject(new Error("the session ended"));
    asked.clear();
    side.length = 0;
  };

  async function* send(message: string): AsyncGenerator<ComposeEvent> {
    try {
      if (!conversation) {
        const resolved = typeof spec === "function" ? spec() : spec;
        provider = resolved.provider;
        conversation = { spec: { ...resolved, ask }, history: [] };
        yield { kind: "session", id: randomUUID() };
      }
      const current = conversation;
      const turn = runHarness(message, current.spec, query, current.history);
      stream = turn;
      let next = turn.next();
      for (;;) {
        while (side.length > 0) yield side.shift()!;
        // The loop's next entry, or a question card the model's tool raised while the loop waits on its answer.
        const woke = new Promise<"side">((resolve) => { wakeSide = () => resolve("side"); });
        const got = await Promise.race([next.then((value) => ({ value })), woke]);
        if (got === "side") continue;
        const result = got.value;
        if (result.done) {
          stream = undefined;
          if (result.value) current.history = result.value;
          return;
        }
        const event = composeEvent(result.value);
        if (event !== undefined) yield event;
        next = turn.next();
      }
    } catch (error) {
      const hint = provider === undefined ? "" : ` ${providerHint(provider)}`;
      reset(); // the next message starts a fresh session
      throw new Error(`pablo's session failed (${(error as Error).message}).${hint}`);
    }
  }

  function answer(id: string, text: string): void {
    const waiting = asked.get(id);
    if (!waiting) return;
    asked.delete(id);
    const index = /^\d+$/.test(text.trim()) ? Number(text.trim()) : 0;
    waiting.resolve(index >= 1 && index <= waiting.options.length ? waiting.options[index - 1]! : text.trim());
  }

  return { send, answer, close: reset };
}
