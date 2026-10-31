/**
 * The `claude-code` provider kind (AGT-2281): Claude on the author's
 * subscription, one `claude -p` per turn, under pablo's own agent loop.
 *
 * This is not a return of the old `claude -p` planner path or the Agent SDK
 * (AGT-2128 removed both, D-12). pablo still runs its own loop; this adapter is
 * one more `chat()` behind it, like the OpenAI-compatible and Anthropic ones.
 * Each turn is a fresh `claude -p` process: the conversation so far is
 * serialised into the prompt (`serialiseConversation`), the system prompt goes
 * in a file (`--system-prompt-file`), and the single JSON reply
 * (`--output-format json`) becomes `text` and `done` events. Nothing is resumed
 * between turns (`--no-session-persistence`).
 *
 * **No Claude Code tool can touch the work.** The adapter declares no native
 * tools (`nativeTools: false`), so the agent loop lists pablo's tools in the
 * system prompt and reads each reply for a `{"tool", "arguments"}` call, which
 * it checks and runs itself. Claude Code's own tools are switched off several
 * ways at once (`CLAUDE_FLAGS`): `--tools ""` removes every built-in,
 * `--disallowedTools` denies each one by name as well, `--strict-mcp-config`
 * with an empty `--mcp-config` loads no MCP server, `--setting-sources ""` and
 * `--safe-mode` skip the author's settings, hooks, plugins, skills and
 * CLAUDE.md, `--disable-slash-commands` turns off skills and commands, and
 * `--permission-mode dontAsk` refuses anything that would still ask. The
 * process runs in a new empty temp directory, never the vault, and that
 * directory is removed after the turn.
 *
 * **The login, not a key.** The child's environment has `ANTHROPIC_API_KEY`,
 * `ANTHROPIC_AUTH_TOKEN` and the other variables that outrank a `/login`
 * session (a base URL, Bedrock/Vertex/Foundry switches) removed
 * (`subscriptionEnv`), so a key in the author's shell can never make this
 * provider bill the API. `CLAUDE_CODE_OAUTH_TOKEN` is kept: it is a
 * subscription token (`claude setup-token`). The turn costs nothing per
 * token (`billing: "subscription"`): receipts carry `cost_usd: 0` and the loop
 * never reads it as an unpriced model.
 *
 * The prompt goes on stdin, never argv: it is untrusted content (a manuscript,
 * a web page a tool fetched) and argv is visible in the process list.
 *
 * Failures are refusals, not crashes: no `claude` on PATH (or at `binary`) is
 * `ClaudeCodeMissingError`, a signed-out login is `ClaudeCodeSignedOutError`
 * naming `claude auth login`; both are `ProviderConfigError`s, which every verb
 * already turns into a refusal.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectionText } from "../document";
import { resolveAll } from "../markup/spans";
import { validateProposal } from "../markup/validate";
import { CRITICMARKUP_EDIT_CLOSING } from "../pack/closing";
import type { ProviderConfig } from "./config";
import { DEFAULT_CLAUDE_BINARY } from "./config";
import { ClaudeCodeMissingError, ClaudeCodeSignedOutError, EndpointHung, ProviderConfigError, ProviderResponseError } from "./errors";
import type { RateMeter } from "./rates";
import type {
  Adapter,
  ChatEvent,
  ChatMessage,
  ChatRequest,
  CompletionEvent,
  CompletionRequest,
  EditRequest,
  ExtractRequest,
  OutputMode,
  Proposal,
} from "./types";

export type Env = Record<string, string | undefined>;

/** The text path is the only one: there is no native tool call to carry a proposal. */
export const CLAUDE_CODE_PREFERRED_OUTPUT: OutputMode = "text";

export interface ClaudeRun {
  readonly argv: readonly string[];
  /** The prompt. On stdin, never argv. */
  readonly stdin: string;
  readonly env: Env;
  readonly cwd: string;
  readonly signal: AbortSignal;
}

export interface ClaudeRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Starts one `claude -p` and waits for it. The default spawns the real process; it is the only seam a test could swap. */
export type ClaudeRunner = (run: ClaudeRun) => Promise<ClaudeRunResult>;

export interface ClaudeCodeAdapterOptions {
  readonly provider: ProviderConfig;
  readonly meter?: RateMeter;
  /** The environment the child starts from (and where `binary` is looked up on PATH); the subscription filter is applied on top. Defaults to `process.env`. */
  readonly env?: Env;
  readonly runner?: ClaudeRunner;
  readonly now?: () => number;
}

/**
 * Credentials, providers and routing that outrank a `/login` session in
 * `claude -p`. Removed so the subscription is what pays: an `ANTHROPIC_API_KEY`
 * in the shell must not silently bill the API. `CLAUDE_CODE_OAUTH_TOKEN` stays.
 */
const STRIP = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "AWS_BEARER_TOKEN_BEDROCK",
]);
const STRIP_PATTERNS = [/^CLAUDE_CODE_USE_/, /^ANTHROPIC_(BEDROCK|VERTEX|FOUNDRY|AWS)_/, /^CLAUDE_CODE_SKIP_.*AUTH$/];

/** `base` without anything that would make `claude -p` bill an API key or another provider instead of the login. */
export function subscriptionEnv(base: Env = process.env): Env {
  const out: Env = {};
  for (const [name, value] of Object.entries(base)) {
    if (!STRIP.has(name) && !STRIP_PATTERNS.some((pattern) => pattern.test(name))) out[name] = value;
  }
  return out;
}

/**
 * Every built-in Claude Code tool by name, denied on top of `--tools ""` so a
 * version that ignored the empty list would still have none of them.
 */
export const CLAUDE_BUILT_IN_TOOLS: readonly string[] = [
  "Agent",
  "Task",
  "Bash",
  "BashOutput",
  "KillShell",
  "PowerShell",
  "Monitor",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "NotebookRead",
  "Glob",
  "Grep",
  "LS",
  "LSP",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Skill",
  "SlashCommand",
  "ToolSearch",
  "ExitPlanMode",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "SendMessage",
  "TaskStop",
  "Workflow",
];

/**
 * The flags after `-p` that make a turn a bare model call: JSON out, no tool,
 * no MCP server, none of the author's settings, hooks, plugins, skills or
 * CLAUDE.md, nothing saved. Checked against `claude --help` on Claude Code
 * 2.1.314 (and, with a local fake API, that the request it sends carries no
 * tools and only the system prompt pablo wrote).
 */
export const CLAUDE_FLAGS: readonly string[] = [
  "--output-format",
  "json",
  "--tools",
  "",
  "--disallowedTools",
  CLAUDE_BUILT_IN_TOOLS.join(","),
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--setting-sources",
  "",
  "--safe-mode",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--permission-mode",
  "dontAsk",
];

/** The whole argv for one turn. The system prompt is a file path; the prompt itself goes on stdin. */
export function claudeArgs(binary: string, model: string, systemPromptFile: string): string[] {
  return [binary, "-p", "--model", model, "--system-prompt-file", systemPromptFile, ...CLAUDE_FLAGS];
}

/** The system prompt `complete()`, `proposeEdit()` and `extractFacts()` send: no persona of Claude Code's, no tools. */
const PLAIN_SYSTEM = [
  "You are the writing model behind pablo. You have no tools and cannot read or write files.",
  "Answer the request directly with the requested text and nothing else: no preamble and no commentary.",
].join(" ");

/**
 * The conversation as one prompt. A single user message is sent as it is; a
 * longer history is laid out turn by turn, tool calls and their results
 * included, with the model asked to reply as the assistant to the last turn.
 */
export function serialiseConversation(messages: readonly ChatMessage[]): string {
  if (messages.length === 1 && messages[0]?.role === "user") return messages[0].content;
  const turns = messages.map((message) => {
    switch (message.role) {
      case "user":
        return `<turn role="user">\n${message.content}\n</turn>`;
      case "assistant": {
        const calls = message.toolCalls ?? [];
        // A text-protocol reply already carries its call as JSON; one with only native calls is shown in the same shape.
        const body =
          message.content.trim() !== "" || calls.length === 0
            ? message.content
            : calls.map((call) => `\`\`\`json\n${JSON.stringify({ tool: call.name, arguments: call.arguments })}\n\`\`\``).join("\n");
        return `<turn role="assistant">\n${body}\n</turn>`;
      }
      case "tool":
        return `<turn role="tool_result" call="${message.toolCallId}"${message.isError === true ? ' error="true"' : ""}>\n${message.content}\n</turn>`;
    }
  });
  return [
    "This is the conversation so far, oldest turn first. Each tool_result turn is the result of the tool call the assistant made just before it.",
    "Write the assistant's next reply to it, and only that reply: no turn markers.",
    "",
    ...turns,
  ].join("\n\n");
}

/** One `claude -p` reply in `--output-format json`. */
interface ClaudeReply {
  readonly type?: unknown;
  readonly subtype?: unknown;
  readonly is_error?: unknown;
  readonly result?: unknown;
  readonly api_error_status?: unknown;
  readonly usage?: {
    readonly input_tokens?: unknown;
    readonly output_tokens?: unknown;
    readonly cache_creation_input_tokens?: unknown;
    readonly cache_read_input_tokens?: unknown;
  };
}

const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** What `claude` says when the login is missing, expired or rejected. */
const SIGNED_OUT =
  /not logged in|please run \/login|run \/login|\/login\b|invalid api key|authentication[_ ]error|oauth token (?:has )?(?:expired|been revoked)|token (?:is )?(?:expired|revoked)|login (?:is )?required|unauthori[sz]ed|\b401\b/i;

/** `binary` as an executable path: a path is used as given, a bare name is looked up on the child's PATH. */
export function resolveBinary(binary: string, env: Env): string | undefined {
  if (binary.includes("/")) {
    try {
      return statSync(binary).isFile() ? binary : undefined;
    } catch {
      return undefined;
    }
  }
  return Bun.which(binary, { PATH: env["PATH"] ?? "" }) ?? undefined;
}

/** The real runner: `Bun.spawn`, killed when the signal aborts. */
export const spawnClaude: ClaudeRunner = async (run) => {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([...run.argv], {
      stdin: Buffer.from(run.stdin),
      env: run.env,
      cwd: run.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ClaudeCodeMissingError(run.argv[0] ?? DEFAULT_CLAUDE_BINARY);
    throw error;
  }
  const kill = () => child.kill();
  if (run.signal.aborted) kill();
  run.signal.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    run.signal.removeEventListener("abort", kill);
  }
};

interface TurnResult {
  readonly text: string;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly elapsedMs: number;
}

interface TurnRequest {
  readonly system: string;
  readonly prompt: string;
  readonly model?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions): Adapter {
  const { provider } = options;
  const runner = options.runner ?? spawnClaude;
  const now = options.now ?? (() => Date.now());
  const binary = provider.binary ?? DEFAULT_CLAUDE_BINARY;
  const where = provider.endpoint;

  /** `EndpointHung`, worded for a process rather than a server. */
  function hung(elapsedMs: number, timeoutMs: number): EndpointHung {
    const error = new EndpointHung(where, elapsedMs, timeoutMs);
    error.message =
      `pablo: \`claude -p\` gave no reply in ${Math.round(timeoutMs / 1000)}s (provider "${provider.id}"). Retry, or raise its "timeoutMs" ` +
      `(\`pablo config set providers.${provider.id}.timeoutMs <ms>\`).`;
    return error;
  }

  /** One `claude -p` process, start to finish, in its own empty directory. */
  async function turn(request: TurnRequest): Promise<TurnResult> {
    const env = subscriptionEnv(options.env ?? process.env);
    const executable = resolveBinary(binary, env);
    if (executable === undefined) throw new ClaudeCodeMissingError(binary, provider.id);
    const model = request.model ?? provider.model;
    if (model === "") {
      throw new ProviderConfigError(`pablo: provider "${provider.id}" has no "model" — run \`pablo config set providers.${provider.id}.model <model id>\``);
    }
    // A whole-turn timeout, never shorter than the provider's own: `claude -p` prints nothing until the reply is done, so a
    // caller's idle timeout (`config test` sends 20s) would cut off a turn that is only slow to start.
    const timeoutMs = Math.max(request.timeoutMs ?? 0, provider.timeoutMs);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);

    const dir = mkdtempSync(join(tmpdir(), "pablo-claude-"));
    const started = now();
    let result: ClaudeRunResult;
    try {
      const systemFile = join(dir, ".pablo-system-prompt.txt");
      writeFileSync(systemFile, request.system);
      result = await runner({ argv: claudeArgs(executable, model, systemFile), stdin: request.prompt, env, cwd: dir, signal });
    } catch (error) {
      if (request.signal?.aborted === true) throw request.signal.reason ?? error;
      if (timeout.aborted) throw hung(now() - started, timeoutMs);
      throw error;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (request.signal?.aborted === true) throw request.signal.reason;
    if (timeout.aborted) throw hung(now() - started, timeoutMs);

    let reply: ClaudeReply | undefined;
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) reply = parsed as ClaudeReply;
    } catch {
      reply = undefined;
    }
    const said = reply !== undefined && typeof reply.result === "string" ? reply.result : "";
    const failed = reply === undefined || reply.is_error === true || result.exitCode !== 0;
    if (failed) {
      const detail = oneLine(said || result.stderr || result.stdout) || `exit ${result.exitCode}`;
      const status = count(reply?.api_error_status);
      if (status === 401 || status === 403 || SIGNED_OUT.test(`${said}\n${result.stderr}`)) throw new ClaudeCodeSignedOutError(provider.id, detail);
      if (reply === undefined) throw new ProviderResponseError(where, `no JSON from \`claude -p\` (exit ${result.exitCode}): ${detail}`);
      throw new ProviderResponseError(where, `an error from \`claude -p\`: ${detail}`, status);
    }
    const usage = reply?.usage;
    const input = count(usage?.input_tokens);
    const cached = (count(usage?.cache_creation_input_tokens) ?? 0) + (count(usage?.cache_read_input_tokens) ?? 0);
    return {
      text: said,
      inputTokens: input === undefined ? undefined : input + cached,
      outputTokens: count(usage?.output_tokens),
      elapsedMs: now() - started,
    };
  }

  async function* complete(request: CompletionRequest): AsyncIterable<CompletionEvent> {
    const reply = await turn({ system: PLAIN_SYSTEM, prompt: request.prompt, model: request.model, timeoutMs: request.timeoutMs, signal: request.signal });
    if (reply.text === "") throw new ProviderResponseError(where, "no content");
    const written = reply.outputTokens ?? 0;
    const stats = {
      // One reply, not a stream: the first token arrives with the last.
      timeToFirstTokenMs: reply.elapsedMs,
      elapsedMs: reply.elapsedMs,
      tokensRead: reply.inputTokens,
      tokensWritten: written,
      tokensPerSecond: reply.elapsedMs > 0 ? (written * 1000) / reply.elapsedMs : 0,
    };
    options.meter?.record(stats);
    yield { type: "token", text: reply.text };
    yield { type: "done", stats };
  }

  async function* chat(request: ChatRequest): AsyncIterable<ChatEvent> {
    if (request.tools.length > 0) {
      throw new ProviderConfigError(
        `pablo: provider "${provider.id}" (kind "claude-code") takes no native tool calls; pablo's agent loop offers it tools through its text protocol. ` +
          `A caller that sends tools on the wire must check the adapter's nativeTools first.`,
      );
    }
    const reply = await turn({
      system: request.system,
      prompt: serialiseConversation(request.messages),
      model: request.model,
      timeoutMs: request.timeoutMs,
      signal: request.signal,
    });
    if (reply.text !== "") yield { type: "text", text: reply.text };
    yield { type: "done", usage: { inputTokens: reply.inputTokens, outputTokens: reply.outputTokens } };
  }

  return {
    id: provider.id,
    model: provider.model,
    preferredOutput: CLAUDE_CODE_PREFERRED_OUTPUT,
    nativeTools: false,
    billing: "subscription",
    complete,
    chat,

    // Text path only (CriticMarkup checked by `validateProposal`), whatever `output` asks for: there is no tool call to carry a proposal.
    async proposeEdit(request: EditRequest): Promise<Proposal> {
      const passage = selectionText(request.document, request.span);
      const wanted = request.variants ?? 1;
      if (!Number.isInteger(wanted) || wanted < 1) {
        throw new RangeError(`pablo: asked for ${request.variants} variants; ask for at least one`);
      }
      const context = request.context?.trim();
      const prompt = [...(context ? [context] : []), "# The passage", passage, "# What to do to it", request.instruction, CRITICMARKUP_EDIT_CLOSING].join("\n\n");
      const variants: string[] = [];
      for (let i = 0; i < wanted; i += 1) {
        const reply = await turn({ system: PLAIN_SYSTEM, prompt, model: request.model, timeoutMs: request.timeoutMs, signal: request.signal });
        const checked = validateProposal(reply.text);
        if (!checked.ok) {
          const detail = checked.violations
            .slice(0, 3)
            .map((violation) => `${violation.message} (at ${violation.position})`)
            .join("; ");
          throw new ProviderResponseError(where, `CriticMarkup that does not conform: ${detail}`);
        }
        const replacement = resolveAll({ path: where, text: reply.text }, "accept").text.trim();
        if (replacement === "") throw new ProviderResponseError(where, "an empty replacement for the selected passage");
        variants.push(replacement);
      }
      return {
        span: request.span,
        variants: variants as [string, ...string[]],
        intent: request.intent,
        providerId: provider.id,
        model: request.model ?? provider.model,
      };
    },

    async extractFacts(request: ExtractRequest): Promise<readonly string[]> {
      const context = request.context?.trim();
      const prompt = [
        ...(context ? [context] : []),
        "# The passage",
        request.text,
        "# What to pull out of it",
        request.instruction,
        "One per line, in the order they appear. No numbering, no bullets, no commentary.",
      ].join("\n\n");
      const reply = await turn({ system: PLAIN_SYSTEM, prompt, model: request.model, timeoutMs: request.timeoutMs, signal: request.signal });
      return reply.text
        .split("\n")
        .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
        .filter((line) => line !== "");
    },
  };
}
