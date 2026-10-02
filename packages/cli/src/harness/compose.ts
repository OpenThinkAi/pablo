/**
 * The compose view's session (AGT-1566): one long-lived harness conversation behind the screen's `Composer` seam
 * (packages/tui/src/compose.ts). The tui does not depend on the Agent SDK; the cli builds this and passes it to
 * `runScreen`, the way it passes the project.
 *
 * A conversation is one SDK query fed by an async-iterable prompt (streaming input): each message the author sends
 * is pushed into it, and the session keeps its context between turns without persisting anything to disk
 * (`persistSession: false`, as `harnessOptions` sets). `send` yields the events of one turn and ends at its result.
 * The session runs in this process, so leaving the compose view loses nothing; `close` ends it with the screen.
 *
 * `ComposeQuery` is `HarnessQuery`'s streaming sibling and the fake seam for the same reason: every test passes a
 * fake, and nothing in `bun test` starts Claude. Saved sessions (AGT-1565) hook in at `session` events (the id) and
 * at the query's `options` (resume).
 */

import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Composer, ComposeEvent } from "@openthink/pablo-tui";
import type { AskAuthor } from "./ask-author";
import { harnessOptions } from "./session";
import type { HarnessSpec } from "./session";
import { displayToolName, transcriptEntries } from "./transcript";

/** The SDK's `query` with a streaming prompt; a test fake implements this. */
export type ComposeQuery = (params: { readonly prompt: AsyncIterable<SDKUserMessage>; readonly options: Options }) => AsyncIterable<SDKMessage>;

/** The real session: the Agent SDK's `query`, imported lazily like `sdkQuery`. */
export const sdkStreamQuery: ComposeQuery = async function* (params) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  yield* query({ prompt: params.prompt, options: params.options });
};

/** A queue the session reads as its prompt: `push` a message, `close` to end the session. */
function channel<T>(): { push(value: T): void; close(): void; iterable: AsyncIterable<T> } {
  const queue: T[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  return {
    push(value) { queue.push(value); wake?.(); },
    close() { closed = true; wake?.(); },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = queue.shift();
          if (next !== undefined) { yield next; continue; }
          if (closed) return;
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = undefined;
        }
      },
    },
  };
}

const userMessage = (text: string): SDKUserMessage => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });

/** One SDK message as the screen's events: the transcript's entries, plus the session's id. */
export function composeEvents(message: SDKMessage): ComposeEvent[] {
  const events: ComposeEvent[] = [];
  if (message.type === "system" && message.subtype === "init") events.push({ kind: "session", id: message.session_id });
  for (const entry of transcriptEntries(message)) {
    switch (entry.kind) {
      case "session": break;
      case "assistant": events.push(entry); break;
      case "tool_call": events.push({ ...entry, tool: displayToolName(entry.tool) }); break;
      case "tool_result": events.push(entry); break;
      case "result": events.push({ kind: "result", ok: entry.ok, errors: entry.errors }); break;
    }
  }
  return events;
}

/**
 * The seam's implementation. `spec` may be a function so a missing credential surfaces in the conversation, as an
 * error on the first message, rather than before the screen opens. The session gets `ask_author`: a question the
 * model asks reaches the screen as a `question` event in the turn's stream, and `answer` resolves it (a number picks
 * an option, as in `pablo agent`).
 */
export function createComposer(spec: HarnessSpec | (() => HarnessSpec), query: ComposeQuery = sdkStreamQuery): Composer {
  let inbox: ReturnType<typeof channel<SDKUserMessage>> | undefined;
  let stream: AsyncIterator<SDKMessage> | undefined;
  let route: HarnessSpec["auth"]["route"] = "subscription";
  // Events that do not come from the SDK's stream (question cards), and the questions waiting for an answer.
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
    inbox?.close();
    void stream?.return?.();
    inbox = undefined;
    stream = undefined;
    for (const waiting of asked.values()) waiting.reject(new Error("the session ended"));
    asked.clear();
    side.length = 0;
  };

  async function* send(message: string): AsyncGenerator<ComposeEvent> {
    try {
      if (!stream || !inbox) {
        const resolved = typeof spec === "function" ? spec() : spec;
        route = resolved.auth.route;
        inbox = channel<SDKUserMessage>();
        stream = query({ prompt: inbox.iterable, options: harnessOptions({ ...resolved, ask }) })[Symbol.asyncIterator]();
      }
      inbox.push(userMessage(message));
      let next = stream.next();
      for (;;) {
        while (side.length > 0) yield side.shift()!;
        // The next SDK message, or a question card the model's tool raised while the stream waits on its answer.
        const woke = new Promise<"side">((resolve) => { wakeSide = () => resolve("side"); });
        const got = await Promise.race([next.then((value) => ({ value })), woke]);
        if (got === "side") continue;
        const result = got.value;
        if (result.done) { reset(); return; }
        yield* composeEvents(result.value);
        if (result.value.type === "result") return;
        next = stream.next();
      }
    } catch (error) {
      reset(); // the next message starts a fresh session
      const hint = route === "subscription" ? "Run `claude` once to log in, or put an Anthropic key in pablo's config." : "Check the Anthropic key in pablo's config.";
      throw new Error(`pablo's session failed (${(error as Error).message}). ${hint}`);
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
