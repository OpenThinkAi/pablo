/**
 * The Anthropic adapter: `POST {endpoint}/messages` with `stream: true`,
 * written from the current Messages API reference (the `claude-api` skill,
 * read 2026-09-02) rather than from memory.
 *
 * Anthropic is its own API, not an OpenAI-compatible one: the key goes in
 * `x-api-key` with an `anthropic-version` header, `max_tokens` is required,
 * the stream is typed SSE events rather than `[DONE]`-terminated chunks, and a
 * tool call arrives as a `tool_use` content block whose arguments are streamed
 * as `input_json_delta` fragments. All of that stops at this module boundary —
 * above it there is only `Proposal`.
 *
 * **The model has no write tool.** The two tools defined here (`propose_edit`,
 * `extract_facts`) return text to the app; neither can touch a file, and the
 * system prompt says so.
 *
 * Both structured paths the design doc requires are here, and which one a
 * request takes is `EditRequest.output`, defaulting to `PREFERRED_OUTPUT`
 * below: a native tool call, or CriticMarkup in the body checked by
 * `validateProposal`. Unlike the OpenAI-compatible adapter, the tool path here
 * is **streamed** — Anthropic's `input_json_delta` framing is specified, where
 * OpenAI-compatible tool-call deltas differ server to server — so a tool call
 * shows progress and is measured like any other completion.
 *
 * Deliberate omissions, each of them a property of the current API rather than
 * a preference:
 *
 * - **No server-side refusal `fallbacks`.** A rescue by a second model would
 *   make `Proposal.model` a lie about the text the author is looking at. A
 *   refusal is surfaced as a named error instead.
 * - **No `thinking` parameter.** Omitting it runs adaptive thinking on the
 *   default model (Claude Opus 5, where thinking is on by default) and is
 *   valid on every older model too, so a configured model never 400s on it.
 * - **No sampling parameters.** `temperature`, `top_p` and `top_k` were removed
 *   from every current Claude model and return a 400; adaptive thinking and
 *   effort replaced them. `EditRequest.temperature` is therefore accepted by
 *   the interface and ignored here rather than turned into a failed request —
 *   worth knowing when comparing a bench run against a local endpoint, which
 *   does honour it.
 */

import { selectionText } from "../document";
import { resolveAll } from "../markup/spans";
import { validateProposal } from "../markup/validate";
import { CRITICMARKUP_EDIT_CLOSING, TOOL_EDIT_CLOSING } from "../pack/closing";
import type { ProviderConfig } from "./config";
import { EndpointHung, ProviderConfigError, ProviderResponseError } from "./errors";
import { readFacts } from "./facts";
import { envVariableFor } from "./keys";
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

export interface AnthropicAdapterOptions {
  readonly provider: ProviderConfig;
  readonly meter: RateMeter;
  /** Present when the endpoint is local; an Anthropic endpoint never is. */
  readonly gate?: Gate;
  /** Resolved lazily so a Keychain read happens on first use, not at startup. */
  readonly key?: () => string | undefined;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** Pinned; the API is versioned by header, not by URL, and this is its current value. */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * `max_tokens` is required by the Messages API. The SDK guidance defaults a
 * streaming request to ~64k, which is sized for a whole document; pablo's unit
 * of work is one span, so the ceiling here is 16k — far above any replacement
 * and a bound on a runaway generation. A request may raise or lower it, and a
 * caller that lowers it should leave room: adaptive thinking spends this same
 * budget before a single word of the answer is written.
 */
const DEFAULT_MAX_TOKENS = 16_000;

/** Rough enough to size a timeout with; nothing downstream depends on it. */
const CHARS_PER_TOKEN = 4;

const PROPOSE_EDIT = "propose_edit";
const EXTRACT_FACTS = "extract_facts";

/**
 * The default structured path, measured by `bun run bench/bakeoff.ts --adapter
 * anthropic --max-tokens 8000` against Claude Opus 5 on 2026-09-02, over the
 * ten bench spans and both paths.
 *
 * **Conformance did not decide it: speed did.** Both paths passed 10 of 10,
 * including all three spans over 400 words, with no mangling class on either —
 * unlike the local writer, which loses a CriticMarkup delimiter past about 400
 * words. What separates them is that the tool call returns the replacement
 * alone where the text path re-emits the whole passage around it: 6.0s median
 * against 18.0s, 65s against 205s over the ten spans, and a 58.5s worst case on
 * the longest span. Three times the wall clock and three times the output
 * tokens for the same conformance is the whole argument.
 *
 * The text path is not deleted — it is the portable fallback, reachable with
 * `output: "text"`, and it is the path to reach for when an instruction
 * addresses only part of a span, because CriticMarkup makes the untouched text
 * part of the answer. The numbers are in `bench/README.md` and the design doc
 * under Proposal pipeline.
 */
export const PREFERRED_OUTPUT: OutputMode = "tool";

/**
 * pablo's standing instruction to the model. The invariant is stated because a
 * capable model with a tool schema will otherwise offer to save the file.
 */
const SYSTEM = [
  "You are the writing model behind pablo, a tool for revising prose one selected passage at a time.",
  "You cannot write files and you are never asked to: you return a proposal, and the application applies it after the author accepts it.",
  "Answer with the requested structure and nothing else — no preamble, no explanation, no commentary on what you changed.",
].join(" ");

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly strict?: true;
  readonly input_schema: Record<string, unknown>;
}

/**
 * One replacement per call, the same argument name the OpenAI-compatible
 * adapter uses, so the bench decodes both without knowing which it is talking
 * to. `strict: true` is safe here because the schema is one required string:
 * strict demands `additionalProperties: false` and every property required,
 * which the facts schema below cannot satisfy without forcing the model to
 * invent a story time it was never given.
 */
const PROPOSE_EDIT_TOOL: ToolDefinition = {
  name: PROPOSE_EDIT,
  description: "Propose a replacement for the selected passage. The app applies it; you never write to a file.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      replacement: {
        type: "string",
        description:
          "The complete replacement text for the passage, verbatim, with no surrounding quotes and no commentary.",
      },
    },
    required: ["replacement"],
    additionalProperties: false,
  },
};

/** The tool form of the writing-lab extraction prompt: one fact per item, each with its anchor. */
const EXTRACT_FACTS_TOOL: ToolDefinition = {
  name: EXTRACT_FACTS,
  description: "Record every fact in the passage that a later chapter could contradict.",
  input_schema: {
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
              description:
                "An absolute date if the passage states one, else a relative story time like 'day 1, dawn'.",
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
};

export function createAnthropicAdapter(options: AnthropicAdapterOptions): Adapter {
  const { provider, meter } = options;
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const url = `${provider.endpoint}/messages`;

  /**
   * AC4: one error, before anything is sent, naming both ways to supply a key.
   * The key itself is never logged, echoed, or put in an error message.
   */
  function apiKey(): string {
    const resolved = options.key?.();
    if (resolved === undefined || resolved === "") {
      throw new ProviderConfigError(
        `pablo: provider "${provider.id}" has no API key, so nothing was sent to ${provider.endpoint}. ` +
          `Either set ${envVariableFor(provider.id)} in the environment, or point its config entry at the ` +
          `Keychain: "key": "keychain:<service>[/<account>]".`,
      );
    }
    return resolved;
  }

  async function* send(request: WireRequest): AsyncIterable<WireEvent> {
    const key = apiKey();
    const release = await options.gate?.acquire();
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal?.addEventListener("abort", abort, { once: true });

    const started = now();
    let firstTokenAt: number | undefined;
    let tokensWritten = 0;
    let tokensRead: number | undefined;
    let stopReason: string | undefined;
    let refusal: string | undefined;

    try {
      const idleMs = request.timeoutMs ?? provider.timeoutMs;
      const prefillMs = meter.estimatePrefillMs(Math.ceil(request.prompt.length / CHARS_PER_TOKEN)) ?? 0;
      const firstByteMs = Math.max(idleMs, prefillMs * 2);

      const response = await waitFor(
        doFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": ANTHROPIC_VERSION,
          },
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
      const blocks = new Map<number, OpenBlock>();
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

          for (const frame of framed.events) {
            const payload = dataOf(frame);
            if (payload === undefined) continue;
            const event = parseEvent(provider.endpoint, payload);

            switch (event.type) {
              case "error":
                throw new ProviderResponseError(provider.endpoint, event.message);

              case "message_start":
                if (event.inputTokens !== undefined) tokensRead = event.inputTokens;
                if (event.outputTokens !== undefined) tokensWritten = event.outputTokens;
                break;

              case "block_start":
                blocks.set(event.index, { kind: event.kind, name: event.name, json: "" });
                break;

              case "text_delta":
                if (firstTokenAt === undefined) firstTokenAt = now();
                yield { type: "text", text: event.text };
                break;

              case "json_delta": {
                if (firstTokenAt === undefined) firstTokenAt = now();
                const block = blocks.get(event.index);
                if (block !== undefined) block.json += event.partial;
                break;
              }

              case "block_stop": {
                const block = blocks.get(event.index);
                blocks.delete(event.index);
                if (block?.kind !== "tool_use" || block.name === undefined) break;
                yield { type: "tool", name: block.name, input: parseToolInput(provider.endpoint, block) };
                break;
              }

              case "message_delta":
                if (event.outputTokens !== undefined) tokensWritten = event.outputTokens;
                if (event.stopReason !== undefined) stopReason = event.stopReason;
                if (event.refusal !== undefined) refusal = event.refusal;
                break;

              case "other":
                break;
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      // A refusal is an HTTP 200 with no usable content; it must not read as an empty answer.
      if (stopReason === "refusal") {
        throw new ProviderResponseError(
          provider.endpoint,
          `a refusal${refusal === undefined ? "" : ` (${refusal})`} rather than an answer — rephrase the instruction, or send this passage to another provider`,
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

  async function* complete(request: CompletionRequest): AsyncIterable<CompletionEvent> {
    for await (const event of send({ ...request, system: SYSTEM })) {
      if (event.type === "text") yield { type: "token", text: event.text };
      else if (event.type === "done") yield { type: "done", stats: event.stats };
    }
  }

  /**
   * Drains a stream that was asked for one named tool call, and returns its
   * arguments. Forced `tool_choice` makes the call mandatory, but the answer is
   * still model output: a wrong tool name, a non-object argument, and prose
   * instead of a call are all named errors rather than an empty proposal.
   */
  async function callTool(request: WireRequest, name: string): Promise<Record<string, unknown>> {
    let input: unknown;
    let called: string | undefined;
    let text = "";
    for await (const event of send(request)) {
      if (event.type === "tool" && input === undefined && called === undefined) {
        called = event.name;
        if (event.name === name) input = event.input;
      } else if (event.type === "text") text += event.text;
    }
    if (called !== undefined && called !== name) {
      throw new ProviderResponseError(provider.endpoint, `a call to ${truncate(called)} rather than ${name}`);
    }
    if (input === undefined) {
      throw new ProviderResponseError(
        provider.endpoint,
        `prose instead of a ${name} call${text.trim() === "" ? "" : `: ${truncate(text)}`}`,
      );
    }
    if (!isRecord(input)) {
      throw new ProviderResponseError(provider.endpoint, `a ${name} call whose arguments are not an object`);
    }
    return input;
  }

  async function collect(request: WireRequest): Promise<string> {
    let text = "";
    for await (const event of send(request)) {
      if (event.type === "text") text += event.text;
    }
    return text.trim();
  }

  /**
   * The portable path: the passage comes back marked up, the conformance gate
   * runs on the raw answer before anything parses it, and the replacement is
   * the text with every mark accepted. `parse` is permissive and never throws,
   * so without `validateProposal` first a mangled answer would land in the
   * manuscript as prose.
   */
  function replacementFromMarkup(answer: string): string {
    const result = validateProposal(answer);
    if (!result.ok) {
      const detail = result.violations
        .slice(0, 3)
        .map((violation) => `${violation.message} (at ${violation.position})`)
        .join("; ");
      throw new ProviderResponseError(provider.endpoint, `CriticMarkup that does not conform: ${detail}`);
    }
    return resolveAll({ path: provider.endpoint, text: answer }, "accept").text.trim();
  }

  async function extractWithAnchors(request: ExtractRequest): Promise<readonly ExtractedFact[]> {
    const args = await callTool(
      {
        prompt: factsPrompt(request),
        system: SYSTEM,
        model: request.model,
        maxTokens: request.maxTokens,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
        tools: [EXTRACT_FACTS_TOOL],
        toolChoice: { type: "tool", name: EXTRACT_FACTS },
      },
      EXTRACT_FACTS,
    );
    return readFacts(provider.endpoint, args);
  }

  return {
    id: provider.id,
    model: provider.model,
    preferredOutput: PREFERRED_OUTPUT,
    complete,

    async proposeEdit(request: EditRequest): Promise<Proposal> {
      // Throws before anything is sent when the span does not address the document.
      const passage = selectionText(request.document, request.span);
      const wanted = request.variants ?? 1;
      if (!Number.isInteger(wanted) || wanted < 1) {
        throw new RangeError(`pablo: asked for ${request.variants} variants; ask for at least one`);
      }

      const mode = request.output ?? PREFERRED_OUTPUT;
      const shared = {
        prompt: mode === "tool" ? toolEditPrompt(passage, request) : criticMarkupPrompt(passage, request),
        system: SYSTEM,
        model: request.model,
        maxTokens: request.maxTokens,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      } satisfies WireRequest;

      const oneVariant = async (): Promise<string> => {
        const replacement =
          mode === "tool"
            ? readReplacement(
                provider.endpoint,
                await callTool(
                  { ...shared, tools: [PROPOSE_EDIT_TOOL], toolChoice: { type: "tool", name: PROPOSE_EDIT } },
                  PROPOSE_EDIT,
                ),
              )
            : replacementFromMarkup(await collect(shared));
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
        system: SYSTEM,
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

interface OpenBlock {
  readonly kind: string;
  readonly name: string | undefined;
  json: string;
}

interface WireRequest extends CompletionRequest {
  readonly system?: string;
  readonly tools?: readonly ToolDefinition[];
  readonly toolChoice?: { readonly type: "tool"; readonly name: string };
}

type WireEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool"; readonly name: string; readonly input: unknown }
  | { readonly type: "done"; readonly stats: CompletionStats };

function body(provider: ProviderConfig, request: WireRequest): Record<string, unknown> {
  return {
    model: request.model ?? provider.model,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
    messages: [{ role: "user", content: request.prompt }],
    ...(request.system === undefined ? {} : { system: request.system }),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(request.toolChoice === undefined ? {} : { tool_choice: request.toolChoice }),
  };
}

/** The tool path's prompt. The closing line lives in the pack, which prices it. */
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

/** The CriticMarkup path's prompt, closing with the same pack-owned block the OpenAI adapter sends. */
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
    `Call ${EXTRACT_FACTS} once with every fact a later chapter could contradict: names, roles,` +
      " relationships, objects, places, times, what characters know, and what was said aloud." +
      " Each fact's anchor must be copied character for character from the passage above.",
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

/** Model output is untrusted input: the argument is checked before it is believed. */
function readReplacement(endpoint: string, args: Record<string, unknown>): string {
  const replacement = args["replacement"];
  if (typeof replacement !== "string") {
    throw new ProviderResponseError(endpoint, `a ${PROPOSE_EDIT} call with no replacement string`);
  }
  return replacement.trim();
}

type ParsedEvent =
  | { readonly type: "message_start"; readonly inputTokens?: number; readonly outputTokens?: number }
  | { readonly type: "block_start"; readonly index: number; readonly kind: string; readonly name: string | undefined }
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "json_delta"; readonly index: number; readonly partial: string }
  | { readonly type: "block_stop"; readonly index: number }
  | {
      readonly type: "message_delta";
      readonly outputTokens?: number;
      readonly stopReason?: string;
      readonly refusal?: string;
    }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "other" };

/** One SSE payload, checked field by field before any of it is believed. */
function parseEvent(endpoint: string, payload: string): ParsedEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new ProviderResponseError(endpoint, `a stream event that is not JSON: ${truncate(payload)}`);
  }
  if (!isRecord(parsed)) throw new ProviderResponseError(endpoint, `a stream event that is not an object`);

  const index = countOf(parsed["index"]) ?? 0;

  switch (parsed["type"]) {
    case "message_start": {
      const usage = isRecord(parsed["message"]) ? asUsage(parsed["message"]["usage"]) : {};
      return { type: "message_start", ...usage };
    }
    case "content_block_start": {
      const block = isRecord(parsed["content_block"]) ? parsed["content_block"] : {};
      return {
        type: "block_start",
        index,
        kind: typeof block["type"] === "string" ? block["type"] : "unknown",
        name: typeof block["name"] === "string" ? block["name"] : undefined,
      };
    }
    case "content_block_delta": {
      const delta = isRecord(parsed["delta"]) ? parsed["delta"] : {};
      if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
        return { type: "text_delta", text: delta["text"] };
      }
      if (delta["type"] === "input_json_delta" && typeof delta["partial_json"] === "string") {
        return { type: "json_delta", index, partial: delta["partial_json"] };
      }
      // thinking_delta and signature_delta are streamed and deliberately dropped:
      // pablo shows the proposal, not the reasoning that produced it.
      return { type: "other" };
    }
    case "content_block_stop":
      return { type: "block_stop", index };
    case "message_delta": {
      const delta = isRecord(parsed["delta"]) ? parsed["delta"] : {};
      const raw = delta["stop_details"] ?? parsed["stop_details"];
      const details = isRecord(raw) ? raw : undefined;
      return {
        type: "message_delta",
        ...asUsage(parsed["usage"]),
        ...(typeof delta["stop_reason"] === "string" ? { stopReason: delta["stop_reason"] } : {}),
        ...(typeof details?.["category"] === "string" ? { refusal: details["category"] } : {}),
      };
    }
    case "error": {
      const error = isRecord(parsed["error"]) ? parsed["error"] : {};
      const message = typeof error["message"] === "string" ? error["message"] : "an unnamed stream error";
      return { type: "error", message: truncate(message) };
    }
    default:
      return { type: "other" };
  }
}

function asUsage(value: unknown): { inputTokens?: number; outputTokens?: number } {
  if (!isRecord(value)) return {};
  const inputTokens = countOf(value["input_tokens"]);
  const outputTokens = countOf(value["output_tokens"]);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

function parseToolInput(endpoint: string, block: OpenBlock): unknown {
  if (block.json.trim() === "") return {};
  try {
    return JSON.parse(block.json);
  } catch {
    throw new ProviderResponseError(
      endpoint,
      `arguments for ${block.name ?? "a tool"} that are not JSON: ${truncate(block.json)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
