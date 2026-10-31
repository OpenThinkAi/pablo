/**
 * The `claude-code` provider kind (AGT-2281): config, routing, and the
 * adapter driving a fake `claude` on PATH (`fake-claude.ts`). Nothing here
 * starts the real `claude` or reaches a model.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  ClaudeCodeMissingError,
  ClaudeCodeSignedOutError,
  CLAUDE_BUILT_IN_TOOLS,
  costUsd,
  createClaudeCodeAdapter,
  createProviders,
  DEFAULT_CLAUDE_CODE_TIMEOUT_MS,
  mergeProjectConfig,
  parseConfig,
  ProviderConfigError,
  ProviderResponseError,
  serialiseConversation,
  subscriptionEnv,
  withReceipts,
} from "../src";
import type { Adapter, ChatEvent, ChatRequest, CompletionEvent, ProviderConfig, Receipt } from "../src";
import { makeFakeClaude, okReply } from "./fake-claude";

const CC = { kind: "claude-code", model: "claude-test-model" };

function provider(extra: Record<string, unknown> = {}): ProviderConfig {
  return parseConfig(JSON.stringify({ providers: { cc: { ...CC, ...extra } } })).providers.get("cc")!;
}

async function drain<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of events) out.push(event);
  return out;
}

const chatRequest = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  system: "pablo's system prompt",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
  ...over,
});

describe("config", () => {
  test("a claude-code entry needs only a model; binary, timeout, no key, no native tools", () => {
    const p = provider();
    expect(p.kind).toBe("claude-code");
    expect(p.model).toBe("claude-test-model");
    expect(p.binary).toBe("claude");
    expect(p.endpoint).toBe("claude-code:claude");
    expect(p.key).toEqual({ from: "none" });
    expect(p.local).toBe(false);
    expect(p.tools).toBe(false);
    expect(p.timeoutMs).toBe(DEFAULT_CLAUDE_CODE_TIMEOUT_MS);
    expect(provider({ binary: "/opt/claude/bin/claude", timeoutMs: 5000 })).toMatchObject({ binary: "/opt/claude/bin/claude", timeoutMs: 5000 });
  });

  test("it refuses endpoint, key, local and native tools, and needs a model", () => {
    expect(() => provider({ endpoint: "https://api.anthropic.com/v1" })).toThrow(/takes no "endpoint"/);
    expect(() => provider({ key: "env:ANTHROPIC_API_KEY" })).toThrow(/takes no "key"/);
    expect(() => provider({ local: true })).toThrow(/takes no "local"/);
    expect(() => provider({ tools: true })).toThrow(/no native tools/);
    expect(() => parseConfig(JSON.stringify({ providers: { cc: { kind: "claude-code" } } }))).toThrow(/"model" must be set/);
    // `config set` builds an entry a field at a time.
    expect(parseConfig(JSON.stringify({ providers: { cc: { kind: "claude-code" } } }), "x", { allowIncomplete: true }).providers.get("cc")?.model).toBe("");
  });

  test("binary belongs to claude-code only", () => {
    expect(() => parseConfig(JSON.stringify({ providers: { l: { endpoint: "http://127.0.0.1:1/v1", model: "m", binary: "x" } } }))).toThrow(
      /"binary" applies only to kind "claude-code"/,
    );
  });

  test("a work may change a claude-code provider's model, but not add one, set binary, or turn another into one", () => {
    const base = parseConfig(
      JSON.stringify({ providers: { cc: CC, local: { endpoint: "http://127.0.0.1:8002/v1", model: "m", local: true } } }),
    );
    const merged = mergeProjectConfig(base, JSON.stringify({ providers: { cc: { model: "other-model" } }, intents: { agent: "cc" } }));
    expect(merged.providers.get("cc")).toMatchObject({ kind: "claude-code", model: "other-model", binary: "claude" });
    expect(merged.intents.get("agent")).toBe("cc");

    expect(() => mergeProjectConfig(base, JSON.stringify({ providers: { cc: { binary: "/tmp/evil" } } }))).toThrow(/may not set "binary"/);
    expect(() => mergeProjectConfig(base, JSON.stringify({ providers: { mine: CC } }))).toThrow(/may add only a provider on this machine/);
    expect(() => mergeProjectConfig(base, JSON.stringify({ providers: { local: { kind: "claude-code" } } }))).toThrow(ProviderConfigError);
  });
});

describe("routing", () => {
  test("any intent can route to it, and it is never skipped for want of a key", () => {
    const config = parseConfig(
      JSON.stringify({
        providers: { local: { endpoint: "http://127.0.0.1:8002/v1", model: "m", local: true }, cc: CC },
        intents: { agent: "cc", draft: "cc" },
      }),
    );
    const skipped: unknown[] = [];
    const providers = createProviders(config, { keys: { env: {} }, onSkip: (s) => skipped.push(s) });
    expect(providers.route({ name: "agent", kind: "planning" })).toBe("cc");
    expect(providers.route({ name: "draft", kind: "drafting" })).toBe("cc");
    // Unmapped planning goes to the first non-local provider: the claude-code one, with no key.
    expect(providers.route({ name: "plan", kind: "planning" })).toBe("cc");
    expect(skipped).toEqual([]);
    const adapter = providers.adapter("cc");
    expect(adapter.nativeTools).toBe(false);
    expect(adapter.billing).toBe("subscription");
    expect(adapter.preferredOutput).toBe("text");
  });
});

describe("the adapter on a fake claude", () => {
  test("chat(): one claude -p with every tool off, the prompt on stdin, in an empty temp dir", async () => {
    const fake = makeFakeClaude();
    fake.reply(okReply("Hi there.", { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 4 }));
    const env = { ...fake.env, ANTHROPIC_API_KEY: "sk-ant-must-not-leak", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "oauth-sub", HOME: "/tmp" };
    const adapter = createClaudeCodeAdapter({ provider: provider(), env });
    const events = await drain(adapter.chat!(chatRequest({ messages: [{ role: "user", content: "the untrusted manuscript text" }] })));

    expect(events).toEqual([
      { type: "text", text: "Hi there." },
      { type: "done", usage: { inputTokens: 115, outputTokens: 4 } },
    ]);
    const [run] = fake.calls();
    expect(run).toBeDefined();
    const argv = run!.argv;
    expect(argv[0]).toBe("-p");
    const flag = (name: string) => argv[argv.indexOf(name) + 1];
    expect(flag("--model")).toBe("claude-test-model");
    expect(flag("--output-format")).toBe("json");
    expect(flag("--tools")).toBe("");
    expect(flag("--disallowedTools")?.split(",")).toEqual([...CLAUDE_BUILT_IN_TOOLS]);
    expect(flag("--disallowedTools")).toContain("Bash");
    expect(argv).toContain("--strict-mcp-config");
    expect(flag("--mcp-config")).toBe('{"mcpServers":{}}');
    expect(flag("--setting-sources")).toBe("");
    expect(argv).toContain("--safe-mode");
    expect(argv).toContain("--disable-slash-commands");
    expect(argv).toContain("--no-session-persistence");
    expect(flag("--permission-mode")).toBe("dontAsk");
    // The prompt is on stdin, never argv; the system prompt is a file.
    expect(run!.stdin).toBe("the untrusted manuscript text");
    expect(argv.join("\n")).not.toContain("untrusted manuscript");
    expect(run!.system).toBe("pablo's system prompt");
    // The login, not a key: API-key variables stripped, the subscription token kept.
    expect(run!.env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(run!.env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
    expect(run!.env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("oauth-sub");
    // A neutral, fresh directory, removed after the turn.
    expect(run!.cwd).toContain("pablo-claude-");
    expect(existsSync(run!.cwd)).toBe(false);
  });

  test("chat(): a longer conversation is serialised turn by turn, tool results included", async () => {
    const fake = makeFakeClaude();
    fake.reply(okReply("Done."));
    const adapter = createClaudeCodeAdapter({ provider: provider(), env: fake.env });
    await drain(
      adapter.chat!(
        chatRequest({
          messages: [
            { role: "user", content: "check the status" },
            { role: "assistant", content: '```json\n{"tool": "status", "arguments": {}}\n```', toolCalls: [{ id: "text-1-1", name: "status", arguments: {} }] },
            { role: "tool", toolCallId: "text-1-1", content: '{"stage":"bible"}' },
          ],
        }),
      ),
    );
    const stdin = fake.calls()[0]!.stdin;
    expect(stdin).toContain('<turn role="user">\ncheck the status\n</turn>');
    expect(stdin).toContain('{"tool": "status", "arguments": {}}');
    expect(stdin).toContain('<turn role="tool_result" call="text-1-1">\n{"stage":"bible"}\n</turn>');
    expect(stdin.indexOf("check the status")).toBeLessThan(stdin.indexOf('"stage"'));
  });

  test("serialiseConversation shows a native-only tool call as protocol JSON", () => {
    const text = serialiseConversation([
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "resume", arguments: { project: "w" } }] },
      { role: "tool", toolCallId: "a", content: "boom", isError: true },
    ]);
    expect(text).toContain('{"tool":"resume","arguments":{"project":"w"}}');
    expect(text).toContain('error="true"');
  });

  test("chat() refuses a turn that offers native tools, before starting claude", async () => {
    const fake = makeFakeClaude();
    const adapter = createClaudeCodeAdapter({ provider: provider(), env: fake.env });
    const tools = [{ name: "status", description: "s", parameters: { type: "object" } }];
    await expect(drain(adapter.chat!(chatRequest({ tools })))).rejects.toThrow(/takes no native tool calls/);
    expect(fake.calls()).toEqual([]);
  });

  test("complete(): the prompt in, one token and done out; the model can be overridden", async () => {
    const fake = makeFakeClaude();
    fake.reply(okReply("ok", { input_tokens: 7, output_tokens: 1 }));
    const adapter = createClaudeCodeAdapter({ provider: provider(), env: fake.env });
    const events = await drain<CompletionEvent>(adapter.complete({ prompt: "Reply with the single word: ok", model: "another-model", timeoutMs: 20_000 }));
    expect(events[0]).toEqual({ type: "token", text: "ok" });
    expect(events[1]?.type).toBe("done");
    const run = fake.calls()[0]!;
    expect(run.argv[run.argv.indexOf("--model") + 1]).toBe("another-model");
    expect(run.stdin).toBe("Reply with the single word: ok");
    expect(run.system).toContain("You have no tools");
  });

  test("a missing claude is a refusal naming the install and the binary field", async () => {
    const fake = makeFakeClaude();
    const adapter = createClaudeCodeAdapter({ provider: provider({ binary: "claude-not-installed" }), env: fake.env });
    const error = await drain(adapter.complete({ prompt: "x" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeCodeMissingError);
    expect(error).toBeInstanceOf(ProviderConfigError);
    expect((error as Error).message).toContain("claude-not-installed");
    expect((error as Error).message).toContain("providers.cc.binary");
    const atPath = createClaudeCodeAdapter({ provider: provider({ binary: "/nonexistent/claude" }), env: fake.env });
    await expect(drain(atPath.chat!(chatRequest()))).rejects.toBeInstanceOf(ClaudeCodeMissingError);
  });

  test("binary may be a path", async () => {
    const fake = makeFakeClaude("my-claude");
    const adapter = createClaudeCodeAdapter({ provider: provider({ binary: `${fake.bin}/my-claude` }), env: { ...fake.env, PATH: "/usr/bin:/bin" } });
    expect((await drain(adapter.chat!(chatRequest())))[0]).toEqual({ type: "text", text: "ok" });
  });

  test("a signed-out login is a refusal naming claude auth login", async () => {
    const fake = makeFakeClaude();
    const adapter = createClaudeCodeAdapter({ provider: provider(), env: fake.env });
    // What Claude Code 2.1.314 prints with no login.
    fake.reply({ type: "result", subtype: "success", is_error: true, api_error_status: null, result: "Not logged in · Please run /login" }, 1);
    const error = await drain(adapter.chat!(chatRequest())).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClaudeCodeSignedOutError);
    expect(error).toBeInstanceOf(ProviderConfigError);
    expect((error as Error).message).toContain("claude auth login");
    expect((error as Error).message).toContain("Not logged in");
    // A rejected credential reports HTTP 401.
    fake.reply({ type: "result", is_error: true, api_error_status: 401, result: "Invalid API key · Fix external API key" }, 1);
    await expect(drain(adapter.complete({ prompt: "x" }))).rejects.toBeInstanceOf(ClaudeCodeSignedOutError);
  });

  test("any other failure is a provider error with claude's words, not a crash", async () => {
    const fake = makeFakeClaude();
    const adapter = createClaudeCodeAdapter({ provider: provider(), env: fake.env });
    fake.reply({ type: "result", is_error: true, api_error_status: 429, result: "Claude AI usage limit reached" }, 1);
    const error = await drain(adapter.chat!(chatRequest())).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderResponseError);
    expect((error as Error).message).toContain("usage limit reached");
    fake.reply("this is not json", 2);
    await expect(drain(adapter.complete({ prompt: "x" }))).rejects.toThrow(/no JSON from `claude -p` \(exit 2\)/);
  });

  test("proposeEdit takes the CriticMarkup path", async () => {
    const fake = makeFakeClaude();
    fake.reply(okReply("{~~The cat sat.~>The cat lay down.~~}"));
    const adapter = createClaudeCodeAdapter({ provider: provider(), env: fake.env });
    const text = "The cat sat.";
    const proposal = await adapter.proposeEdit({
      intent: { name: "revise", kind: "revising" },
      instruction: "make it lie down",
      document: { path: "c.md", text },
      span: { start: 0, end: text.length },
    });
    expect(proposal.variants).toEqual(["The cat lay down."]);
    expect(fake.calls()[0]!.stdin).toContain("Answer with CriticMarkup");
  });
});

describe("usage", () => {
  test("receipts record the turn with cost 0 and billing subscription", async () => {
    const fake = makeFakeClaude();
    fake.reply(okReply("Hi.", { input_tokens: 1000, output_tokens: 1000 }));
    const receipts: Receipt[] = [];
    const inner = createClaudeCodeAdapter({ provider: provider({ model: "claude-opus-5-5" }), env: fake.env });
    // Even with a cost function that would price this model, a subscription turn costs 0.
    const wrapped: Adapter = withReceipts(inner, (r) => void receipts.push(r), { intent: "agent", cost: (u, m) => costUsd(u, m) });
    expect(wrapped.nativeTools).toBe(false);
    expect(wrapped.billing).toBe("subscription");
    await drain<ChatEvent>(wrapped.chat!(chatRequest()));
    await drain<CompletionEvent>(wrapped.complete({ prompt: "x" }));
    expect(receipts).toHaveLength(2);
    for (const receipt of receipts) {
      expect(receipt.billing).toBe("subscription");
      expect(receipt.cost_usd).toBe(0);
      expect(receipt.provider).toBe("cc");
    }
    expect(receipts[0]?.tokens_read).toBe(1000);
  });

  test("costUsd is 0 for a subscription whatever the model", () => {
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 0 }, "claude-opus-5-5", { subscription: true })).toBe(0);
    expect(costUsd({ inputTokens: 1_000_000, outputTokens: 0 }, "claude-opus-5-5")).toBe(4);
  });

  test("subscriptionEnv strips API-key and provider variables and keeps the OAuth token", () => {
    const env = subscriptionEnv({
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_AUTH_TOKEN: "t",
      ANTHROPIC_BASE_URL: "u",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_VERTEX_PROJECT_ID: "p",
      CLAUDE_CODE_OAUTH_TOKEN: "o",
      PATH: "/bin",
    });
    expect(env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "o", PATH: "/bin" });
  });
});
