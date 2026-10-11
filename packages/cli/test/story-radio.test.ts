/**
 * AGT-1700 (pm project `pablo-casting`, C22): the radio output in `pablo story` and in `pablo perform
 * --output radio --all` on a work whose radio output was added later. Every run is on a temp git copy of the
 * synthetic fixture vault; the harness is a fake `HarnessQuery` calling pablo's own tools, the writer a fake
 * adapter that writes radio scripts (or prose), and the casting side a fake `CastingDeps` that writes what
 * the Python side writes (cast.json, manifests, the stream) without uv, Python or a model. Never ~/writing.
 */

import { afterEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { continuityFile, defaultConfig } from "@openthink/pablo-core";
import type { Adapter, CompletionEvent, CompletionRequest } from "@openthink/pablo-core";
import { venvPython } from "../src/casting";
import type { CastingDeps, CastingLayout } from "../src/casting";
import { harnessAuth } from "../src/harness/auth";
import type { HarnessQuery } from "../src/harness/session";
import { mergeChanges, mergeDraftInProject } from "../src/novel/merge";
import { radioMachine } from "../src/outputs/radio/casting-side";
import { scriptRoles } from "../src/outputs/radio/script";
import { streamRoot } from "../src/radio-stream";
import { runStory } from "../src/story";
import type { StoryDeps } from "../src/story";
import { VERBS } from "../src/verbs";
import type { VerbContext } from "../src/verbs";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");

/** Matt's spec example (pablo-casting decision 6). */
const SPEC =
  "research 1900 Italian Riviera fishing villages and write me a story about a family who lives there and discovers an opportunity to move to the United States";

/** Planted in the research note: it must never reach a writer's prompt (AC6). */
const CANARY = "RESEARCH-CANARY-Bertolotto-ledger-1899";

/** A whole run (core, git merges, every episode) is seconds of work; under a loaded full suite, more. */
const SLOW = 60_000;

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8").trim();
}

function tempVault(): { root: string; vault: string; env: Record<string, string>; ctx: VerbContext } {
  const root = temp("pablo-story-radio-");
  const vault = join(root, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "config", "commit.gpgsign", "false");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  const env = {
    PABLO_VAULT: vault,
    PABLO_HOME: join(root, "pablo-home"),
    PATH: NO_THINK_PATH,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    HF_HOME: join(root, "hf"),
  };
  return { root, vault, env, ctx: { cwd: vault, env, stderr: { write: () => {} } } };
}

// ---------------------------------------------------------------------------
// The fake harness: the core through pablo's own tools
// ---------------------------------------------------------------------------

const success = (result: string) =>
  ({ type: "result", subtype: "success", is_error: false, result, num_turns: 2, duration_ms: 10, total_cost_usd: 0 }) as unknown as SDKMessage;

type Call = readonly [string, Record<string, unknown>];

const BEATS = [
  "| # | Story date | Title (working) | Beat | POV | Status |",
  "|---|---|---|---|---|---|",
  "| 1 | Spring 1900 | The Letter | A letter from a cousin in New York reaches Rosa's kitchen in Camogli. | Rosa | outline |",
  "| 2 | Summer 1900 | The Catch | Paolo's boat comes back light three weeks running; the price of anchovies falls. | Paolo | outline |",
  "| 3 | Autumn 1900 | The Ticket | Rosa sells her mother's coral to buy one passage, not two. | Rosa | outline |",
  "| 4 | Winter 1900 | The Quay | The family on the quay at Genoa, deciding who boards. | Rosa | outline |",
].join("\n");

const STAGE_CALLS: Readonly<Record<string, readonly Call[]>> = {
  research: [
    [
      "save_research",
      {
        title: "Ligurian fishing villages, 1900",
        note: `Camogli's fleet fished anchovy and sardine; emigration to New York ran through Genoa. ${CANARY}`,
        sources: ["https://example.org/liguria-1900"],
      },
    ],
  ],
  premise: [
    [
      "propose",
      {
        stage: "premise",
        content:
          "# Overview\n\n## Logline\n\nA fishing family in 1900 Camogli is offered one passage to New York and has to decide who takes it.\n\n## Premise\n\nThe sea is failing them.\n\n## Themes\n\n- Leaving.\n\n## Tone\n\nPlain.\n\n## Structure\n\nFour seasons.\n",
      },
    ],
  ],
  bible: [
    ["propose", { stage: "cast", name: "rosa", content: "# Rosa Bertolotto\n\nThe mother; keeps the household accounts.\n" }],
    ["propose", { stage: "places", content: "# Places\n\n- Camogli: the harbour town.\n- Genoa: the emigrant quay.\n" }],
    ["propose", { stage: "timeline", content: "# Timeline\n\n| Year | Real events | In the story |\n|---|---|---|\n| 1900 | emigration through Genoa peaks | the cousin's letter arrives |\n" }],
  ],
  acts: [["propose", { stage: "acts", content: "| Act | Years | What it accomplishes |\n|---|---|---|\n| I | 1900 | The offer comes and the sea fails. |\n| II | 1900 | The choice on the quay. |" }]],
  beats: [["propose", { stage: "beats", content: BEATS }]],
};

function fakeHarness(): { query: HarnessQuery; stages: string[] } {
  const stages: string[] = [];
  const query: HarnessQuery = async function* (params) {
    const stage = /Stage \d of 5, (\w+)\./.exec(params.prompt)?.[1] ?? "unknown";
    stages.push(stage);
    const instance = (params.options.mcpServers?.["pablo"] as { instance: McpServer }).instance;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await instance.connect(serverSide);
    const client = new Client({ name: "fake-sdk", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      for (const [name, args] of STAGE_CALLS[stage] ?? []) {
        const called = await client.callTool({ name, arguments: args });
        const body = JSON.parse((called.content as { text: string }[])[0]!.text) as { ok: boolean; message?: string };
        if (body.ok !== true) throw new Error(`${name} refused: ${body.message}`);
      }
    } finally {
      await client.close();
    }
    yield success(`${stage} done`);
  };
  return { query, stages };
}

// ---------------------------------------------------------------------------
// The fake writers: radio scripts (one per call, in episode order) and prose
// ---------------------------------------------------------------------------

interface ScriptWriter extends Adapter {
  calls: number;
  readonly prompts: string[];
}

/**
 * Writes episode k's script on its k-th call (the writer queue is serial). `roles(k)` names the episode's
 * speaking roles (default NARRATOR and ROSA); `before(k)` runs before the k-th script is written.
 */
function scriptWriter(options: { roles?: (k: number) => readonly string[]; before?: (k: number) => Promise<void> } = {}): ScriptWriter {
  const writer: ScriptWriter = {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text",
    calls: 0,
    prompts: [],
    async *complete(request: CompletionRequest): AsyncIterable<CompletionEvent> {
      writer.calls += 1;
      const k = writer.calls;
      writer.prompts.push(request.prompt);
      await options.before?.(k);
      const roles = options.roles?.(k) ?? ["NARRATOR", "ROSA"];
      const cast = roles.map((r) => `${r}=${r === "NARRATOR" ? "m" : "f"} "forties, even, warm"`).join(", ");
      const lines = roles.map((r) => `${r}: Episode ${k}, and ${r.toLowerCase()} speaks.`);
      yield { type: "token", text: `CAST: ${cast}\n[MUSIC: the theme. an organ swell]\n${lines.join("\n")}` };
      yield { type: "done", stats: { timeToFirstTokenMs: 5, elapsedMs: 10, tokensRead: 100, tokensWritten: 30, tokensPerSecond: 3000 } };
    },
    async extractFactsWithAnchors() {
      return [];
    },
    async proposeEdit(): Promise<never> {
      throw new Error("not used");
    },
    async extractFacts(): Promise<never> {
      throw new Error("not used");
    },
  } as unknown as ScriptWriter;
  return writer;
}

function proseWriter(): Adapter & { prompts: string[] } {
  const writer = {
    id: "local",
    model: "test-writer-model",
    preferredOutput: "text" as const,
    prompts: [] as string[],
    async *complete(request: CompletionRequest): AsyncIterable<CompletionEvent> {
      writer.prompts.push(request.prompt);
      yield { type: "token", text: "Rosa read the letter twice at the kitchen table.\nThe boat came back light again." };
      yield { type: "done", stats: { timeToFirstTokenMs: 5, elapsedMs: 10, tokensRead: 100, tokensWritten: 30, tokensPerSecond: 3000 } };
    },
    async extractFactsWithAnchors() {
      return [{ fact: "Rosa reads the letter at the kitchen table", entities: ["Rosa"], storyTime: undefined, certainty: undefined, anchor: "Rosa read the letter twice" }];
    },
    async proposeEdit(): Promise<never> {
      throw new Error("not used");
    },
    async extractFacts(): Promise<never> {
      throw new Error("not used");
    },
  };
  return writer as unknown as Adapter & { prompts: string[] };
}

// ---------------------------------------------------------------------------
// The fake casting side: what the Python side writes, through the runner seam
// ---------------------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(2, "0");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FakeMachine {
  readonly deps: CastingDeps;
  /** Every runner call, as `<command> <episode>` (`sync`, `pull`, `cast 1`, `perform 1 stream`, `mix 1`). */
  readonly calls: string[];
  readonly layout: CastingLayout;
}

function episodeScriptText(work: string, episode: number): string {
  const dir = join(work, "outputs", "radio", "episodes");
  const name = readdirSync(dir).find((n) => n.startsWith(`${pad(episode)}-`));
  return name === undefined ? "" : readFileSync(join(dir, name), "utf8");
}

function writeManifest(work: string, episode: number, mixed: boolean): void {
  const dir = join(work, "outputs", "radio", "casting", "renders", `ep${pad(episode)}`);
  mkdirSync(dir, { recursive: true });
  const audio = `ep${pad(episode)}.v1.m4a`;
  if (mixed) writeFileSync(join(dir, audio), `fake-m4a-${episode}`);
  const manifest = {
    episode,
    version: 1,
    parent: null,
    changed_lines: [0],
    flags_applied: [],
    ...(mixed ? { audio, duration: 12 } : {}),
    lines: [{ i: 0, speaker: "ROSA", text: "line", take: "a".repeat(64), gates: {}, failing: [] }],
  };
  writeFileSync(join(dir, "v1.json"), JSON.stringify(manifest));
}

/**
 * A fake casting side. `cast --auto` binds every role of the episode's script (NARRATOR by match, the rest
 * designed), refusing a role named GHOST the way `design.py` refuses an uncastable one; `perform` writes a
 * manifest (`--stream`: mixed, after `engineMs`); `mix` adds the audio. `autoFlag` episodes get perform's
 * automatic flag. `syncFails` makes `uv sync` fail.
 */
function fakeMachine(options: { engineMs?: number; autoFlag?: readonly number[]; syncFails?: boolean; uv?: boolean } = {}): FakeMachine {
  const root = temp("pablo-story-radio-machine-");
  const source = join(root, "casting");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "pyproject.toml"), '[project]\nname = "pablo-casting"\n', "utf8");
  writeFileSync(join(source, "uv.lock"), "version = 1\n", "utf8");
  const layout: CastingLayout = { source, venv: join(source, ".venv"), install: "checkout" };
  const calls: string[] = [];
  const episodeOf = (argv: readonly string[]) => Number(argv.find((a) => a.startsWith("--episode="))?.slice("--episode=".length));
  const workOf = (argv: readonly string[]) => argv[argv.indexOf("--work") + 1] as string;
  const json = (code: number, body: unknown) => ({ code, stdout: JSON.stringify(body), stderr: "" });

  const flag = (work: string, episode: number) => {
    if (!(options.autoFlag ?? []).includes(episode)) return;
    const path = join(work, "outputs", "radio", "casting", "flags.json");
    const body = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { flags: unknown[] }) : { flags: [] };
    body.flags.push({ episode, line: 0, by: "auto", reason: "other", failing: ["sim_card"] });
    writeFileSync(path, JSON.stringify(body));
  };

  const deps: CastingDeps = {
    layout,
    which: () => (options.uv === false ? undefined : "/fake/bin/uv"),
    run: (argv) => {
      if (argv[1] === "sync") {
        calls.push("sync");
        if (options.syncFails) return { code: 1, stdout: "", stderr: "resolution failed" };
        mkdirSync(join(layout.venv, "bin"), { recursive: true });
        writeFileSync(venvPython(layout), "", "utf8");
        return { code: 0, stdout: "", stderr: "" };
      }
      const command = argv[3];
      if (command === "pull") {
        calls.push("pull");
        return json(0, { ok: true, weights: [] });
      }
      const episode = episodeOf(argv);
      const work = workOf(argv);
      if (command === "cast") {
        calls.push(`cast ${episode}${argv.includes("--design") ? " design" : ""}`);
        const roles = scriptRoles(episodeScriptText(work, episode));
        if (roles.includes("GHOST")) {
          return json(2, { ok: false, code: 2, message: "pablo cast --auto --design: no voice could be designed for GHOST after one re-phrased retry", missing: ["role GHOST"], role: "GHOST" });
        }
        const path = join(work, "outputs", "radio", "casting", "cast.json");
        mkdirSync(dirname(path), { recursive: true });
        const body = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { version: number; roles: Record<string, unknown> }) : { version: 1, roles: {} };
        const bound: string[] = [];
        for (const role of roles) {
          if (body.roles[role] !== undefined) continue;
          const by = role === "NARRATOR" ? "match" : "design";
          body.roles[role] = { slug: role.toLowerCase(), card_hash: `h-${role}`, by, score: by === "match" ? 0.82 : 0.71, at: "2026-10-11T12:00:00Z" };
          bound.push(role);
        }
        writeFileSync(path, JSON.stringify(body));
        return json(0, { ok: true, bound, needsDesign: [], designed: bound.filter((r) => r !== "NARRATOR") });
      }
      if (command === "perform") {
        calls.push(`perform ${episode}`);
        writeManifest(work, episode, false);
        flag(work, episode);
        return json(0, { ok: true, episode, version: 1 });
      }
      if (command === "mix") {
        calls.push(`mix ${episode}`);
        writeManifest(work, episode, true);
        return json(0, { ok: true, episode, version: 1 });
      }
      return json(1, { ok: false, code: 1, message: `the fake has no ${String(command)}` });
    },
    stream: async (argv, _options, onLine) => {
      const episode = episodeOf(argv);
      const work = workOf(argv);
      calls.push(`perform ${episode} stream`);
      onLine(JSON.stringify({ event: "start", episode, stream: true }));
      await sleep(options.engineMs ?? 0);
      writeManifest(work, episode, true);
      flag(work, episode);
      const body = { ok: true, episode, version: 1 };
      onLine(JSON.stringify(body));
      return { code: 0, stdout: JSON.stringify(body), stderr: "" };
    },
    now: () => new Date("2026-10-11T12:00:00Z"),
  };
  return { deps, calls, layout };
}

/** The radio type's own `ensure()` seam, faked: sources present, uv on PATH (or not), nothing run. */
function ensureSeam(uv: boolean): { looks: () => number; restore: () => void } {
  const source = temp("pablo-story-radio-ensure-");
  writeFileSync(join(source, "pyproject.toml"), '[project]\nname = "pablo-casting"\n');
  writeFileSync(join(source, "uv.lock"), "version = 1\n");
  const saved = { deps: radioMachine.deps, env: radioMachine.env };
  let looks = 0;
  radioMachine.deps = () => {
    looks += 1;
    return {
      layout: { source, venv: join(source, ".venv"), install: "checkout" },
      which: () => (uv ? "/fake/bin/uv" : undefined),
      run: () => {
        throw new Error("ensure() must never run anything");
      },
      now: () => new Date("2026-10-11T12:00:00Z"),
    };
  };
  radioMachine.env = () => ({ PATH: "/nowhere" });
  return {
    looks: () => looks,
    restore: () => {
      radioMachine.deps = saved.deps;
      radioMachine.env = saved.env;
    },
  };
}

function depsFor(env: Record<string, string>, query: HarnessQuery, writer: Adapter, extra: Partial<StoryDeps> = {}): StoryDeps {
  return { query, writer, auth: harnessAuth(defaultConfig(), env, { env: {} }), now: () => new Date("2026-10-11T12:00:00Z"), ...extra };
}

function streamIndex(work: string): { episode: number; audio: string }[] {
  const path = join(streamRoot(work), "index.json");
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, "utf8")) as { chapters: { episode: number; audio: string }[] }).chapters;
}

/** Every file under `dir`, relative, with its bytes. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, name.name);
      if (name.isDirectory()) walk(path);
      else out[relative(dir, path)] = readFileSync(path).toString("base64");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// AC1: the written default never touches the casting side
// ---------------------------------------------------------------------------

test("AC1: the written default (no --output radio) with no uv and no venv never calls the casting runner, creates no venv and downloads nothing", async () => {
  const { root, vault, env, ctx } = tempVault();
  const seam = ensureSeam(false);
  const machine = fakeMachine({ uv: false });
  const spied: string[] = [];
  const spy: CastingDeps = {
    layout: machine.layout,
    which: (...a) => (spied.push("which"), machine.deps.which(...a)),
    run: (...a) => (spied.push("run"), machine.deps.run(...a)),
    stream: (...a) => (spied.push("stream"), (machine.deps.stream as NonNullable<CastingDeps["stream"]>)(...a)),
    now: () => (spied.push("now"), machine.deps.now()),
  };
  try {
    const result = await runStory({ prompt: SPEC }, { ...ctx, casting: spy }, depsFor(env, fakeHarness().query, proseWriter(), { casting: spy }));
    const body = result.body as Record<string, any>;
    expect(result.exitCode).toBe(0);
    expect(body.outputs).toEqual(["story"]);
    expect(existsSync(join(vault, "stories", body.project, "outputs", "story", "story.md"))).toBe(true);
    // The runner seam: no call at all, and the radio type was never even asked to look.
    expect(spied).toEqual([]);
    expect(machine.calls).toEqual([]);
    expect(seam.looks()).toBe(0);
    // The filesystem: no venv, no casting receipts, no model cache.
    expect(existsSync(machine.layout.venv)).toBe(false);
    expect(existsSync(join(root, "data", "pablo", "casting"))).toBe(false);
    expect(existsSync(join(root, "hf"))).toBe(false);
    expect(existsSync(join(vault, "stories", body.project, ".pablo", "casting"))).toBe(false);
    expect(existsSync(join(vault, "stories", body.project, "outputs", "radio"))).toBe(false);
  } finally {
    seam.restore();
  }
}, SLOW);

// ---------------------------------------------------------------------------
// AC2 + AC6: radio requested up front, on demand
// ---------------------------------------------------------------------------

test("AC2: --output radio builds the core, writes, casts, performs, mixes and publishes every episode; episode 1 is published before the last is written", async () => {
  const { vault, env, ctx } = tempVault();
  const seam = ensureSeam(true);
  const machine = fakeMachine({ engineMs: 40 });
  let workDir = "";
  let publishedBeforeLast: boolean | undefined;
  // The last script waits (bounded) for episode 1 to reach the listening directory: a run that wrote every
  // script before performing any would time out here and record false.
  const writer = scriptWriter({
    before: async (k) => {
      if (k !== 4) return;
      const stories = join(vault, "stories");
      for (let i = 0; i < 150 && publishedBeforeLast !== true; i += 1) {
        workDir = join(stories, readdirSync(stories)[0] as string);
        publishedBeforeLast = streamIndex(workDir).some((c) => c.episode === 1);
        if (!publishedBeforeLast) await sleep(20);
      }
    },
  });
  try {
    const lines: string[] = [];
    const result = await runStory(
      { prompt: SPEC, output: ["radio"] },
      { ...ctx, stderr: { write: (t: string) => void lines.push(t) } },
      depsFor(env, fakeHarness().query, writer, { casting: machine.deps }),
    );
    const body = result.body as Record<string, any>;
    expect(body.message).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(body.outputs).toEqual(["radio"]);
    const work = join(vault, "stories", body.project);

    // One work with a core ...
    expect(body.core.every((s: { done: boolean }) => s.done)).toBe(true);
    expect(readFileSync(join(work, "outline", "beats.md"), "utf8")).toContain("| 4 | Winter 1900 | The Quay |");
    // ... its episodes, merged on main ...
    const episodes = readdirSync(join(work, "outputs", "radio", "episodes")).filter((n) => n.endsWith(".md")).sort();
    expect(episodes).toHaveLength(4);
    expect(git(vault, "ls-tree", "--name-only", "main", `stories/${body.project}/outputs/radio/episodes/`).split("\n")).toHaveLength(4);
    // ... every role bound (match or design) ...
    const cast = JSON.parse(readFileSync(join(work, "outputs", "radio", "casting", "cast.json"), "utf8")) as { roles: Record<string, { by: string }> };
    expect(Object.keys(cast.roles).sort()).toEqual(["NARRATOR", "ROSA"]);
    expect(Object.values(cast.roles).every((r) => r.by === "match" || r.by === "design")).toBe(true);
    expect(cast.roles["ROSA"]?.by).toBe("design");
    // ... manifests, and a published episode list.
    for (const n of [1, 2, 3, 4]) expect(existsSync(join(work, "outputs", "radio", "casting", "renders", `ep${pad(n)}`, "v1.json"))).toBe(true);
    expect(streamIndex(work).map((c) => c.episode)).toEqual([1, 2, 3, 4]);
    expect(body.published.radio.target).toBe("stream");
    expect(body.published.radio.where).toBe(streamRoot(work));
    expect(body.published.radio.episodes.map((e: { episode: number }) => e.episode)).toEqual([1, 2, 3, 4]);

    // Overlap: episode 1 was in the listening directory before the last script was written.
    expect(workDir).toBe(work);
    expect(publishedBeforeLast).toBe(true);
    // The chain, through the runner: provisioned once, each episode cast with design on demand and streamed.
    expect(machine.calls.slice(0, 2)).toEqual(["sync", "pull"]);
    expect(machine.calls.filter((c) => c.startsWith("cast"))).toEqual(["cast 1 design"]);
    expect(machine.calls.filter((c) => c.startsWith("perform"))).toEqual(["perform 1 stream", "perform 2 stream", "perform 3 stream", "perform 4 stream"]);
    expect(writer.calls).toBe(4);
    // Progress lines name the radio steps.
    expect(lines.some((l) => l.includes("radio: writing episode 4 of 4"))).toBe(true);
    expect(lines.some((l) => l.includes("radio: episode 1 published"))).toBe(true);

    // AC6: research notes never reach the radio writer.
    expect(readFileSync(join(work, "research", "ligurian-fishing-villages-1900.md"), "utf8")).toContain(CANARY);
    expect(writer.prompts).toHaveLength(4);
    for (const prompt of writer.prompts) expect(prompt).not.toContain(CANARY);

    // A finished run resumes as finished: nothing runs again.
    const again = await runStory({ project: body.project }, ctx, depsFor(env, fakeHarness().query, writer, { casting: machine.deps }));
    expect(again.exitCode).toBe(0);
    expect(writer.calls).toBe(4);
    expect(machine.calls.filter((c) => c.startsWith("perform"))).toHaveLength(4);
  } finally {
    seam.restore();
  }
}, SLOW);

// ---------------------------------------------------------------------------
// AC3: radio added later to a work with a finished novel
// ---------------------------------------------------------------------------

test("AC3: output add radio then perform --output radio --all renders every episode from the same core; the novel's chapters and ledger are byte-identical", async () => {
  const { vault, env, ctx } = tempVault();
  const seam = ensureSeam(true);
  try {
    // A finished novel, from the same pipeline (no radio: the casting side is never asked).
    const novel = await runStory({ prompt: SPEC, output: ["novel"] }, ctx, depsFor(env, fakeHarness().query, proseWriter()));
    expect(novel.exitCode).toBe(0);
    const slug = (novel.body as { project: string }).project;
    const work = join(vault, "novels", slug);
    expect(seam.looks()).toBe(0);
    const ledger = join(work, continuityFile(work, "novel"));
    const chapters = snapshot(join(work, "chapters"));
    expect(Object.keys(chapters).filter((n) => n.endsWith(".md"))).toHaveLength(4);
    const ledgerBytes = readFileSync(ledger).toString("base64");

    const outputVerb = VERBS.find((v) => v.name === "output");
    const added = await outputVerb!.run({ sub: "add", type: "radio", project: slug, "dry-run": false } as never, ctx);
    expect(added.exitCode).toBe(0);

    const machine = fakeMachine();
    const writer = scriptWriter();
    const perform = VERBS.find((v) => v.name === "perform");
    const parsed = perform!.args.parse({ project: slug, output: "radio", all: true });
    const result = await perform!.run(parsed as never, { ...ctx, casting: machine.deps, writer });
    const body = result.body as Record<string, any>;
    expect(body.message).toContain("made 4 radio episode(s)");
    expect(result.exitCode).toBe(0);
    expect(body.written).toEqual([1, 2, 3, 4]);
    expect(body.episodes.map((e: { episode: number }) => e.episode)).toEqual([1, 2, 3, 4]);
    expect(body.published.chapters.map((c: { episode: number }) => c.episode)).toEqual([1, 2, 3, 4]);
    for (const n of [1, 2, 3, 4]) expect(existsSync(join(work, "outputs", "radio", "casting", "renders", `ep${pad(n)}`, `ep${pad(n)}.v1.m4a`))).toBe(true);
    // The same core: each episode tells its beat (the plan maps episode N to beat N of outline/beats.md).
    expect(readFileSync(join(work, "outputs", "radio", "plan.md"), "utf8")).toContain("The Quay");

    // The novel is untouched.
    expect(snapshot(join(work, "chapters"))).toEqual(chapters);
    expect(readFileSync(ledger).toString("base64")).toBe(ledgerBytes);
    // Nothing of the novel's was even sent to the radio writer.
    for (const prompt of writer.prompts) expect(prompt).not.toContain("Rosa read the letter twice at the kitchen table.");

    // Again: every episode is made, so it is a refusal naming that, and nothing runs.
    const before = machine.calls.length;
    const again = await perform!.run(parsed as never, { ...ctx, casting: machine.deps, writer });
    expect(again.exitCode).toBe(2);
    expect(machine.calls.length).toBe(before);
  } finally {
    seam.restore();
  }
}, SLOW);

test("perform --output novel --all is refused: only the radio output is performed", async () => {
  const { ctx } = tempVault();
  const perform = VERBS.find((v) => v.name === "perform");
  const result = await perform!.run(perform!.args.parse({ project: "ice-house", output: "novel", all: true }) as never, { ...ctx, casting: fakeMachine().deps });
  expect(result.exitCode).toBe(2);
  expect((result.body as { message: string }).message).toContain("only the radio output is performed");
});

// ---------------------------------------------------------------------------
// AC4: --review stops at each radio stage and resumes where it stopped
// ---------------------------------------------------------------------------

test("AC4: --review stops on each episode's script, bindings and render (open flags keep it waiting), publishes only once approved, and resumes where it stopped", async () => {
  const { vault, env, ctx } = tempVault();
  const seam = ensureSeam(true);
  const machine = fakeMachine({ autoFlag: [2] });
  const harness = fakeHarness();
  const writer = scriptWriter();
  const deps = depsFor(env, harness.query, writer, { casting: machine.deps });
  try {
    let result = await runStory({ prompt: SPEC, output: ["radio"], review: true }, ctx, deps);
    let body = result.body as Record<string, any>;
    const slug = body.project as string;
    const work = join(vault, "stories", slug);
    const steps: string[] = [];
    for (let i = 0; i < 40 && body.waiting !== undefined; i += 1) {
      expect(result.exitCode).toBe(0);
      const { step, branch, review, unit } = body.waiting;
      steps.push(step);
      if (branch !== undefined && branch.startsWith("plan/")) {
        expect((await mergeChanges(work, branch, { slug, env })).ok).toBe(true);
      } else if (branch !== undefined) {
        expect((await mergeDraftInProject(work, branch, env, writer)).exitCode).toBe(0);
      } else if (review === "binding") {
        // The bindings to approve: every role of the episode, with how it was bound.
        expect(body.waiting.bindings.map((b: { role: string }) => b.role)).toEqual(["NARRATOR", "ROSA"]);
        expect(body.waiting.bindings.every((b: { by: string }) => b.by === "match" || b.by === "design")).toBe(true);
        expect(body.next).toContain("pablo bind");
      } else {
        // The render to approve: mixed, played in the review player, and not yet published.
        expect(review).toBe("render");
        expect(body.waiting.render.audio).toContain(`ep${pad(unit)}.v1.m4a`);
        expect(body.waiting.render.player).toBe(`pablo review --project ${slug} --episode ${unit}`);
        expect(streamIndex(work).map((c) => c.episode)).not.toContain(unit);
        if (unit === 2 && body.waiting.render.openFlags > 0) {
          // perform's auto-flag stops it: resuming without fixing or clearing keeps it waiting.
          expect(body.missing).toEqual(["episode 2 has 1 open flag(s) (pablo fix --output radio --unit 2)"]);
          const still = await runStory({ project: slug }, ctx, deps);
          expect((still.body as Record<string, any>).waiting).toMatchObject({ step: "render:radio:2", review: "render" });
          steps.push("render:radio:2 (flagged)");
          // The author clears the flag in the player.
          writeFileSync(join(work, "outputs", "radio", "casting", "flags.json"), JSON.stringify({ flags: [] }));
        }
      }
      result = await runStory({ project: slug }, ctx, deps);
      body = result.body as Record<string, any>;
    }
    expect(body.message).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(body.waiting).toBeUndefined();
    const radioSteps = (n: number) => [`draft:radio:${n}`, `cast:radio:${n}`, `render:radio:${n}`];
    expect(steps).toEqual([
      "core:research",
      "core:premise",
      "core:bible",
      "core:acts",
      "core:beats",
      ...radioSteps(1),
      "draft:radio:2",
      "cast:radio:2",
      "render:radio:2",
      "render:radio:2 (flagged)",
      ...radioSteps(3),
      ...radioSteps(4),
    ]);
    // Resumed where it stopped: each stage ran once.
    expect(harness.stages).toEqual(["research", "premise", "bible", "acts", "beats"]);
    expect(writer.calls).toBe(4);
    expect(machine.calls.filter((c) => c.startsWith("perform"))).toEqual(["perform 1", "perform 2", "perform 3", "perform 4"]);
    expect(machine.calls.filter((c) => c.startsWith("mix"))).toEqual(["mix 1", "mix 2", "mix 3", "mix 4"]);
    expect(streamIndex(work).map((c) => c.episode)).toEqual([1, 2, 3, 4]);
    expect(body.published.radio.episodes).toHaveLength(4);
  } finally {
    seam.restore();
  }
}, SLOW);

// ---------------------------------------------------------------------------
// AC5: a refusal stops the pipeline and leaves what is published
// ---------------------------------------------------------------------------

test("AC5: an uncastable role in episode 2 stops the pipeline with the refusal body; episode 1 stays published", async () => {
  const { vault, env, ctx } = tempVault();
  const seam = ensureSeam(true);
  const machine = fakeMachine({ engineMs: 5 });
  // A slow third script: the engine reaches episode 2's refusal while the writer is still on it.
  const writer = scriptWriter({ roles: (k) => (k === 2 ? ["NARRATOR", "GHOST"] : ["NARRATOR", "ROSA"]), before: async (k) => {
      if (k >= 3) await sleep(600);
    },
  });
  try {
    const result = await runStory({ prompt: SPEC, output: ["radio"] }, ctx, depsFor(env, fakeHarness().query, writer, { casting: machine.deps }));
    const body = result.body as Record<string, any>;
    expect(result.exitCode).toBe(2);
    expect(body).toMatchObject({ ok: false, code: 2, output: "radio", unit: 2, queue: "engine", missing: ["role GHOST"] });
    expect(body.message).toContain("no voice could be designed for GHOST");
    expect(body.next).toContain(`pablo story --project ${body.project}`);
    const work = join(vault, "stories", body.project);
    // Episode 1 is published and stays; nothing after episode 2 was cast or performed.
    expect(streamIndex(work).map((c) => c.episode)).toEqual([1]);
    expect(existsSync(join(streamRoot(work), streamIndex(work)[0]!.audio))).toBe(true);
    expect(body.published.radio.episodes.map((e: { episode: number }) => e.episode)).toEqual([1]);
    expect(machine.calls.filter((c) => c.startsWith("perform"))).toEqual(["perform 1 stream"]);
    expect(machine.calls.some((c) => c.startsWith("cast 3") || c.startsWith("cast 4"))).toBe(false);
    // The writer started nothing after the stop.
    expect(writer.calls).toBeLessThanOrEqual(3);
  } finally {
    seam.restore();
  }
}, SLOW);

test("AC5: a casting side that fails to provision stops the pipeline before any episode is performed; the merged scripts stay", async () => {
  const { vault, env, ctx } = tempVault();
  const seam = ensureSeam(true);
  const machine = fakeMachine({ syncFails: true });
  try {
    const result = await runStory({ prompt: SPEC, output: ["radio"] }, ctx, depsFor(env, fakeHarness().query, scriptWriter(), { casting: machine.deps }));
    const body = result.body as Record<string, any>;
    expect(result.exitCode).toBe(1);
    expect(body).toMatchObject({ ok: false, output: "radio", unit: 1 });
    expect(body.message).toContain("uv sync --frozen failed");
    const work = join(vault, "stories", body.project);
    expect(machine.calls).toEqual(["sync"]);
    expect(existsSync(streamRoot(work))).toBe(false);
    expect(readdirSync(join(work, "outputs", "radio", "episodes")).some((n) => n.startsWith("01-"))).toBe(true);
  } finally {
    seam.restore();
  }
}, SLOW);

test("AC5: --output radio on a machine that cannot provision the Python side (no uv) is refused by name before anything is written", async () => {
  const { vault, env, ctx } = tempVault();
  const seam = ensureSeam(false);
  const machine = fakeMachine({ uv: false });
  try {
    const result = await runStory({ prompt: SPEC, output: ["radio"] }, ctx, depsFor(env, fakeHarness().query, scriptWriter(), { casting: machine.deps }));
    expect(result.exitCode).toBe(2);
    expect((result.body as { message: string }).message).toContain("the radio output cannot run on this machine");
    expect((result.body as { missing: string[] }).missing).toEqual(["uv (brew install uv)"]);
    expect(existsSync(join(vault, "stories"))).toBe(false);
    expect(machine.calls).toEqual([]);
  } finally {
    seam.restore();
  }
}, SLOW);
