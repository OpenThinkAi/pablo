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

function vaultCopy(): string {
  const vault = join(temp("pablo-casting-vault-"), "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  return vault;
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
  });
});
