/**
 * Saved harness sessions (AGT-1565): the store and the index. The store is the
 * Agent SDK's format, which pablo's own loop does not write; `pablo agent`
 * runs one fresh conversation per run until sessions return as neutral JSONL
 * (AGT-2122), and the last test holds it to leaving `.pablo/sessions/` alone.
 * Sessions land under a temp copy of the fixture vault, never ~/.cache/pablo
 * or ~/.config/pablo.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScriptedChatAdapter } from "@openthink/pablo-core";
import { runAgent } from "../src/harness/agent";
import { adapterProvider } from "../src/harness/provider";
import { chooseSession, fileSessionStore, readSessionIndex, sessionsDir } from "../src/harness/sessions";
import { parseCliArgs } from "../src/cli";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pablo-sessions-test-"));
const vault = join(root, "vault");
cpSync(FIXTURE_VAULT, vault, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const work = join(vault, "novels", "ice-house");
const ENV = { PABLO_VAULT: vault, PATH: "/usr/bin:/bin", HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") };

test("pablo agent on the loop runs a fresh conversation and writes no SDK session, with or without --new", async () => {
  for (const fresh of [false, true]) {
    const model = createScriptedChatAdapter({ turns: [[{ type: "text", text: "ok" }]] });
    const ctx = { cwd: vault, env: ENV, stdout: { write: () => {} }, stderr: { write: () => {} } };
    expect(await runAgent({ project: "ice-house", message: "Where are we?", json: false, new: fresh }, ctx, { provider: adapterProvider(model), readConfig: () => undefined })).toBe(0);
    expect(model.requests[0]!.messages).toEqual([{ role: "user", content: "Where are we?" }]);
  }
  expect(existsSync(sessionsDir(work))).toBe(false);
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
