/**
 * `audition --preview` (AGT-2298): candidates read the work's own text. The Python side is a fake runner that
 * records argv and environment; the audio is `packages/casting/tests/test_audition_preview.py` over fake engines.
 * Nothing loads a model, runs uv or Python, or opens a window. Runs on a temp copy of the synthetic fixture vault.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { venvPython } from "../src/casting";
import type { CastingDeps } from "../src/casting";
import { parseCliArgs } from "../src/cli";
import { CASTING_OUTPUT_ENV } from "../src/outputs/audio";
import { VERBS, verbArgsFromCli } from "../src/verbs";
import type { VerbContext } from "../src/verbs";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const STATE_HOME = mkdtempSync(join(tmpdir(), "pablo-audition-preview-state-"));
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

function work(outputs: Record<string, unknown>): { vault: string; work: string } {
  const vault = join(temp("pablo-audition-preview-"), "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const dir = join(vault, "novels", "ice-house");
  const marker = JSON.parse(readFileSync(join(dir, "pablo.json"), "utf8")) as Record<string, unknown>;
  delete marker["format"];
  writeFileSync(join(dir, "pablo.json"), `${JSON.stringify({ ...marker, outputs }, null, 2)}\n`);
  mkdirSync(join(dir, "outputs", "narrated", "readings"), { recursive: true });
  writeFileSync(join(dir, "outputs", "narrated", "readings", "01-reading.md"), 'CAST: NARRATOR="the narrator"\n\nNARRATOR: A first line.\n');
  return { vault, work: dir };
}

interface Call {
  readonly argv: string[];
  readonly output: string | undefined;
}

function fakeMachine(): { deps: CastingDeps; calls: Call[] } {
  const source = temp("pablo-audition-preview-casting-");
  writeFileSync(join(source, "pyproject.toml"), '[project]\nname = "pablo-casting"\n');
  writeFileSync(join(source, "uv.lock"), "version = 1\n");
  const venv = join(source, ".venv");
  const layout = { source, venv, install: "checkout" as const };
  mkdirSync(join(venv, "bin"), { recursive: true });
  writeFileSync(venvPython(layout), "");
  const lock = createHash("sha256").update(readFileSync(join(source, "uv.lock"))).digest("hex");
  writeFileSync(join(venv, ".pablo-provisioned.json"), JSON.stringify({ lock, at: "2026-11-14T00:00:00Z", extras: [] }));
  const calls: Call[] = [];
  const run = (argv: readonly string[], options: { readonly env: Record<string, string | undefined> }) => {
    calls.push({ argv: argv.slice(3), output: options.env[CASTING_OUTPUT_ENV] });
    return { code: 0, stdout: JSON.stringify({ ok: true, preview: true, previews: [] }), stderr: "" };
  };
  const deps: CastingDeps = { layout, which: () => "/fake/bin/uv", run, stream: async (argv, options) => run(argv, options), now: () => new Date("2026-11-14T12:00:00Z") };
  return { deps, calls };
}

function ctx(vault: string, deps: CastingDeps): VerbContext {
  return { cwd: vault, env: { PATH: "/nowhere", XDG_STATE_HOME: STATE_HOME }, stderr: { write: () => undefined }, casting: deps };
}

const audition = VERBS.find((v) => v.name === "audition")!;
const NARRATED = { novel: { dir: "chapters", added: "2026-09-01" }, narrated: { added: "2026-10-26", from: "novel" } };

test("AC1: audition --preview --output narrated --unit N --lines a-b asks the Python side, told the output", async () => {
  const { vault, work: dir } = work(NARRATED);
  const { deps, calls } = fakeMachine();
  const result = await audition.run({ project: "ice-house", role: "NARRATOR", preview: true, output: "narrated", unit: 1, lines: "0-3", voice: "fenn", "dry-run": false }, ctx(vault, deps));
  expect(result.exitCode).toBe(0);
  expect(calls.at(-1)).toEqual({
    argv: ["audition", "--preview", "--role=NARRATOR", "--voice=fenn", "--lines=0-3", "--episode=1", `--vault=${vault}`, "--work", dir, "--json"],
    output: "narrated",
  });
});

test("AC2: a NARRATOR preview with no unit passes the passage choice through and needs no output", async () => {
  const { vault } = work(NARRATED);
  const { deps, calls } = fakeMachine();
  await audition.run({ project: "ice-house", role: "NARRATOR", preview: true, passage: "expository", "dry-run": false }, ctx(vault, deps));
  expect(calls.at(-1)?.argv).toContain("--passage=expository");
  expect(calls.at(-1)?.argv).not.toContain("--episode=1");
  expect(calls.at(-1)?.output).toBeUndefined();
});

test("a preview of the work's text with no unit, or on an output the work lacks, is refused before anything runs", async () => {
  const { vault } = work(NARRATED);
  const { deps, calls } = fakeMachine();
  const noUnit = await audition.run({ project: "ice-house", role: "NARRATOR", preview: true, lines: "0-2", "dry-run": false }, ctx(vault, deps));
  expect(noUnit.exitCode).toBe(2);
  const lacking = work({ novel: { dir: "chapters", added: "2026-09-01" } });
  const refused = await audition.run({ project: "ice-house", role: "NARRATOR", preview: true, output: "narrated", unit: 1, "dry-run": false }, ctx(lacking.vault, deps));
  expect(refused.exitCode).toBe(2);
  expect(calls).toHaveLength(0);
});

test("a plain audition is unchanged and does not preview", async () => {
  const { vault } = work(NARRATED);
  const { deps, calls } = fakeMachine();
  await audition.run({ project: "ice-house", role: "CORA", describe: "a voice", "dry-run": false, preview: false }, ctx(vault, deps));
  expect(calls.at(-1)?.argv).not.toContain("--preview");
});

test("the CLI spells it --preview --output narrated --unit 1 --lines 0-3", () => {
  const parsed = parseCliArgs(["audition", "--preview", "--role", "NARRATOR", "--output", "narrated", "--unit", "1", "--lines", "0-3", "--passage", "work"]);
  const args = verbArgsFromCli(audition, parsed.values, parsed.rest);
  expect(args).toMatchObject({ ok: true, args: { preview: true, role: "NARRATOR", output: "narrated", unit: 1, lines: "0-3", passage: "work" } });
});
