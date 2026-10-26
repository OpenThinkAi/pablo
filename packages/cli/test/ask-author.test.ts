/**
 * ask_author (AGT-1560). Every session is pablo's agent loop on a scripted model; nothing reaches a model.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScriptedChatAdapter } from "@openthink/pablo-core";
import type { ScriptedChatAdapter } from "@openthink/pablo-core";
import { runAgent } from "../src/harness/agent";
import type { AgentContext } from "../src/harness/agent";
import { askAuthorTool, formatQuestionCard, lineReader, stdinAskAuthor } from "../src/harness/ask-author";
import type { AuthorQuestion } from "../src/harness/ask-author";
import { adapterProvider } from "../src/harness/provider";
import { sessionToolList } from "../src/harness/session";
import { harnessTools } from "../src/harness/tools";

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
    provider: adapterProvider(createScriptedChatAdapter({ turns: [] })),
    ctx,
  };
  expect(sessionToolList(spec).map((t) => t.name)).not.toContain("ask_author");
  expect(sessionToolList({ ...spec, ask: async () => "x" }).map((t) => t.name)).toContain("ask_author");
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
// A headless session end to end: the scripted model calls ask_author through
// pablo's agent loop and the answer comes from stdin.
// ---------------------------------------------------------------------------

/** A model that asks one question, then answers; what the tool returned is the second request's last message. */
function askingModel(args: Record<string, unknown> = { question: q.question, options: [...q.options], why: q.why }): ScriptedChatAdapter {
  return createScriptedChatAdapter({
    turns: [[{ type: "tool_call", call: { id: "a1", name: "ask_author", arguments: args } }], [{ type: "text", text: "done" }]],
  });
}

const toolResult = (model: ScriptedChatAdapter): string => {
  const last = model.requests[1]!.messages.at(-1)!;
  return last.content;
};

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
  const model = askingModel();
  const run = io(chunks("1\n"));
  const code = await runAgent({ project: "ice-house", message: "Go", json: false }, run.ctx, { provider: adapterProvider(model), readConfig: noConfig });
  expect(code).toBe(0);
  expect(JSON.parse(toolResult(model))).toMatchObject({ answer: "She stays" });
  expect(run.out()).toContain("? Does Cora leave?");
  expect(run.out()).toContain("  why: A character's fate.");
});

test("with --json the card goes to stderr and stdout stays one object", async () => {
  const model = askingModel();
  const run = io(chunks("She leaves\n"));
  const code = await runAgent({ project: "ice-house", message: "Go", json: true }, run.ctx, { provider: adapterProvider(model), readConfig: noConfig });
  expect(code).toBe(0);
  expect(JSON.parse(toolResult(model))).toMatchObject({ answer: "She leaves" });
  expect(run.err()).toContain("? Does Cora leave?");
  expect(() => JSON.parse(run.out())).not.toThrow();
});

test("empty stdin: the tool refuses and the session carries on", async () => {
  const model = askingModel({ question: "Q?", why: "w" });
  const run = io(chunks());
  expect(await runAgent({ project: "ice-house", message: "Go", json: false }, run.ctx, { provider: adapterProvider(model), readConfig: noConfig })).toBe(0);
  expect(toolResult(model)).toContain("stdin closed");
});
