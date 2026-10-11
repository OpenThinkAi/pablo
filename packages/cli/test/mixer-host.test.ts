import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CastingDeps, CastingLayout } from "../src/casting";
import { venvPython } from "../src/casting";
import { createMixerHost, mixerMutations } from "../src/mixer-host";
import { MUTATIONS } from "../views/mixer-protocol";
import type { ClipAudioPayload, MixPayload, PeaksPayload, SavedMixPayload } from "../views/mixer-protocol";

/**
 * AGT-1766: the mixer's host side over a fake casting machine. The Python side (`mixer.py`, tested in
 * `packages/casting/tests/test_mixer.py`) is replaced by canned bodies that record the argv they were asked;
 * what is under test here is the call shape, the argument checks, the memoised peaks and the wire payloads.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pablo-mixer-host-test-"));
  dirs.push(dir);
  return dir;
};

const KEY = (n: number): string => n.toString(16).padStart(64, "0");

const DOC = { schema: 1, episode: 1, version: 1, manifest_version: 1, parent: null, by: "auto", created: "2026-10-11T00:00:00Z", tracks: {}, master: { gain: 0, peak_db: -1, target_lufs: null } };

interface Machine {
  readonly deps: CastingDeps;
  /** The `mixer ...` argv of each call, without the interpreter. */
  readonly calls: string[][];
  /** The document file the last `save` was handed (read while it existed). */
  saved: unknown;
  respond: (op: string, argv: readonly string[]) => { code: number; body: unknown };
}

function machine(): { m: Machine; work: string } {
  const root = temp();
  const source = join(root, "casting");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "pyproject.toml"), '[project]\nname = "pablo-casting"\n', "utf8");
  writeFileSync(join(source, "uv.lock"), "version = 1\n", "utf8");
  const layout: CastingLayout = { source, venv: join(source, ".venv"), install: "checkout" };
  const work = join(root, "novels", "lamp-room");
  mkdirSync(join(work, "outputs", "radio", "episodes"), { recursive: true });
  writeFileSync(join(work, "outputs", "radio", "episodes", "01-the-first-night.md"), "---\ntitle: The First Night\n---\n\nCAST: HOST\n");
  const m: Machine = {
    calls: [],
    saved: undefined,
    respond: () => ({ code: 0, body: { ok: true } }),
    deps: {
      layout,
      which: () => "/fake/bin/uv",
      run: (argv) => {
        if (argv[1] === "sync") {
          mkdirSync(join(layout.venv, "bin"), { recursive: true });
          writeFileSync(venvPython(layout), "", "utf8");
          return { code: 0, stdout: "", stderr: "" };
        }
        if (argv[3] === "pull") return { code: 0, stdout: JSON.stringify({ ok: true, weights: [] }), stderr: "" };
        m.calls.push(argv.slice(3));
        const from = argv.indexOf("--from");
        if (from >= 0) m.saved = JSON.parse(readFileSync(argv[from + 1] as string, "utf8"));
        const answer = m.respond(argv[4] as string, argv);
        return { code: answer.code, stdout: JSON.stringify(answer.body), stderr: "" };
      },
      now: () => new Date("2026-10-11T12:00:00Z"),
    },
  };
  return { m, work };
}

const host = (m: Machine, work: string, vault?: string) => createMixerHost({ work, env: { PATH: "/nowhere" }, casting: m.deps, ...(vault === undefined ? {} : { vault }) });

test("loadMix asks the Python side for the newest mix and returns the document, versions, manifest and layout", () => {
  const { m, work } = machine();
  m.respond = () => ({
    code: 0,
    body: {
      ok: true,
      episode: 1,
      version: 2,
      newest: 2,
      versions: [
        { version: 1, by: "auto", created: "t1", parent: null, manifest_version: 1 },
        { version: 2, by: "human", created: "t2", parent: 1, manifest_version: 1, summary: "1 changed" },
      ],
      document: { ...DOC, version: 2, by: "human" },
      manifest: { version: 1, duration: 9, lines: [{ i: 0, speaker: "HOST", text: "Hello.", take: KEY(1), stretch: 1, start: 0.5, end: 1.5 }], cues: [] },
      latest_manifest: 3,
      layout: [{ track: "dialogue", lanes: [{ name: "HOST", clips: 1 }], volume: 0, mute: false, solo: false, automation: 0 }],
    },
  });
  const mix: MixPayload = host(m, work, "/vault").loadMix({ episode: 1 });
  expect(m.calls[0]).toEqual(["mixer", "load", "--episode", "1", "--vault", "/vault", "--work", work, "--json"]);
  expect([mix.episode, mix.title, mix.version, mix.newest, mix.latestManifest]).toEqual([1, "The First Night", 2, 2, 3]);
  expect(mix.versions.map((v) => v.by)).toEqual(["auto", "human"]);
  expect(mix.manifest.lines[0]?.speaker).toBe("HOST");
  expect(mix.layout[0]?.track).toBe("dialogue");

  host(m, work).loadMix({ episode: 1, version: 1 });
  expect(m.calls[1]).toContain("--version");
});

test("a refusal from the Python side is thrown in its own words, and bad arguments never reach it", () => {
  const { m, work } = machine();
  const h = host(m, work);
  m.respond = () => ({ code: 2, body: { ok: false, code: 2, message: "episode 4 has no mix document yet (run pablo mix)" } });
  expect(() => h.loadMix({ episode: 4 })).toThrow("no mix document yet");
  const before = m.calls.length;
  expect(() => h.loadMix({ episode: 0 })).toThrow("episode must be");
  expect(() => h.loadMix({})).toThrow("episode must be");
  expect(() => h.loadMix({ episode: 1, version: 1.5 })).toThrow("version must be");
  expect(() => h.peaks({ source: { kind: "tape", key: KEY(1) } })).toThrow("take or cue");
  expect(() => h.peaks({ source: { kind: "take", key: "abc" } })).toThrow("64-character");
  expect(() => h.peaks({ source: { kind: "take", key: KEY(1), stretch: 0 } })).toThrow("positive");
  expect(() => h.clipAudio({ source: { kind: "cue", key: KEY(1), stretch: 0.9 } })).toThrow("only a take is paced");
  expect(() => h.clipAudio({})).toThrow("source must be");
  expect(() => h.saveMix({ episode: 1, base: 1 })).toThrow("document must be");
  expect(() => h.saveMix({ episode: 1, document: {} })).toThrow("base must be");
  expect(m.calls.length).toBe(before);
});

test("peaks are computed once and reused: a second ask for the same source spawns nothing", () => {
  const { m, work } = machine();
  m.respond = () => ({ code: 0, body: { ok: true, seconds: 0.03, per_second: 100, peaks: [0.1, 0.4, 0.2], cached: false } });
  const h = host(m, work);
  const take = { kind: "take", key: KEY(7), stretch: 0.9 };
  const first: PeaksPayload = h.peaks({ source: take });
  expect(m.calls).toHaveLength(1);
  expect(m.calls[0]).toEqual(["mixer", "peaks", "--source", `take:${KEY(7)}`, "--stretch", "0.9", "--work", work, "--json"]);
  expect([first.cached, first.perSecond, first.peaks]).toEqual([false, 100, [0.1, 0.4, 0.2]]);

  const second = h.peaks({ source: take });
  expect(m.calls).toHaveLength(1); // served from memory
  expect([second.cached, second.peaks]).toEqual([true, first.peaks]);

  h.peaks({ source: { ...take, stretch: 1.1 } }); // another pace is another waveform
  h.peaks({ source: { kind: "cue", key: KEY(7) } }); // and another source
  expect(m.calls).toHaveLength(3);
  expect(m.calls[2]).toEqual(["mixer", "peaks", "--source", `cue:${KEY(7)}`, "--work", work, "--json"]);
  // a fresh host (a reopened window) asks again, and the Python side answers from its own disk cache
  m.respond = () => ({ code: 0, body: { ok: true, seconds: 0.03, per_second: 100, peaks: [0.1, 0.4, 0.2], cached: true } });
  expect(host(m, work).peaks({ source: take }).cached).toBe(true);
});

test("clipAudio asks for the take's pace and hands back the base64 WAV the Python side paced", () => {
  const { m, work } = machine();
  m.respond = () => ({ code: 0, body: { ok: true, mime: "audio/wav", sample_rate: 44100, seconds: 1.6, b64: "UklGRg==" } });
  const audio: ClipAudioPayload = host(m, work).clipAudio({ source: { kind: "take", key: KEY(3), stretch: 1.25 } });
  expect(m.calls[0]).toEqual(["mixer", "audio", "--source", `take:${KEY(3)}`, "--stretch", "1.25", "--work", work, "--json"]);
  expect(audio).toEqual({ source: { kind: "take", key: KEY(3), stretch: 1.25 }, mime: "audio/wav", b64: "UklGRg==", sampleRate: 44100, seconds: 1.6 });
  expect(host(m, work).clipAudio({ source: { kind: "take", key: KEY(3) } }).source.stretch).toBe(1);
  expect(m.calls[1]).toContain("1");
  host(m, work).clipAudio({ source: { kind: "cue", key: KEY(4) } });
  expect(m.calls[2]).toEqual(["mixer", "audio", "--source", `cue:${KEY(4)}`, "--work", work, "--json"]);
});

test("saveMix hands the document to the Python side with its base, returns the version written, and removes the temp file", () => {
  const { m, work } = machine();
  let file = "";
  m.respond = (_op, argv) => {
    file = argv[argv.indexOf("--from") + 1] as string;
    return {
      code: 0,
      body: {
        ok: true,
        episode: 1,
        version: 2,
        parent: 1,
        by: "human",
        summary: { added: [], removed: [], changed: ["line-0"], tracks: [], master: false, text: "1 changed" },
        document: { ...DOC, version: 2, by: "human" },
        versions: [{ version: 1, by: "auto" }, { version: 2, by: "human" }],
      },
    };
  };
  const edit = { manifest_version: 1, tracks: { dialogue: { lanes: {} } }, master: DOC.master };
  const saved: SavedMixPayload = host(m, work).saveMix({ episode: 1, base: 1, document: edit });
  expect(m.calls[0]?.slice(0, 7)).toEqual(["mixer", "save", "--episode", "1", "--base", "1", "--from"]);
  expect(m.saved).toEqual(edit);
  expect([saved.version, saved.parent, saved.by, saved.summary.changed]).toEqual([2, 1, "human", ["line-0"]]);
  expect(existsSync(file)).toBe(false);
});

test("a save against a base that is no longer the newest is refused and says so", () => {
  const { m, work } = machine();
  m.respond = () => ({ code: 2, body: { ok: false, code: 2, stale: true, newest: 3, message: "mix v1 is not the newest (v3); reload v3 and apply your edits to it. Nothing was written" } });
  expect(() => host(m, work).saveMix({ episode: 1, base: 1, document: { manifest_version: 1 } })).toThrow("not the newest");
});

test("the window may call the four mixer mutations and nothing else", async () => {
  const { m, work } = machine();
  const handlers = mixerMutations(host(m, work));
  expect(Object.keys(handlers).sort()).toEqual([...MUTATIONS].sort());
  expect([...MUTATIONS]).toEqual(["loadMix", "peaks", "clipAudio", "saveMix"]);
  m.respond = () => ({ code: 2, body: { ok: false, code: 2, message: "nope" } });
  await expect((handlers["loadMix"] as (a: unknown) => Promise<unknown>)({ episode: 1 })).rejects.toThrow("nope");
});
