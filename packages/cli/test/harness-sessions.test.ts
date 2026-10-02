/**
 * Saved harness sessions (AGT-1565). A fake `HarnessQuery` stands in for the
 * SDK and plays its part in the store contract (mirrors entries in, loads on
 * resume); nothing starts Claude. Sessions land under a temp copy of the
 * fixture vault, never ~/.cache/pablo or ~/.config/pablo.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { runAgent } from "../src/harness/agent";
import type { AgentContext } from "../src/harness/agent";
import { chooseSession, fileSessionStore, readSessionIndex, sessionsDir } from "../src/harness/sessions";
import type { HarnessQuery } from "../src/harness/session";
import { parseCliArgs } from "../src/cli";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pablo-sessions-test-"));
const vault = join(root, "vault");
cpSync(FIXTURE_VAULT, vault, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const work = join(vault, "novels", "ice-house");
const ENV = { PABLO_VAULT: vault, PATH: "/usr/bin:/bin", HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };
const noConfig = () => undefined;

function io(): { ctx: AgentContext; err: () => string } {
  let err = "";
  return {
    ctx: { cwd: vault, env: ENV, stdout: { write: () => {} }, stderr: { write: (t) => void (err += t) } },
    err: () => err,
  };
}

let n = 0;

/** Plays the SDK's side of the store: loads on resume, mirrors the turn's entries in. */
function fakeSession(): { query: HarnessQuery; calls: Options[]; loaded: unknown[] } {
  const calls: Options[] = [];
  const loaded: unknown[] = [];
  const query: HarnessQuery = async function* (params) {
    const { options } = params;
    calls.push(options);
    const id = (options.resume ?? options.sessionId) as string;
    const key = { projectKey: "k", sessionId: id };
    if (options.resume !== undefined) loaded.push(await options.sessionStore!.load(key));
    n += 1;
    await options.sessionStore!.append(key, [
      { type: "user", uuid: `u${n}-${id}`, message: params.prompt },
      { type: "assistant", uuid: `a${n}-${id}`, message: "ok" },
    ]);
    yield { type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, duration_ms: 1, total_cost_usd: 0 } as unknown as SDKMessage;
  };
  return { query, calls, loaded };
}

const run = (message: string, query: HarnessQuery, fresh = false) =>
  runAgent({ project: "ice-house", message, json: false, new: fresh }, io().ctx, { query, readConfig: noConfig });

// ---------------------------------------------------------------------------
// AC 1: stored under the work's .pablo/ and resumed on the next open
// ---------------------------------------------------------------------------

test("the first open starts a session and stores it under the work's .pablo/sessions", async () => {
  const fake = fakeSession();
  expect(await run("Where are we?", fake.query)).toBe(0);

  const options = fake.calls[0]!;
  expect(options.resume).toBeUndefined();
  expect(options.persistSession).toBe(true);
  const index = readSessionIndex(work);
  expect(index.sessions).toHaveLength(1);
  expect(options.sessionId).toBe(index.current as string);
  expect(existsSync(join(sessionsDir(work), `${index.current}.jsonl`))).toBe(true);
  expect(sessionsDir(work)).toBe(join(work, ".pablo", "sessions"));
});

test("the next open resumes the same session with its stored conversation", async () => {
  const before = readSessionIndex(work).current as string;
  const fake = fakeSession();
  expect(await run("Continue.", fake.query)).toBe(0);

  expect(fake.calls[0]!.resume).toBe(before);
  expect(fake.calls[0]!.sessionId).toBeUndefined();
  expect((fake.loaded[0] as unknown[]).length).toBe(2);
  expect(readSessionIndex(work).sessions).toHaveLength(1);
  const lines = readFileSync(join(sessionsDir(work), `${before}.jsonl`), "utf8").trim().split("\n");
  expect(lines).toHaveLength(4);
});

// ---------------------------------------------------------------------------
// AC 2: --new starts a fresh session; the old one stays on disk
// ---------------------------------------------------------------------------

test("--new starts a fresh session and leaves the old one on disk", async () => {
  const old = readSessionIndex(work).current as string;
  const oldBytes = readFileSync(join(sessionsDir(work), `${old}.jsonl`), "utf8");
  const fake = fakeSession();
  expect(await run("Start over.", fake.query, true)).toBe(0);

  const index = readSessionIndex(work);
  expect(index.current).not.toBe(old);
  expect(index.sessions.map((s) => s.id)).toEqual([old, index.current as string]);
  expect(fake.calls[0]!.resume).toBeUndefined();
  expect(fake.calls[0]!.sessionId).toBe(index.current as string);
  expect(readFileSync(join(sessionsDir(work), `${old}.jsonl`), "utf8")).toBe(oldBytes);
  expect(readdirSync(sessionsDir(work)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(2);

  // And the open after that resumes the new one, not the old.
  const next = fakeSession();
  await run("More.", next.query);
  expect(next.calls[0]!.resume).toBe(index.current as string);
});

test("a current session with no transcript yet is started under its id, not resumed", () => {
  const dir = mkdtempSync(join(root, "w-"));
  const first = chooseSession(dir, { fresh: false });
  expect(first.resume).toBe(false);
  const again = chooseSession(dir, { fresh: false });
  expect(again.id).toBe(first.id);
  expect(again.resume).toBe(false);
  expect(readSessionIndex(dir).sessions).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// The store adapter and the flag
// ---------------------------------------------------------------------------

test("the file store round-trips entries, dedupes by uuid and returns null for an unknown session", async () => {
  const store = fileSessionStore(mkdtempSync(join(root, "s-")));
  const key = { projectKey: "k", sessionId: "abc" };
  expect(await store.load(key)).toBeNull();
  await store.append(key, [{ type: "user", uuid: "1", message: "hi" }, { type: "title", title: "T" }]);
  await store.append(key, [{ type: "user", uuid: "1", message: "hi" }, { type: "assistant", uuid: "2" }]);
  expect(await store.load(key)).toEqual([{ type: "user", uuid: "1", message: "hi" }, { type: "title", title: "T" }, { type: "assistant", uuid: "2" }]);
  await store.append({ ...key, subpath: "subagents/x" }, [{ type: "user", uuid: "s" }]);
  expect(await store.listSubkeys!(key)).toEqual(["subagents/x"]);
  expect((await store.listSessions!("k")).map((s) => s.sessionId)).toEqual(["abc"]);
  await expect(store.load({ projectKey: "k", sessionId: "../escape" })).rejects.toThrow("unsafe");
});

test("--new parses", () => {
  expect(parseCliArgs(["agent", "--project", "ice-house", "--new", "hi"]).new).toBe(true);
  expect(parseCliArgs(["agent", "--project", "ice-house", "hi"]).new).toBe(false);
});
