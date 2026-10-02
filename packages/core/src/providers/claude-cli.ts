/**
 * The planner's subscription path: `claude -p` on Matt's own Claude login.
 *
 * Copied from prview's `claude-env.ts` / `llm.ts` and cut down to one-shot text
 * (the planner never writes prose, so there is no proposal or fact extraction
 * here). The process is spawned through an injected `ClaudeRunner`, so every
 * test runs a fake and nothing in `bun test` ever starts a real `claude`.
 *
 * This is an `Adapter`, so `withReceipts` wraps it like any other provider and
 * a planner call lands in `receipts.jsonl` the same way a Gemma call does.
 */

import { tmpdir } from "node:os";
import { ProviderConfigError, ProviderResponseError } from "./errors";
import type { Adapter, CompletionEvent, CompletionRequest } from "./types";

export const CLAUDE_CLI_ID = "claude-cli";
export const DEFAULT_CLAUDE_TIMEOUT_MS = 600_000;

export type Env = Record<string, string | undefined>;

export interface ClaudeRun {
  readonly argv: readonly string[];
  /** The prompt. Goes on stdin, never argv, so it stays out of the process list. */
  readonly stdin: string;
  readonly env: Env;
  readonly cwd: string;
  readonly signal?: AbortSignal | undefined;
}

export interface ClaudeRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export type ClaudeRunner = (run: ClaudeRun) => Promise<ClaudeRunResult>;

/**
 * Credentials, providers and routing that outrank a `/login` session in
 * `claude -p` (see prview's claude-env.ts for the precedence list). The
 * subscription is the default, so these are removed: an `ANTHROPIC_API_KEY` in
 * the shell must not silently bill the API. `CLAUDE_CODE_OAUTH_TOKEN` stays; it
 * is a subscription token.
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

/** `base` without anything that would make `claude -p` bill an API key or another provider. */
export function subscriptionEnv(base: Env = process.env): Env {
  const out: Env = {};
  for (const [name, value] of Object.entries(base)) {
    if (!STRIP.has(name) && !STRIP_PATTERNS.some((pattern) => pattern.test(name))) out[name] = value;
  }
  return out;
}

/** The argv for `claude -p`: flags and the system prompt only. */
export function claudeArgs(model: string | undefined, system: string | undefined): string[] {
  // Not --bare (that skips the subscription login). Tools, MCP and skills off.
  const args = [
    "claude",
    "-p",
    "--tools",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--output-format",
    "json",
  ];
  if (system !== undefined) args.push("--system-prompt", system);
  if (model !== undefined) args.push("--model", model);
  return args;
}

/** The real runner: `Bun.spawn`, killed when the signal aborts. */
export const spawnClaude: ClaudeRunner = async (run) => {
  let process_: ReturnType<typeof Bun.spawn>;
  try {
    process_ = Bun.spawn([...run.argv], {
      stdin: Buffer.from(run.stdin),
      env: run.env,
      cwd: run.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new ProviderConfigError(
      `pablo: could not start \`claude\` (${(error as Error).message}). Install Claude Code and run \`claude\` once to log in, or put an Anthropic key in pablo's config.`,
    );
  }
  const kill = () => process_.kill();
  run.signal?.addEventListener("abort", kill, { once: true });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process_.stdout as ReadableStream).text(),
      new Response(process_.stderr as ReadableStream).text(),
      process_.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    run.signal?.removeEventListener("abort", kill);
  }
};

export interface ClaudeCliAdapterOptions {
  /** Concrete model id for `--model`; absent means claude's own default for the login. */
  readonly model?: string | undefined;
  /** The system prompt, passed as `--system-prompt`. */
  readonly system?: string | undefined;
  readonly runner?: ClaudeRunner | undefined;
  /** The environment the child starts from; the subscription filter is applied on top. */
  readonly env?: Env | undefined;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
}

interface ClaudeReply {
  readonly is_error?: unknown;
  readonly result?: unknown;
  readonly model?: unknown;
  readonly modelUsage?: unknown;
  readonly usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

/** The model id in a `claude -p --output-format json` reply: `model`, else the `modelUsage` key that wrote the most. */
export function claudeModelId(reply: ClaudeReply): string | undefined {
  if (typeof reply.model === "string" && reply.model !== "") return reply.model;
  const usage = reply.modelUsage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const entries = usage as Record<string, { outputTokens?: unknown } | undefined>;
  const written = (id: string): number => {
    const tokens = entries[id]?.outputTokens;
    return typeof tokens === "number" ? tokens : 0;
  };
  return Object.keys(entries).sort((a, b) => written(b) - written(a))[0];
}

const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** An `Adapter` whose `complete()` is one `claude -p` call; the proposal methods refuse, since the planner never edits prose. */
export function createClaudeCliAdapter(options: ClaudeCliAdapterOptions = {}): Adapter {
  const runner = options.runner ?? spawnClaude;
  const now = options.now ?? (() => Date.now());
  const configured = options.model;

  async function* complete(request: CompletionRequest): AsyncIterable<CompletionEvent> {
    const started = now();
    const model = request.model ?? configured;
    const timeout = AbortSignal.timeout(request.timeoutMs ?? options.timeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS);
    const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);

    let result: ClaudeRunResult;
    try {
      result = await runner({
        argv: claudeArgs(model, options.system),
        stdin: request.prompt,
        env: subscriptionEnv(options.env ?? process.env),
        cwd: options.cwd ?? tmpdir(),
        signal,
      });
    } catch (error) {
      if (signal.aborted && !(error instanceof ProviderConfigError)) {
        throw new ProviderResponseError(CLAUDE_CLI_ID, "no answer before the timeout");
      }
      throw error;
    }

    let reply: ClaudeReply;
    try {
      reply = JSON.parse(result.stdout) as ClaudeReply;
    } catch {
      const detail = (result.stdout || result.stderr).trim().slice(0, 300);
      throw new ProviderResponseError(CLAUDE_CLI_ID, `no JSON from \`claude -p\` (exit ${result.exitCode}): ${detail}`);
    }
    if (reply.is_error === true || result.exitCode !== 0) {
      throw new ProviderResponseError(CLAUDE_CLI_ID, `an error: ${String(reply.result ?? result.stderr).slice(0, 300)}`);
    }

    const text = typeof reply.result === "string" ? reply.result : "";
    if (text === "") throw new ProviderResponseError(CLAUDE_CLI_ID, "no content");

    const elapsedMs = now() - started;
    const tokensWritten = count(reply.usage?.output_tokens) ?? 0;
    const tokensRead = count(reply.usage?.input_tokens);
    yield { type: "token", text };
    yield {
      type: "done",
      stats: {
        // One reply, not a stream: the first token arrives with the last.
        timeToFirstTokenMs: elapsedMs,
        elapsedMs,
        tokensRead,
        tokensWritten,
        tokensPerSecond: elapsedMs > 0 ? (tokensWritten / elapsedMs) * 1000 : 0,
      },
    };
  }

  const refuse = (): never => {
    throw new ProviderConfigError("pablo: the planner talks; it never edits or extracts. Use the local writer for that.");
  };

  return {
    id: CLAUDE_CLI_ID,
    model: configured ?? "default",
    preferredOutput: "text",
    complete,
    proposeEdit: async () => refuse(),
    extractFacts: async () => refuse(),
  };
}
