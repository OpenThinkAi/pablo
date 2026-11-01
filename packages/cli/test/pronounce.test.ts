/**
 * `pablo pronounce` (AGT-2302): one `VERBS` entry and MCP tool, read-only, that asks the Python side
 * (`python -m pablo_casting pronounce`) what the engine will say for an output's script lines. Here the Python side
 * is a fake runner that records argv and the output its environment names; nothing runs uv, Python or a model. The
 * normalisers themselves are tested in `packages/casting/tests/test_spoken.py`.
 *
 * Everything runs on a temp copy of the synthetic fixture vault; never `~/writing`.
 */

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { venvPython } from "../src/casting";
import type { CastingDeps } from "../src/casting";
import { castingVerbs } from "../src/casting-verbs";
import { castingText } from "../src/cli";
import { mcpTools } from "../src/mcp";
import { CASTING_OUTPUT_ENV } from "../src/outputs/audio";
import { VERBS } from "../src/verbs";
import type { Verb, VerbContext } from "../src/verbs";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** The fixture vault with ice-house given a narrated output. */
function narratedWork(): { vault: string; work: string } {
  const vault = join(temp("pablo-pronounce-"), "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  delete marker["format"];
  writeFileSync(join(work, "pablo.json"), `${JSON.stringify({ ...marker, outputs: { novel: { dir: "chapters", added: "2026-09-01" }, narrated: { added: "2026-10-26", from: "novel" } } }, null, 2)}\n`);
  return { vault, work };
}

interface Call {
  readonly argv: string[];
  readonly output: string | undefined;
}

function fakeMachine(): { deps: CastingDeps; calls: Call[] } {
  const source = temp("pablo-pronounce-casting-");
  writeFileSync(join(source, "pyproject.toml"), '[project]\nname = "pablo-casting"\n');
  writeFileSync(join(source, "uv.lock"), "version = 1\n");
  const venv = join(source, ".venv");
  const layout = { source, venv, install: "checkout" as const };
  mkdirSync(join(venv, "bin"), { recursive: true });
  writeFileSync(venvPython(layout), "");
  const lock = createHash("sha256").update(readFileSync(join(source, "uv.lock"))).digest("hex");
  writeFileSync(join(venv, ".pablo-provisioned.json"), JSON.stringify({ lock, at: "2026-11-01T00:00:00Z", extras: [] }));
  const calls: Call[] = [];
  const deps: CastingDeps = {
    layout,
    which: () => "/fake/bin/uv",
    run: (argv, options) => {
      calls.push({ argv: argv.slice(3), output: options.env[CASTING_OUTPUT_ENV] });
      return { code: 0, stdout: JSON.stringify({ ok: true, output: options.env[CASTING_OUTPUT_ENV], units: [], unresolved: [], changedLines: 0 }), stderr: "" };
    },
    now: () => new Date("2026-11-01T12:00:00Z"),
  };
  return { deps, calls };
}

function verb(deps: CastingDeps): Verb {
  const found = castingVerbs(() => deps).find((v) => v.name === "pronounce");
  if (found === undefined) throw new Error("no pronounce verb");
  return found;
}

function ctxIn(cwd: string): VerbContext {
  return { cwd, env: { PATH: "/nowhere", XDG_STATE_HOME: join(cwd, "state") }, stderr: { write: () => undefined } };
}

test("pronounce is one VERBS entry and MCP tool, and needs a project", () => {
  expect(VERBS.filter((v) => v.name === "pronounce")).toHaveLength(1);
  expect(mcpTools().filter((t) => t.name === "pronounce")).toHaveLength(1);
  expect(verb(fakeMachine().deps).args.safeParse({}).success).toBe(false);
});

test("pronounce --output narrated --unit N asks the Python side for that unit of the narrated output, writing nothing", async () => {
  const { vault, work } = narratedWork();
  const { deps, calls } = fakeMachine();
  const result = await verb(deps).run({ project: "ice-house", output: "narrated", unit: 1 } as never, ctxIn(vault));
  expect(result.exitCode).toBe(0);
  const last = calls.at(-1)!;
  expect(last.output).toBe("narrated");
  expect(last.argv).toEqual(["pronounce", "--episode=1", `--vault=${vault}`, "--work", work, "--json"]);
  expect(calls.some((c) => c.argv[0] === "sync" || c.argv.includes("pull"))).toBe(false);
});

test("pronounce defaults to the work's one performed output, else radio, and every unit, and refuses an output the work does not have or a bare --unit", async () => {
  const { vault } = narratedWork();
  const { deps, calls } = fakeMachine();
  expect((await verb(deps).run({ project: "ice-house" } as never, ctxIn(vault))).exitCode).toBe(0);
  expect(calls.at(-1)!.output).toBe("narrated"); // the work's one performed output
  expect(calls.at(-1)!.argv[1]).toBe(`--vault=${vault}`);
  const before = calls.length;
  expect((await verb(deps).run({ project: "ice-house", output: "radio" } as never, ctxIn(vault))).exitCode).toBe(2);
  expect((await verb(deps).run({ project: "ice-house", unit: 1 } as never, ctxIn(vault))).exitCode).toBe(2);
  expect((await verb(deps).run({ project: "ice-house", output: "novel" } as never, ctxIn(vault))).exitCode).toBe(2);
  expect(calls.length).toBe(before);
});

test("pronounce's plain text lists each changed line, its tokens and engine text, then the undecided words", () => {
  const text = castingText("pronounce", {
    ok: true,
    output: "narrated",
    acronyms: true,
    lexicon: "outputs/narrated/pronounce.md",
    lexiconEntries: 0,
    changedLines: 1,
    units: [
      {
        unit: 1,
        file: "outputs/narrated/readings/01-jobs.md",
        lines: [{ line: 3, speaker: "NARRATOR", text: "AI at 10-20%", engine: "A.I. at ten to twenty percent", changes: [{ from: "10-20%", to: "ten to twenty percent" }, { from: "AI", to: "A.I." }] }],
      },
    ],
    unresolved: [{ token: "Okafor", kind: "capitalised", count: 2, first: { unit: 1, line: 7 } }],
  });
  expect(text).toContain("acronyms read as letters");
  expect(text).toContain('  3 NARRATOR: "10-20%" -> "ten to twenty percent", "AI" -> "A.I."');
  expect(text).toContain("      A.I. at ten to twenty percent");
  expect(text).toContain("  Okafor  capitalised, 2x, first unit 1 line 7");
});
