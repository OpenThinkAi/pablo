/**
 * ask_author (AGT-1560). Every session is a fake `HarnessQuery`; nothing starts Claude.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runAgent } from "../src/harness/agent";
import type { AgentContext } from "../src/harness/agent";
import { askAuthorTool, formatQuestionCard, lineReader, stdinAskAuthor } from "../src/harness/ask-author";
import type { AuthorQuestion } from "../src/harness/ask-author";
import { harnessOptions } from "../src/harness/session";
import type { HarnessQuery } from "../src/harness/session";
import { harnessTools } from "../src/harness/tools";
import { harnessAuth } from "../src/harness/auth";
import { defaultConfig } from "@openthink/pablo-core";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pablo-ask-author-test-"));
const vault = join(root, "vault");
cpSync(FIXTURE_VAULT, vault, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const BASE_ENV = { PABLO_VAULT: vault, PATH: "/usr/bin:/bin", HOME: root, XDG_CONFIG_HOME: join(root, "config") };
const noConfig = () => undefined;
const ctx = { cwd: vault, env: BASE_ENV, stderr: { write: () => {} }, caller: "mcp" as const };

const q: AuthorQuestion = { question: "Does Cora leave?", options: ["She stays", "She leaves"], why: "A character's fate." };

async function* chunks(...parts: string[]): AsyncGenerator<string> {
  for (const part of parts) yield part;
}

test("the tool is only offered when a front end can ask", () => {
  expect(harnessTools().map((t) => t.name)).not.toContain("ask_author");
  expect(harnessTools(async () => "x").map((t) => t.name)).toContain("ask_author");

  const spec = {
    work: { title: "The Ice House", format: "novel", slug: "ice-house" },
    projectPath: join(vault, "novels", "ice-house"),
    auth: harnessAuth(defaultConfig(), BASE_ENV, { env: {} }),
    ctx,
  };
  expect(harnessOptions(spec).allowedTools).not.toContain("mcp__pablo__ask_author");
  expect(harnessOptions({ ...spec, ask: async () => "x" }).allowedTools).toContain("mcp__pablo__ask_author");
});

test("the tool blocks until the answer arrives and returns it", async () => {
  let release!: (answer: string) => void;
  let seen: AuthorQuestion | undefined;
  const tool = askAuthorTool(
    (question) =>
      new Promise((resolve) => {
        seen = question;
        release = resolve;
      }),
  );
  let settled = false;
  const pending = tool.run({ question: " Does Cora leave? ", options: ["She stays"], why: "Her fate." }, ctx).then((r) => {
    settled = true;
    return r;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(seen).toEqual({ question: "Does Cora leave?", options: ["She stays"], why: "Her fate." });

  release("  She stays  ");
  const result = await pending;
  expect(result.exitCode).toBe(0);
  expect(result.body).toMatchObject({ ok: true, answer: "She stays" });
  expect((result.body as { next: string }).next).toContain("record_fact");
});

test("a front end that cannot answer gives the model a refusal, not a crash", async () => {
  const tool = askAuthorTool(async () => {
    throw new Error("screen closed");
  });
  const result = await tool.run({ question: "Q?", why: "w" }, ctx);
  expect(result.exitCode).toBe(1);
  expect((result.body as { message: string }).message).toContain("screen closed");
  expect((await tool.run({ question: "  ", why: "w" }, ctx)).exitCode).toBe(2);
});

test("the question card lists the reason and the numbered options", () => {
  expect(formatQuestionCard(q)).toBe(
    ["? Does Cora leave?", "  why: A character's fate.", "  1. She stays", "  2. She leaves", "  answer (a number picks an option, or type your own):"].join("\n"),
  );
  expect(formatQuestionCard({ ...q, options: [] })).toContain("  answer:");
});

test("stdin answers: a number picks an option, text is taken as written, blanks are skipped", async () => {
  const out: string[] = [];
  const ask = stdinAskAuthor(lineReader(chunks("\n2\nfin", "ally\r\n")), { write: (t) => void out.push(t) });
  expect(await ask(q)).toBe("She leaves");
  expect(await ask(q)).toBe("finally");
  expect(out.join("")).toContain("? Does Cora leave?");
  await expect(ask(q)).rejects.toThrow("stdin closed");
});

// ---------------------------------------------------------------------------
// A headless session end to end: the fake model calls ask_author through the
// attached server and the answer comes from stdin.
// ---------------------------------------------------------------------------

function askingQuery(seen: { answer?: string }): HarnessQuery {
  return async function* (params: { prompt: string; options: Options }) {
    const instance = (params.options.mcpServers?.["pablo"] as { instance: McpServer }).instance;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await instance.connect(serverSide);
    const client = new Client({ name: "fake-sdk", version: "0.0.0" });
    await client.connect(clientSide);
    const called = await client.callTool({
      name: "ask_author",
      arguments: { question: q.question, options: [...q.options], why: q.why },
    });
    await client.close();
    seen.answer = (JSON.parse((called.content as { text: string }[])[0]!.text) as { answer: string }).answer;
    yield { type: "result", subtype: "success", is_error: false, result: "done", num_turns: 1, duration_ms: 1, total_cost_usd: 0 } as unknown as SDKMessage;
  };
}

function io(stdin?: AsyncIterable<string>): { ctx: AgentContext; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    ctx: { cwd: vault, env: BASE_ENV, stdout: { write: (t) => void (out += t) }, stderr: { write: (t) => void (err += t) }, ...(stdin ? { stdin } : {}) },
    out: () => out,
    err: () => err,
  };
}

test("pablo agent prints the card and resumes with the stdin answer", async () => {
  const seen: { answer?: string } = {};
  const run = io(chunks("1\n"));
  const code = await runAgent({ project: "ice-house", message: "Go", json: false }, run.ctx, { query: askingQuery(seen), readConfig: noConfig });
  expect(code).toBe(0);
  expect(seen.answer).toBe("She stays");
  expect(run.out()).toContain("? Does Cora leave?");
  expect(run.out()).toContain("  why: A character's fate.");
});

test("with --json the card goes to stderr and stdout stays one object", async () => {
  const seen: { answer?: string } = {};
  const run = io(chunks("She leaves\n"));
  const code = await runAgent({ project: "ice-house", message: "Go", json: true }, run.ctx, { query: askingQuery(seen), readConfig: noConfig });
  expect(code).toBe(0);
  expect(seen.answer).toBe("She leaves");
  expect(run.err()).toContain("? Does Cora leave?");
  expect(() => JSON.parse(run.out())).not.toThrow();
});

test("empty stdin: the tool refuses and the session carries on", async () => {
  const seen: { answer?: string } = {};
  const query: HarnessQuery = async function* (params) {
    const instance = (params.options.mcpServers?.["pablo"] as { instance: McpServer }).instance;
    const [c, s] = InMemoryTransport.createLinkedPair();
    await instance.connect(s);
    const client = new Client({ name: "fake-sdk", version: "0.0.0" });
    await client.connect(c);
    const called = await client.callTool({ name: "ask_author", arguments: { question: "Q?", why: "w" } });
    await client.close();
    seen.answer = (called.content as { text: string }[])[0]!.text;
    yield { type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, duration_ms: 1, total_cost_usd: 0 } as unknown as SDKMessage;
  };
  const run = io(chunks());
  expect(await runAgent({ project: "ice-house", message: "Go", json: false }, run.ctx, { query, readConfig: noConfig })).toBe(0);
  expect(seen.answer).toContain("stdin closed");
});
