/**
 * `pablo flag` and `pablo fix --stale` (AGT-2305, pm project `pablo-platform`).
 *
 * AC1: `fix --stale` re-records the lines whose take no longer matches how they are spoken: the Python side
 *      (`packages/casting/tests/test_fix.py`) decides and does it; here the verb reaches it with no open flag.
 * AC2: `pronounce`'s text names the stale lines (its count comes from the Python side).
 * AC3: `pablo flag --project <slug> --output narrated --unit N --line I[,J|all] "<reason>"` writes the flags.json
 *      `pablo fix` reads, with no player and no model.
 *
 * Everything runs on a temp copy of the synthetic fixture vault; never `~/writing`. The Python side is a fake.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { venvPython } from "../src/casting";
import type { CastingDeps } from "../src/casting";
import { castingText, parseCliArgs } from "../src/cli";
import { parseLines } from "../src/flag-lines";
import { VERBS, verbArgsFromCli } from "../src/verbs";
import type { VerbContext } from "../src/verbs";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const STATE_HOME = mkdtempSync(join(tmpdir(), "pablo-flag-stale-state-"));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => rmSync(STATE_HOME, { recursive: true, force: true }));

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const CASTING = ["outputs", "narrated", "casting"];
const FLAGS = (work: string): string => join(work, ...CASTING, "flags.json");
const flagsOf = (work: string): Array<Record<string, unknown>> => (JSON.parse(readFileSync(FLAGS(work), "utf8")) as { flags: Array<Record<string, unknown>> }).flags;

/** A fixture work with a narrated output whose unit 1 is performed (v1, three lines) and its narrator cast. */
function performedWork(performed = true): { vault: string; work: string } {
  const vault = join(temp("pablo-flag-stale-"), "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  delete marker["format"];
  writeFileSync(join(work, "pablo.json"), `${JSON.stringify({ ...marker, outputs: { novel: { dir: "chapters", added: "2026-09-01" }, narrated: { added: "2026-10-26", from: "novel" } } }, null, 2)}\n`);
  mkdirSync(join(work, "outputs", "narrated", "readings"), { recursive: true });
  writeFileSync(join(work, "outputs", "narrated", "readings", "01-the-last-full-cut.md"), 'CAST: NARRATOR="the narrator"\n\nNARRATOR: One.\n\nNARRATOR: Two.\n\nNARRATOR: Three.\n');
  mkdirSync(join(work, ...CASTING), { recursive: true });
  writeFileSync(join(work, ...CASTING, "cast.json"), JSON.stringify({ version: 1, roles: { NARRATOR: { slug: "reader", card_hash: "h", by: "match", at: "2026-10-26T00:00:00Z" } } }));
  if (performed) {
    const dir = join(work, ...CASTING, "renders", "ep01");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "v1.json"), JSON.stringify({ version: 1, lines: [{ i: 0 }, { i: 1 }, { i: 2 }] }));
  }
  return { vault, work };
}

function fakeMachine(): { deps: CastingDeps; calls: string[][] } {
  const source = temp("pablo-flag-stale-casting-");
  writeFileSync(join(source, "pyproject.toml"), '[project]\nname = "pablo-casting"\n');
  writeFileSync(join(source, "uv.lock"), "version = 1\n");
  const venv = join(source, ".venv");
  const layout = { source, venv, install: "checkout" as const };
  mkdirSync(join(venv, "bin"), { recursive: true });
  writeFileSync(venvPython(layout), "");
  const lock = createHash("sha256").update(readFileSync(join(source, "uv.lock"))).digest("hex");
  writeFileSync(join(venv, ".pablo-provisioned.json"), JSON.stringify({ lock, at: "2026-10-26T00:00:00Z", extras: ["mix", "scorers"] }));
  const calls: string[][] = [];
  const run = (argv: readonly string[]) => {
    calls.push(argv.slice(3));
    return { code: 0, stdout: JSON.stringify({ ok: true, episode: 1, version: 2 }), stderr: "" };
  };
  return { deps: { layout, which: () => "/fake/bin/uv", run, stream: async (argv) => run(argv), now: () => new Date("2026-10-26T12:00:00Z") }, calls };
}

function ctxFor(vault: string, deps?: CastingDeps): VerbContext {
  return { cwd: vault, env: { PATH: "/nowhere", XDG_STATE_HOME: STATE_HOME }, stderr: { write: () => undefined }, ...(deps === undefined ? {} : { casting: deps }) };
}

function verb(name: string) {
  const found = VERBS.find((v) => v.name === name);
  if (found === undefined) throw new Error(`no verb ${name}`);
  return found;
}

// ---------------------------------------------------------------------------
// AC3: pablo flag
// ---------------------------------------------------------------------------

test("AC3: flag writes the flags fix reads, one per line, for a narrated unit", async () => {
  const { vault, work } = performedWork();
  const result = await verb("flag").run({ project: "ice-house", output: "narrated", unit: 1, line: "0,2", reason: "wrong voice" }, ctxFor(vault));
  expect(result.exitCode).toBe(0);
  expect(result.body).toMatchObject({ ok: true, output: "narrated", unit: 1, version: 1, lines: [0, 2] });
  expect((result.body as { message: string }).message).toBe("flagged lines 0, 2 of narrated unit 1 v1: wrong voice; re-record with pablo fix");
  expect(flagsOf(work).map((f) => ({ episode: f["episode"], line: f["line"], reason: f["reason"], by: f["by"], source: f["source"] }))).toEqual([
    { episode: 1, line: 0, reason: "wrong voice", by: "cli", source: "human" },
    { episode: 1, line: 2, reason: "wrong voice", by: "cli", source: "human" },
  ]);
  expect(new Set(flagsOf(work).map((f) => f["id"])).size).toBe(2);
});

test("AC3: all flags every line; flagging a line again replaces the listener's flag and keeps the performer's", async () => {
  const { vault, work } = performedWork();
  writeFileSync(FLAGS(work), JSON.stringify({ keep: true, flags: [{ id: "a1", episode: 1, line: 1, reason: "best of 4 failed: pace", source: "auto", by: "auto" }, { id: "o1", episode: 2, line: 1, reason: "flat", by: "human" }] }));
  const all = await verb("flag").run({ project: "ice-house", output: "narrated", unit: 1, line: "all", reason: "flat" }, ctxFor(vault));
  expect(all.exitCode).toBe(0);
  expect(flagsOf(work).filter((f) => f["episode"] === 1 && f["by"] === "cli").map((f) => f["line"])).toEqual([0, 1, 2]);
  await verb("flag").run({ project: "ice-house", output: "narrated", unit: 1, line: "1", reason: "rushed" }, ctxFor(vault));
  const onOne = flagsOf(work).filter((f) => f["episode"] === 1 && f["line"] === 1);
  expect(onOne.map((f) => [f["by"], f["reason"]])).toEqual([["auto", "best of 4 failed: pace"], ["cli", "rushed"]]);
  expect(flagsOf(work).some((f) => f["id"] === "o1")).toBe(true); // another unit's flag is untouched
  expect(JSON.parse(readFileSync(FLAGS(work), "utf8"))).toMatchObject({ keep: true });
});

test("AC3: flag refuses a unit that is not performed, a line it lacks, a bad line list and a missing reason, writing nothing", async () => {
  const unperformed = performedWork(false);
  const ask = (ctx: VerbContext, line: string, reason: string) => verb("flag").run({ project: "ice-house", output: "narrated", unit: 1, line, reason }, ctx);
  const none = await ask(ctxFor(unperformed.vault), "0", "flat");
  expect(none.exitCode).toBe(2);
  expect((none.body as { message: string }).message).toContain("is not performed");
  const { vault, work } = performedWork();
  for (const [line, reason, expected] of [["3", "flat", "there is no line 3 (lines 0-2)"], ["0,x", "flat", "--line must be a line number"], ["0", "  ", "needs a reason"]] as const) {
    const refused = await ask(ctxFor(vault), line, reason);
    expect(refused.exitCode).toBe(2);
    expect((refused.body as { message: string }).message).toContain(expected);
  }
  expect(() => readFileSync(FLAGS(work))).toThrow();
});

test("AC3: flag is a CLI verb and an MCP tool; the reason is its positional, the line a list or all", () => {
  expect(VERBS.filter((v) => v.name === "flag")).toHaveLength(1);
  const parsed = parseCliArgs(["flag", "--project", "ice-house", "--output", "narrated", "--unit", "1", "--line", "0,2", "needs a retake"]);
  expect(parsed.verb).toBe("flag");
  const args = verbArgsFromCli(verb("flag"), parsed.values, parsed.rest);
  expect(args).toEqual({ ok: true, args: { project: "ice-house", output: "narrated", unit: 1, line: "0,2", reason: "needs a retake" } });
  expect(parseLines("2, 0 ,2", [0, 1, 2])).toEqual({ lines: [0, 2] });
  expect(parseLines("ALL", [0, 1])).toEqual({ lines: [0, 1] });
});

// ---------------------------------------------------------------------------
// AC1: fix --stale
// ---------------------------------------------------------------------------

test("AC1: fix --stale reaches the Python side with --stale and no open flag; plain fix still needs one", async () => {
  const { vault } = performedWork();
  const { deps, calls } = fakeMachine();
  const ctx = ctxFor(vault, deps);
  const plain = await verb("fix").run({ project: "ice-house", output: "narrated", unit: 1, "json-lines": false, stale: false }, ctx);
  expect(plain.body).toMatchObject({ ok: false, missing: ["unit 1 has no open flags (flag lines in pablo mixer)"] });
  expect(calls).toHaveLength(0);
  const stale = await verb("fix").run({ project: "ice-house", output: "narrated", unit: 1, "json-lines": false, stale: true }, ctx);
  expect(stale.exitCode).toBe(0);
  expect(calls.at(-1)).toEqual(expect.arrayContaining(["fix", "--episode=1", "--stale"]));
  const line = await verb("fix").run({ project: "ice-house", output: "narrated", unit: 1, "json-lines": false, stale: true, line: 2 }, ctx);
  expect(line.exitCode).toBe(0);
  expect(calls.at(-1)).toEqual(expect.arrayContaining(["--line=2", "--stale"]));
});

test("AC1: fix --stale on a unit that was never performed is refused before anything runs", async () => {
  const { vault } = performedWork(false);
  const { deps, calls } = fakeMachine();
  const refused = await verb("fix").run({ project: "ice-house", output: "narrated", unit: 1, "json-lines": false, stale: true }, ctxFor(vault, deps));
  expect(refused.exitCode).toBe(2);
  expect(calls).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// AC2: pronounce's text
// ---------------------------------------------------------------------------

test("AC2: pronounce's text names the stale performed lines and the command that re-records them", () => {
  const body = { ok: true, output: "narrated", changedLines: 0, acronyms: false, lexicon: "outputs/narrated/pronounce.md", lexiconEntries: 1, staleLines: 3, units: [{ unit: 1, file: "outputs/narrated/readings/01.md", lines: [], stale: [0, 4, 5] }, { unit: 2, file: "x", lines: [], stale: [] }], unresolved: [] };
  const text = castingText("pronounce", body);
  expect(text).toContain("3 performed line(s) stale (taken from an older pronunciation): unit 1 line(s) 0,4,5; re-record them with pablo fix --stale");
  expect(text).not.toContain("unit 2");
  expect(castingText("pronounce", { ...body, staleLines: 0 })).not.toContain("stale");
});
