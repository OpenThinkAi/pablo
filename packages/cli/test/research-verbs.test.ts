import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "bun:test";
import { mcpTools } from "../src/mcp";
import { main } from "../src/cli";
import { harnessAuth } from "../src/harness/auth";
import { harnessOptions } from "../src/harness/session";
import { defaultConfig } from "@openthink/pablo-core";
import type { VerbContext } from "../src/verbs";
import { VERBS } from "../src/verbs";

/** AGT-2106: `research save` and `fact record` as CLI verbs and MCP tools, over a temp git copy of the fixture vault. */
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const cleanupDirs: string[] = [];

function sh(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pablo-rverbs-test-")));
  cleanupDirs.push(dir);
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", vault]);
  sh(vault, "config", "user.name", "Test");
  sh(vault, "config", "user.email", "t@t.example");
  sh(vault, "add", "-A");
  sh(vault, "commit", "-qm", "base");
  const env = { PABLO_VAULT: vault, PABLO_HOME: join(dir, "home"), PATH: process.env["PATH"] ?? "" };
  const ctx: VerbContext = { cwd: vault, env, stderr: { write: () => {} } };
  return { vault, ctx, env };
}

afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

function verb(name: string) {
  const found = VERBS.find((v) => v.name === name);
  if (found === undefined) throw new Error(`no such verb: ${name}`);
  return found;
}

function planBranch(vault: string): string {
  return sh(vault, "branch", "--list", "plan/*", "--format=%(refname:short)").trim().split("\n")[0] as string;
}

test("research save writes research/<slug>.md with sources and the retrieval date on a plan branch", async () => {
  const { vault, ctx } = setup();
  const r = await verb("research").run(
    { sub: "save", project: "ice-house", title: "Ice Prices, 1929", note: "A ton sold for four dollars.", source: ["https://example.test/ice", "Almanac 1930, p. 4"] } as never,
    ctx,
  );
  expect(r.exitCode).toBe(0);
  const body = r.body as { ok: boolean; path: string; branch: string };
  expect(body.path).toBe("novels/ice-house/research/ice-prices-1929.md");
  expect(body.branch).toMatch(/^plan\//);
  const text = sh(vault, "show", `${body.branch}:${body.path}`);
  expect(text).toContain("# Ice Prices, 1929");
  expect(text).toMatch(/Retrieved: \d{4}-\d{2}-\d{2}/);
  expect(text).toContain("## Sources\n\n- https://example.test/ice\n- Almanac 1930, p. 4\n");
  // main is untouched.
  expect(existsSync(join(vault, "novels/ice-house/research/ice-prices-1929.md"))).toBe(false);
});

test("research save refuses a note with no source, and creates no branch", async () => {
  const { vault, ctx } = setup();
  const r = await verb("research").run({ sub: "save", project: "ice-house", title: "T", note: "N", source: [] } as never, ctx);
  expect(r.exitCode).toBe(2);
  expect((r.body as { message: string }).message).toContain("at least one source");
  expect(sh(vault, "branch", "--list", "plan/*").trim()).toBe("");
});

test("fact record tags researched (source required), invented and author facts", async () => {
  const { vault, ctx } = setup();
  const record = (extra: Record<string, unknown>) => verb("fact").run({ sub: "record", project: "ice-house", where: "continuity", ...extra } as never, ctx);

  const noSource = await record({ fact: "Ice cost $4.", kind: "researched" });
  expect(noSource.exitCode).toBe(2);
  expect((noSource.body as { message: string }).message).toContain("researched fact needs a source");

  const researched = await record({ fact: "Ice cost $4 a ton.", kind: "researched", source: ["Smith, p. 12", "Almanac"] });
  expect(researched.exitCode).toBe(0);
  expect((researched.body as { line: string }).line).toContain("[researched: Smith, p. 12; Almanac]");

  const invented = await record({ fact: "The shed had a green door.", kind: "invented" });
  expect((invented.body as { line: string }).line).toContain("[invented]");
  const author = await record({ fact: "Cora hates winter.", kind: "author" });
  expect((author.body as { line: string }).line).toContain("[author]");

  const unknown = await record({ fact: "x", kind: "guess" });
  expect(unknown.exitCode).toBe(2);
  expect(sh(vault, "branch", "--list", "plan/*").trim()).not.toBe("");
});

test("fact record --promote needs established-by and writes facts.md", async () => {
  const { ctx } = setup();
  const r = await verb("fact").run({ sub: "record", project: "ice-house", fact: "Ice cost $4.", kind: "author", promote: true } as never, ctx);
  expect(r.exitCode).toBe(2);
  const ok = await verb("fact").run({ sub: "record", project: "ice-house", fact: "Ice cost $4.", kind: "author", promote: true, "established-by": "novel/ch01" } as never, ctx);
  expect(ok.exitCode).toBe(0);
  expect((ok.body as { path: string }).path).toBe("novels/ice-house/facts.md");
});

test("the CLI dispatches pablo research save and pablo fact record", async () => {
  const { vault, env } = setup();
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const logs: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try {
    const a = await main(["research", "save", "--project", "ice-house", "--title", "Ice", "--note", "Cold.", "--source", "https://a.test", "--source", "https://b.test", "--json"], vault);
    const b = await main(["fact", "record", "--project", "ice-house", "--fact", "Ice is cold.", "--where", "continuity", "--kind", "invented", "--json"], vault);
    expect(a).toBe(0);
    expect(b).toBe(0);
  } finally {
    console.log = log;
    for (const k of Object.keys(env)) if (saved[k] === undefined) delete process.env[k];
    Object.assign(process.env, saved);
  }
  expect(JSON.parse(logs[0] as string).path).toBe("novels/ice-house/research/ice.md");
  expect(sh(vault, "show", `${JSON.parse(logs[0] as string).branch}:novels/ice-house/research/ice.md`)).toContain("- https://b.test");
  expect(JSON.parse(logs[1] as string).line).toContain("[invented]");
});

test("save_research and record_fact are MCP tools with descriptions that run the same writers", async () => {
  const { vault, ctx } = setup();
  const tools = new Map(mcpTools().map((t) => [t.name, t]));
  for (const name of ["save_research", "record_fact"]) {
    const tool = tools.get(name);
    expect(tool?.description.length).toBeGreaterThan(40);
    expect("project" in (tool?.args.shape ?? {})).toBe(true);
  }
  const saved = await tools.get("save_research")!.run({ project: "ice-house", title: "Wind", note: "Gusty.", sources: ["https://w.test"] }, ctx);
  expect(saved.exitCode).toBe(0);
  const fact = await tools.get("record_fact")!.run({ project: "ice-house", fact: "Wind blew.", where: "continuity", kind: "researched", source: "W, p. 1" }, ctx);
  expect(fact.exitCode).toBe(0);
  expect(readFileSync(join(vault, "novels/ice-house/continuity.md"), "utf8")).not.toContain("Wind blew.");
  expect(planBranch(vault)).toMatch(/^plan\//);
});

test("the harness's session tools replace the same-named pablo mcp tools, so each name is attached once", () => {
  const { vault, ctx } = setup();
  const stub = (name: string) => ({ name, description: "session", args: verb("research").args, run: async () => ({ body: {}, exitCode: 0 }) });
  const spec = {
    work: { title: "The Ice House", format: "novel", slug: "ice-house" },
    projectPath: join(vault, "novels", "ice-house"),
    auth: harnessAuth(defaultConfig(), ctx.env, { env: {} }),
    ctx,
  };
  const count = (allowed: readonly string[] | undefined, name: string) => (allowed ?? []).filter((t) => t === name).length;
  expect(count(harnessOptions(spec).allowedTools, "mcp__pablo__save_research")).toBe(1);
  const withSession = harnessOptions({ ...spec, sessionTools: [stub("save_research"), stub("record_fact")] }).allowedTools;
  expect(count(withSession, "mcp__pablo__save_research")).toBe(1);
  expect(count(withSession, "mcp__pablo__record_fact")).toBe(1);
});
