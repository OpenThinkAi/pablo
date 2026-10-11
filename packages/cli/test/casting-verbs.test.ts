import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { castingVerbs } from "../src/casting-verbs";
import { venvPython } from "../src/casting";
import type { CastingDeps, CastingLayout } from "../src/casting";
import { castingText, parseCliArgs } from "../src/cli";
import { mcpTools } from "../src/mcp";
import { VERBS, verbArgsFromCli } from "../src/verbs";
import type { Verb, VerbContext } from "../src/verbs";

// AGT-1679: the casting verbs over a fake machine. Nothing here runs uv,
// Python or a model; every directory is a mkdtemp one, never ~/writing.

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** A provisioned fake casting side that records argv and answers `{ok:true}`. */
function fakeMachine(): { deps: CastingDeps; calls: string[][]; root: string } {
  const root = temp("pablo-casting-verbs-");
  const source = join(root, "casting");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "pyproject.toml"), '[project]\nname = "pablo-casting"\n', "utf8");
  writeFileSync(join(source, "uv.lock"), "version = 1\n", "utf8");
  const layout: CastingLayout = { source, venv: join(source, ".venv"), install: "checkout" };
  const calls: string[][] = [];
  const deps: CastingDeps = {
    layout,
    which: () => "/fake/bin/uv",
    run: (argv) => {
      calls.push([...argv]);
      if (argv[1] === "sync") {
        mkdirSync(join(layout.venv, "bin"), { recursive: true });
        writeFileSync(venvPython(layout), "", "utf8");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[3] === "pull") return { code: 0, stdout: JSON.stringify({ ok: true, weights: [] }), stderr: "" };
      return { code: 0, stdout: JSON.stringify({ ok: true, hash: "abc", message: "done" }), stderr: "" };
    },
    now: () => new Date("2026-10-10T12:00:00Z"),
  };
  return { deps, calls, root };
}

function verbsOver(deps: CastingDeps): Record<string, Verb> {
  return Object.fromEntries(castingVerbs(() => deps).map((verb) => [verb.name, verb]));
}

function ctxIn(cwd: string, env: Record<string, string | undefined> = {}): VerbContext {
  return { cwd, env: { PATH: "/nowhere", XDG_STATE_HOME: join(cwd, "state"), ...env }, stderr: { write: () => undefined } };
}

/** The `python -m pablo_casting ...` argv of the last call, without the interpreter. */
function lastPython(calls: string[][]): string[] {
  return (calls.at(-1) ?? []).slice(3);
}

/** An invented two-role episode script, as the radio rules lay one out. */
function script(episode: number): string {
  return [
    "---",
    `episode: ${episode}`,
    `title: Invented Episode ${episode}`,
    "---",
    "",
    'CAST: CORA=f "thirties, dry, exact", NED=m "forties, slow, gruff"',
    "[SFX: a kettle on the boil]",
    "CORA: (dry) The ice came in at dawn.",
    "NED: Then we cut it before noon.",
    "",
  ].join("\n");
}

/**
 * The fixture vault with ice-house's radio episodes 1-3 written and both roles bound (AGT-1686: the casting
 * verbs check the radio output's stage before they run). Renders and flags are added per test with `performed`.
 */
function vaultCopy(): string {
  const vault = join(temp("pablo-casting-vault-"), "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  mkdirSync(join(work, "outputs", "radio", "episodes"), { recursive: true });
  for (const n of [1, 2, 3]) writeFileSync(join(work, "outputs", "radio", "episodes", `0${n}-invented-episode-${n}.md`), script(n));
  mkdirSync(join(work, "outputs", "radio", "casting"), { recursive: true });
  const bound = { slug: "x", card_hash: "h", by: "manual", at: "2026-10-10T00:00:00Z" };
  writeFileSync(join(work, "outputs", "radio", "casting", "cast.json"), JSON.stringify({ version: 1, roles: { CORA: bound, NED: { ...bound, slug: "y" } } }));
  return vault;
}

/** Gives ice-house's episode a performed manifest (v1), and with `flags` that many open flags on it. */
function performed(vault: string, episode: number, flags = 0): void {
  const casting = join(vault, "novels", "ice-house", "outputs", "radio", "casting");
  const dir = join(casting, "renders", `ep0${episode}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "v1.json"), JSON.stringify({ version: 1, lines: [] }));
  if (flags > 0) {
    const entries = Array.from({ length: flags }, (_, i) => ({ id: `f${i}`, episode, line: i, reason: "flat" }));
    writeFileSync(join(casting, "flags.json"), JSON.stringify({ flags: entries }));
  }
}

describe("one VERBS entry each (AC4)", () => {
  test("audition, cast and voices are VERBS entries and MCP tools", () => {
    for (const name of ["audition", "cast", "voices"]) {
      expect(VERBS.filter((v) => v.name === name)).toHaveLength(1);
      expect(mcpTools().filter((t) => t.name === name)).toHaveLength(1);
    }
  });

  test("cast's schema has no from-wav field: synthetic only", () => {
    const cast = VERBS.find((v) => v.name === "cast")!;
    expect(Object.keys(cast.args.shape)).not.toContain("from-wav");
    expect(Object.keys(cast.args.shape).some((key) => /wav|file|path/i.test(key))).toBe(false);
  });
});

describe("argv to the Python side", () => {
  test("audition passes every field as one --flag=value token, and the vault for the library", async () => {
    const { deps, calls } = fakeMachine();
    const vault = vaultCopy();
    const result = await verbsOver(deps)["audition"]!.run(
      { role: "CORA", describe: "-a woman, thirties", designer: "voxcpm2", n: 3, seed: 7, traits: '{"gender":"f"}', "dry-run": false },
      ctxIn(vault),
    );
    expect(result.exitCode).toBe(0);
    expect(lastPython(calls)).toEqual([
      "audition",
      "--role=CORA",
      "--describe=-a woman, thirties",
      "--designer=voxcpm2",
      "--n=3",
      "--seed=7",
      '--traits={"gender":"f"}',
      `--vault=${vault}`,
      "--json",
    ]);
  });

  test("audition --dry-run stays the no-model check", async () => {
    const { deps, calls } = fakeMachine();
    const vault = vaultCopy();
    await verbsOver(deps)["audition"]!.run({ "dry-run": true }, ctxIn(vault));
    expect(lastPython(calls)).toEqual(["audition", "--dry-run", `--vault=${vault}`, "--json"]);
  });

  test("cast with --project puts receipts under the work", async () => {
    const { deps, calls } = fakeMachine();
    const vault = vaultCopy();
    const result = await verbsOver(deps)["cast"]!.run({ role: "CORA", candidate: 2, recast: true, notes: "warmer", project: "ice-house" }, ctxIn(vault));
    expect(result.exitCode).toBe(0);
    expect(lastPython(calls)).toEqual([
      "cast",
      "--role=CORA",
      "--candidate=2",
      "--recast",
      "--notes=warmer",
      `--vault=${vault}`,
      "--work",
      join(vault, "novels", "ice-house"),
      "--json",
    ]);
  });

  test("cast --auto (AGT-1698) passes the work and the episode scope, nothing to hand-cast", async () => {
    const { deps, calls } = fakeMachine();
    const vault = vaultCopy();
    const verb = verbsOver(deps)["cast"]!;
    const result = await verb.run({ auto: true, episode: 2, all: false, recast: false, project: "ice-house" }, ctxIn(vault));
    expect(result.exitCode).toBe(0);
    expect(lastPython(calls)).toEqual(["cast", "--auto", "--episode=2", `--vault=${vault}`, "--work", join(vault, "novels", "ice-house"), "--json"]);
    await verb.run({ auto: true, all: true, recast: false, project: "ice-house" }, ctxIn(vault));
    expect(lastPython(calls)).toEqual(["cast", "--auto", "--all", `--vault=${vault}`, "--work", join(vault, "novels", "ice-house"), "--json"]);
  });

  test("cast --auto refuses without a project, with hand-casting fields, or with --episode and --all; nothing runs", async () => {
    const { deps, calls } = fakeMachine();
    const vault = vaultCopy();
    const verb = verbsOver(deps)["cast"]!;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ auto: true, all: false, recast: false }, "needs --project"],
      [{ auto: true, all: false, recast: false, project: "ice-house", candidate: 2 }, "no --candidate"],
      [{ auto: true, all: false, recast: true, project: "ice-house", role: "CORA" }, "no --role, --recast"],
      [{ auto: true, all: true, episode: 1, recast: false, project: "ice-house" }, "not both"],
      [{ auto: false, all: false, recast: false, role: "CORA" }, "needs --role R and --candidate n"],
    ];
    for (const [args, message] of cases) {
      const result = await verb.run(args as never, ctxIn(vault));
      expect(result.exitCode).toBe(2);
      expect((result.body as { message: string }).message).toContain(message);
    }
    expect(calls).toEqual([]);
  });

  test("cast --auto --design (AGT-1699) provisions the scorers extra and passes the harness's role traits", async () => {
    const { deps, calls } = fakeMachine();
    const vault = vaultCopy();
    const verb = verbsOver(deps)["cast"]!;
    const traits = '{"RAMON":{"gender":"m","age":"70s"}}';
    const result = await verb.run({ auto: true, design: true, "role-traits": traits, all: false, recast: false, project: "ice-house" }, ctxIn(vault));
    expect(result.exitCode).toBe(0);
    expect(calls[0]).toEqual(["/fake/bin/uv", "sync", "--frozen", "--extra", "scorers"]);
    expect(lastPython(calls)).toEqual([
      "cast",
      "--auto",
      "--design",
      `--role-traits=${traits}`,
      `--vault=${vault}`,
      "--work",
      join(vault, "novels", "ice-house"),
      "--json",
    ]);
  });

  test("--design and --role-traits without --auto (or role-traits without design) are refused; nothing runs", async () => {
    const { deps, calls } = fakeMachine();
    const vault = vaultCopy();
    const verb = verbsOver(deps)["cast"]!;
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ auto: false, design: true, all: false, recast: false, role: "CORA", candidate: 1 }, "with --auto"],
      [{ auto: true, design: false, "role-traits": "{}", all: false, recast: false, project: "ice-house" }, "only applies with --auto --design"],
    ];
    for (const [args, message] of cases) {
      const result = await verb.run(args as never, ctxIn(vault));
      expect(result.exitCode).toBe(2);
      expect((result.body as { message: string }).message).toContain(message);
    }
    expect(calls).toEqual([]);
  });

  test("describe_voice (AGT-1699) is one VERBS entry and MCP tool, and passes the description and gender", async () => {
    expect(VERBS.filter((v) => v.name === "describe_voice")).toHaveLength(1);
    expect(mcpTools().filter((t) => t.name === "describe_voice")).toHaveLength(1);
    const { deps, calls } = fakeMachine();
    const vault = vaultCopy();
    const result = await verbsOver(deps)["describe_voice"]!.run({ describe: "seventies, smells of the sea", gender: "m", role: "RAMON" }, ctxIn(vault));
    expect(result.exitCode).toBe(0);
    expect(lastPython(calls)).toEqual(["describe", "--describe=seventies, smells of the sea", "--gender=m", "--role=RAMON", `--vault=${vault}`, "--json"]);
    const text = castingText("describe_voice", { ok: true, message: "not in the vocabulary: smells of the sea", traits: { gender: "m", age: "70s" }, instruct: "A man in his seventies." });
    expect(text).toContain("traits: gender=m age=70s");
    expect(text).toContain("instruct: A man in his seventies.");
  });

  test("voices passes its subcommand and slug as positionals", async () => {
    const { deps, calls } = fakeMachine();
    const vault = vaultCopy();
    await verbsOver(deps)["voices"]!.run({ sub: "retire", name: "cora", reason: "too like edwin", "auto-admitted": false }, ctxIn(vault));
    expect(lastPython(calls)).toEqual(["voices", "retire", "cora", "--reason=too like edwin", `--vault=${vault}`, "--json"]);
    await verbsOver(deps)["voices"]!.run({ sub: "list", "auto-admitted": true }, ctxIn(vault));
    expect(lastPython(calls)).toEqual(["voices", "list", "--auto-admitted", `--vault=${vault}`, "--json"]);
  });

  test("outside a vault no --vault is passed (the config's library, or the Python side refuses)", async () => {
    const { deps, calls, root } = fakeMachine();
    await verbsOver(deps)["voices"]!.run({ sub: "list", "auto-admitted": false }, ctxIn(join(root, "casting")));
    expect(lastPython(calls)).toEqual(["voices", "list", "--json"]);
  });

  test("--library and --vault reach the Python side, resolved against the cwd (AGT-1709)", async () => {
    const { deps, calls, root } = fakeMachine();
    const cwd = join(root, "casting");
    const verbs = verbsOver(deps);
    await verbs["voices"]!.run({ sub: "list", "auto-admitted": false, library: "lib" }, ctxIn(cwd));
    expect(lastPython(calls)).toEqual(["voices", "list", `--library=${join(cwd, "lib")}`, "--json"]);
    await verbs["cast"]!.run({ role: "CORA", candidate: 1, recast: false, library: "/abs/lib", vault: "v" }, ctxIn(cwd));
    expect(lastPython(calls)).toEqual(["cast", "--role=CORA", "--candidate=1", `--vault=${join(cwd, "v")}`, "--library=/abs/lib", "--json"]);
    await verbs["audition"]!.run({ role: "CORA", describe: "a voice", "dry-run": false, library: "/abs/lib" }, ctxIn(cwd));
    expect(lastPython(calls)).toEqual(["audition", "--role=CORA", "--describe=a voice", "--library=/abs/lib", "--json"]);
  });

  test("over MCP --library and --vault are refused: a model cannot redirect where cards are written", async () => {
    const { deps, calls, root } = fakeMachine();
    const mcp: VerbContext = { ...ctxIn(join(root, "casting")), caller: "mcp" };
    for (const [name, args] of [
      ["cast", { role: "CORA", candidate: 1, recast: false, library: "/elsewhere" }],
      ["audition", { role: "CORA", describe: "a voice", "dry-run": false, vault: "/elsewhere" }],
      ["voices", { sub: "list", "auto-admitted": false, library: "/elsewhere" }],
    ] as const) {
      const result = await verbsOver(deps)[name]!.run(args as never, mcp);
      expect(result.exitCode).toBe(2);
      expect((result.body as { message: string }).message).toContain("CLI options");
    }
    expect(calls).toEqual([]);
  });

  test("the CLI flags --library and --vault parse into the verbs' args", () => {
    for (const name of ["audition", "cast", "voices"]) {
      const verb = VERBS.find((v) => v.name === name)!;
      const parsed = parseCliArgs([name, "list", "--library", "/lib", "--vault", "/v"]);
      const built = verbArgsFromCli(verb, parsed.values, parsed.rest);
      expect(built).toMatchObject({ ok: true, args: { library: "/lib", vault: "/v" } });
    }
  });

  test("a real audition and cast provision with the scorers extra; dry-run, cast --auto and voices do not (AGT-1709)", async () => {
    const real = (name: string, args: Record<string, unknown>) => {
      const machine = fakeMachine();
      return verbsOver(machine.deps)[name]!.run(args as never, ctxIn(machine.root)).then(() => machine.calls.find((call) => call[1] === "sync"));
    };
    expect(await real("audition", { role: "CORA", describe: "a voice", "dry-run": false })).toEqual(["/fake/bin/uv", "sync", "--frozen", "--extra", "scorers"]);
    expect(await real("cast", { role: "CORA", candidate: 1, recast: false, auto: false, all: false })).toEqual(["/fake/bin/uv", "sync", "--frozen", "--extra", "scorers"]);
    expect(await real("audition", { "dry-run": true })).toEqual(["/fake/bin/uv", "sync", "--frozen"]);
    expect(await real("voices", { sub: "list", "auto-admitted": false })).toEqual(["/fake/bin/uv", "sync", "--frozen"]);
    expect(await real("cast", { auto: true, all: true, recast: false, project: undefined })).toBeUndefined(); // refused before provisioning
  });

  test("the extra is stamped, so a later dry-run does not strip it", async () => {
    const machine = fakeMachine();
    const verbs = verbsOver(machine.deps);
    await verbs["audition"]!.run({ role: "CORA", describe: "a voice", "dry-run": false } as never, ctxIn(machine.root));
    await verbs["audition"]!.run({ "dry-run": true } as never, ctxIn(machine.root));
    expect(machine.calls.filter((call) => call[1] === "sync")).toHaveLength(1);
  });

  test("an unknown --project is a refusal and runs nothing", async () => {
    const { deps, calls } = fakeMachine();
    const result = await verbsOver(deps)["cast"]!.run({ role: "CORA", candidate: 1, recast: false, project: "nope" }, ctxIn(vaultCopy()));
    expect(result.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });

  test("a refusal from the Python side comes back as the verb's own", async () => {
    const { deps } = fakeMachine();
    const refusal = { ok: false, code: 2, message: '"cora" already has a card (abc); pass --recast' };
    const refusing: CastingDeps = {
      ...deps,
      run: (argv, options) => (argv[3] === "cast" ? { code: 2, stdout: JSON.stringify(refusal), stderr: "" } : deps.run(argv, options)),
    };
    const result = await verbsOver(refusing)["cast"]!.run({ role: "CORA", candidate: 1, recast: false }, ctxIn(vaultCopy()));
    expect(result.exitCode).toBe(2);
    expect(result.body).toMatchObject(refusal);
  });
});

describe("CLI argv to verb args", () => {
  const verb = (name: string) => VERBS.find((v) => v.name === name)!;

  test("-n and numeric flags become numbers; the zod shape validates", () => {
    const parsed = parseCliArgs(["audition", "--role", "CORA", "--describe", "a woman", "-n", "4", "--seed", "9"]);
    const built = verbArgsFromCli(verb("audition"), parsed.values, parsed.rest);
    expect(built).toEqual({ ok: true, args: { role: "CORA", describe: "a woman", n: 4, seed: 9, "dry-run": false } });
  });

  test("a bad number or a designer outside the enum is an error naming the field", () => {
    const bad = parseCliArgs(["cast", "--role", "CORA", "--candidate", "two"]);
    const built = verbArgsFromCli(verb("cast"), bad.values, bad.rest);
    expect(built.ok).toBe(false);
    expect(!built.ok && built.message).toContain("--candidate must be a number");

    const dia = parseCliArgs(["audition", "--role", "CORA", "--describe", "x", "--designer", "dia"]);
    const result = verbArgsFromCli(verb("audition"), dia.values, dia.rest);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("designer");
  });

  test("cast --auto --episode N parses to the verb's args", () => {
    const parsed = parseCliArgs(["cast", "--auto", "--project", "ice-house", "--episode", "3"]);
    expect(verbArgsFromCli(verb("cast"), parsed.values, parsed.rest)).toEqual({
      ok: true,
      args: { project: "ice-house", auto: true, design: false, episode: 3, all: false, recast: false },
    });
  });

  test("cast --auto --design --role-traits parses to the verb's args (AGT-1699)", () => {
    const parsed = parseCliArgs(["cast", "--auto", "--design", "--project", "ice-house", "--role-traits", '{"RAMON":{"gender":"m"}}']);
    expect(verbArgsFromCli(verb("cast"), parsed.values, parsed.rest)).toEqual({
      ok: true,
      args: { project: "ice-house", auto: true, design: true, "role-traits": '{"RAMON":{"gender":"m"}}', all: false, recast: false },
    });
  });

  test("voices reads its subcommand and slug from positionals", () => {
    const parsed = parseCliArgs(["voices", "show", "cora"]);
    expect(verbArgsFromCli(verb("voices"), parsed.values, parsed.rest)).toEqual({
      ok: true,
      args: { sub: "show", name: "cora", "auto-admitted": false },
    });
  });
});

describe("the CLI", () => {
  test("cast --from-wav is refused by name, before anything is provisioned", () => {
    const result = Bun.spawnSync(["bun", "run", CLI, "cast", "--role", "CORA", "--from-wav", "me.wav", "--json"], {
      env: { ...process.env, PATH: process.env["PATH"] ?? "" },
    });
    expect(result.exitCode).toBe(2);
    const body = JSON.parse(result.stdout.toString()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain("synthetic only");
  });

  test("--help names the casting verbs", () => {
    const help = Bun.spawnSync(["bun", "run", CLI, "--help"]).stdout.toString();
    for (const line of ["pablo audition --role R", "pablo cast --role R --candidate n", "pablo voices list"]) expect(help).toContain(line);
  });

  test("plain text: cast prints the hash, audition its candidates, voices its rows", () => {
    expect(castingText("cast", { ok: true, message: "cast cora from candidate 2: card abc123" })).toBe("pablo: cast cora from candidate 2: card abc123");
    const audition = castingText("audition", {
      ok: true,
      message: "2 candidates",
      candidates: [
        { candidate: 1, seed: 7, seconds: 26.1, reference_ok: true, scores: { utmos: 4.1, pitch_hz: 180, wps: 2.9 }, near_duplicates: [2], file: "/x/1.wav" },
        { candidate: 2, seed: 8, seconds: 31.2, reference_ok: false, scores: { utmos: 3.9, pitch_hz: 181, wps: 2.5 }, near_duplicates: [1], file: "/x/2.wav" },
      ],
    });
    expect(audition).toContain("1: seed 7, 26.1 s, naturalness 4.1/5, 180 Hz, 2.9 w/s, sounds like 2");
    expect(audition).toContain("too short or long for a reference");
    const voices = castingText("voices", {
      ok: true,
      library: "/lib",
      voices: [
        { slug: "cora", cast: true, hash: "0123456789abcdef", traits: { gender: "f", roles: ["lead", "bookkeeper"] }, retired: true, admitted_by: "matt" },
        { slug: "edwin", cast: false, auditions: 3 },
      ],
    });
    expect(voices).toContain("cora  0123456789ab  gender=f roles=lead/bookkeeper  (retired)");
    expect(voices).toContain("edwin  not cast (3 auditions)");
    const auto = castingText("cast", {
      ok: true,
      message: "auto-cast 2 roles; NELL marked review; RAMON needs a designed voice",
      bindings: [
        { role: "CORA", slug: "cora", by: "match", score: 1, runnerUp: { slug: "cora-twin", score: 0.824 }, review: false, new: true },
        { role: "NELL", slug: "maren", by: "match", score: 0.667, runnerUp: null, review: true, new: true },
        { role: "EDWIN", slug: "edwin", by: "manual", score: null, runnerUp: null, review: false, new: false, pin: "changed" },
      ],
      needsDesign: [{ role: "RAMON", reason: "the best match, tom, scored 0.143, below 0.6" }],
    });
    expect(auto).toContain("CORA -> cora (match, score 1, runner-up cora-twin 0.824)");
    expect(auto).toContain("NELL -> maren (match, score 0.667)  REVIEW");
    expect(auto).toContain("EDWIN -> edwin (manual)  PIN CHANGED");
    expect(auto).toContain("RAMON: needs a designed voice (the best match, tom, scored 0.143, below 0.6)");
    const designed = castingText("cast", {
      ok: true,
      message: "designed and admitted RAMON -> ramon",
      bindings: [{ role: "RAMON", slug: "ramon", by: "design", score: null, runnerUp: null, review: false, new: true }],
      needsDesign: [],
      designed: [{ role: "RAMON", slug: "ramon", hash: "fedcba9876543210", round: 2, candidate: 9 }],
    });
    expect(designed).toContain("RAMON -> ramon (design)");
    expect(designed).toContain("RAMON: designed ramon (round 2, candidate 9), card fedcba987654");
    const partial = castingText("cast", {
      ok: false,
      bindings: [],
      needsDesign: [{ role: "BOSUN", reason: "not on the CAST: line" }],
      refused: [{ role: "BOSUN", message: "no voice could be cast for BOSUN" }],
    });
    expect(partial).toContain("BOSUN: REFUSED (no voice could be cast for BOSUN)");
    expect(partial).not.toContain("BOSUN: needs a designed voice");
  });
});

describe("perform (AGT-1683)", () => {
  const work = (vault: string) => join(vault, "novels", "ice-house");

  test("is one VERBS entry and one MCP tool", () => {
    expect(VERBS.filter((v) => v.name === "perform")).toHaveLength(1);
    expect(mcpTools().filter((t) => t.name === "perform")).toHaveLength(1);
  });

  test("provisions with the scorers extra and passes the episode, engine, vault and work", async () => {
    const { deps, calls } = fakeMachine();
    const vault = vaultCopy();
    const result = await verbsOver(deps)["perform"]!.run({ project: "ice-house", episode: 1, engine: "dia", "json-lines": false }, ctxIn(vault));
    expect(result.exitCode).toBe(0);
    expect(calls[0]).toEqual(["/fake/bin/uv", "sync", "--frozen", "--extra", "scorers"]);
    expect(lastPython(calls)).toEqual(["perform", "--episode=1", "--engine=dia", `--vault=${vault}`, "--work", work(vault), "--json"]);
  });

  test("needs a project and an episode (or --all, not both); an unknown project is a refusal that runs nothing", async () => {
    const perform = VERBS.find((v) => v.name === "perform")!;
    expect(perform.args.safeParse({ episode: 1 }).success).toBe(false);
    const { deps, calls } = fakeMachine();
    const vault = vaultCopy();
    for (const [args, says] of [
      [{ project: "ice-house" }, "needs --episode N"],
      [{ project: "ice-house", episode: 1, all: true }, "or --all, not both"],
    ] as const) {
      const result = await verbsOver(deps)["perform"]!.run({ "json-lines": false, all: false, stream: false, ...args }, ctxIn(vault));
      expect(result.exitCode).toBe(2);
      expect((result.body as { message: string }).message).toContain(says);
    }
    const result = await verbsOver(deps)["perform"]!.run({ project: "nope", episode: 1, "json-lines": false }, ctxIn(vault));
    expect(result.exitCode).toBe(2);
    // AGT-1686: the episode may be `--episode N` or `--output radio --unit N`, so naming neither is a refusal at run time.
    const none = await verbsOver(deps)["perform"]!.run({ project: "ice-house", "json-lines": false }, ctxIn(vaultCopy()));
    expect(none.exitCode).toBe(2);
    expect((none.body as { message: string }).message).toContain("needs --episode N (or --output radio --unit N)");
    expect(calls).toEqual([]);
  });

  test("--json-lines relays each progress event to stdout as it arrives, never the body", async () => {
    const { deps } = fakeMachine();
    const vault = vaultCopy();
    const events = [{ event: "start", lines: 1 }, { event: "line", i: 0, take: "ab" }, { event: "done" }].map((e) => JSON.stringify(e));
    const body = { ok: true, episode: 1, manifest: "/m/v1.json" };
    const seen: string[][] = [];
    const streaming: CastingDeps = {
      ...deps,
      stream: async (argv, _options, onLine) => {
        seen.push([...argv]);
        for (const line of [...events, JSON.stringify(body)]) onLine(line);
        return { code: 0, stdout: [...events, JSON.stringify(body)].join("\n"), stderr: "" };
      },
    };
    const written: string[] = [];
    const ctx = { ...ctxIn(vault), stdout: { write: (text: string) => void written.push(text) } };
    const result = await verbsOver(streaming)["perform"]!.run({ project: "ice-house", episode: 1, "json-lines": true }, ctx);
    expect(result.exitCode).toBe(0);
    expect(result.body).toMatchObject(body);
    expect(written).toEqual(events.map((e) => `${e}\n`));
    expect(seen[0]).toContain("--json-lines");
  });

  test("without a stdout to relay to (pablo mcp), --json-lines stays on stderr only", async () => {
    const { deps, calls } = fakeMachine();
    const vault = vaultCopy();
    await verbsOver(deps)["perform"]!.run({ project: "ice-house", episode: 2, "json-lines": true }, ctxIn(vault));
    expect(lastPython(calls)).not.toContain("--json-lines");
  });

  test("castingText summarises a perform body", () => {
    const text = castingText("perform", {
      ok: true,
      message: "episode 1 v1: 4 lines, 3 pass, 1 best-of (flagged), 6 takes rendered, rtf_total 0.9",
      manifest: "/w/outputs/radio/casting/renders/ep01/v1.json",
      wall: 12.5,
      audioSeconds: 14.2,
      rtfTotal: 0.9,
      rtfEngine: 0.4,
      flags: ["f-auto-1"],
    });
    expect(text).toContain("manifest: /w/outputs/radio/casting/renders/ep01/v1.json");
    expect(text).toContain("rtf_total 0.9, engine 0.4");
    expect(text).toContain("1 line(s) auto-flagged");
  });

  test("the CLI parses --episode and --json-lines for perform", () => {
    const parsed = parseCliArgs(["perform", "--project", "ice-house", "--episode", "3", "--json-lines"]);
    const built = verbArgsFromCli(VERBS.find((v) => v.name === "perform")!, parsed.values, parsed.rest);
    expect(built).toEqual({ ok: true, args: { project: "ice-house", episode: 3, "json-lines": true, all: false, stream: false } });
  });
});

describe("mix (AGT-1684)", () => {
  const work = (vault: string) => join(vault, "novels", "ice-house");

  test("is one VERBS entry and one MCP tool", () => {
    expect(VERBS.filter((v) => v.name === "mix")).toHaveLength(1);
    expect(mcpTools().filter((t) => t.name === "mix")).toHaveLength(1);
  });

  test("provisions with the mix extra and passes the episode, version, vault and work", async () => {
    const { deps, calls } = fakeMachine();
    const vault = vaultCopy();
    performed(vault, 2);
    const result = await verbsOver(deps)["mix"]!.run({ project: "ice-house", episode: 2, version: 3 }, ctxIn(vault));
    expect(result.exitCode).toBe(0);
    expect(calls[0]).toEqual(["/fake/bin/uv", "sync", "--frozen", "--extra", "mix"]);
    expect(lastPython(calls)).toEqual(["mix", "--episode=2", "--version=3", `--vault=${vault}`, "--work", work(vault), "--json"]);
  });

  test("the version is optional, and a project and an episode are required", async () => {
    const mix = VERBS.find((v) => v.name === "mix")!;
    expect(mix.args.safeParse({ project: "ice-house", episode: 1 }).success).toBe(true);
    expect(mix.args.safeParse({ episode: 1 }).success).toBe(false);
    const { deps, calls } = fakeMachine();
    const none = await verbsOver(deps)["mix"]!.run({ project: "ice-house" }, ctxIn(vaultCopy()));
    expect(none.exitCode).toBe(2);
    expect(calls).toEqual([]);
    const vault = vaultCopy();
    performed(vault, 1);
    await verbsOver(deps)["mix"]!.run({ project: "ice-house", episode: 1 }, ctxIn(vault));
    expect(lastPython(calls).some((arg) => arg.startsWith("--version"))).toBe(false);
  });

  test("an unknown project is a refusal that runs nothing", async () => {
    const { deps, calls } = fakeMachine();
    const result = await verbsOver(deps)["mix"]!.run({ project: "nope", episode: 1 }, ctxIn(vaultCopy()));
    expect(result.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });

  test("the CLI reads --version k as the mix version, and --version alone elsewhere still prints the version", () => {
    for (const argv of [
      ["mix", "--project", "ice-house", "--episode", "3", "--version", "2"],
      ["mix", "--project", "ice-house", "--episode", "3", "--version=2"],
    ]) {
      const parsed = parseCliArgs(argv);
      expect(parsed.version).toBe(false);
      const built = verbArgsFromCli(VERBS.find((v) => v.name === "mix")!, parsed.values, parsed.rest);
      expect(built).toEqual({ ok: true, args: { project: "ice-house", episode: 3, version: 2 } });
    }
    const bare = parseCliArgs(["mix", "--project", "ice-house", "--episode", "3"]);
    expect(verbArgsFromCli(VERBS.find((v) => v.name === "mix")!, bare.values, bare.rest)).toEqual({ ok: true, args: { project: "ice-house", episode: 3 } });
    expect(parseCliArgs(["--version"]).version).toBe(true);
    expect(parseCliArgs(["perform", "-v"]).version).toBe(true);
  });

  test("castingText summarises a mix body", () => {
    const text = castingText("mix", {
      ok: true,
      message: "episode 1 v1: 345.7 s, 60 lines, 19 cues (12 generated, 0 reused) -> ep01.v1.m4a",
      audio: "/w/outputs/radio/casting/renders/ep01/ep01.v1.m4a",
      manifest: "/w/outputs/radio/casting/renders/ep01/v1.json",
      duration: 345.7,
      cuesGenerated: 12,
      cuesReused: 0,
      cueLibrary: "/lib/cues",
      linkMoved: true,
    });
    expect(text).toContain("audio: /w/outputs/radio/casting/renders/ep01/ep01.v1.m4a");
    expect(text).toContain("12 cue(s) generated, 0 reused (/lib/cues)");
  });
});

describe("fix (AGT-1685)", () => {
  const work = (vault: string) => join(vault, "novels", "ice-house");

  test("is one VERBS entry and one MCP tool", () => {
    expect(VERBS.filter((v) => v.name === "fix")).toHaveLength(1);
    expect(mcpTools().filter((t) => t.name === "fix")).toHaveLength(1);
  });

  test("provisions the scorers and mix extras and passes the episode, vault and work", async () => {
    const { deps, calls } = fakeMachine();
    const vault = vaultCopy();
    performed(vault, 2, 1);
    const result = await verbsOver(deps)["fix"]!.run({ project: "ice-house", episode: 2, "json-lines": false }, ctxIn(vault));
    expect(result.exitCode).toBe(0);
    expect(calls[0]).toEqual(["/fake/bin/uv", "sync", "--frozen", "--extra", "mix", "--extra", "scorers"]);
    expect(lastPython(calls)).toEqual(["fix", "--episode=2", `--vault=${vault}`, "--work", work(vault), "--json"]);
  });

  test("a project and an episode are required, and an unknown project runs nothing", async () => {
    const fix = VERBS.find((v) => v.name === "fix")!;
    expect(fix.args.safeParse({ project: "ice-house", episode: 1 }).success).toBe(true);
    expect(fix.args.safeParse({ episode: 1 }).success).toBe(false);
    const { deps, calls } = fakeMachine();
    const result = await verbsOver(deps)["fix"]!.run({ project: "nope", episode: 1, "json-lines": false }, ctxIn(vaultCopy()));
    expect(result.exitCode).toBe(2);
    const none = await verbsOver(deps)["fix"]!.run({ project: "ice-house", "json-lines": false }, ctxIn(vaultCopy()));
    expect(none.exitCode).toBe(2);
    expect(calls).toEqual([]);
  });

  test("the CLI parses --episode and --json-lines for fix", () => {
    const parsed = parseCliArgs(["fix", "--project", "ice-house", "--episode", "3", "--json-lines"]);
    const built = verbArgsFromCli(VERBS.find((v) => v.name === "fix")!, parsed.values, parsed.rest);
    expect(built).toEqual({ ok: true, args: { project: "ice-house", episode: 3, "json-lines": true } });
  });

  test("castingText summarises a fix body", () => {
    const text = castingText("fix", {
      ok: true,
      message: "episode 1 v2: re-recorded line(s) 7, 41",
      manifest: "/w/outputs/radio/casting/renders/ep01/v2.json",
      changedLines: [7, 41],
      audio: "/w/outputs/radio/casting/renders/ep01/ep01.v2.m4a",
      flags: ["f-auto-x"],
    });
    expect(text).toContain("changed lines: 7, 41");
    expect(text).toContain("audio: /w/outputs/radio/casting/renders/ep01/ep01.v2.m4a");
    expect(text).toContain("1 line(s) flagged again automatically");
  });
});
