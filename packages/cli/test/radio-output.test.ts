/**
 * The `radio` output type (AGT-1686, pm project `pablo-casting`): a row of `OUTPUTS` with its stage machine
 * (script -> cast -> perform -> mix -> fix -> publish), and the casting verbs asking it before they run.
 *
 * AC1: `pablo output add radio` on the migrated fixture work scaffolds outputs/radio/{plan.md,RULES.md}, one plan
 *      row per beat, and commits.
 * AC2: `perform --output radio --unit 3` with NED unbound is refused naming the role, exit 2, and runs nothing.
 * AC3: with the roles bound it returns the manifest version, the audio path and the receipt summary; the same
 *      body over MCP and from the harness.
 * AC4: `pablo resume` on a work with novel and radio outputs lists both over one core, with the episodes' render
 *      status and open flags.
 * AC5: the type passes the registry conformance run (`test/outputs.test.ts` runs every row; repeated here) and
 *      every Python call goes to a fake runner: nothing here loads a model, runs uv or Python.
 *
 * Everything runs on a temp git copy of the synthetic fixture vault with invented scripts; never `~/writing`.
 */

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Adapter, CompletionEvent } from "@openthink/pablo-core";
import { venvPython } from "../src/casting";
import type { CastingDeps } from "../src/casting";
import { readCoreState } from "../src/core/machine";
import { harnessTools } from "../src/harness/tools";
import { readMarker } from "../src/marker";
import { buildMcpServer } from "../src/mcp";
import { migrateOutputs } from "../src/migrate-outputs";
import { addOutput } from "../src/output-verbs";
import { runConformance } from "../src/outputs/conformance";
import { radioMachine } from "../src/outputs/radio/casting-side";
import { buildRadioPack } from "../src/outputs/radio/pack";
import { scriptRoles } from "../src/outputs/radio/script";
import { radioStageCheck } from "../src/outputs/radio/state";
import { OUTPUTS, outputIds } from "../src/outputs/registry";
import { buildResume, formatResumeProse } from "../src/resume";
import { runReviewView, parseCliArgs } from "../src/cli";
import { publishOutput, unitStatus, VERBS } from "../src/verbs";
import type { VerbContext } from "../src/verbs";
import { runWrite } from "../src/write";
import type { WriteArgs } from "../src/write";
import { useLocalConfigHome } from "./local-config";

useLocalConfigHome();

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const CONFORMANCE = fileURLToPath(new URL("./fixtures/conformance", import.meta.url));
const ROLE_NAMES = fileURLToPath(new URL("../../casting/tests/fixtures/role_names.json", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const STATE_HOME = mkdtempSync(join(tmpdir(), "pablo-radio-output-state-"));

const dirs: string[] = [];
const saved = { deps: radioMachine.deps, env: radioMachine.env };
beforeAll(() => {
  // The radio type's view of the casting side: never the host's uv or venv.
  radioMachine.env = () => ({ PATH: "/nowhere" });
});
afterEach(() => {
  radioMachine.deps = saved.deps;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  radioMachine.env = saved.env;
  rmSync(STATE_HOME, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8").trim();
}

/** The fixture vault in a temp git repository, ice-house migrated to the outputs layout (a novel output). */
function migratedVault(): { vault: string; work: string; home: string } {
  const dir = temp("pablo-radio-output-");
  const vault = join(dir, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "config", "commit.gpgsign", "false");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  const migrated = migrateOutputs(vault, work, { dryRun: false, now: () => new Date("2026-10-11T12:00:00Z") });
  if (!migrated.ok) throw new Error(`migrate failed: ${JSON.stringify(migrated)}`);
  return { vault, work, home: join(dir, "pablo-home") };
}

/** The migrated work with the radio output added (a novel and a radio over one core). */
function radioVault(): { vault: string; work: string; home: string } {
  const made = migratedVault();
  const added = addOutput(made.vault, made.work, "radio", { now: () => new Date("2026-10-12T12:00:00Z") });
  if (!added.ok) throw new Error(`output add failed: ${JSON.stringify(added)}`);
  return made;
}

/** An invented episode script with the given roles; every role described. */
function script(episode: number, roles: readonly string[] = ["CORA", "NED"]): string {
  const cast = roles.map((r) => `${r}=${r === "CORA" ? "f" : "m"} "forties, plain, even"`).join(", ");
  return [
    "---",
    `episode: ${episode}`,
    `title: Invented ${episode}`,
    "status: draft",
    "---",
    "",
    `CAST: ${cast}`,
    "[MUSIC: a thin organ line]",
    "NARRATOR: The pond froze early that year.",
    ...roles.filter((r) => r !== "NARRATOR").map((r, i) => `${r}: (dry) Invented line ${i + 1} of episode ${episode}.`),
    "[SFX: a door closes]",
    "",
  ].join("\n");
}

function writeEpisode(work: string, episode: number, roles: readonly string[] = ["NARRATOR", "CORA", "NED"]): void {
  mkdirSync(join(work, "outputs", "radio", "episodes"), { recursive: true });
  writeFileSync(join(work, "outputs", "radio", "episodes", `${String(episode).padStart(2, "0")}-invented-${episode}.md`), script(episode, roles));
}

function bind(work: string, roles: readonly string[]): void {
  const dir = join(work, "outputs", "radio", "casting");
  mkdirSync(dir, { recursive: true });
  const entries = Object.fromEntries(roles.map((r) => [r, { slug: r.toLowerCase(), card_hash: "h", by: "manual", at: "2026-10-11T00:00:00Z" }]));
  writeFileSync(join(dir, "cast.json"), JSON.stringify({ version: 1, roles: entries }));
}

/** Writes a manifest version for an episode, mixed (with its m4a on disk) or not. */
function render(work: string, episode: number, version: number, mixed: boolean): void {
  const tag = `ep${String(episode).padStart(2, "0")}`;
  const dir = join(work, "outputs", "radio", "casting", "renders", tag);
  mkdirSync(dir, { recursive: true });
  const audio = `${tag}.v${version}.m4a`;
  writeFileSync(join(dir, `v${version}.json`), JSON.stringify({ version, lines: [], ...(mixed ? { audio } : {}) }));
  if (mixed) writeFileSync(join(dir, audio), "fake-aac");
}

function flag(work: string, episode: number, count: number): void {
  const flags = Array.from({ length: count }, (_, i) => ({ id: `f${episode}-${i}`, episode, line: i, reason: "flat", by: "matt" }));
  const path = join(work, "outputs", "radio", "casting", "flags.json");
  const existing = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { flags: unknown[] }).flags : [];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ flags: [...existing, ...flags] }));
}

/**
 * A provisioned fake casting side: records argv; `perform` writes the manifest and a receipt the way the Python
 * side does and answers its body; anything else answers `{ok: true}`. Never runs a process.
 */
function fakeMachine(work: string): { deps: CastingDeps; calls: string[][] } {
  const source = temp("pablo-radio-casting-");
  writeFileSync(join(source, "pyproject.toml"), '[project]\nname = "pablo-casting"\n');
  writeFileSync(join(source, "uv.lock"), "version = 1\n");
  const venv = join(source, ".venv");
  const layout = { source, venv, install: "checkout" as const };
  mkdirSync(join(venv, "bin"), { recursive: true });
  writeFileSync(venvPython(layout), "");
  const lock = createHash("sha256").update(readFileSync(join(source, "uv.lock"))).digest("hex");
  writeFileSync(join(venv, ".pablo-provisioned.json"), JSON.stringify({ lock, at: "2026-10-11T00:00:00Z", extras: ["mix", "scorers"] }));
  const calls: string[][] = [];
  const deps: CastingDeps = {
    layout,
    which: () => "/fake/bin/uv",
    run: (argv) => {
      calls.push([...argv]);
      if (argv[3] === "perform") {
        const episode = Number((argv.find((a) => a.startsWith("--episode=")) ?? "=0").split("=")[1]);
        render(work, episode, 1, false);
        const receipts = join(work, ".pablo", "casting", "receipts.jsonl");
        mkdirSync(dirname(receipts), { recursive: true });
        appendFileSync(receipts, `${JSON.stringify({ at: "2026-10-11T12:00:00Z", intent: "perform", episode, engine: "chatterbox-turbo", version: 1, lines: 3, pass: 3, best_of_failed: 0, rtf_total: 0.4, load: { big: true } })}\n`);
        const manifest = join(work, "outputs", "radio", "casting", "renders", `ep0${episode}`, "v1.json");
        return { code: 0, stdout: JSON.stringify({ ok: true, episode, engine: "chatterbox-turbo", version: 1, manifest, lines: 3, message: `episode ${episode} v1` }), stderr: "" };
      }
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    },
    now: () => new Date("2026-10-11T12:00:00Z"),
  };
  return { deps, calls };
}

function ctxFor(vault: string, deps: CastingDeps, caller?: "cli" | "mcp"): VerbContext {
  return {
    cwd: vault,
    env: { PATH: "/nowhere", XDG_STATE_HOME: STATE_HOME },
    stderr: { write: () => undefined },
    casting: deps,
    ...(caller !== undefined ? { caller } : {}),
  };
}

function verb(name: string) {
  const found = VERBS.find((v) => v.name === name);
  if (found === undefined) throw new Error(`no verb ${name}`);
  return found;
}

/** Calls one tool on an in-process MCP server the way Claude Code (or the harness's SDK) would. */
async function callTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<unknown> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "fake-client", version: "0.0.0" });
  await client.connect(clientSide);
  try {
    const result = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[] };
    return JSON.parse(result.content[0]?.text ?? "null") as unknown;
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// The registry row
// ---------------------------------------------------------------------------

test("radio is a row of OUTPUTS: episodes in outputs/radio/episodes, draft/radio-epNN, its stages and targets", () => {
  const radio = OUTPUTS.radio;
  expect(outputIds()).toContain("radio");
  expect(radio.noun).toBe("episode");
  expect(radio.plural).toBe("episodes");
  expect(radio.artifactDir).toBe("outputs/radio/episodes");
  expect(radio.stages).toEqual(["script", "cast", "perform", "mix", "fix", "publish"]);
  expect(radio.publish.targets).toEqual(["bundle", "player", "stream"]);
  expect(radio.branch(3)).toBe("draft/radio-ep03");
  expect(radio.unitOfBranch("draft/radio-ep12-v2")).toBe(12);
  expect(radio.unitOfBranch("draft/ch03")).toBeUndefined();
  expect(radio.unitOfPath("novels/x/outputs/radio/episodes/07-the-well.md")).toBe(7);
  expect(radio.unitOfPath("novels/x/outputs/novel/07-the-well.md")).toBeUndefined();
  expect(radio.unitFileName(2, "Black Ice!")).toBe("02-black-ice.md");
  expect(radio.manuscript).toBe("lines");
  expect(typeof radio.ensure).toBe("function");
});

test("AC5: the radio type passes the registry conformance run over the four-beat fixture", async () => {
  const vault = temp("pablo-radio-conformance-");
  cpSync(CONFORMANCE, vault, { recursive: true });
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "config", "commit.gpgsign", "false");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  const work = join(vault, "novels", "four-beats");
  const marker = readMarker(work);
  if (!marker.ok) throw new Error(marker.message);
  const report = await runConformance(OUTPUTS.radio, {
    vaultRoot: vault,
    workDir: work,
    marker: marker.marker,
    writer: (_prompt, unit) => `CAST: NARRATOR=f "sixties, low, even"\nNARRATOR: Episode ${unit} begins.`,
    env: { PATH: "/usr/bin:/bin" },
    now: () => new Date("2026-10-11T12:00:00Z"),
  });
  expect(report.units).toEqual([1, 2, 3, 4]);
  expect(readdirSync(join(work, "outputs", "radio", "episodes")).sort()).toHaveLength(4);
  expect(report.rituals.slice(0, 6).map((r) => `${r.name}:${r.status}`)).toEqual(["note:ran", "readme:ran", "continuity:skipped", "cast:ran", "git:ran", "think:skipped"]);
  expect(report.rituals[3]?.detail).toContain("1 role(s) to cast (NARRATOR)");
  expect(report.published).toBe(join(work, ".pablo", "out", "four-beats-radio-bundle"));
  expect(JSON.parse(readFileSync(join(report.published, "bundle.json"), "utf8")).episodes).toHaveLength(4);
  // The outline's beat statuses are the core's: an episode never ticks them.
  expect(git(vault, "status", "--porcelain", "--untracked-files=no")).toBe("");
});

test("the role reader matches the Python side's role_names() over the shared fixture", () => {
  const cases = JSON.parse(readFileSync(ROLE_NAMES, "utf8")) as { name: string; script: string; roles: string[] }[];
  expect(cases.length).toBeGreaterThan(0);
  for (const c of cases) expect({ name: c.name, roles: scriptRoles(c.script) }).toEqual({ name: c.name, roles: c.roles });
});

// ---------------------------------------------------------------------------
// AC1: output add
// ---------------------------------------------------------------------------

test("AC1: output add radio on the migrated fixture work scaffolds plan.md (one row per beat) and RULES.md, and commits", () => {
  const { vault, work } = migratedVault();
  const result = addOutput(vault, work, "radio", { now: () => new Date("2026-10-12T12:00:00Z") });
  expect(result).toMatchObject({ ok: true, action: "add", type: "radio", committed: true });
  const plan = readFileSync(join(work, "outputs", "radio", "plan.md"), "utf8");
  const rows = plan.split("\n").filter((l) => /^\|\s*\d+\s*\|/.test(l));
  expect(rows).toHaveLength(OUTPUTS.radio.plan(work).length);
  expect(rows.length).toBe(4);
  expect(rows[0]).toContain("The Last Full Cut");
  expect(readFileSync(join(work, "outputs", "radio", "RULES.md"), "utf8")).toBe(OUTPUTS.radio.rulesTemplate);
  expect(readMarker(work)).toMatchObject({ ok: true, marker: { outputs: { novel: expect.anything(), radio: { added: "2026-10-12" } } } });
  expect(git(vault, "log", "-1", "--format=%s")).toBe("ice-house: add the radio output");
  expect(git(vault, "status", "--porcelain")).toBe("");
});

// ---------------------------------------------------------------------------
// The script stage: preconditions, pack, write
// ---------------------------------------------------------------------------

test("an episode needs the one before it, and its pack carries the radio rules, the previous episode's summary, never a novel chapter or research", () => {
  const { vault, work } = radioVault();
  expect(OUTPUTS.radio.preconditions(work, 2)).toEqual({ ready: false, missing: ["episode 1 is not written"] });
  writeEpisode(work, 1);
  expect(OUTPUTS.radio.preconditions(work, 2)).toEqual({ ready: true, missing: [] });
  const marker = readMarker(work);
  if (!marker.ok) throw new Error(marker.message);
  const packed = buildRadioPack(vault, work, 2, { marker: marker.marker, output: "radio" });
  if (!packed.ok) throw new Error(packed.message);
  const slice = (name: string) => packed.pack.slices.find((s) => s.name === name);
  expect(slice("outputRules")?.source).toBe("novels/ice-house/outputs/radio/RULES.md");
  const previous = slice("previousTail");
  expect(previous?.source).toBe("novels/ice-house/outputs/radio/episodes/01-invented-1.md");
  expect(previous?.text).toContain('Episode 1, "Invented 1", in summary.');
  expect(previous?.text).toContain("NARRATOR: The pond froze early that year.");
  expect(previous?.text).toContain("NED: Invented line 2 of episode 1.");
  expect(previous?.text).not.toContain("(dry)");
  expect(previous?.text).not.toContain("CAST:");
  expect(packed.pack.prompt).toContain("You are drafting episode 2 of a radio drama");
  for (const s of packed.pack.slices) {
    expect(s.source ?? "").not.toContain("/chapters/");
    expect(s.source ?? "").not.toContain("research/");
    expect(s.source ?? "").not.toContain("outputs/novel/");
  }
});

function fakeScriptWriter(): Adapter {
  return {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text",
    async *complete(): AsyncIterable<CompletionEvent> {
      yield { type: "token", text: 'CAST: CORA=f "thirties, dry. exact", NED=m "forties, slow"\n[MUSIC: the theme. an organ swell]\n' };
      yield { type: "token", text: "NARRATOR: Winter. The pond.\nCORA: (dry) I said no. I meant it. Mr. Hale knows.\nNED: Fine.\n[SFX: a door slams]" };
      yield { type: "done", stats: { timeToFirstTokenMs: 10, elapsedMs: 20, tokensRead: 100, tokensWritten: 30, tokensPerSecond: 600 } };
    },
    async proposeEdit(): Promise<never> {
      throw new Error("not used");
    },
    async extractFacts(): Promise<never> {
      throw new Error("not used");
    },
  };
}

test("write --output radio stores the script line for line: a cue never joins a speaker, a speech is never split into sentences", async () => {
  const { vault, work, home } = radioVault();
  const lines: string[] = [];
  const log = console.log;
  console.log = (text: unknown) => void lines.push(String(text));
  let code: number;
  try {
    code = await runWrite(
      { chapter: undefined, output: "radio", unit: "1", words: undefined, scenes: undefined, dryRun: false, json: true, force: false } as WriteArgs,
      vault,
      work,
      { adapter: fakeScriptWriter(), env: { PATH: NO_THINK_PATH, XDG_STATE_HOME: STATE_HOME, PABLO_HOME: home }, stderr: { write: () => {} }, now: () => new Date("2026-10-12T12:00:00Z") },
    );
  } finally {
    console.log = log;
  }
  expect(code).toBe(0);
  expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: true, branch: "draft/radio-ep01", path: "outputs/radio/episodes/01-the-last-full-cut.md" });
  const text = git(vault, "show", "draft/radio-ep01:novels/ice-house/outputs/radio/episodes/01-the-last-full-cut.md");
  expect(text).toContain("episode: 1");
  expect(text).toContain('\nCAST: CORA=f "thirties, dry. exact", NED=m "forties, slow"\n[MUSIC: the theme. an organ swell]\nNARRATOR: Winter. The pond.\n');
  expect(text).toContain("\nCORA: (dry) I said no. I meant it. Mr. Hale knows.\n");
  expect(scriptRoles(text)).toEqual(["CORA", "NED", "NARRATOR"]);
});

// ---------------------------------------------------------------------------
// AC2, AC3: perform through the stage machine
// ---------------------------------------------------------------------------

test("AC2: perform --output radio --unit 3 with NED unbound is refused naming the role, exit 2, and runs nothing", async () => {
  const { vault, work } = radioVault();
  for (const n of [1, 2, 3]) writeEpisode(work, n);
  bind(work, ["NARRATOR", "CORA"]);
  const { deps, calls } = fakeMachine(work);
  const result = await verb("perform").run({ project: "ice-house", output: "radio", unit: 3, "json-lines": false }, ctxFor(vault, deps));
  expect(result.exitCode).toBe(2);
  expect(result.body).toMatchObject({ ok: false, code: 2, output: "radio", unit: 3, stage: "perform", missing: ["role NED is not cast"] });
  expect(calls).toEqual([]);
  expect(existsSync(join(work, "outputs", "radio", "casting", "renders"))).toBe(false);
});

test("the casting verbs' other stage refusals: no script, already performed, mix before perform, fix with no flags, cast --auto with no script", async () => {
  const { vault, work } = radioVault();
  writeEpisode(work, 1);
  bind(work, ["NARRATOR", "CORA", "NED"]);
  render(work, 1, 1, true);
  const { deps, calls } = fakeMachine(work);
  const ctx = ctxFor(vault, deps);
  const run = (name: string, args: Record<string, unknown>) => verb(name).run(args as never, ctx);
  expect((await run("perform", { project: "ice-house", output: "radio", unit: 2, "json-lines": false })).body).toMatchObject({
    missing: ["episode 2 has no script (pablo write --output radio --unit 2)"],
  });
  expect((await run("perform", { project: "ice-house", episode: 1, "json-lines": false })).body).toMatchObject({
    missing: ["episode 1 is already performed (v1); re-record flagged lines with pablo fix"],
  });
  expect((await run("mix", { project: "ice-house", output: "radio", unit: 2 })).exitCode).toBe(2);
  expect((await run("fix", { project: "ice-house", output: "radio", unit: 1, "json-lines": false })).body).toMatchObject({
    missing: ["episode 1 has no open flags (flag lines in pablo review)"],
  });
  expect((await run("cast", { project: "ice-house", auto: true, all: false, recast: false, output: "radio", unit: 2 })).exitCode).toBe(2);
  // Addressing: another output, a bare --unit, and two different episodes are refused by name.
  expect((await run("perform", { project: "ice-house", output: "novel", unit: 1, "json-lines": false })).body).toMatchObject({ missing: ["--output radio", "--output narrated"] });
  expect((await run("perform", { project: "ice-house", unit: 1, "json-lines": false })).body).toMatchObject({ missing: ["--output radio"] });
  expect((await run("perform", { project: "ice-house", output: "radio", unit: 1, episode: 2, "json-lines": false })).exitCode).toBe(2);
  expect(calls).toEqual([]);
  // With a flag the fix stage runs; cast --auto for a written episode runs.
  flag(work, 1, 1);
  expect((await run("fix", { project: "ice-house", output: "radio", unit: 1, "json-lines": false })).exitCode).toBe(0);
  expect((await run("cast", { project: "ice-house", auto: true, all: false, recast: false, output: "radio", unit: 1 })).exitCode).toBe(0);
  expect(calls.map((c) => c[3])).toEqual(["fix", "cast"]);
  expect(calls[1]).toContain("--episode=1");
});

test("--output radio on a work without a radio output is refused naming `output add`", async () => {
  const { vault, work } = migratedVault();
  writeEpisode(work, 1);
  const { deps, calls } = fakeMachine(work);
  const result = await verb("perform").run({ project: "ice-house", output: "radio", unit: 1, "json-lines": false }, ctxFor(vault, deps));
  expect(result.exitCode).toBe(2);
  expect(result.body).toMatchObject({ missing: ["output radio (pablo output add radio)"] });
  expect(calls).toEqual([]);
});

test("AC3: with the roles bound, perform returns the manifest version, the audio path and the receipt summary, the same over MCP and from the harness", async () => {
  const { vault, work } = radioVault();
  for (const n of [1, 2, 3]) writeEpisode(work, n);
  bind(work, ["NARRATOR", "CORA", "NED"]);
  const { deps, calls } = fakeMachine(work);
  const args = { project: "ice-house", output: "radio", unit: 3 };
  const clean = () => rmSync(join(work, "outputs", "radio", "casting", "renders"), { recursive: true, force: true });

  const cli = await verb("perform").run({ ...args, "json-lines": false }, ctxFor(vault, deps, "cli"));
  expect(cli.exitCode).toBe(0);
  expect(cli.body).toMatchObject({
    ok: true,
    output: "radio",
    unit: 3,
    version: 1,
    manifest: join(work, "outputs", "radio", "casting", "renders", "ep03", "v1.json"),
    audio: null,
    next: "pablo mix --output radio --unit 3",
    receiptSummary: { intent: "perform", episode: 3, engine: "chatterbox-turbo", version: 1, lines: 3, pass: 3, best_of_failed: 0, rtf_total: 0.4 },
    provisioned: false,
  });
  expect((cli.body as { receiptSummary: Record<string, unknown> }).receiptSummary["load"]).toBeUndefined();
  expect(calls.at(-1)?.slice(3)).toEqual(["perform", "--episode=3", `--vault=${vault}`, "--work", work, "--json"]);

  clean();
  const mcp = await callTool(buildMcpServer(ctxFor(vault, deps, "mcp")), "perform", args);
  clean();
  const harness = await callTool(buildMcpServer(ctxFor(vault, deps, "mcp"), harnessTools()), "perform", args);
  expect(mcp).toEqual(cli.body);
  expect(harness).toEqual(cli.body);
  expect(calls.filter((c) => c[3] === "perform")).toHaveLength(3);
});

test("a mixed episode's perform/fix body names its audio", async () => {
  const { vault, work } = radioVault();
  writeEpisode(work, 1);
  bind(work, ["NARRATOR", "CORA", "NED"]);
  render(work, 1, 1, true);
  flag(work, 1, 2);
  const { deps } = fakeMachine(work);
  const result = await verb("fix").run({ project: "ice-house", output: "radio", unit: 1, "json-lines": false }, ctxFor(vault, deps));
  expect(result.exitCode).toBe(0);
  expect(result.body).toMatchObject({ output: "radio", unit: 1, audio: join(work, "outputs", "radio", "casting", "renders", "ep01", "ep01.v1.m4a") });
});

// ---------------------------------------------------------------------------
// status --for "radio N"
// ---------------------------------------------------------------------------

function fakeRadioSide(uv: boolean, provisioned: boolean): void {
  const source = temp("pablo-radio-side-");
  writeFileSync(join(source, "pyproject.toml"), '[project]\nname = "pablo-casting"\n');
  writeFileSync(join(source, "uv.lock"), "version = 1\n");
  const layout = { source, venv: join(source, ".venv"), install: "checkout" as const };
  if (provisioned) {
    mkdirSync(join(layout.venv, "bin"), { recursive: true });
    writeFileSync(venvPython(layout), "");
    const lock = createHash("sha256").update(readFileSync(join(source, "uv.lock"))).digest("hex");
    writeFileSync(join(layout.venv, ".pablo-provisioned.json"), JSON.stringify({ lock, at: "x", extras: [] }));
  }
  radioMachine.deps = () => ({
    layout,
    which: () => (uv ? "/fake/bin/uv" : undefined),
    run: () => {
      throw new Error("status never runs anything");
    },
    now: () => new Date(),
  });
}

test('status --for "radio 3" reports the unbound roles, the missing render and an unprovisioned Python side, and runs nothing', () => {
  const { work } = radioVault();
  for (const n of [1, 2, 3]) writeEpisode(work, n);
  bind(work, ["NARRATOR", "CORA"]);
  fakeRadioSide(true, false);
  const status = unitStatus(work, "radio 3");
  expect(status.exitCode).toBe(2);
  expect(status.body).toMatchObject({
    ready: false,
    missing: [
      "role NED is not cast",
      "episode 3 has no render (pablo perform --output radio --unit 3)",
      "the casting side is not provisioned (the first casting verb provisions it)",
    ],
    stage: "cast",
    unbound: ["NED"],
    render: "none",
    openFlags: 0,
    casting: { state: "not provisioned" },
  });
  expect(status.label).toBe("episode 3");
  expect(status.lines).toContain("unbound roles: NED");

  // No uv: the side cannot be provisioned here, and status says what to install.
  fakeRadioSide(false, false);
  expect((unitStatus(work, "radio 3").body as { missing: string[] }).missing.at(-1)).toBe("the casting side cannot be provisioned here: uv (brew install uv)");
});

test('status --for "radio N" through the stages: performed, mixed with flags, and done', () => {
  const { work } = radioVault();
  writeEpisode(work, 1);
  bind(work, ["NARRATOR", "CORA", "NED"]);
  fakeRadioSide(true, true);
  render(work, 1, 1, false);
  expect(unitStatus(work, "radio 1").body).toMatchObject({ ready: false, stage: "mix", render: "performed v1", missing: ["episode 1 is not mixed (pablo mix --output radio --unit 1)"] });
  render(work, 1, 1, true);
  flag(work, 1, 2);
  expect(unitStatus(work, "radio 1").body).toMatchObject({ ready: false, stage: "fix", render: "mixed v1", openFlags: 2, missing: ["episode 1 has 2 open flag(s) (pablo fix --output radio --unit 1)"] });
  writeFileSync(join(work, "outputs", "radio", "casting", "flags.json"), JSON.stringify({ flags: [] }));
  const done = unitStatus(work, "radio 1");
  expect(done.exitCode).toBe(0);
  expect(done.body).toMatchObject({ ready: true, missing: [], stage: "publish", casting: { state: "provisioned" } });
  expect((done.body as { stages: { stage: string; done: boolean }[] }).stages.filter((s) => s.done).map((s) => s.stage)).toEqual(["script", "cast", "perform", "mix", "fix"]);
  // The novel's `status --for` is unchanged: its preconditions, nothing more.
  expect(Object.keys(unitStatus(work, "novel 2").body as object).sort()).toEqual(["missing", "ready"]);
});

// ---------------------------------------------------------------------------
// AC4: resume
// ---------------------------------------------------------------------------

test("AC4: resume on a work with novel and radio outputs lists both over one core, with the episodes' render status and open flags", async () => {
  const { work } = radioVault();
  writeEpisode(work, 1);
  writeEpisode(work, 2);
  bind(work, ["NARRATOR", "CORA", "NED"]);
  render(work, 1, 1, true);
  render(work, 2, 1, false);
  flag(work, 1, 2);
  const result = await buildResume(work, "ice-house", { env: { PATH: NO_THINK_PATH }, timeoutMs: 1000 });
  expect(Object.keys(result.outputs)).toEqual(["novel", "radio"]);
  expect(result.core.stages.length).toBeGreaterThan(0);
  const radio = result.outputs["radio"]!;
  expect(radio.units.map((u) => [u.unit, u.render, u.openFlags])).toEqual([
    [1, "mixed v1", 2],
    [2, "performed v1", 0],
    [3, "none", 0],
    [4, "none", 0],
  ]);
  expect(radio.drafted).toBe(2);
  expect(radio.next).toBe("write episode 3 (pablo write --output radio --unit 3)");
  const prose = formatResumeProse(result);
  expect(prose).toContain("novel: 1 of 4 chapters drafted");
  expect(prose).toContain("radio: 2 of 4 episodes drafted; 1 mixed, 1 performed, 2 open flags");
  expect(result.outputs["novel"]!.units.every((u) => u.render === undefined)).toBe(true);
});

test("once every episode is written, the radio output's next is the first episode's next casting stage", () => {
  const { work } = radioVault();
  for (const n of [1, 2, 3, 4]) writeEpisode(work, n);
  bind(work, ["NARRATOR", "CORA"]);
  const report = OUTPUTS.radio.report(work, readCoreState(work));
  expect(report.next).toBe("cast episode 1's roles (pablo cast --auto --episode 1, or pablo bind)");
});

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

test("publish --output radio --target bundle writes the episodes' m4as and manifests (and scripts) to one directory", () => {
  const { work } = radioVault();
  writeEpisode(work, 1);
  writeEpisode(work, 2);
  render(work, 1, 1, true);
  render(work, 1, 2, true);
  render(work, 2, 1, false);
  const result = publishOutput(work, "bundle", "radio");
  expect(result.exitCode).toBe(0);
  const dir = join(work, ".pablo", "out", "ice-house-radio-bundle");
  expect(result.body).toMatchObject({ ok: true, output: "radio", target: "bundle", where: dir, chapters: 2 });
  expect((result.body as { notes: string[] }).notes).toEqual(["episode 2 has no mixed audio yet (pablo perform, then pablo mix): script only"]);
  expect(readdirSync(dir).sort()).toEqual(["bundle.json", "ep01.json", "ep01.m4a", "scripts"]);
  expect(readdirSync(join(dir, "scripts")).sort()).toEqual(["01-invented-1.md", "02-invented-2.md"]);
  expect(JSON.parse(readFileSync(join(dir, "ep01.json"), "utf8"))).toMatchObject({ version: 2, audio: "ep01.v2.m4a" });
  const bundle = JSON.parse(readFileSync(join(dir, "bundle.json"), "utf8")) as { episodes: Record<string, unknown>[] };
  expect(bundle.episodes).toEqual([
    { episode: 1, script: "scripts/01-invented-1.md", audio: "ep01.m4a", manifest: "ep01.json", version: 2 },
    { episode: 2, script: "scripts/02-invented-2.md", audio: null, manifest: null, version: null },
  ]);
  // The casting directory is untouched: copied, never moved.
  expect(existsSync(join(work, "outputs", "radio", "casting", "renders", "ep01", "ep01.v2.m4a"))).toBe(true);
});

test("the player target is named and refused, stream with nothing mixed is refused (AGT-1697); an unknown target lists the radio targets", () => {
  const { work } = radioVault();
  writeEpisode(work, 1);
  expect((publishOutput(work, "player", "radio").body as { message: string }).message).toContain("pablo review --project ice-house");
  expect((publishOutput(work, "stream", "radio").body as { message: string }).message).toContain("no radio episode has mixed audio yet");
  expect((publishOutput(work, "draft", "radio").body as { message: string }).message).toContain("bundle|player|stream");
});

// ---------------------------------------------------------------------------
// review and ensure
// ---------------------------------------------------------------------------

test("pablo review --episode N on an unmixed episode is refused by the stage machine before any window", async () => {
  const { work } = radioVault();
  writeEpisode(work, 1);
  render(work, 1, 1, false);
  expect(radioStageCheck(work, "review", 1)).toEqual({ ready: false, missing: ["episode 1 has no mixed audio yet (pablo perform, then pablo mix)"] });
  let opened = 0;
  const log = console.log;
  const lines: string[] = [];
  console.log = (text: unknown) => void lines.push(String(text));
  try {
    const code = await runReviewView(parseCliArgs(["review", "--project", "ice-house", "--episode", "1", "--json"]), work, async () => {
      opened += 1;
      throw new Error("never opened");
    });
    expect(code).toBe(2);
  } finally {
    console.log = log;
  }
  expect(opened).toBe(0);
  expect(JSON.parse(lines.join("\n"))).toMatchObject({ ok: false, code: 2, missing: ["episode 1 has no mixed audio yet (pablo perform, then pablo mix)"] });
});

test("ensure() only looks: provisioned or provisionable is ok, no uv and no venv is a refusal naming uv; it never runs anything", async () => {
  fakeRadioSide(true, false);
  expect(await OUTPUTS.radio.ensure?.()).toEqual({ ok: true });
  fakeRadioSide(false, true);
  expect(await OUTPUTS.radio.ensure?.()).toEqual({ ok: true });
  fakeRadioSide(false, false);
  expect(await OUTPUTS.radio.ensure?.()).toMatchObject({ ok: false, missing: ["uv (brew install uv)"] });
});
