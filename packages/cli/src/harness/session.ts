/**
 * A harness session (AGT-1552): one run of the Claude Agent SDK configured as
 * pablo, not as a coding agent (`pm project show ai-terminal --doc harness`,
 * "Runtime").
 *
 * `harnessOptions` is the whole configuration, built as data so a test can pin
 * it: pablo's system prompt in place of Claude Code's (role, the work's
 * judgement policy and its `QWEN.md` rules, `prompt.ts`), WebSearch and WebFetch
 * the only built-ins, pablo's tools attached in-process as the `pablo` MCP
 * server, no settings, CLAUDE.md, user MCP servers or plugins loaded from disk,
 * and `dontAsk` so a tool off the allowed list is refused rather than prompted
 * for (there is nobody to prompt in a headless run).
 *
 * `runHarness` sends one message through a `HarnessQuery`. The real one is the
 * SDK's `query`, imported lazily so the CLI does not load the SDK for every
 * verb; every test passes a fake, and nothing in `bun test` starts Claude.
 * The compose view (AGT-1566) and `ask_author` (AGT-1560) build on the same
 * two functions; a multi-turn session will pass an `AsyncIterable` prompt
 * through the same seam.
 */

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { McpToolSpec, VerbContext } from "../verbs";
import type { AskAuthor } from "./ask-author";
import type { HarnessAuth } from "./auth";
import { harnessSystemPrompt } from "./prompt";
import type { PromptWork } from "./prompt";
import { allowedTools, BUILTIN_TOOLS, harnessTools, PABLO_SERVER, pabloServer } from "./tools";

/** The SDK's `query`, narrowed to what the harness uses; a test fake implements this. */
export type HarnessQuery = (params: { readonly prompt: string; readonly options: Options }) => AsyncIterable<SDKMessage>;

/** The real session: the Agent SDK's `query`. */
export const sdkQuery: HarnessQuery = async function* (params) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  yield* query({ prompt: params.prompt, options: params.options });
};

export interface HarnessSpec {
  /** The work, with its policy and rules: `loadPromptWork` reads them. */
  readonly work: PromptWork;
  /** The work's directory; the session's cwd. */
  readonly projectPath: string;
  readonly auth: HarnessAuth;
  /** What pablo's tools resolve projects against (vault, env, progress sink). */
  readonly ctx: VerbContext;
  /** pablo's tools to attach; defaults to `harnessTools()`. */
  readonly tools?: readonly McpToolSpec[];
  /**
   * The front end's way to put a question to the author (AGT-1560). Present,
   * the session gets the `ask_author` tool; absent, it has none.
   */
  readonly ask?: AskAuthor;
}

export function harnessOptions(spec: HarnessSpec): Options {
  const tools = spec.tools ?? harnessTools(spec.ask);
  const options: Options = {
    systemPrompt: harnessSystemPrompt(spec.work),
    tools: [...BUILTIN_TOOLS],
    allowedTools: allowedTools(tools),
    permissionMode: "dontAsk",
    mcpServers: { [PABLO_SERVER]: { type: "sdk", name: PABLO_SERVER, instance: pabloServer(spec.ctx, tools) } },
    strictMcpConfig: true,
    settingSources: [],
    persistSession: false,
    cwd: spec.projectPath,
    env: spec.auth.env,
  };
  return spec.auth.model === undefined ? options : { ...options, model: spec.auth.model };
}

/** One message, one session: the SDK's message stream, as it arrives. */
export function runHarness(message: string, spec: HarnessSpec, query: HarnessQuery = sdkQuery): AsyncIterable<SDKMessage> {
  return query({ prompt: message, options: harnessOptions(spec) });
}
