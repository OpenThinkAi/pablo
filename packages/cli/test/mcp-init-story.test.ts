/**
 * AGT-2143 (D-16): `init`, `story`, `output_add` and `merge` as MCP tools. An
 * agent connected over MCP goes from a vault with no work in it to a merged
 * unit of the story output, through pablo's own tools only, with a fake writer
 * (no model, no network, no `think`, never `~/writing`). The vault is a temp git
 * repository holding only the fixture's style/ and voices/. The server is the
 * real `buildMcpServer` over an in-memory transport, so the writer can be
 * injected through the verb context; `mcp.test.ts` covers the spawned bin.
 *
 * Each tool's refusals are the CLI's own: the same body for the same request.
 */

import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Adapter, CompletionEvent } from "@openthink/pablo-core";
import { main } from "../src/cli";
import { buildMcpServer } from "../src/mcp";
import { captureConsoleLog } from "../src/verbs";
import type { VerbContext } from "../src/verbs";
import { useLocalConfigHome } from "./local-config";

useLocalConfigHome();

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8").trim();
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "pablo-mcp-init-story-")));
const vault = join(root, "vault");
mkdirSync(vault, { recursive: true });
// The vault markers (style/, voices/) and nothing else: no work exists yet.
cpSync(join(FIXTURE_VAULT, "style"), join(vault, "style"), { recursive: true });
cpSync(join(FIXTURE_VAULT, "voices"), join(vault, "voices"), { recursive: true });
git(vault, "init", "-q", "-b", "main");
git(vault, "config", "user.email", "pablo-test@example.com");
git(vault, "config", "user.name", "Pablo Test");
git(vault, "config", "commit.gpgsign", "false");
git(vault, "add", ".");
git(vault, "commit", "-q", "-m", "base");

const env = { PABLO_VAULT: vault, PABLO_HOME: join(root, "pablo-home"), PATH: NO_THINK_PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };

const PROSE = ["Nell saw the light where no boat should be.", "The fog sat on the bar like wet wool.", "She took the pilot boat out anyway."].join("\n");

/** The writer and the continuity extractor in one fake: counts calls, never reaches a model. */
function fakeWriter(): Adapter & { drafts: number; extractions: number } {
  const writer = {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text" as const,
    drafts: 0,
    extractions: 0,
    async *complete(): AsyncIterable<CompletionEvent> {
      writer.drafts += 1;
      yield { type: "token", text: PROSE };
      yield { type: "done", stats: { timeToFirstTokenMs: 5, elapsedMs: 10, tokensRead: 100, tokensWritten: 30, tokensPerSecond: 3000 } };
    },
    async extractFactsWithAnchors() {
      writer.extractions += 1;
      return [{ fact: "Nell sees a light off the bar", entities: ["Nell"], storyTime: undefined, certainty: undefined, anchor: "Nell saw the light" }];
    },
    async proposeEdit(): Promise<never> {
      throw new Error("not used");
    },
    async extractFacts(): Promise<never> {
      throw new Error("not used");
    },
  };
  return writer as unknown as Adapter & { drafts: number; extractions: number };
}

const writer = fakeWriter();
const ctx: VerbContext = { cwd: vault, env, stderr: { write: () => {} }, caller: "mcp", writer, extractor: writer };
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await buildMcpServer(ctx).connect(serverSide);
const client = new Client({ name: "pablo-mcp-init-story-test", version: "0.0.0" });
await client.connect(clientSide);

afterAll(async () => {
  await client.close();
  rmSync(root, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  expect(result.isError ?? false).toBe(false);
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

/** The CLI's `--json` body for the same request, run against the same vault. */
async function cli(argv: readonly string[]): Promise<Record<string, unknown>> {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try {
    const { text } = await captureConsoleLog(() => main([...argv, "--json"], vault));
    return JSON.parse(text.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/** A planning file the agent saves with `save` (which reads `file`, a path inside the vault). */
function scratch(name: string, content: string): string {
  const dir = join(vault, ".scratch");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const PREMISE = "# Overview\n\n## Logline\n\nA harbour pilot has one night to bring a stranger's boat in over the bar.\n\n## Premise\n\nFog.\n";
const ACTS = "| Act | Years | What it accomplishes |\n|---|---|---|\n| I | 1950 | The boat is sighted. |\n| II | 1950 | The pilot brings it in. |\n";
const BEATS = [
  "| # | Story date | Title (working) | Beat | POV | Status |",
  "|---|---|---|---|---|---|",
  "| 1 | Autumn 1950 | The Sighting | Nell sees a light where no boat should be. | Nell | outline |",
  "| 2 | Autumn 1950 | The Bar | Nell takes the pilot boat over the bar in fog. | Nell | outline |",
].join("\n");

test("init, output_add, story and merge are served with descriptions", async () => {
  const { tools } = await client.listTools();
  for (const name of ["init", "output_add", "story", "merge"]) {
    const tool = tools.find((t) => t.name === name);
    expect(tool, name).toBeDefined();
    expect((tool?.description ?? "").length).toBeGreaterThan(40);
  }
  const outputAdd = tools.find((t) => t.name === "output_add")!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  expect(Object.keys(outputAdd.properties ?? {}).sort()).toEqual(["from", "project", "type"]);
  expect((outputAdd.required ?? []).sort()).toEqual(["project", "type"]);
  // There is one way to add an output over MCP: the `output` tool keeps list, remove and plan.
  const output = tools.find((t) => t.name === "output")!.inputSchema as unknown as { properties: { sub: { enum: string[] } } };
  expect(output.properties.sub.enum).toEqual(["list", "remove", "plan"]);
});

test("an MCP agent goes from an empty vault to a merged story unit with the fake writer", async () => {
  const init = await call("init", { track: "fiction", slug: "harbour", title: "The Harbour" });
  expect(init).toMatchObject({ ok: true, track: "fiction", slug: "harbour", title: "The Harbour", committed: true, format: null });
  const work = String(init["path"]);
  expect(existsSync(join(work, "pablo.json"))).toBe(true);

  // Before the core is at beats, output_add refuses and names what is missing.
  const early = await call("output_add", { project: "harbour", type: "story" });
  expect(early).toMatchObject({ ok: false, code: 2 });
  expect(early["missing"]).toEqual(expect.arrayContaining([expect.stringContaining("core beats")]));

  for (const [stage, content] of [["premise", PREMISE], ["acts", ACTS], ["beats", BEATS]] as const) {
    expect(await call("save", { project: "harbour", stage, file: scratch(`${stage}.md`, content) })).toMatchObject({ ok: true, stage, committed: true });
  }

  expect(await call("output_add", { project: "harbour", type: "story" })).toMatchObject({ ok: true, action: "add", type: "story", committed: true });
  expect(await call("status", { project: "harbour", for: "story 1" })).toMatchObject({ ready: true });

  const drafted = await call("write", { project: "harbour", output: "story", unit: 1 });
  expect(drafted["ok"]).toBe(true);
  expect(writer.drafts).toBe(1);
  const branch = String(drafted["branch"]);
  expect(branch).toStartWith("draft/");
  // The draft waits on its branch; main does not have it yet.
  expect(existsSync(join(work, "outputs", "story", "story.md"))).toBe(false);

  const merged = await call("merge", { project: "harbour", branch });
  expect(merged).toMatchObject({ ok: true, branch });
  expect(git(vault, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  // The merge commit is on main (the after-write rituals may commit on top of it).
  git(vault, "merge-base", "--is-ancestor", String(merged["commit"]), "main");
  const unit = readFileSync(join(work, "outputs", "story", "story.md"), "utf8");
  expect(unit).toContain("Nell saw the light where no boat should be.");
  expect(writer.extractions).toBeGreaterThan(0);
});

test("init refuses as the CLI does", async () => {
  const cases: readonly [Record<string, unknown>, readonly string[]][] = [
    [{ track: "fiction", slug: "Bad Slug", title: "X" }, ["init", "--track", "fiction", "Bad Slug", "X"]],
    [{ track: "space-opera", slug: "nebula", title: "X" }, ["init", "--track", "space-opera", "nebula", "X"]],
    [{ track: "fiction", slug: "novel", title: "X" }, ["init", "--track", "fiction", "novel", "X"]],
    [{ output: "radio", slug: "airwaves", title: "X" }, ["init", "radio", "airwaves", "X"]],
    [{ slug: "lonely" }, ["init", "lonely"]],
    [{ adopt: true }, ["init", "--adopt"]],
    [{ adopt: true, project: "nowhere" }, ["init", "--adopt", "--project", "nowhere"]],
  ];
  for (const [args, argv] of cases) {
    const viaMcp = await call("init", args);
    expect(viaMcp["ok"]).toBe(false);
    expect(viaMcp).toEqual(await cli(argv));
  }
  expect(await call("init", { adopt: true })).toMatchObject({ code: 2, message: "pablo: init --adopt requires --project <slug>" });
  expect(await call("init", { output: "radio", slug: "airwaves", title: "X" })).toMatchObject({ code: 1 });
});

test("init over MCP refuses a work that already exists, naming it", async () => {
  await call("init", { track: "fiction", slug: "twice", title: "Twice" });
  const again = await call("init", { track: "fiction", slug: "twice", title: "Twice" });
  expect(again).toMatchObject({ ok: false, code: 2 });
  expect(String(again["message"])).toContain("already exists");
});

test("output_add and merge refuse as the CLI does", async () => {
  await call("init", { track: "fiction", slug: "bare", title: "Bare" });
  expect(await call("output_add", { project: "bare", type: "story" })).toEqual(await cli(["output", "add", "story", "--project", "bare"]));
  expect(await call("output_add", { project: "bare", type: "podcast" })).toEqual(await cli(["output", "add", "podcast", "--project", "bare"]));
  expect(await call("output_add", { project: "nope", type: "story" })).toEqual(await cli(["output", "add", "story", "--project", "nope"]));

  const notDraft = await call("merge", { project: "bare", branch: "main" });
  expect(notDraft).toMatchObject({ ok: false, code: 2 });
  expect(notDraft).toEqual(await cli(["merge", "--project", "bare", "main"]));
});

test("story refuses as the CLI does, and writes nothing", async () => {
  const before = git(vault, "rev-parse", "main");
  const noPrompt = await call("story", {});
  expect(noPrompt).toMatchObject({ ok: false, code: 2 });
  expect(noPrompt).toEqual(await cli(["story"]));
  const both = await call("story", { prompt: "a short story about a lighthouse", project: "harbour" });
  expect(both).toMatchObject({ ok: false });
  expect(both).toEqual(await cli(["story", "a short story about a lighthouse", "--project", "harbour"]));
  expect(git(vault, "rev-parse", "main")).toBe(before);
});
