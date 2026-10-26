/**
 * Saved harness sessions (AGT-1565, neutral JSONL since AGT-2122): the file
 * format, the index, resume across runs and providers, `--new`, and a legacy
 * SDK-format file left untouched. Sessions land under a temp copy of the
 * fixture vault, never ~/.cache/pablo or ~/.config/pablo; no real model runs.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScriptedChatAdapter } from "@openthink/pablo-core";
import { runAgent } from "../src/harness/agent";
import { adapterProvider } from "../src/harness/provider";
import { appendMessages, chooseSession, loadSession, readSessionIndex, sessionsDir, transcriptPath } from "../src/harness/sessions";
import { parseCliArgs } from "../src/cli";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pablo-sessions-test-"));
const vault = join(root, "vault");
cpSync(FIXTURE_VAULT, vault, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const work = join(vault, "novels", "ice-house");
const ENV = { PABLO_VAULT: vault, PATH: "/usr/bin:/bin", HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };

const quiet = { write: () => {} };
function run(message: string, model: ReturnType<typeof createScriptedChatAdapter>, extra: { new?: boolean; stderr?: string[] } = {}) {
  const stderr = { write: (text: string) => { extra.stderr?.push(text); } };
  const ctx = { cwd: vault, env: ENV, stdout: quiet, stderr };
  return runAgent({ project: "ice-house", message, json: false, new: extra.new ?? false }, ctx, { provider: adapterProvider(model), readConfig: () => undefined });
}

test("a run is saved as neutral JSONL and the next run resumes it", async () => {
  const first = createScriptedChatAdapter({ turns: [[{ type: "text", text: "one" }]] });
  expect(await run("Where are we?", first)).toBe(0);
  const index = readSessionIndex(work);
  expect(index.sessions).toHaveLength(1);
  const lines = readFileSync(transcriptPath(work, index.current!), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines[0]).toMatchObject({ pablo: "session", version: 1, id: index.current });
  expect(lines.slice(1)).toEqual([{ message: { role: "user", content: "Where are we?" } }, { message: { role: "assistant", content: "one" } }]);

  const stderr: string[] = [];
  const second = createScriptedChatAdapter({ turns: [[{ type: "text", text: "two" }]] });
  expect(await run("And next?", second, { stderr })).toBe(0);
  expect(second.requests[0]!.messages).toEqual([
    { role: "user", content: "Where are we?" },
    { role: "assistant", content: "one" },
    { role: "user", content: "And next?" },
  ]);
  expect(stderr.join("")).toContain("resuming session");
  expect(readSessionIndex(work).sessions).toHaveLength(1);
  const saved = loadSession(work, index.current!);
  expect(saved.kind === "ok" && saved.history.length).toBe(4);
});

test("tool turns are saved and replayed on any provider", async () => {
  const ghost = { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "nope", arguments: {} }] };
  const first = createScriptedChatAdapter({ turns: [[{ type: "tool_call", call: ghost.toolCalls[0]! }], [{ type: "text", text: "done" }]] });
  expect(await run("Try a tool", first, { new: true })).toBe(0);
  const id = readSessionIndex(work).current!;
  const saved = loadSession(work, id);
  expect(saved.kind === "ok" && saved.history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  const other = createScriptedChatAdapter({ turns: [[{ type: "text", text: "ok" }]] });
  expect(await run("Again", other)).toBe(0);
  expect(other.requests[0]!.messages).toHaveLength(5);
  expect(other.requests[0]!.messages[1]).toEqual(ghost);
});

test("--new starts a fresh session and leaves the old file", async () => {
  await run("hello", createScriptedChatAdapter({ turns: [[{ type: "text", text: "a" }]] }), { new: true });
  const old = readSessionIndex(work).current!;
  const model = createScriptedChatAdapter({ turns: [[{ type: "text", text: "b" }]] });
  expect(await run("fresh", model, { new: true })).toBe(0);
  expect(model.requests[0]!.messages).toEqual([{ role: "user", content: "fresh" }]);
  const index = readSessionIndex(work);
  expect(index.current).not.toBe(old);
  expect(index.sessions.map((s) => s.id)).toContain(old);
  expect(existsSync(transcriptPath(work, old))).toBe(true);
});

test("an old SDK-format session is reported as legacy and left untouched", async () => {
  const dir = mkdtempSync(join(root, "legacy-"));
  const id = "11111111-2222-3333-4444-555555555555";
  mkdirSync(sessionsDir(dir), { recursive: true });
  const legacyText = `${JSON.stringify({ type: "user", uuid: "1", message: "hi" })}\n${JSON.stringify({ type: "assistant", uuid: "2" })}\n`;
  writeFileSync(transcriptPath(dir, id), legacyText);
  writeFileSync(join(sessionsDir(dir), "index.json"), JSON.stringify({ current: id, sessions: [{ id, startedAt: "2026-01-01T00:00:00.000Z" }] }));
  expect(loadSession(dir, id).kind).toBe("legacy");
  const choice = chooseSession(dir, { fresh: false });
  expect(choice.legacy).toBe(id);
  expect(choice.id).not.toBe(id);
  expect(choice.history).toEqual([]);
  expect(readFileSync(transcriptPath(dir, id), "utf8")).toBe(legacyText);
  expect(readSessionIndex(dir).sessions.map((s) => s.id)).toEqual([id, choice.id]);
  expect(readdirSync(sessionsDir(dir)).sort()).toEqual([`${id}.jsonl`, "index.json"].sort());
});

test("pablo agent says so when the current session is legacy", async () => {
  const id = "99999999-2222-3333-4444-555555555555";
  mkdirSync(sessionsDir(work), { recursive: true });
  writeFileSync(transcriptPath(work, id), `${JSON.stringify({ type: "user", uuid: "1" })}\n`);
  writeFileSync(join(sessionsDir(work), "index.json"), JSON.stringify({ current: id, sessions: [{ id, startedAt: "2026-01-01T00:00:00.000Z" }] }));
  const stderr: string[] = [];
  const model = createScriptedChatAdapter({ turns: [[{ type: "text", text: "ok" }]] });
  expect(await run("hi", model, { stderr })).toBe(0);
  expect(stderr.join("")).toContain("legacy");
  expect(model.requests[0]!.messages).toEqual([{ role: "user", content: "hi" }]);
  expect(readFileSync(transcriptPath(work, id), "utf8")).toBe(`${JSON.stringify({ type: "user", uuid: "1" })}\n`);
});

test("a damaged current session is refused, not overwritten", async () => {
  const dir = mkdtempSync(join(root, "damaged-"));
  const first = chooseSession(dir, { fresh: false });
  appendMessages(dir, first.id, [{ role: "user", content: "a" }, { role: "assistant", content: "b" }]);
  const path = transcriptPath(dir, first.id);
  const good = readFileSync(path, "utf8");
  writeFileSync(path, good.replace('"a"', "oops"));
  expect(() => chooseSession(dir, { fresh: false })).toThrow("cannot be resumed");
  expect(readFileSync(path, "utf8")).toContain("oops");
  // A torn final line (a write cut short) is dropped, not fatal.
  writeFileSync(path, `${good}{"message":{"role":"us`);
  const resumed = chooseSession(dir, { fresh: false });
  expect(resumed.history).toHaveLength(2);
});

test("a current session with no transcript yet is started under its id, not resumed", () => {
  const dir = mkdtempSync(join(root, "w-"));
  const first = chooseSession(dir, { fresh: false });
  expect(first.resumed).toBe(false);
  const again = chooseSession(dir, { fresh: false });
  expect(again.id).toBe(first.id);
  expect(again.resumed).toBe(false);
  expect(readSessionIndex(dir).sessions).toHaveLength(1);
});

test("a session id cannot climb out of the directory", () => {
  expect(() => transcriptPath(root, "../escape")).toThrow("unsafe");
});

test("--new parses", () => {
  expect(parseCliArgs(["agent", "--project", "ice-house", "--new", "hi"]).new).toBe(true);
  expect(parseCliArgs(["agent", "--project", "ice-house", "hi"]).new).toBe(false);
});
