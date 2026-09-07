import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * A real client/server round trip over stdio, spawning the actual bin
 * (`bun run packages/cli/src/cli.ts mcp`) — exercises `mcp.ts` end to end,
 * not just `verbs.ts`'s `run` functions in-process (see `verbs.test.ts` for
 * those). `PABLO_VAULT` points at a throwaway copy of the synthetic fixture
 * vault, never the real `~/writing` vault; `PATH` resolves no `think` (only
 * `resume` shells out to it, and this suite never wants a real network call).
 */
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const BUN_BIN = Bun.which("bun") ?? "bun";
const NO_THINK_PATH = [dirname(BUN_BIN), "/usr/bin", "/bin"].join(":");

function tempVault(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  return vault;
}

const vault = tempVault("pablo-mcp-test-");

const transport = new StdioClientTransport({
  command: BUN_BIN,
  args: ["run", CLI, "mcp"],
  env: { PABLO_VAULT: vault, PATH: NO_THINK_PATH },
  cwd: vault,
});
const client = new Client({ name: "pablo-mcp-test", version: "0.0.0" });
await client.connect(transport);

afterAll(async () => {
  await client.close();
  rmSync(vault, { recursive: true, force: true });
});

/** `callTool`'s return type covers both regular and task-based tool results; every verb here always returns the regular `{content: [...]}` shape. */
function parseTextBody(result: unknown): unknown {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new Error(`expected a content array, got ${JSON.stringify(result)}`);
  }
  const first = content[0] as { type?: string; text?: string } | undefined;
  if (first === undefined || first.type !== "text" || typeof first.text !== "string") {
    throw new Error(`expected a text content block, got ${JSON.stringify(content)}`);
  }
  return JSON.parse(first.text);
}

test("listTools returns exactly the seven verbs, each project-scoped verb with a project input", async () => {
  const { tools } = await client.listTools();

  expect(tools.map((t) => t.name).sort()).toEqual(["check", "prose", "resume", "save", "status", "voice", "write"]);
  for (const tool of tools) {
    if (tool.name === "voice" || tool.name === "prose") continue; // neither resolves via a --project slug
    const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect("project" in properties).toBe(true);
  }
});

test('callTool("status", {project: "ice-house", for: "chapter 3"}) is a normal result carrying ready:false, not a tool error', async () => {
  const result = await client.callTool({ name: "status", arguments: { project: "ice-house", for: "chapter 3" } });

  expect(result.isError).not.toBe(true);
  const body = parseTextBody(result);
  expect(body).toMatchObject({ ready: false });
  expect(Array.isArray((body as { missing: unknown[] }).missing)).toBe(true);
});

test('callTool("status", {project: "nope"}) is a normal result carrying ok:false, code:2, not a tool error', async () => {
  const result = await client.callTool({ name: "status", arguments: { project: "nope" } });

  expect(result.isError).not.toBe(true);
  const body = parseTextBody(result);
  expect(body).toMatchObject({ ok: false, code: 2 });
});

test('callTool("check", {project: "ice-house"}) parses with hits/unprovenanced', async () => {
  const result = await client.callTool({ name: "check", arguments: { project: "ice-house" } });

  expect(result.isError).not.toBe(true);
  const body = parseTextBody(result) as { ok: boolean; hits: unknown[]; unprovenanced: unknown[] };
  expect(body.ok).toBe(true);
  expect(Array.isArray(body.hits)).toBe(true);
  expect(Array.isArray(body.unprovenanced)).toBe(true);
});

test('callTool("write", {project: "ice-house", chapter: 2, "dry-run": true}) returns a prompt_hash', async () => {
  const result = await client.callTool({
    name: "write",
    arguments: { project: "ice-house", chapter: 2, "dry-run": true },
  });

  expect(result.isError).not.toBe(true);
  const body = parseTextBody(result) as { ok: boolean; dryRun: boolean; prompt_hash: string };
  expect(body).toMatchObject({ ok: true, dryRun: true });
  expect(typeof body.prompt_hash).toBe("string");
});

test('callTool("resume", {project: "ice-house"}) returns the resume summary shape', async () => {
  const result = await client.callTool({ name: "resume", arguments: { project: "ice-house" } });

  expect(result.isError).not.toBe(true);
  const body = parseTextBody(result);
  expect(body).toMatchObject({ format: "novel", title: "The Ice House" });
});

test('callTool("save", {project: "ice-house", stage: "premise", file: <a path inside the vault>}) saves it', async () => {
  const inputPath = join(vault, "premise-input.md");
  writeFileSync(inputPath, "# Logline\n\nA new logline from the MCP save round trip.\n", "utf8");

  const result = await client.callTool({
    name: "save",
    arguments: { project: "ice-house", stage: "premise", file: inputPath },
  });

  expect(result.isError).not.toBe(true);
  const body = parseTextBody(result);
  expect(body).toMatchObject({ ok: true, stage: "premise", path: "bible/overview.md" });
});

test('callTool("save", {project: "ice-house", stage: "premise", file: <a path outside the vault>}) refuses (exit 2), never reads it', async () => {
  const result = await client.callTool({
    name: "save",
    arguments: { project: "ice-house", stage: "premise", file: "/etc/hosts" },
  });

  expect(result.isError).not.toBe(true);
  const body = parseTextBody(result);
  expect(body).toMatchObject({ ok: false, code: 2 });
  expect((body as { message: string }).message).toContain("inside the vault");
});

test('callTool("prose", {voice: "plain", brief: <a path inside the vault>, "dry-run": true}) returns a prompt_hash', async () => {
  const briefPath = join(vault, "prose-brief.md");
  writeFileSync(briefPath, "Announce the new dock hours.\n", "utf8");

  const result = await client.callTool({
    name: "prose",
    arguments: { voice: "plain", brief: briefPath, "dry-run": true },
  });

  expect(result.isError).not.toBe(true);
  const body = parseTextBody(result) as { ok: boolean; dryRun: boolean; prompt_hash: string };
  expect(body).toMatchObject({ ok: true, dryRun: true });
  expect(typeof body.prompt_hash).toBe("string");
});

test('callTool("prose", {voice: "plain", brief: <a path outside the vault>, "dry-run": true}) refuses (exit 2), never reads it', async () => {
  const result = await client.callTool({
    name: "prose",
    arguments: { voice: "plain", brief: "/etc/hosts", "dry-run": true },
  });

  expect(result.isError).not.toBe(true);
  const body = parseTextBody(result);
  expect(body).toMatchObject({ ok: false, code: 2 });
  expect((body as { message: string }).message).toContain("inside");
});
