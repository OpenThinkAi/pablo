/**
 * A harness session (AGT-1552, on pablo's own loop since AGT-2121, D-12): one
 * message through `runLoop` (`loop.ts`) configured as pablo, not as a coding
 * agent.
 *
 * `loopSpec` is the whole configuration, built as data so a test can pin it:
 * pablo's system prompt (role, the work's judgement policy and its `STYLE.md`
 * rules, `prompt.ts`), pablo's tools and nothing else (the loop has no
 * built-ins: no shell, no file read or write), and the provider the `agent`
 * intent routes to (`provider.ts`).
 *
 * `runHarness` sends one message through a `HarnessQuery`. The real one is
 * `runLoop`; a test passes a fake query, or keeps the real loop and gives the
 * spec a scripted adapter (core's `createScriptedChatAdapter`), so nothing in
 * `bun test` reaches a model. The compose view (AGT-1566) and `ask_author`
 * (AGT-1560) build on the same functions; a multi-message conversation passes
 * the previous message's returned history back in.
 */

import type { ChatMessage } from "@openthink/pablo-core";
import type { McpToolSpec, VerbContext } from "../verbs";
import type { AskAuthor } from "./ask-author";
import { runLoop } from "./loop";
import type { LoopSpec } from "./loop";
import { harnessSystemPrompt } from "./prompt";
import type { PromptWork } from "./prompt";
import type { HarnessProvider } from "./provider";
import { harnessTools } from "./tools";
import type { TranscriptEntry } from "./transcript";

/**
 * One message through a session: its transcript entries as they happen, and
 * the conversation after it (`void` when a fake keeps none). The real one is
 * `loopQuery`; a test fake implements this.
 */
export type HarnessQuery = (params: {
  readonly prompt: string;
  readonly spec: LoopSpec;
  readonly history: readonly ChatMessage[];
}) => AsyncGenerator<TranscriptEntry, readonly ChatMessage[] | void, undefined>;

/** The real session: pablo's agent loop. */
export const loopQuery: HarnessQuery = (params) => runLoop(params.prompt, params.spec, params.history);

export interface HarnessSpec {
  /** The work, with its policy and rules: `loadPromptWork` reads them. */
  readonly work: PromptWork;
  /** The provider the session runs on: `harnessProvider` routes the `agent` intent. */
  readonly provider: HarnessProvider;
  /** What pablo's tools resolve projects against (vault, env, progress sink). */
  readonly ctx: VerbContext;
  /** pablo's tools to offer; defaults to `harnessTools(ask)`. */
  readonly tools?: readonly McpToolSpec[];
  /**
   * The front end's way to put a question to the author (AGT-1560). Present,
   * the session gets the `ask_author` tool; absent, it has none.
   */
  readonly ask?: AskAuthor;
  /** Tools built for this session (plan-branch tools), offered after `tools`. */
  readonly sessionTools?: readonly McpToolSpec[];
  /** Where each turn's receipt is appended, and the intent it names (AGT-2191). */
  readonly receipts?: LoopSpec["receipts"];
}

/** The tools a session offers: `tools` (or every `pablo mcp` tool), then the session's own. */
export function sessionToolList(spec: HarnessSpec): readonly McpToolSpec[] {
  // A session tool replaces a same-named `pablo mcp` tool (`save_research`, `record_fact`, AGT-2106): the session's is
  // bound to its plan branch, the verb's starts a branch per call.
  const sessionTools = spec.sessionTools ?? [];
  const taken = new Set(sessionTools.map((tool) => tool.name));
  return [...(spec.tools ?? harnessTools(spec.ask)).filter((tool) => !taken.has(tool.name)), ...sessionTools];
}

export function loopSpec(spec: HarnessSpec): LoopSpec {
  return {
    adapter: spec.provider.adapter,
    system: harnessSystemPrompt(spec.work),
    tools: sessionToolList(spec),
    ctx: spec.ctx,
    local: spec.provider.local,
    credential: spec.provider.credential,
    forcedToolChoice: spec.provider.forcedToolChoice,
    ...(spec.receipts === undefined ? {} : { receipts: spec.receipts }),
  };
}

/** One message, one session (or the next message of one, given its `history`): the transcript, as it arrives. */
export function runHarness(
  message: string,
  spec: HarnessSpec,
  query: HarnessQuery = loopQuery,
  history: readonly ChatMessage[] = [],
): AsyncGenerator<TranscriptEntry, readonly ChatMessage[] | void, undefined> {
  return query({ prompt: message, spec: loopSpec(spec), history });
}
