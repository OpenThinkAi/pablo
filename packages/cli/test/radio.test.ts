import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { venvPython } from "../src/casting";
import type { CastingDeps, CastingLayout, CastingRun } from "../src/casting";
import { hasRadioScripts, parseForEpisode, radioCheckLines, radioScriptDir } from "../src/radio";
import { VERBS } from "../src/verbs";
import type { VerbContext } from "../src/verbs";

// AGT-1680: the Python side parses scripts and owns cast.json (its pytest suite
// holds the grammar). Here the cli's half: when a work counts as radio, which
// Python command each verb runs, and how the body comes back. Every test injects
// `CastingDeps`, so none needs uv, Python or a model, and nothing leaves a temp dir.

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function vaultCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "pablo-radio-"));
  temps.push(root);
  cpSync(FIXTURE_VAULT, join(root, "vault"), { recursive: true });
  return join(root, "vault");
}

/** A radio work next to the fixture's novel: `novels/show` with one script under `outputs/radio/episodes`. */
function radioWork(vault: string, where: "episodes" | "chapters" = "episodes"): string {
  const work = join(vault, "novels", "show");
  cpSync(join(vault, "novels", "ice-house", "pablo.json"), join(work, "pablo.json"));
  const dir = where === "episodes" ? join(work, "outputs", "radio", "episodes") : join(work, "chapters");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "01-pilot.md"), 'CAST: CORA=f "thirties, dry"\nCORA: (dryly) Hello.\n', "utf8");
  return work;
}

function fakeLayout(root: string): CastingLayout {
  const source = join(root, "casting");
  mkdirSync(join(source, "src", "pablo_casting"), { recursive: true });
  writeFileSync(join(source, "pyproject.toml"), '[project]\nname = "pablo-casting"\n', "utf8");
  writeFileSync(join(source, "uv.lock"), "version = 1\n", "utf8");
  return { source, venv: join(source, ".venv"), install: "checkout" };
}

/** A fake machine whose `python -m pablo_casting <cmd>` answers per `answers`. */
function fakeDeps(root: string, answers: Record<string, CastingRun> = {}): CastingDeps & { calls: string[][] } {
  const layout = fakeLayout(root);
  const calls: string[][] = [];
  return {
    calls,
    layout,
    which: () => "/fake/bin/uv",
    run: (argv) => {
      calls.push([...argv]);
      if (argv[1] === "sync") {
        mkdirSync(join(layout.venv, "bin"), { recursive: true });
        writeFileSync(venvPython(layout), "", "utf8");
        return { code: 0, stdout: "", stderr: "" };
      }
      const command = argv[3] ?? "";
      return answers[command] ?? { code: 0, stdout: JSON.stringify({ ok: true, weights: [] }), stderr: "" };
    },
    now: () => new Date("2026-10-10T12:00:00Z"),
  };
}

function ctx(vault: string, casting: CastingDeps, root: string): VerbContext & { err: string[] } {
  const err: string[] = [];
  return { cwd: vault, env: { PABLO_VAULT: vault, XDG_STATE_HOME: join(root, "state"), PATH: "/nowhere" }, stderr: { write: (t) => void err.push(t) }, casting, err };
}

function verb(name: string) {
  const found = VERBS.find((v) => v.name === name);
  if (!found) throw new Error(`no verb ${name}`);
  return found;
}

const json = (body: unknown): CastingRun => ({ code: 0, stdout: JSON.stringify(body), stderr: "" });
const refusal = (body: unknown): CastingRun => ({ code: 2, stdout: JSON.stringify(body), stderr: "" });

describe("radio detection", () => {
  test("a work counts as radio only when a script carries a CAST line", () => {
    const vault = vaultCopy();
    expect(hasRadioScripts(join(vault, "novels", "ice-house"))).toBe(false);
    expect(hasRadioScripts(radioWork(vault))).toBe(true);
  });

  test("scripts are read from outputs/radio/episodes when it exists, else chapters", () => {
    const vault = vaultCopy();
    const work = radioWork(vault);
    expect(radioScriptDir(work)).toBe(join(work, "outputs", "radio", "episodes"));
    const sandbox = join(vault, "novels", "drama");
    mkdirSync(join(sandbox, "chapters"), { recursive: true });
    writeFileSync(join(sandbox, "chapters", "01-a.md"), "CAST: A=m\nA: hi\n", "utf8");
    expect(radioScriptDir(sandbox)).toBe(join(sandbox, "chapters"));
    expect(hasRadioScripts(sandbox)).toBe(true);
  });

  test("--for accepts episode N, episode-N and ep N, and never a bare number", () => {
    expect(parseForEpisode("episode 3")).toBe(3);
    expect(parseForEpisode("Episode-12")).toBe(12);
    expect(parseForEpisode("ep 4")).toBe(4);
    expect(parseForEpisode("3")).toBeUndefined();
    expect(parseForEpisode("chapter 3")).toBeUndefined();
  });
});

describe("check", () => {
  test("a writing-only work never touches the Python side", async () => {
    const vault = vaultCopy();
    const deps = fakeDeps(vault);
    const result = await verb("check").run({ project: "ice-house" }, ctx(vault, deps, vault));
    expect(result.exitCode).toBe(0);
    expect(deps.calls).toEqual([]);
    expect((result.body as { radio?: unknown }).radio).toBeUndefined();
  });

  test("a radio work adds the Python side's unknown directions and unbound roles under `radio` (AC3)", async () => {
    const vault = vaultCopy();
    radioWork(vault);
    const report = {
      ok: true,
      episodes: [{ episode: 1, file: "outputs/radio/episodes/01-pilot.md", lines: 1, cues: 0 }],
      unknownDirections: [{ file: "outputs/radio/episodes/01-pilot.md", line: 2, text: "(approaching)", speaker: "CORA", kind: "direction", unknown: ["approaching"] }],
      unboundRoles: [{ file: "outputs/radio/episodes/01-pilot.md", episode: 1, role: "CORA" }],
    };
    const deps = fakeDeps(vault, { check: json(report) });
    const result = await verb("check").run({ project: "show" }, ctx(vault, deps, vault));
    expect(result.exitCode).toBe(0);
    const body = result.body as { ok: boolean; hits: unknown[]; radio: typeof report };
    expect(body.ok).toBe(true);
    expect(body.radio.unknownDirections[0]?.line).toBe(2);
    expect(body.radio.unboundRoles[0]?.role).toBe("CORA");
    expect(deps.calls.at(-1)).toEqual([venvPython(deps.layout as CastingLayout), "-m", "pablo_casting", "check", "--work", join(vault, "novels", "show"), "--json"]);
    expect(radioCheckLines(body.radio)).toEqual([
      "outputs/radio/episodes/01-pilot.md:2 unknown direction (approaching) (CORA: approaching)",
      "outputs/radio/episodes/01-pilot.md unbound role: CORA",
    ]);
  });

  test("a refusal from the Python side (a corrupt cast.json) is handed back as exit 2", async () => {
    const vault = vaultCopy();
    radioWork(vault);
    const deps = fakeDeps(vault, { check: refusal({ ok: false, code: 2, message: "cast.json is not valid" }) });
    const result = await verb("check").run({ project: "show" }, ctx(vault, deps, vault));
    expect(result.exitCode).toBe(2);
  });

  test("scanning one --file skips the radio read", async () => {
    const vault = vaultCopy();
    const work = radioWork(vault);
    const deps = fakeDeps(vault);
    const result = await verb("check").run({ project: "show", file: join(work, "outputs", "radio", "episodes", "01-pilot.md") }, ctx(vault, deps, vault));
    expect(deps.calls).toEqual([]);
    expect(result.exitCode).toBe(0);
  });
});

describe("status --for episode N", () => {
  test("is exit 2 while a role is unbound, naming it (AC3)", async () => {
    const vault = vaultCopy();
    radioWork(vault);
    const missing = ["role CORA is not bound to a voice (pablo bind --role CORA --voice <slug>)"];
    const deps = fakeDeps(vault, { status: refusal({ ready: false, missing, episode: 1 }) });
    const result = await verb("status").run({ project: "show", for: "episode 1" }, ctx(vault, deps, vault));
    expect(result.exitCode).toBe(2);
    expect((result.body as { ready: boolean; missing: string[] }).missing).toEqual(missing);
    expect(deps.calls.at(-1)).toContain("--episode");
  });

  test("is exit 0 once every role is bound", async () => {
    const vault = vaultCopy();
    radioWork(vault);
    const deps = fakeDeps(vault, { status: json({ ready: true, missing: [], episode: 1 }) });
    const result = await verb("status").run({ project: "show", for: "episode 1" }, ctx(vault, deps, vault));
    expect(result.exitCode).toBe(0);
  });

  test("a chapter target still goes to the novel machine, and a bad target names both forms", async () => {
    const vault = vaultCopy();
    const deps = fakeDeps(vault);
    const chapter = await verb("status").run({ project: "ice-house", for: "chapter 1" }, ctx(vault, deps, vault));
    expect(chapter.body).toHaveProperty("ready");
    expect(deps.calls).toEqual([]);
    const bad = await verb("status").run({ project: "ice-house", for: "act 1" }, ctx(vault, deps, vault));
    expect(bad.exitCode).toBe(2);
    expect(String((bad.body as { message: string }).message)).toContain("episode N");
  });
});

describe("bind", () => {
  test("is a verb, so the CLI and MCP both see it", () => {
    expect(VERBS.map((v) => v.name)).toContain("bind");
  });

  test("passes the role, the voice and the vault to the Python side and returns its body (AC4)", async () => {
    const vault = vaultCopy();
    radioWork(vault);
    const answer = { ok: true, role: "CORA", slug: "cora", cardHash: "sha256:abc", by: "manual", castFile: "x" };
    const deps = fakeDeps(vault, { bind: json(answer) });
    const result = await verb("bind").run({ project: "show", role: "CORA", voice: "cora" }, ctx(vault, deps, vault));
    expect(result.exitCode).toBe(0);
    expect(result.body).toEqual(answer);
    expect(deps.calls.at(-1)).toEqual([
      venvPython(deps.layout as CastingLayout), "-m", "pablo_casting", "bind", "--role", "CORA", "--voice", "cora", "--vault", vault, "--work", join(vault, "novels", "show"), "--json",
    ]);
  });

  test("hands back a refusal for an absent or retired voice", async () => {
    const vault = vaultCopy();
    radioWork(vault);
    const deps = fakeDeps(vault, { bind: refusal({ ok: false, code: 2, message: 'no voice "nobody" in the library' }) });
    const result = await verb("bind").run({ project: "show", role: "CORA", voice: "nobody" }, ctx(vault, deps, vault));
    expect(result.exitCode).toBe(2);
  });

  test("an unresolvable project is a refusal before anything runs", async () => {
    const vault = vaultCopy();
    const deps = fakeDeps(vault);
    const result = await verb("bind").run({ project: "missing", role: "CORA", voice: "cora" }, ctx(vault, deps, vault));
    expect(result.exitCode).toBe(2);
    expect(deps.calls).toEqual([]);
    expect(existsSync(join(vault, "novels", "missing"))).toBe(false);
  });
});

describe("the built CLI", () => {
  const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  function runCli(args: string[], env: Record<string, string>) {
    const result = Bun.spawnSync([process.execPath, "run", CLI, ...args], { env: { ...process.env, ...env } });
    return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), exitCode: result.exitCode };
  }

  test("bind without its flags is a refusal, not a crash", () => {
    const vault = vaultCopy();
    const run = runCli(["bind", "--project", "ice-house", "--json"], { PABLO_VAULT: vault });
    expect(run.exitCode).toBe(2);
    expect(JSON.parse(run.stdout).ok).toBe(false);
  });

  test("status --for episode on a work with no radio scripts is exit 2 and provisions nothing", () => {
    const vault = vaultCopy();
    // The refusal names the missing script: nothing was provisioned to ask.
    const run = runCli(["status", "--project", "ice-house", "--for", "episode 1", "--json"], { PABLO_VAULT: vault });
    expect(run.exitCode).toBe(2);
    expect(JSON.parse(run.stdout).missing[0]).toContain("no script");
  });

  test("--help lists bind and the episode form of status", () => {
    const run = runCli(["--help"], {});
    expect(run.stdout).toContain("pablo bind");
    expect(run.stdout).toContain('--for "episode N"');
  });
});
