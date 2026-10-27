/**
 * The compose view's session (AGT-1566, on pablo's agent loop since AGT-2121): `createComposer` over the real loop
 * and a scripted model, or a fake `HarnessQuery`. No test reaches a model or the network, reads the Keychain or the
 * real config file; the fixture vault is a temp copy.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScriptedChatAdapter } from "@openthink/pablo-core";
import type { ChatRequest, ScriptedTurn } from "@openthink/pablo-core";
import type { ComposeEvent } from "@openthink/pablo-tui";
import { composeSpec } from "../src/cli";
import { composeEvent, createComposer } from "../src/harness/compose";
import { adapterProvider } from "../src/harness/provider";
import { loopSpec } from "../src/harness/session";
import type { HarnessQuery, HarnessSpec } from "../src/harness/session";
import { harnessTools } from "../src/harness/tools";
import { writeLocalConfig } from "./local-config";




const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pablo-compose-test-"));
const vault = join(root, "vault");
cpSync(FIXTURE_VAULT, vault, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const BASE_ENV = { PABLO_VAULT: vault, PATH: "/usr/bin:/bin", HOME: root, XDG_CONFIG_HOME: join(root, "config") };
writeLocalConfig(join(root, "config"));
const ctx = { cwd: vault, env: BASE_ENV, stderr: { write: () => {} }, caller: "mcp" as const };

/** A spec on a scripted model; `tools` narrows what is offered (the default is every pablo tool). */
function scriptedSpec(turns: readonly ScriptedTurn[]) {
  const model = createScriptedChatAdapter({ turns });
  const spec = (): HarnessSpec => ({ work: { title: "The Ice House", format: "novel", slug: "ice-house" }, provider: adapterProvider(model), ctx });
  return { model, spec };
}

const text = (t: string) => ({ type: "text" as const, text: t });
const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "tool_call" as const, call: { id, name, arguments: args } });
const lastUser = (request: ChatRequest) => [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";

async function collect(stream: AsyncIterable<ComposeEvent>): Promise<ComposeEvent[]> {
  const out: ComposeEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

test("a turn streams a session id, pablo's text, the tool call by its plain name, its result, and ends at the result", async () => {
  const { spec } = scriptedSpec([
    (request) => [text(`heard ${lastUser(request)}`), call("t1", "status", { project: "ice-house" })],
    [text("The bible is in.")],
  ]);
  const composer = createComposer(spec);
  const events = await collect(composer.send("where are we?"));
  expect(events.map((e) => e.kind)).toEqual(["session", "assistant", "tool_call", "tool_result", "assistant", "result"]);
  expect(events[0]).toMatchObject({ kind: "session", id: expect.any(String) });
  expect(events[1]).toEqual({ kind: "assistant", text: "heard where are we?" });
  expect(events[2]).toEqual({ kind: "tool_call", id: "t1", tool: "status", input: { project: "ice-house" } });
  expect(JSON.parse((events[3] as Extract<ComposeEvent, { kind: "tool_result" }>).text)).toMatchObject({ core: { premise: true } });
  expect(events.at(-1)).toEqual({ kind: "result", ok: true, errors: [] });
  composer.close?.();
});

test("one conversation carries every message: the second send is given the first's history", async () => {
  const { model, spec } = scriptedSpec([[text("turn 1")], [text("turn 2")]]);
  const composer = createComposer(spec);
  await collect(composer.send("one"));
  const second = await collect(composer.send("two"));
  expect(second).toEqual([{ kind: "assistant", text: "turn 2" }, { kind: "result", ok: true, errors: [] }]); // the id is announced once
  expect(model.requests[1]!.messages).toEqual([
    { role: "user", content: "one" },
    { role: "assistant", content: "turn 1" },
    { role: "user", content: "two" },
  ]);
  composer.close?.();
});

test("the session is configured as pablo: pablo's system prompt and pablo's tools, plus ask_author, nothing else", async () => {
  const { model, spec } = scriptedSpec([[text("ok")]]);
  const composer = createComposer(spec);
  await collect(composer.send("hi"));
  const request = model.requests[0]!;
  expect(request.system).toStartWith("You are pablo");
  expect(request.tools.map((t) => t.name)).toEqual([...harnessTools().map((t) => t.name), "ask_author"]);
  composer.close?.();
});

test("a failed result carries the reasons; a session that throws is an error with the provider hint, and the next message starts afresh", async () => {
  let starts = 0;
  const query: HarnessQuery = async function* () {
    starts++;
    if (starts === 1) throw new Error("connection refused");
    yield { kind: "result", ok: false, text: "", turns: 1, durationMs: 1, costUsd: 0, errors: ["boom"] };
  };
  const { spec } = scriptedSpec([]);
  const composer = createComposer(spec, query);
  await expect(collect(composer.send("hi"))).rejects.toThrow(/pablo's session failed \(connection refused\)\. Check the "scripted" provider/);
  const again = await collect(composer.send("again"));
  expect(again[0]).toMatchObject({ kind: "session" });
  expect(again.at(-1)).toEqual({ kind: "result", ok: false, errors: ["boom"] });
  expect(starts).toBe(2);
});

test("a provider failure inside the loop is a failed result in the turn, not a throw", async () => {
  const { spec } = scriptedSpec([() => { throw new Error("endpoint hung"); }]);
  const composer = createComposer(spec);
  expect((await collect(composer.send("hi"))).at(-1)).toEqual({ kind: "result", ok: false, errors: ["endpoint hung"] });
});

test("a spec that cannot be built (no provider) surfaces as an error on the first message, not at construction", async () => {
  const composer = createComposer(() => { throw new Error("no key"); });
  await expect(collect(composer.send("hi"))).rejects.toThrow(/no key/);
});

test("composeEvent maps what the screen draws; the loop's own session entry is not one", () => {
  expect(composeEvent({ kind: "session", model: "m", apiKeySource: "none", tools: [] })).toBeUndefined();
  expect(composeEvent({ kind: "result", ok: true, text: "x", turns: 1, durationMs: 1, costUsd: 0, errors: [] })).toEqual({ kind: "result", ok: true, errors: [] });
});

test("ask_author in the compose session: the card reaches the screen mid-turn, the answer resumes the tool call", async () => {
  const { spec } = scriptedSpec([
    [call("t1", "ask_author", { question: "Does Cora know?", options: ["yes", "no"], why: "it changes chapter 4" })],
    [text("Noted.")],
  ]);
  const composer = createComposer(spec);
  const events: ComposeEvent[] = [];
  for await (const event of composer.send("plan chapter 4")) {
    events.push(event);
    if (event.kind === "question") {
      expect(event).toEqual({ kind: "question", id: "q1", question: "Does Cora know?", options: ["yes", "no"], why: "it changes chapter 4" });
      composer.answer?.(event.id, "2");
    }
  }
  expect(events.map((e) => e.kind)).toEqual(["session", "tool_call", "question", "tool_result", "assistant", "result"]);
  const answered = events.find((e) => e.kind === "tool_result") as Extract<ComposeEvent, { kind: "tool_result" }>;
  expect(JSON.parse(answered.text)).toMatchObject({ ok: true, answer: "no" });
  composer.close?.();
});

test("the screen's session is built like pablo agent's: the work's policy and QWEN.md reach the system prompt, and a refusal is an error", () => {
  const dir = join(vault, "novels", "ice-house");
  const plain = composeSpec(dir, vault, BASE_ENV);
  expect(plain.work).toMatchObject({ title: "The Ice House", format: "novel", slug: "ice-house" });
  expect(plain.work.rules).toBe(readFileSync(join(dir, "QWEN.md"), "utf8"));
  // The default config has only the local writer, so the agent intent routes there: no key, nothing billed.
  expect(plain.provider.adapter.id).toBe("local");
  expect(plain.provider).toMatchObject({ local: true, credential: "none" });

  const marker = join(dir, "pablo.json");
  const original = readFileSync(marker, "utf8");
  try {
    writeFileSync(marker, JSON.stringify({ ...JSON.parse(original), policy: "historical-fiction" }));
    const historical = composeSpec(dir, vault, BASE_ENV);
    expect(historical.work.policy?.name).toBe("historical-fiction");
    expect(loopSpec(historical).system).toContain(historical.work.policy!.text.trim().split("\n")[0]!);

    writeFileSync(marker, JSON.stringify({ ...JSON.parse(original), policy: "no-such-policy" }));
    expect(() => composeSpec(dir, vault, BASE_ENV)).toThrow(/does not ship/);
  } finally {
    writeFileSync(marker, original);
  }
  expect(() => composeSpec(join(vault, "novels", "no-marker"), vault, BASE_ENV)).toThrow();
});
