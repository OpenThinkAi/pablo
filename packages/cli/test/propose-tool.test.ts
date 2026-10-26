import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createScriptedChatAdapter } from "@openthink/pablo-core";
import { planTools } from "../src/harness/plan-tools";
import { adapterProvider } from "../src/harness/provider";
import { loopSpec } from "../src/harness/session";
import { buildMcpServer } from "../src/mcp";
import { startPlanSession } from "../src/plan";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "pablo-propose-tool-test-")));
const repo = join(root, "vault");
cpSync(FIXTURE_VAULT, repo, { recursive: true });
const sh = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" });
execFileSync("git", ["init", "-q", "-b", "main", repo]);
sh("config", "user.name", "Test");
sh("config", "user.email", "t@t.example");
sh("add", "-A");
sh("commit", "-qm", "base");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const env = { PABLO_VAULT: repo, PABLO_HOME: join(root, "home"), PATH: "/usr/bin:/bin", HOME: root };
const work = join(repo, "novels", "ice-house");

async function connect(id = "cd34") {
  const session = startPlanSession(repo, "ice-house", { env, date: "2026-10-01", id });
  const ctx = { cwd: repo, env, stderr: { write: () => {} }, caller: "mcp" as const };
  const spec = loopSpec({
    work: { title: "The Ice House", format: "novel", slug: "ice-house" },
    provider: adapterProvider(createScriptedChatAdapter({ turns: [] })),
    ctx,
    sessionTools: planTools(session, work),
  });
  const options = { allowedTools: spec.tools.map((tool) => tool.name) };
  const instance = buildMcpServer(ctx, spec.tools);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await instance.connect(s);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(c);
  return { session, options, client };
}

const textOf = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]!).text);

test("propose is among the session's tools and callable; it lands on the session's plan branch", async () => {
  const { session, options, client } = await connect();
  try {
    expect(options.allowedTools).toContain("propose");
    const r = await client.callTool({ name: "propose", arguments: { stage: "premise", content: "A logline." } });
    expect(textOf(r)).toMatchObject({ ok: true, stage: "premise", branch: "plan/2026-10-01-cd34" });
    expect(readFileSync(join(session.worktree as string, "novels/ice-house/bible/overview.md"), "utf8")).toBe("A logline.\n");
    expect(sh("log", "--format=%an|%s", "main..plan/2026-10-01-cd34").trim()).toBe("pablo|propose premise");
  } finally {
    await client.close();
  }
});

test("an unknown stage is refused over the tool with the valid stages", async () => {
  const { client } = await connect();
  try {
    const r = await client.callTool({ name: "propose", arguments: { stage: "epilogue", content: "x" } });
    const body = textOf(r);
    expect(body.ok).toBe(false);
    expect(body.message).toContain("premise, acts, beats, cast, places");
  } finally {
    await client.close();
  }
});

test("record_fact shares the session's plan branch with propose; a researched fact needs a source", async () => {
  const { session, options, client } = await connect("ef56");
  try {
    expect(options.allowedTools).toContain("record_fact");
    const bad = textOf(await client.callTool({ name: "record_fact", arguments: { fact: "Ice cost a cent.", where: "continuity", kind: "researched" } }));
    expect(bad.ok).toBe(false);
    await client.callTool({ name: "propose", arguments: { stage: "premise", content: "A logline." } });
    const ok = textOf(await client.callTool({ name: "record_fact", arguments: { fact: "Cora is left-handed.", where: "continuity", kind: "invented" } }));
    expect(ok).toMatchObject({ ok: true, branch: "plan/2026-10-01-ef56" });
    expect(session.worktree).toBeDefined();
    expect(sh("log", "--format=%an", "main..plan/2026-10-01-ef56").trim().split("\n")).toEqual(["pablo", "pablo"]);
  } finally {
    await client.close();
  }
});
