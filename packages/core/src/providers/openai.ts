/**
 * The OpenAI-compatible adapter: `POST {endpoint}/chat/completions` with
 * `stream: true`. One adapter covers the local writer (mlx_lm), llama.cpp, LM
 * Studio and OpenAI itself — which one it is talking to is config, not code.
 *
 * It streams, so the wait is visible and measurable; it holds its endpoint's
 * gate for the whole stream when the endpoint is local; and it turns silence
 * into `EndpointHung` rather than waiting forever.
 */

import { selectionText } from "../document";
import type { ProviderConfig } from "./config";
import { EndpointHung, ProviderResponseError } from "./errors";
import type { Gate } from "./queue";
import type { RateMeter } from "./rates";
import type {
  Adapter,
  CompletionEvent,
  CompletionRequest,
  CompletionStats,
  EditRequest,
  ExtractRequest,
  Proposal,
} from "./types";

export interface OpenAiAdapterOptions {
  readonly provider: ProviderConfig;
  readonly meter: RateMeter;
  /** Present when the endpoint is local: one request in flight at a time. */
  readonly gate?: Gate;
  /** Resolved lazily so a Keychain read happens on first use, not at startup. */
  readonly key?: () => string | undefined;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

const TIMED_OUT = Symbol("timed out");
/** Rough enough to size a timeout with; nothing downstream depends on it. */
const CHARS_PER_TOKEN = 4;

export function createOpenAiAdapter(options: OpenAiAdapterOptions): Adapter {
  const { provider, meter } = options;
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const url = `${provider.endpoint}/chat/completions`;

  async function* complete(request: CompletionRequest): AsyncIterable<CompletionEvent> {
    const release = await options.gate?.acquire();
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });

    const started = now();
    let firstTokenAt: number | undefined;
    let tokensWritten = 0;
    let tokensRead: number | undefined;

    try {
      const idleMs = request.timeoutMs ?? provider.timeoutMs;
      const prefillMs = meter.estimatePrefillMs(Math.ceil(request.prompt.length / CHARS_PER_TOKEN)) ?? 0;
      const firstByteMs = Math.max(idleMs, prefillMs * 2);

      const response = await waitFor(
        doFetch(url, {
          method: "POST",
          headers: headers(options.key?.()),
          body: JSON.stringify(body(provider, request)),
          signal: controller.signal,
        }),
        firstByteMs,
        () => {
          controller.abort();
          throw new EndpointHung(provider.endpoint, now() - started, firstByteMs);
        },
      );

      if (!response.ok) {
        throw new ProviderResponseError(provider.endpoint, truncate(await response.text()), response.status);
      }
      if (!response.body) throw new ProviderResponseError(provider.endpoint, "no response body to stream");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        for (;;) {
          const limit = firstTokenAt === undefined ? firstByteMs : idleMs;
          const chunk = await waitFor(reader.read(), limit, () => {
            void reader.cancel();
            controller.abort();
            throw new EndpointHung(provider.endpoint, now() - started, limit);
          });
          if (chunk.done) break;

          buffer += decoder.decode(chunk.value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";

          for (const event of events) {
            const payload = dataOf(event);
            if (payload === undefined || payload === "[DONE]") continue;
            const parsed = parseChunk(provider.endpoint, payload);
            if (parsed.promptTokens !== undefined) tokensRead = parsed.promptTokens;
            if (parsed.completionTokens !== undefined) tokensWritten = parsed.completionTokens;
            if (parsed.text === undefined || parsed.text === "") continue;
            if (firstTokenAt === undefined) firstTokenAt = now();
            if (parsed.completionTokens === undefined) tokensWritten += 1;
            yield { type: "token", text: parsed.text };
          }
        }
      } finally {
        reader.releaseLock();
      }

      const stats = measure(started, firstTokenAt ?? now(), now(), tokensRead, tokensWritten);
      meter.record(stats);
      yield { type: "done", stats };
    } finally {
      request.signal?.removeEventListener("abort", abort);
      release?.();
    }
  }

  async function collect(request: CompletionRequest): Promise<string> {
    let text = "";
    for await (const event of complete(request)) {
      if (event.type === "token") text += event.text;
    }
    return text.trim();
  }

  return {
    id: provider.id,
    model: provider.model,
    complete,

    async proposeEdit(request: EditRequest): Promise<Proposal> {
      const passage = selectionText(request.document, request.span);
      const wanted = request.variants ?? 1;
      if (!Number.isInteger(wanted) || wanted < 1) {
        throw new RangeError(`pablo: asked for ${request.variants} variants; ask for at least one`);
      }

      const prompt = editPrompt(passage, request);
      const oneVariant = async (): Promise<string> => {
        const replacement = await collect({
          prompt,
          model: request.model,
          maxTokens: request.maxTokens,
          temperature: request.temperature,
          timeoutMs: request.timeoutMs,
          signal: request.signal,
        });
        if (replacement === "") {
          throw new ProviderResponseError(provider.endpoint, "an empty replacement for the selected passage");
        }
        return replacement;
      };

      const first = await oneVariant();
      const rest: string[] = [];
      for (let extra = 1; extra < wanted; extra += 1) rest.push(await oneVariant());

      return {
        span: request.span,
        variants: [first, ...rest],
        intent: request.intent,
        providerId: provider.id,
        model: request.model ?? provider.model,
      };
    },

    async extractFacts(request: ExtractRequest): Promise<readonly string[]> {
      const answer = await collect({
        prompt: extractPrompt(request),
        model: request.model,
        maxTokens: request.maxTokens,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      });
      return answer
        .split("\n")
        .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
        .filter((line) => line !== "");
    },
  };
}

function headers(key: string | undefined): Record<string, string> {
  const sent: Record<string, string> = { "content-type": "application/json" };
  if (key !== undefined) sent["authorization"] = `Bearer ${key}`;
  return sent;
}

function body(provider: ProviderConfig, request: CompletionRequest): Record<string, unknown> {
  return {
    model: request.model ?? provider.model,
    messages: [{ role: "user", content: request.prompt }],
    stream: true,
    stream_options: { include_usage: true },
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  };
}

function editPrompt(passage: string, request: EditRequest): string {
  const context = request.context?.trim();
  return [
    ...(context ? [context] : []),
    "# The passage",
    passage,
    "# What to do to it",
    request.instruction,
    "Write the replacement passage and nothing else: no preamble, no explanation, no quotation marks around it.",
  ].join("\n\n");
}

function extractPrompt(request: ExtractRequest): string {
  const context = request.context?.trim();
  return [
    ...(context ? [context] : []),
    "# The passage",
    request.text,
    "# What to pull out of it",
    request.instruction,
    "One per line, in the order they appear. No numbering, no bullets, no commentary.",
  ].join("\n\n");
}

interface ParsedChunk {
  readonly text: string | undefined;
  readonly promptTokens: number | undefined;
  readonly completionTokens: number | undefined;
}

/** Model output is untrusted input: every field is checked before it is used. */
function parseChunk(endpoint: string, payload: string): ParsedChunk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new ProviderResponseError(endpoint, `a stream chunk that is not JSON: ${truncate(payload)}`);
  }
  const chunk = parsed as {
    choices?: { delta?: { content?: unknown } }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const content = chunk.choices?.[0]?.delta?.content;
  return {
    text: typeof content === "string" ? content : undefined,
    promptTokens: countOf(chunk.usage?.prompt_tokens),
    completionTokens: countOf(chunk.usage?.completion_tokens),
  };
}

function countOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function dataOf(event: string): string | undefined {
  const line = event.split("\n").find((candidate) => candidate.startsWith("data:"));
  return line === undefined ? undefined : line.slice("data:".length).trim();
}

function measure(
  started: number,
  firstTokenAt: number,
  ended: number,
  tokensRead: number | undefined,
  tokensWritten: number,
): CompletionStats {
  const generatingMs = Math.max(ended - firstTokenAt, 1);
  return {
    timeToFirstTokenMs: firstTokenAt - started,
    elapsedMs: ended - started,
    tokensRead,
    tokensWritten,
    tokensPerSecond: (tokensWritten * 1000) / generatingMs,
  };
}

/** Resolves `work`, or runs `onTimeout` (which throws) after `ms` of silence. */
async function waitFor<T>(work: Promise<T>, ms: number, onTimeout: () => never): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    const result = await Promise.race([work, expiry]);
    if (result === TIMED_OUT) onTimeout();
    return result as T;
  } finally {
    clearTimeout(timer);
  }
}

function truncate(text: string): string {
  const cleaned = text.trim().replace(/\s+/g, " ");
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
}
