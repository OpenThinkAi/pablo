/**
 * The OpenAI-compatible adapter: `POST {endpoint}/chat/completions` with
 * `stream: true`. One adapter covers the local writer (mlx_lm), llama.cpp, LM
 * Studio and OpenAI itself — which one it is talking to is config, not code.
 *
 * It streams, so the wait is visible and measurable; it holds its endpoint's
 * gate for the whole stream when the endpoint is local; and it turns silence
 * into `EndpointHung` rather than waiting forever.
 *
 * It has both structured paths the design doc requires: a native `propose_edit`
 * / `extract_facts` tool call, and CriticMarkup in the completion body checked
 * by `validateProposal`. `PREFERRED_OUTPUT` is which one it takes by default,
 * and it is a measurement — see `bench/README.md`.
 */

import { selectionText } from "../document";
import { resolveAll } from "../markup/spans";
import { CRITICMARKUP_EDIT_CLOSING, TOOL_EDIT_CLOSING } from "../pack/closing";
import { validateProposal } from "../markup/validate";
import type { ProviderConfig } from "./config";
import { EndpointHung, NoToolCallError, ProviderResponseError } from "./errors";
import { readFacts } from "./facts";
import type { Gate } from "./queue";
import type { RateMeter } from "./rates";
import { countOf, dataOf, frameSse, measure, truncate, waitFor } from "./stream";
import type {
  Adapter,
  CompletionEvent,
  CompletionRequest,
  CompletionStats,
  EditRequest,
  ExtractedFact,
  ExtractRequest,
  OutputMode,
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

/** Rough enough to size a timeout with; nothing downstream depends on it. */
const CHARS_PER_TOKEN = 4;

/**
 * The default structured path for every OpenAI-compatible endpoint, measured by
 * `bench/bakeoff.ts` against the local writer (Gemma 4 31B on mlx_lm) on
 * 2026-09-02: the tool call conformed on 10 of 10 spans and 3 of 3 over 400
 * words, at a 7.3s median; CriticMarkup as text conformed on 7 of 10, only 1 of
 * 3 over 400 words, at 13.3s. The long-prose worry the design doc had about
 * JSON string arguments did not appear — no escaped newlines and no lost quotes
 * anywhere. What fails at length is the delimiter, not the string: past about
 * 400 words the model drops a `~~}` or forgets the `~>`. The numbers are in
 * `bench/README.md` and the design doc under Proposal pipeline.
 *
 * The text path is not deleted: it is the portable fallback for an endpoint
 * with no tool support, reachable with `output: "text"`.
 */
export const PREFERRED_OUTPUT: OutputMode = "tool";

/** The tool the model calls to hand back one replacement for the selected span. */
const PROPOSE_EDIT_TOOL = {
  type: "function",
  function: {
    name: "propose_edit",
    description:
      "Propose a replacement for the selected passage. The app applies it; you never write to a file.",
    parameters: {
      type: "object",
      properties: {
        replacement: {
          type: "string",
          description:
            "The complete replacement text for the passage, verbatim, with no surrounding quotes and no commentary.",
        },
      },
      required: ["replacement"],
    },
  },
} as const;

/** The tool form of the writing-lab extraction prompt: one fact per item, each with its anchor. */
const EXTRACT_FACTS_TOOL = {
  type: "function",
  function: {
    name: "extract_facts",
    description: "Record every fact in the passage that a later chapter could contradict.",
    parameters: {
      type: "object",
      properties: {
        facts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              fact: { type: "string", description: "The fact, in one sentence." },
              entities: { type: "array", items: { type: "string" }, description: "Names the fact is about." },
              story_time: {
                type: "string",
                description: "An absolute date if the passage states one, else a relative story time like 'day 1, dawn'.",
              },
              certainty: { type: "string", enum: ["stated", "implied"] },
              anchor: {
                type: "string",
                description: "An exact substring of the passage, at most 12 words, that establishes the fact.",
              },
            },
            required: ["fact", "anchor"],
          },
        },
      },
      required: ["facts"],
    },
  },
} as const;

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
    let answered = false;
    let thought = false;
    let finish: string | undefined;

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
          const framed = frameSse(buffer);
          buffer = framed.rest;

          for (const event of framed.events) {
            const payload = dataOf(event);
            if (payload === undefined || payload === "[DONE]") continue;
            const parsed = parseChunk(provider.endpoint, payload);
            if (parsed.promptTokens !== undefined) tokensRead = parsed.promptTokens;
            if (parsed.completionTokens !== undefined) tokensWritten = parsed.completionTokens;
            if (parsed.reasoning) thought = true;
            if (parsed.finish !== undefined) finish = parsed.finish;
            if (parsed.text === undefined || parsed.text === "") continue;
            answered = true;
            if (firstTokenAt === undefined) firstTokenAt = now();
            if (parsed.completionTokens === undefined) tokensWritten += 1;
            yield { type: "token", text: parsed.text };
          }
        }
      } finally {
        reader.releaseLock();
      }

      // A thinking model can spend the whole budget before it answers; that is
      // not an empty answer, and saying so names the fix.
      if (!answered && thought) {
        throw new ProviderResponseError(
          provider.endpoint,
          finish === "length"
            ? `only thinking: it spent all ${tokensWritten} tokens of its budget thinking and never answered (set "thinking": false for this provider)`
            : `only thinking and no answer (set "thinking": false for this provider)`,
        );
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

  /**
   * One forced tool call, unstreamed.
   *
   * Unstreamed because a tool call has nothing to show as it arrives — the
   * argument is only usable once its JSON closes — and because tool-call deltas
   * are the least uniform part of the OpenAI streaming shape across servers.
   * The cost is that the whole generation has to land inside the first-byte
   * budget, so a long replacement wants a raised `timeoutMs`; the budget below
   * is the same one `complete` uses, stretched by the measured prefill rate.
   *
   * Nothing here is recorded into the rate meter: an unstreamed answer cannot
   * separate prefill from generation, and feeding it in would poison both rates.
   */
  async function callTool(
    tool: { readonly function: { readonly name: string } },
    prompt: string,
    request: {
      readonly model?: string;
      readonly maxTokens?: number;
      readonly temperature?: number;
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<Record<string, unknown>> {
    const release = await options.gate?.acquire();
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });
    const started = now();

    try {
      const idleMs = request.timeoutMs ?? provider.timeoutMs;
      const prefillMs = meter.estimatePrefillMs(Math.ceil(prompt.length / CHARS_PER_TOKEN)) ?? 0;
      const budgetMs = Math.max(idleMs, prefillMs * 2);

      const response = await waitFor(
        doFetch(url, {
          method: "POST",
          headers: headers(options.key?.()),
          body: JSON.stringify({
            model: request.model ?? provider.model,
            messages: [{ role: "user", content: prompt }],
            tools: [tool],
            // Forced rather than "auto": the caller has already decided this is
            // the tool path, and mlx_lm honours the forced form.
            tool_choice: { type: "function", function: { name: tool.function.name } },
            ...thinkingField(provider),
            ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          }),
          signal: controller.signal,
        }),
        budgetMs,
        () => {
          controller.abort();
          throw new EndpointHung(provider.endpoint, now() - started, budgetMs);
        },
      );

      if (!response.ok) {
        throw new ProviderResponseError(provider.endpoint, truncate(await response.text()), response.status);
      }
      const payload = await waitFor(response.text(), budgetMs, () => {
        controller.abort();
        throw new EndpointHung(provider.endpoint, now() - started, budgetMs);
      });
      return toolArguments(provider.endpoint, tool.function.name, payload);
    } finally {
      request.signal?.removeEventListener("abort", abort);
      release?.();
    }
  }

  async function extractWithAnchors(request: ExtractRequest): Promise<readonly ExtractedFact[]> {
    const args = await callTool(EXTRACT_FACTS_TOOL, factsPrompt(request), {
      model: request.model,
      maxTokens: request.maxTokens,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
    return readFacts(provider.endpoint, args);
  }

  return {
    id: provider.id,
    model: provider.model,
    preferredOutput: PREFERRED_OUTPUT,
    complete,

    async proposeEdit(request: EditRequest): Promise<Proposal> {
      const passage = selectionText(request.document, request.span);
      const wanted = request.variants ?? 1;
      if (!Number.isInteger(wanted) || wanted < 1) {
        throw new RangeError(`pablo: asked for ${request.variants} variants; ask for at least one`);
      }

      const mode = request.output ?? PREFERRED_OUTPUT;
      const prompt = mode === "tool" ? toolEditPrompt(passage, request) : criticMarkupPrompt(passage, request);

      const oneVariant = async (): Promise<string> => {
        const replacement =
          mode === "tool"
            ? readReplacement(
                provider.endpoint,
                await callTool(PROPOSE_EDIT_TOOL, prompt, {
                  model: request.model,
                  maxTokens: request.maxTokens,
                  temperature: request.temperature,
                  timeoutMs: request.timeoutMs,
                  signal: request.signal,
                }),
              )
            : replacementFromMarkup(
                provider.endpoint,
                await collect({
                  prompt,
                  model: request.model,
                  maxTokens: request.maxTokens,
                  temperature: request.temperature,
                  timeoutMs: request.timeoutMs,
                  signal: request.signal,
                }),
              );
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
      if ((request.output ?? PREFERRED_OUTPUT) === "tool") {
        return (await extractWithAnchors(request)).map((fact) => fact.fact);
      }
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

    extractFactsWithAnchors: extractWithAnchors,
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
    ...thinkingField(provider),
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
  };
}

/**
 * The chat-template switch for a model that thinks before it answers (Gemma 4,
 * Qwen3). Sent only when thinking is off, which a local endpoint is unless its
 * config says otherwise; a hosted OpenAI endpoint gets nothing, because it
 * rejects arguments it does not know. A template with no such switch ignores it.
 */
function thinkingField(provider: ProviderConfig): Record<string, unknown> {
  const off = provider.thinking === false || (provider.thinking === undefined && provider.local);
  return off ? { chat_template_kwargs: { enable_thinking: false } } : {};
}

/**
 * The tool path's prompt. It has to ask for the call rather than for the prose:
 * a prompt that says "write the replacement and nothing else" gets prose even
 * with `tool_choice` forced, because mlx_lm's forced choice templates the tools
 * in without constraining decoding. Measured on 2026-09-02; the same prompt
 * asking for the call returns one every time.
 */
function toolEditPrompt(passage: string, request: EditRequest): string {
  const context = request.context?.trim();
  return [
    ...(context ? [context] : []),
    "# The passage",
    passage,
    "# What to do to it",
    request.instruction,
    TOOL_EDIT_CLOSING,
  ].join("\n\n");
}

/**
 * The CriticMarkup-as-text path's prompt. It names the three change forms and
 * the whole-passage substitution explicitly, because the one thing a small
 * model gets wrong is the delimiter, not the prose.
 */
function criticMarkupPrompt(passage: string, request: EditRequest): string {
  const context = request.context?.trim();
  return [
    ...(context ? [context] : []),
    "# The passage",
    passage,
    "# What to do to it",
    request.instruction,
    CRITICMARKUP_EDIT_CLOSING,
  ].join("\n\n");
}

/**
 * The CriticMarkup answer, normalized into the replacement the app would write.
 *
 * `validateProposal` runs on the raw answer first and on purpose: `parse` is
 * permissive by design and never throws, so a mangled answer would otherwise be
 * silently swallowed and land in the manuscript as prose. Only once the answer
 * conforms is every mark accepted, which is exactly what the author accepting
 * the proposal would produce.
 */
function replacementFromMarkup(endpoint: string, answer: string): string {
  const result = validateProposal(answer);
  if (!result.ok) {
    const detail = result.violations
      .slice(0, 3)
      .map((violation) => `${violation.message} (at ${violation.position})`)
      .join("; ");
    throw new ProviderResponseError(endpoint, `CriticMarkup that does not conform: ${detail}`);
  }
  return resolveAll({ path: endpoint, text: answer }, "accept").text.trim();
}

/** The writing-lab extraction prompt, minus its "output ONLY JSON" half: the tool carries the schema. */
function factsPrompt(request: ExtractRequest): string {
  const context = request.context?.trim();
  return [
    ...(context ? [context] : []),
    "You are extracting story facts from a passage of a novel for a continuity map.",
    "# The passage",
    request.text,
    "# What to pull out of it",
    request.instruction,
    "Call extract_facts once with every fact a later chapter could contradict: names, roles," +
      " relationships, objects, places, times, what characters know, and what was said aloud." +
      " Each fact's anchor must be copied character for character from the passage above.",
  ].join("\n\n");
}

/** The tool call's arguments, or a named error. Model output is untrusted input throughout. */
function toolArguments(endpoint: string, expected: string, payload: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new ProviderResponseError(endpoint, `a response that is not JSON: ${truncate(payload)}`);
  }
  const choice = (
    parsed as {
      choices?: {
        finish_reason?: unknown;
        message?: { content?: unknown; tool_calls?: { function?: { name?: unknown; arguments?: unknown } }[] };
      }[];
    }
  ).choices?.[0];
  const call = choice?.message;

  const tool = call?.tool_calls?.[0]?.function;
  if (tool === undefined) {
    const said = typeof call?.content === "string" && call.content.trim() !== "" ? truncate(call.content) : "";
    const finish = typeof choice?.finish_reason === "string" ? choice.finish_reason : "none";
    throw new NoToolCallError(endpoint, expected, finish, said);
  }
  if (typeof tool.name === "string" && tool.name !== expected) {
    throw new ProviderResponseError(endpoint, `a call to ${truncate(tool.name)} rather than ${expected}`);
  }
  if (typeof tool.arguments !== "string") {
    throw new ProviderResponseError(endpoint, `a ${expected} call whose arguments are not a JSON string`);
  }
  let args: unknown;
  try {
    args = JSON.parse(tool.arguments);
  } catch {
    throw new ProviderResponseError(
      endpoint,
      `a ${expected} call whose arguments are not valid JSON: ${truncate(tool.arguments)}`,
    );
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new ProviderResponseError(endpoint, `a ${expected} call whose arguments are not an object`);
  }
  return args as Record<string, unknown>;
}

function readReplacement(endpoint: string, args: Record<string, unknown>): string {
  const replacement = args["replacement"];
  if (typeof replacement !== "string") {
    throw new ProviderResponseError(endpoint, "a propose_edit call with no replacement string");
  }
  return replacement.trim();
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
  /** Whether the chunk carried thinking (mlx_lm `reasoning`, others `reasoning_content`). */
  readonly reasoning: boolean;
  readonly finish: string | undefined;
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
    choices?: { delta?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown }; finish_reason?: unknown }[];
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  };
  const choice = chunk.choices?.[0];
  const content = choice?.delta?.content;
  const reasoning = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content;
  return {
    text: typeof content === "string" ? content : undefined,
    reasoning: typeof reasoning === "string" && reasoning !== "",
    finish: typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined,
    promptTokens: countOf(chunk.usage?.prompt_tokens),
    completionTokens: countOf(chunk.usage?.completion_tokens),
  };
}
