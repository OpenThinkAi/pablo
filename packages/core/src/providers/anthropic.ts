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
 * Two structured-output paths, as the design doc requires, chosen with the
 * `output` option:
 *
 * - `tool-call` (default) — native tool use, normalized into `Proposal`.
 * - `criticmarkup` — the passage returned with CriticMarkup marks, put through
 *   `validateProposal` before it is parsed, then resolved to the replacement.
 *
 * Deliberate omissions, both to keep this adapter honest about what produced a
 * proposal and what a configured model will accept:
 *
 * - **No server-side refusal `fallbacks`.** A rescue by a second model would
 *   make `Proposal.model` a lie about the text the author is looking at. A
 *   refusal is surfaced as a named error instead.
 * - **No `thinking` parameter.** Omitting it runs adaptive thinking on the
 *   default model (Claude Opus 5, where thinking is on by default) and is
 *   valid on every older model too, so a configured model never 400s on it.
 * - **No `temperature` unless the caller asks for one.** Current models reject
 *   sampling parameters; passing one through only when it is requested keeps
 *   an older configured model usable without breaking the default.
 */

import { selectionText } from "../document";
import { resolveAll } from "../markup/spans";
import { validateProposal } from "../markup/validate";
import type { ProviderConfig } from "./config";
import { EndpointHung, ProviderConfigError, ProviderResponseError } from "./errors";
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
  ExtractRequest,
  Proposal,
} from "./types";

/** Which structured-output path `proposeEdit` and `extractFacts` take. */
export type AnthropicOutputPath = "tool-call" | "criticmarkup";

export interface AnthropicAdapterOptions {
  readonly provider: ProviderConfig;
  readonly meter: RateMeter;
  /** Present when the endpoint is local; an Anthropic endpoint never is. */
  readonly gate?: Gate;
  /** Resolved lazily so a Keychain read happens on first use, not at startup. */
  readonly key?: () => string | undefined;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Defaults to the native tool call; the bake-off builds one of each. */
  readonly output?: AnthropicOutputPath;
}

/** Pinned; the API is versioned by header, not by URL, and this is its current value. */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * `max_tokens` is required by the Messages API. The SDK guidance defaults a
 * streaming request to ~64k, which is sized for a whole document; pablo's unit
 * of work is one span, so the ceiling here is 16k — far above any replacement
 * and a bound on a runaway generation. A request may raise it.
 */
const DEFAULT_MAX_TOKENS = 16_000;

/** Rough enough to size a timeout with; nothing downstream depends on it. */
const CHARS_PER_TOKEN = 4;

const PROPOSE_EDIT = "propose_edit";
const EXTRACT_FACTS = "extract_facts";

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
  readonly strict: true;
  readonly input_schema: Record<string, unknown>;
}

/** A list of strings, and nothing else, is the whole surface of both tools. */
function listTool(name: string, description: string, field: string, item: string): ToolDefinition {
  return {
    name,
    description,
    strict: true,
    input_schema: {
      type: "object",
      properties: { [field]: { type: "array", items: { type: "string", description: item } } },
      required: [field],
      additionalProperties: false,
    },
  };
}

const PROPOSE_EDIT_TOOL = listTool(
  PROPOSE_EDIT,
  "Propose replacement text for the selected passage. One entry per replacement asked for; each entry is the complete replacement passage, ready to stand in the manuscript.",
  "variants",
  "A complete replacement for the passage.",
);

const EXTRACT_FACTS_TOOL = listTool(
  EXTRACT_FACTS,
  "Report the facts the passage states, for the continuity ledger. One entry per fact, in the order they appear.",
  "facts",
  "One fact, as a short statement.",
);

export function createAnthropicAdapter(options: AnthropicAdapterOptions): Adapter {
  const { provider, meter } = options;
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => Date.now());
  const output = options.output ?? "tool-call";
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

  /** Drains a stream that was asked for one named tool call, and returns its arguments. */
  async function callTool(request: WireRequest, name: string): Promise<unknown> {
    let input: unknown;
    let text = "";
    for await (const event of send(request)) {
      if (event.type === "tool" && event.name === name && input === undefined) input = event.input;
      else if (event.type === "text") text += event.text;
    }
    if (input === undefined) {
      throw new ProviderResponseError(
        provider.endpoint,
        `prose instead of a ${name} call${text.trim() === "" ? "" : `: ${truncate(text)}`}`,
      );
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

  return {
    id: provider.id,
    model: provider.model,
    // Provisional until `bench/bakeoff.ts --adapter anthropic` records a
    // measurement (AGT-1206 AC5); the e2e run used the tool path.
    preferredOutput: "tool",
    complete,

    async proposeEdit(request: EditRequest): Promise<Proposal> {
      // Throws before anything is sent when the span does not address the document.
      const passage = selectionText(request.document, request.span);
      const wanted = request.variants ?? 1;
      if (!Number.isInteger(wanted) || wanted < 1) {
        throw new RangeError(`pablo: asked for ${request.variants} variants; ask for at least one`);
      }

      const shared = {
        model: request.model,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      } satisfies Partial<WireRequest>;

      const variants =
        output === "tool-call"
          ? readStrings(
              provider.endpoint,
              await callTool(
                {
                  ...shared,
                  prompt: editPrompt(passage, request, wanted),
                  system: SYSTEM,
                  tools: [PROPOSE_EDIT_TOOL],
                  toolChoice: { type: "tool", name: PROPOSE_EDIT },
                },
                PROPOSE_EDIT,
              ),
              "variants",
              PROPOSE_EDIT,
              wanted,
            )
          : await markupVariants(passage, request, wanted, shared);

      return {
        span: request.span,
        variants,
        intent: request.intent,
        providerId: provider.id,
        model: request.model ?? provider.model,
      };
    },

    async extractFacts(request: ExtractRequest): Promise<readonly string[]> {
      const shared = {
        prompt: extractPrompt(request),
        system: SYSTEM,
        model: request.model,
        maxTokens: request.maxTokens,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      } satisfies Partial<WireRequest>;

      if (output === "tool-call") {
        const input = await callTool(
          { ...shared, tools: [EXTRACT_FACTS_TOOL], toolChoice: { type: "tool", name: EXTRACT_FACTS } },
          EXTRACT_FACTS,
        );
        return readStrings(provider.endpoint, input, "facts", EXTRACT_FACTS, 0);
      }

      const answer = await collect(shared);
      return answer
        .split("\n")
        .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
        .filter((line) => line !== "");
    },
  };

  /**
   * The portable path: the passage comes back marked up, the conformance gate
   * runs on the raw answer before anything parses it, and the replacement is
   * the text with every mark accepted.
   */
  async function markupVariants(
    passage: string,
    request: EditRequest,
    wanted: number,
    shared: Partial<WireRequest>,
  ): Promise<[string, ...string[]]> {
    const prompt = markupPrompt(passage, request);
    const produced: string[] = [];

    for (let index = 0; index < wanted; index += 1) {
      const raw = await collect({ ...shared, prompt, system: SYSTEM });
      const check = validateProposal(raw);
      if (!check.ok) {
        throw new ProviderResponseError(
          provider.endpoint,
          `CriticMarkup pablo cannot apply — ${check.violations
            .map((violation) => `${violation.message} (at ${violation.position})`)
            .join("; ")}`,
        );
      }
      const replacement = resolveAll({ path: request.document.path, text: raw }, "accept").text.trim();
      if (replacement === "") {
        throw new ProviderResponseError(provider.endpoint, "an empty replacement for the selected passage");
      }
      produced.push(replacement);
    }

    const [first, ...rest] = produced;
    if (first === undefined) throw new ProviderResponseError(provider.endpoint, "no replacement at all");
    return [first, ...rest];
  }
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
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(request.toolChoice === undefined ? {} : { tool_choice: request.toolChoice }),
  };
}

function editPrompt(passage: string, request: EditRequest, wanted: number): string {
  const context = request.context?.trim();
  return [
    ...(context ? [context] : []),
    "# The passage",
    passage,
    "# What to do to it",
    request.instruction,
    `Call ${PROPOSE_EDIT} with ${wanted === 1 ? "one replacement" : `${wanted} different replacements`} for the passage.`,
  ].join("\n\n");
}

function markupPrompt(passage: string, request: EditRequest): string {
  const context = request.context?.trim();
  return [
    ...(context ? [context] : []),
    "# The passage",
    passage,
    "# What to do to it",
    request.instruction,
    [
      "Return the passage with your changes marked in CriticMarkup, and nothing else:",
      "{~~old text~>new text~~} to replace, {++added text++} to add, {--removed text--} to remove.",
      "Leave every unchanged word exactly as it is, mark at least one change, and do not wrap the answer in a code fence.",
    ].join("\n"),
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
    `Call ${EXTRACT_FACTS} with one entry per fact, in the order they appear.`,
  ].join("\n\n");
}

/**
 * Normalizes a tool call's arguments into the internal shape. Model output is
 * untrusted input: the array, its elements, and the count are all checked.
 * `wanted` of 0 means "however many there are".
 */
function readStrings(
  endpoint: string,
  input: unknown,
  field: string,
  tool: string,
  wanted: number,
): [string, ...string[]] {
  const raw = isRecord(input) ? input[field] : undefined;
  if (!Array.isArray(raw)) {
    throw new ProviderResponseError(endpoint, `a ${tool} call with no "${field}" array`);
  }

  const values = raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value !== "");

  const [first, ...rest] = values;
  if (first === undefined) throw new ProviderResponseError(endpoint, `a ${tool} call with nothing in "${field}"`);
  if (wanted > 0 && values.length < wanted) {
    throw new ProviderResponseError(endpoint, `${values.length} entries in "${field}" where ${wanted} were asked for`);
  }
  return wanted > 0 ? [first, ...rest.slice(0, wanted - 1)] : [first, ...rest];
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
