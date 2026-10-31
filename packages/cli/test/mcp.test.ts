import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

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

// AGT-1245: `voice` no longer registers itself as an MCP tool — it exposes
// four narrow ones instead (see `verbs.ts`'s file header). `prose` was
// already an MCP tool before this ticket (AGT-1241); AC1's "five existing
// tools" are resume/status/write/save/check. AGT-1264 adds `revise`, also
// project-scoped.
const PROJECT_SCOPED_TOOLS = new Set(["resume", "status", "timeline", "critique", "write", "draft_chapter", "draft_unit", "output", "output_add", "merge", "promote", "save", "check", "bind", "revise", "revise_passage", "migrate", "publish", "read", "search", "perform", "mix", "fix", "save_research", "distill_facts", "record_fact", "plan_research", "add_research_item", "waive_research_item", "link_research_item"]);

test("listTools returns the project-scoped verbs, prose, and the five narrow voice_* tools", async () => {
  const { tools } = await client.listTools();

  expect(tools.map((t) => t.name).sort()).toEqual([
    "add_research_item", // AGT-2282: from the `research` verb
    "audition", // AGT-1679: the voice library's verbs; project optional (receipts only)
    "bind",
    "cast",
    "check",
    "critique",
    "describe_voice", // AGT-1699: the CAST: mapper and the traits vocabulary, for the harness
    "distill_facts", // AGT-2109: also from the `research` verb
    "draft_chapter",
    "draft_unit",
    "fix", // AGT-1685: fixes a performed radio episode from its flags; project required
    "guide", // AGT-2142: the path for a track x output; no project
    "init", // AGT-2143: starts a work; MCP only, never the harness's
    "link_research_item", // AGT-2111: from the `research` verb
    "merge", // AGT-2143: accepts a draft on the author's word; MCP only, never the harness's
    "migrate",
    "mix", // AGT-1684: mixes a performed radio episode; project required
    "output",
    "output_add", // AGT-2143: from the `output` verb
    "perform", // AGT-1683: performs a radio episode; project required
    "plan_research", // AGT-2111: from the `research` verb
    "promote",
    "prose",
    "publish",
    "read",
    "record_fact", // AGT-2106: from the `fact` verb
    "resume",
    "revise",
    "revise_passage",
    "save",
    "save_research", // AGT-2106: from the `research` verb
    "search",
    "status",
    "story", // AGT-2143: the whole pipeline from a prompt; MCP only, never the harness's
    "timeline",
    "voice_edit",
    "voice_exemplar",
    "voice_flag",
    "voice_list",
    "voice_remove",
    "voice_rule",
    "voice_show",
    "voice_use",
    "voices",
    "waive_research_item", // AGT-2111: from the `research` verb
    "web_fetch", // AGT-2126: from the `web` verb
    "web_search", // AGT-2126: from the `web` verb
    "write",
  ]);
  for (const tool of tools) {
    if (!PROJECT_SCOPED_TOOLS.has(tool.name)) continue;
    const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    expect("project" in properties).toBe(true);
  }
});

// AGT-1669 AC3: the MCP `write` tool's schema shows `output` (and `unit`), straight off `verbs.ts`;
// `draft_unit` takes the output and the unit number, and `draft_chapter` stays.
test("the write tool's schema carries output and unit; draft_unit carries output and n", async () => {
  const { tools } = await client.listTools();
  const propsOf = (name: string): string[] =>
    Object.keys((tools.find((t) => t.name === name)?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
  expect(propsOf("write")).toEqual(expect.arrayContaining(["output", "unit", "chapter"]));
  expect(propsOf("draft_unit")).toEqual(expect.arrayContaining(["project", "output", "n", "direction"]));
  expect(propsOf("draft_chapter")).toContain("chapter");
  expect(propsOf("check")).toContain("output");
  expect(propsOf("publish")).toContain("output");
});

// AGT-2144: the duplicate tools are listed once each, marked as deprecated aliases of the canonical tool.
test("tools/list marks draft_unit, draft_chapter and revise_passage as deprecated aliases, once each", async () => {
  const { tools } = await client.listTools();
  const aliases: Record<string, string> = { draft_unit: "write", draft_chapter: "write", revise_passage: "revise" };
  for (const [alias, canonical] of Object.entries(aliases)) {
    const matches = tools.filter((t) => t.name === alias);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.description).toContain(`Deprecated alias of \`${canonical}\``);
    expect(tools.filter((t) => t.name === canonical)).toHaveLength(1);
    expect(tools.find((t) => t.name === canonical)?.description).not.toContain("Deprecated alias");
  }
});

// AC1: each voice_* tool's schema carries ONLY its own arguments — not a
// union of every sub's fields the way the single `voice` verb's schema does.
test("each voice_* tool's input schema carries only its own arguments", async () => {
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const propsOf = (name: string): string[] =>
    Object.keys((byName.get(name)!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}).sort();

  expect(propsOf("voice_list")).toEqual(["project"]);
  expect(propsOf("voice_show")).toEqual(["name"]);
  expect(propsOf("voice_flag")).toEqual(["line", "name", "section"]);
  expect(propsOf("voice_exemplar")).toEqual(["file", "name", "title"]);
  expect(propsOf("voice_rule")).toEqual(["example", "name", "project", "target", "text"]);
  expect(propsOf("voice_edit")).toEqual(["id", "project", "target", "text"]);
  expect(propsOf("voice_remove")).toEqual(["id", "project", "target"]);
  expect(propsOf("voice_use")).toEqual(["name", "project"]);

  // The schema itself enforces requiredness structurally (AC1's "honest
  // schema" — no `sub` discriminator, no runtime-only requiredness check).
  const requiredOf = (name: string): string[] => (byName.get(name)!.inputSchema as { required?: string[] }).required ?? [];
  expect(requiredOf("voice_show")).toEqual(["name"]);
  expect(requiredOf("voice_flag").sort()).toEqual(["line", "name"]);
  expect(requiredOf("voice_exemplar").sort()).toEqual(["file", "name"]);
});

test("there is no review tool: branches replace the review queue (AGT-1541)", async () => {
  const { tools } = await client.listTools();
  expect(tools.some((t) => t.name === "review")).toBe(false);
});

test("the server sends its usage instructions at initialize (AGT-1873)", () => {
  const instructions = client.getInstructions() ?? "";
  expect(instructions).toContain("`resume`");
  expect(instructions).toMatch(/Never write the book's prose yourself/);
  // AGT-2143: merge is a tool now, called only on the author's word.
  expect(instructions).toMatch(/Call `merge` only when the author has read the branch and told you to accept it/);
  expect(instructions).toContain("`init`");
  expect(instructions).toContain("`output_add`");
});

test("the instructions say to call guide first, and guide returns what the CLI's --json does (AGT-2142)", async () => {
  const instructions = client.getInstructions() ?? "";
  expect(instructions).toMatch(/Call `guide` first/);
  expect(instructions.indexOf("`guide`")).toBeLessThan(instructions.indexOf("`resume`"));
  const { guide, writerModel } = await import("../src/guide");
  const body = parseTextBody(await client.callTool({ name: "guide", arguments: { track: "historical-fiction", output: "novel" } }));
  expect(body).toEqual(JSON.parse(JSON.stringify(guide({ track: "historical-fiction", output: "novel" }, writerModel(process.env)))));
  const index = parseTextBody(await client.callTool({ name: "guide", arguments: {} })) as { ok: boolean; tracks: unknown[] };
  expect(index.ok).toBe(true);
  expect(index.tracks.length).toBeGreaterThan(0);
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

test("revise with branch needs a passage (it is what revise_passage aliases)", async () => {
  const result = await client.callTool({
    name: "revise",
    arguments: { project: "ice-house", file: "chapters/01.md", instruction: "tighten", start: 0, end: 5, branch: true },
  });
  expect(parseTextBody(result)).toMatchObject({ ok: false, code: 2 });
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

// AC2/AC3: `context[]` gets the same vault bound `brief` does — a normal
// refusal (content, `ok:false`), never a thrown tool error.
test('callTool("prose", {..., context: [<a path outside the vault>]}) refuses (exit 2) as content, not a tool error', async () => {
  const briefPath = join(vault, "prose-brief-context.md");
  writeFileSync(briefPath, "Announce the new dock hours.\n", "utf8");

  const result = await client.callTool({
    name: "prose",
    arguments: { voice: "plain", brief: briefPath, context: ["/etc/hosts"], "dry-run": true },
  });

  expect(result.isError).not.toBe(true);
  const body = parseTextBody(result);
  expect(body).toMatchObject({ ok: false, code: 2 });
  expect((body as { message: string }).message).toContain("inside");
});

// ---------------------------------------------------------------------------
// voice_list / voice_show / voice_flag / voice_exemplar (AGT-1245)
// ---------------------------------------------------------------------------

test('callTool("voice_show", {name: "plain"}) returns the fixture voice', async () => {
  const result = await client.callTool({ name: "voice_show", arguments: { name: "plain" } });

  expect(result.isError).not.toBe(true);
  const body = parseTextBody(result) as { ok: boolean; name: string; model: string; rules: unknown[]; exemplars: unknown[] };
  expect(body).toMatchObject({ ok: true, name: "plain", model: "anthropic" });
  expect(body.rules).toHaveLength(1);
  expect(body.exemplars).toHaveLength(2);
});

test('callTool("voice_show", {name: <a path outside the vault>}) refuses (exit 2) as content, not a tool error', async () => {
  const result = await client.callTool({ name: "voice_show", arguments: { name: "/etc/hosts" } });

  expect(result.isError).not.toBe(true);
  const body = parseTextBody(result);
  expect(body).toMatchObject({ ok: false, code: 2 });
  expect((body as { message: string }).message).toContain("inside the vault");
});

// AGT-1243 gate finding, re-verified over the narrow tool: `line` and
// `section` both get CR/LF flattened before writing, so neither can forge a
// second `## ` heading. This appends into the fixture's `plain` voice.md
// (which already has a `## Flagged` section) — run after the `voice_show`
// test above, which only checks `rules`/`exemplars` counts, unaffected by an
// appended line within the same single `rules` source.
test('callTool("voice_flag", {name, line: <embedded newline + "## ">}) writes one flattened line and forges no heading', async () => {
  const flagResult = await client.callTool({
    name: "voice_flag",
    arguments: { name: "plain", line: "Say what changed.\n## Injected Heading\nNot a real section." },
  });

  expect(flagResult.isError).not.toBe(true);
  const body = parseTextBody(flagResult) as { ok: boolean; path: string };
  expect(body.ok).toBe(true);

  const contents = readFileSync(body.path, "utf8");
  expect(contents).toContain('Flagged: "Say what changed. ## Injected Heading Not a real section."');
  expect(contents).not.toMatch(/^## Injected Heading$/m);
});

test('callTool("voice_exemplar", {name, file: <a path outside the vault>}) refuses (exit 2) as content, not a tool error', async () => {
  const result = await client.callTool({
    name: "voice_exemplar",
    arguments: { name: "plain", file: "/etc/hosts" },
  });

  expect(result.isError).not.toBe(true);
  const body = parseTextBody(result);
  expect(body).toMatchObject({ ok: false, code: 2 });
  expect((body as { message: string }).message).toContain("inside the vault");
});

test('callTool("voice_list") includes the fiction alias and every fixture voice', async () => {
  const result = await client.callTool({ name: "voice_list", arguments: {} });

  expect(result.isError).not.toBe(true);
  const body = parseTextBody(result) as { ok: boolean; voices: Array<{ name: string; scope: string }> };
  expect(body.ok).toBe(true);
  expect(body.voices.some((v) => v.name === "fiction" && v.scope === "fiction")).toBe(true);
  expect(body.voices.some((v) => v.name === "plain" && v.scope === "vault")).toBe(true);
});

// AC4: the server writes nothing but the MCP protocol to stdout. Bypasses the
// SDK client entirely (it would itself choke on a stray non-JSON-RPC stdout
// line, but that's an indirect guarantee) and speaks the wire protocol by
// hand: every non-empty line read off the child's raw stdout must `JSON.parse`
// as a `{jsonrpc: "2.0", ...}` message — a `console.log` leaking anything else
// onto stdout would either fail that parse or show up as an extra line neither
// response accounts for.
test("the mcp server writes nothing but JSON-RPC to stdout", async () => {
  const proc = Bun.spawn({
    cmd: [BUN_BIN, "run", CLI, "mcp"],
    cwd: vault,
    env: { PABLO_VAULT: vault, PATH: NO_THINK_PATH },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  function send(msg: unknown): void {
    proc.stdin.write(`${JSON.stringify(msg)}\n`);
    proc.stdin.flush();
  }

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "raw-stdout-test", version: "0.0.0" } },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "voice_list", arguments: {} } });

  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  let buffered = "";
  const lines: string[] = [];
  let sawToolResponse = false;
  const deadline = Date.now() + 10_000;

  while (!sawToolResponse && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newlineAt: number;
    while ((newlineAt = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newlineAt);
      buffered = buffered.slice(newlineAt + 1);
      if (line.trim() === "") continue;
      lines.push(line);
      const parsed = JSON.parse(line) as { readonly jsonrpc?: string; readonly id?: number };
      expect(parsed.jsonrpc).toBe("2.0");
      if (parsed.id === 2) sawToolResponse = true;
    }
  }

  expect(sawToolResponse).toBe(true);
  expect(lines.length).toBe(2); // exactly the initialize response and the tools/call response — nothing extra

  proc.kill();
});

test("MCP instructions cover tracks, guide, story and research (AGT-2145)", async () => {
  const { MCP_INSTRUCTIONS } = await import("../src/mcp");
  for (const word of ["track", "`guide`", "story", "research", "gate"]) expect(MCP_INSTRUCTIONS).toContain(word);
});
