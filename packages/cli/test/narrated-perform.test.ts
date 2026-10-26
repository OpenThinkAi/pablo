/**
 * Performing and mixing the narrated output (AGT-2158, pm project `pablo-platform`, D-7, D-19).
 *
 * AC1: `cast`, `perform`, `mix`, `fix` and `mixer` take `--output narrated`: the stage machine reads the reading
 *      and `outputs/narrated/casting/`, and every Python call is told the output (`PABLO_CASTING_OUTPUT`), so the
 *      narrator is auto-cast from the library into the narrated output's own `cast.json`.
 * AC2: `pablo mixer --output narrated --unit N` opens the unit's mix document.
 * AC3 (the fake-engine perform and mix) is `packages/casting/tests/test_narrated.py`; here the Python side is a
 *      fake runner that records argv and environment. Nothing loads a model, runs uv or Python, or opens a window.
 *
 * Everything runs on a temp copy of the synthetic fixture vault; never `~/writing`.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MountOptions, View } from "@openthink/ui-leaf";
import { venvPython } from "../src/casting";
import type { CastingDeps } from "../src/casting";
import { parseCliArgs, runMixerView } from "../src/cli";
import { openMixer } from "../src/mixer-host";
import type { OpenMixerRequest } from "../src/mixer-host";
import { CASTING_OUTPUT_ENV } from "../src/outputs/audio";
import { narrateProse } from "../src/outputs/narrated/narrate";
import { episodeState, radioStageCheck } from "../src/outputs/radio/state";
import { stripFrontmatter } from "../src/publish";
import { VERBS } from "../src/verbs";
import type { VerbContext } from "../src/verbs";

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const STATE_HOME = mkdtempSync(join(tmpdir(), "pablo-narrated-perform-state-"));
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

const NARRATED_CASTING = ["outputs", "narrated", "casting"];

/** The fixture vault with ice-house on a novel and a narrated output reading it, chapter 1 read aloud. */
function narratedWork(outputs: Record<string, unknown> = { novel: { dir: "chapters", added: "2026-09-01" }, narrated: { added: "2026-10-26", from: "novel" } }): { vault: string; work: string } {
  const vault = join(temp("pablo-narrated-perform-"), "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  delete marker["format"];
  writeFileSync(join(work, "pablo.json"), `${JSON.stringify({ ...marker, outputs }, null, 2)}\n`);
  const prose = stripFrontmatter(readFileSync(join(work, "chapters", "01-the-last-full-cut.md"), "utf8"));
  mkdirSync(join(work, "outputs", "narrated", "readings"), { recursive: true });
  writeFileSync(join(work, "outputs", "narrated", "readings", "01-the-last-full-cut.md"), `---\noutput: narrated\nunit: 1\ntitle: The Last Full Cut\n---\n${narrateProse(prose, "narrator")}\n`);
  return { vault, work };
}

function bindNarrator(work: string): void {
  const dir = join(work, ...NARRATED_CASTING);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cast.json"), JSON.stringify({ version: 1, roles: { NARRATOR: { slug: "reader", card_hash: "h", by: "match", at: "2026-10-26T00:00:00Z" } } }));
}

function render(work: string, version: number, mixed: boolean): void {
  const dir = join(work, ...NARRATED_CASTING, "renders", "ep01");
  mkdirSync(dir, { recursive: true });
  const audio = `ep01.v${version}.m4a`;
  writeFileSync(join(dir, `v${version}.json`), JSON.stringify({ version, lines: [], ...(mixed ? { audio } : {}) }));
  if (mixed) {
    writeFileSync(join(dir, audio), "fake-aac");
    writeFileSync(join(dir, `mix.v${version}.json`), JSON.stringify({ schema: 1, episode: 1, version, manifest_version: version, by: "auto", tracks: {} }));
  }
}

interface Call {
  readonly argv: string[];
  readonly output: string | undefined;
}

/**
 * A provisioned fake casting side: records each call's argv and the output its environment names; `perform` and
 * `mix` write what the Python side would under the narrated output's casting directory. Never runs a process.
 */
function fakeMachine(work: string): { deps: CastingDeps; calls: Call[] } {
  const source = temp("pablo-narrated-casting-");
  writeFileSync(join(source, "pyproject.toml"), '[project]\nname = "pablo-casting"\n');
  writeFileSync(join(source, "uv.lock"), "version = 1\n");
  const venv = join(source, ".venv");
  const layout = { source, venv, install: "checkout" as const };
  mkdirSync(join(venv, "bin"), { recursive: true });
  writeFileSync(venvPython(layout), "");
  const lock = createHash("sha256").update(readFileSync(join(source, "uv.lock"))).digest("hex");
  writeFileSync(join(venv, ".pablo-provisioned.json"), JSON.stringify({ lock, at: "2026-10-26T00:00:00Z", extras: ["mix", "scorers"] }));
  const calls: Call[] = [];
  const answer = (body: unknown) => ({ code: 0, stdout: JSON.stringify(body), stderr: "" });
  const run = (argv: readonly string[], options: { readonly env: Record<string, string | undefined> }) => {
    calls.push({ argv: argv.slice(3), output: options.env[CASTING_OUTPUT_ENV] });
    const narrated = options.env[CASTING_OUTPUT_ENV] === "narrated";
    if (argv[3] === "perform" && narrated) {
      render(work, 1, false);
      const receipts = join(work, ".pablo", "casting", "receipts.jsonl");
      mkdirSync(dirname(receipts), { recursive: true });
      // A radio episode 1 receipt first: the narrated unit's body must not pick it up.
      appendFileSync(receipts, `${JSON.stringify({ at: "2026-10-26T11:00:00Z", intent: "perform", episode: 1, version: 7, lines: 99 })}\n`);
      appendFileSync(receipts, `${JSON.stringify({ at: "2026-10-26T12:00:00Z", intent: "perform", episode: 1, version: 1, lines: 4, pass: 4, output: "narrated" })}\n`);
      return answer({ ok: true, episode: 1, version: 1, lines: 4 });
    }
    if (argv[3] === "mix" && narrated) {
      render(work, 1, true);
      return answer({ ok: true, episode: 1, version: 1 });
    }
    return answer({ ok: true });
  };
  const deps: CastingDeps = {
    layout,
    which: () => "/fake/bin/uv",
    run,
    stream: async (argv, options) => run(argv, options),
    now: () => new Date("2026-10-26T12:00:00Z"),
  };
  return { deps, calls };
}

function ctxFor(vault: string, deps: CastingDeps): VerbContext {
  return { cwd: vault, env: { PATH: "/nowhere", XDG_STATE_HOME: STATE_HOME }, stderr: { write: () => undefined }, casting: deps };
}

function verb(name: string) {
  const found = VERBS.find((v) => v.name === name);
  if (found === undefined) throw new Error(`no verb ${name}`);
  return found;
}

// ---------------------------------------------------------------------------
// AC1: the casting verbs
// ---------------------------------------------------------------------------

test("AC1: the stage machine reads the narrated output's reading and casting state, not radio's", () => {
  const { work } = narratedWork();
  expect(radioStageCheck(work, "perform", 1, "narrated")).toEqual({ ready: false, missing: ["role NARRATOR is not cast"] });
  expect(radioStageCheck(work, "perform", 1)).toMatchObject({ ready: false, missing: ["episode 1 has no script (pablo write --output radio --unit 1)"] });
  expect(radioStageCheck(work, "perform", 2, "narrated").missing).toEqual(["unit 2 has no script (pablo write --output narrated --unit 2)"]);
  bindNarrator(work);
  expect(radioStageCheck(work, "perform", 1, "narrated").ready).toBe(true);
  expect(episodeState(work, 1, "narrated")).toMatchObject({ script: true, unbound: [], stage: "perform" });
});

test("AC1: cast --auto --output narrated auto-casts the narrator from the library, the Python side told the output", async () => {
  const { vault, work } = narratedWork();
  const { deps, calls } = fakeMachine(work);
  const one = await verb("cast").run({ project: "ice-house", auto: true, output: "narrated", unit: 1 }, ctxFor(vault, deps));
  expect(one.exitCode).toBe(0);
  expect(calls.at(-1)).toEqual({ argv: ["cast", "--auto", "--episode=1", "--vault=" + vault, "--work", work, "--json"], output: "narrated" });
  const every = await verb("cast").run({ project: "ice-house", auto: true, output: "narrated" }, ctxFor(vault, deps));
  expect(every.exitCode).toBe(0);
  expect(calls.at(-1)).toEqual({ argv: ["cast", "--auto", "--vault=" + vault, "--work", work, "--json"], output: "narrated" });
  // Radio's own auto-cast leaves the environment alone.
  await verb("cast").run({ project: "ice-house", auto: true }, ctxFor(vault, deps));
  expect(calls.at(-1)?.output).toBeUndefined();
});

test("AC1: perform --output narrated refuses an uncast narrator by name, pointing at cast --auto, and runs nothing", async () => {
  const { vault, work } = narratedWork();
  const { deps, calls } = fakeMachine(work);
  const result = await verb("perform").run({ project: "ice-house", output: "narrated", unit: 1, "json-lines": false }, ctxFor(vault, deps));
  expect(result.exitCode).toBe(2);
  expect(result.body).toMatchObject({ ok: false, output: "narrated", unit: 1, stage: "perform", missing: ["role NARRATOR is not cast"] });
  expect((result.body as { message: string }).message).toContain("pablo cast --auto --output narrated --unit 1");
  expect(calls).toHaveLength(0);
});

test("AC1: perform, mix and fix a narrated unit: each Python call names the output; bodies carry output narrated and its own receipt", async () => {
  const { vault, work } = narratedWork();
  bindNarrator(work);
  const { deps, calls } = fakeMachine(work);
  const ctx = ctxFor(vault, deps);

  const performed = await verb("perform").run({ project: "ice-house", output: "narrated", unit: 1, "json-lines": false }, ctx);
  expect(performed.exitCode).toBe(0);
  expect(calls.at(-1)).toMatchObject({ argv: expect.arrayContaining(["perform", "--episode=1"]), output: "narrated" });
  expect(performed.body).toMatchObject({ output: "narrated", unit: 1, audio: null, next: "pablo mix --output narrated --unit 1", receiptSummary: { version: 1, lines: 4, pass: 4 } });

  const mixed = await verb("mix").run({ project: "ice-house", output: "narrated", unit: 1 }, ctx);
  expect(mixed.exitCode).toBe(0);
  expect(calls.at(-1)).toMatchObject({ argv: expect.arrayContaining(["mix", "--episode=1"]), output: "narrated" });
  expect(mixed.body).toMatchObject({ output: "narrated", unit: 1 });

  // Fix reads the narrated output's flags.json; with none open it is refused before anything runs.
  const before = calls.length;
  const noFlags = await verb("fix").run({ project: "ice-house", output: "narrated", unit: 1, "json-lines": false }, ctx);
  expect(noFlags.body).toMatchObject({ ok: false, output: "narrated", missing: ["unit 1 has no open flags (flag lines in pablo mixer)"] });
  expect(calls).toHaveLength(before);
  writeFileSync(join(work, ...NARRATED_CASTING, "flags.json"), JSON.stringify({ flags: [{ id: "f1", episode: 1, line: 0, reason: "flat", by: "matt" }] }));
  const fixed = await verb("fix").run({ project: "ice-house", output: "narrated", unit: 1, "json-lines": false }, ctx);
  expect(fixed.exitCode).toBe(0);
  expect(calls.at(-1)).toMatchObject({ argv: expect.arrayContaining(["fix", "--episode=1"]), output: "narrated" });
  expect(existsSync(join(work, "outputs", "radio"))).toBe(false);
});

test("AC1: --all and --stream stay radio's; an output the work lacks, or one that is not performed, is refused", async () => {
  const { vault, work } = narratedWork();
  bindNarrator(work);
  const { deps, calls } = fakeMachine(work);
  const ctx = ctxFor(vault, deps);
  expect((await verb("perform").run({ project: "ice-house", output: "narrated", all: true, "json-lines": false }, ctx)).exitCode).toBe(2);
  expect((await verb("perform").run({ project: "ice-house", output: "narrated", unit: 1, stream: true, "json-lines": false }, ctx)).exitCode).toBe(2);
  expect((await verb("mix").run({ project: "ice-house", output: "novel", unit: 1 }, ctx)).body).toMatchObject({ missing: ["--output radio", "--output narrated"] });
  expect((await verb("mix").run({ project: "ice-house", output: "narrated" }, ctx)).body).toMatchObject({ missing: ["--unit N"] });
  expect(calls).toHaveLength(0);

  const radioOnly = narratedWork({ novel: { dir: "chapters", added: "2026-09-01" } });
  const refused = await verb("perform").run({ project: "ice-house", output: "narrated", unit: 1, "json-lines": false }, ctxFor(radioOnly.vault, fakeMachine(radioOnly.work).deps));
  expect(refused.exitCode).toBe(2);
});

// ---------------------------------------------------------------------------
// AC2: the mixer
// ---------------------------------------------------------------------------

function fakeMount(): { mount: (options: MountOptions) => Promise<View>; calls: MountOptions[] } {
  const calls: MountOptions[] = [];
  const view = {
    url: "http://127.0.0.1:1/#token=x",
    closed: Promise.resolve({ reason: "closed" }),
    onDisconnect: () => undefined,
    onReconnect: () => undefined,
    close: async () => undefined,
  } as unknown as View;
  return { mount: async (o) => (calls.push(o), view), calls };
}

test("AC2: openMixer --output narrated mounts the unit's mix document and every mixer call names the output", async () => {
  const { work } = narratedWork();
  const { deps, calls } = fakeMachine(work);
  const fake = fakeMount();
  const overrides = { mount: fake.mount, existsExecutable: () => true, binaryPath: () => undefined, env: { PATH: "/nowhere" } };
  const none = await openMixer({ work, title: "Ice House", episode: 1, output: "narrated", casting: deps }, undefined, overrides);
  expect(none).toMatchObject({ ok: false, code: 2 });
  expect((none as { message: string }).message).toContain("narrated unit 1 has no mix document yet (run pablo mix --output narrated --unit 1)");

  render(work, 1, true);
  const opened = await openMixer({ work, title: "Ice House", episode: 1, output: "narrated", casting: deps }, undefined, overrides);
  expect(opened.ok).toBe(true);
  expect(fake.calls[0]?.data).toEqual({ title: "Ice House", episode: 1, output: "narrated" });
  await fake.calls[0]?.mutations?.["loadMix"]?.({ episode: 1 });
  expect(calls.at(-1)).toMatchObject({ argv: ["mixer", "load", "--episode", "1", "--work", work, "--json"], output: "narrated" });
  // The punch list reads the narrated output's flags.json.
  writeFileSync(join(work, ...NARRATED_CASTING, "flags.json"), JSON.stringify({ flags: [{ id: "f1", episode: 1, line: 0, reason: "flat", by: "matt" }] }));
  const flags = (await fake.calls[0]?.mutations?.["listFlags"]?.({ episode: 1 })) as { flags: unknown[] };
  expect(flags.flags).toHaveLength(1);
});

test("AC2: pablo mixer --output narrated --unit N opens the unit; an output the work lacks or that is not mixed exits 2", async () => {
  const { work } = narratedWork();
  let asked: OpenMixerRequest | undefined;
  const open = (async (request: OpenMixerRequest) => {
    asked = request;
    return { ok: true, view: { url: "http://127.0.0.1:1/#t" }, closed: Promise.resolve() };
  }) as unknown as typeof openMixer;
  expect(await runMixerView(parseCliArgs(["mixer", "--project", "ice-house", "--output", "narrated", "--unit", "1"]), work, work, open)).toBe(0);
  expect([asked?.output, asked?.episode]).toEqual(["narrated", 1]);
  expect(await runMixerView(parseCliArgs(["mixer", "--project", "ice-house", "--output", "novel", "--unit", "1"]), work, work, open)).toBe(2);
  expect(await runMixerView(parseCliArgs(["mixer", "--project", "ice-house", "--output", "narrated"]), work, work, open)).toBe(2);
  const radioOnly = narratedWork({ novel: { dir: "chapters", added: "2026-09-01" } });
  expect(await runMixerView(parseCliArgs(["mixer", "--project", "ice-house", "--output", "narrated", "--unit", "1"]), radioOnly.work, radioOnly.work, open)).toBe(2);
});
