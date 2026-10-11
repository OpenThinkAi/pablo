import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { castingVerbs } from "../src/casting-verbs";
import { venvPython } from "../src/casting";
import type { CastingDeps, CastingLayout } from "../src/casting";
import { parseCliArgs } from "../src/cli";
import { runProgressive } from "../src/progressive";
import type { StepOutcome } from "../src/progressive";
import { publishStream, readLiveStream, streamEpisodeDir, streamRoot } from "../src/radio-stream";
import { createReviewHost } from "../src/review-host";
import { publishOutput, VERBS, verbArgsFromCli } from "../src/verbs";
import type { Verb, VerbContext } from "../src/verbs";
import { scheduleSegment, streamPosition } from "../views/review-logic";
import { SEGMENTS_PER_CALL } from "../views/review-protocol";

/**
 * AGT-1697: the progressive render's TypeScript half. The Python side is a slow fake behind `CastingDeps`
 * (it writes what `perform --stream` writes: a stream index and segments, then the manifest and the episode
 * file, and can be held part way), so nothing here runs uv, Python or a model. Every work is a temp copy of
 * the invented fixture vault, never ~/writing.
 */

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

const pad = (n: number): string => String(n).padStart(2, "0");

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A vault copy whose work has three invented episode scripts. */
function radioVault(episodes = 3): { vault: string; work: string } {
  const vault = join(temp("pablo-progressive-"), "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  const work = join(vault, "novels", "ice-house");
  const dir = join(work, "outputs", "radio", "episodes");
  mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= episodes; n++) writeFileSync(join(dir, `${pad(n)}-night-${n}.md`), `# Night ${n}\n\nCAST: KEEPER=m "fifties, dry"\nKEEPER: The ice holds for one more night.\n`);
  // A work with the radio output (AGT-1686) and its one role bound, so the stage machine lets perform run.
  const marker = JSON.parse(readFileSync(join(work, "pablo.json"), "utf8")) as Record<string, unknown>;
  delete marker["format"];
  marker["outputs"] = { novel: { dir: "chapters", added: "2026-10-11" }, radio: { dir: "outputs/radio", added: "2026-10-11" } };
  writeFileSync(join(work, "pablo.json"), `${JSON.stringify(marker, null, 2)}\n`);
  const casting = join(work, "outputs", "radio", "casting");
  mkdirSync(casting, { recursive: true });
  writeFileSync(join(casting, "cast.json"), JSON.stringify({ version: 1, roles: { KEEPER: { slug: "keeper", card_hash: "h", by: "manual", at: "2026-10-11T00:00:00Z" } } }));
  return { vault, work };
}

/** What `pablo_casting perform --stream` leaves while it is part way: a playable stream with two segments. */
function writeLive(work: string, episode: number, state: "streaming" | "finished" | "mixed" | "failed" = "streaming", segments = 2, playable = true): void {
  const dir = streamEpisodeDir(work, episode);
  mkdirSync(join(dir, "segments"), { recursive: true });
  const rows = Array.from({ length: segments }, (_, n) => ({ n, file: `segments/seg-${String(n).padStart(5, "0")}.wav`, start: n * 6, seconds: 6 }));
  for (const row of rows) writeFileSync(join(dir, row.file), `RIFF-fake-segment-${episode}-${row.n}`);
  const lines = [{ i: 0, speaker: "KEEPER", text: "The ice holds for one more night.", start: 0.4, end: 2.9, status: "pass", gates: { sim_card: 0.8 }, failing: [] }];
  const body = { episode, state, playable, seconds: segments * 6, lines_done: 1, lines_total: 3, segments: rows, lines, ttfa: { first_audio: 4.2, playable: 21.5, chapter: null, started: "2026-10-11T10:00:00.000Z" } };
  writeFileSync(join(dir, "stream.json"), JSON.stringify(body));
}

/** What it leaves once the episode is mixed: `v1.json` with audio and its time to first audio. */
function writeMixed(work: string, episode: number, version = 1): void {
  const dir = join(work, "outputs", "radio", "casting", "renders", `ep${pad(episode)}`);
  mkdirSync(dir, { recursive: true });
  const audio = `ep${pad(episode)}.v${version}.m4a`;
  writeFileSync(join(dir, audio), `fake-m4a-${episode}-v${version}`);
  const manifest = {
    episode,
    version,
    parent: version > 1 ? version - 1 : null,
    changed_lines: version === 1 ? [0] : [],
    flags_applied: [],
    audio,
    duration: 12,
    ttfa: { first_audio: 4.2, playable: 21.5, chapter: null, started: "2026-10-11T10:00:00.000Z" },
    lines: [{ i: 0, speaker: "KEEPER", text: "The ice holds for one more night.", take: "a".repeat(64), start: 0.4, end: 2.9, gates: {}, failing: [] }],
  };
  writeFileSync(join(dir, `v${version}.json`), JSON.stringify(manifest));
}

/**
 * A provisioned fake casting side whose `perform --stream` writes a live stream, waits on `hold[episode]` if
 * one is set, then writes the mixed version, emitting the events the real one does.
 */
function slowMachine(hold: Record<number, Deferred> = {}, started: Record<number, Deferred> = {}): { deps: CastingDeps; order: string[] } {
  const root = temp("pablo-progressive-machine-");
  const source = join(root, "casting");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "pyproject.toml"), '[project]\nname = "pablo-casting"\n', "utf8");
  writeFileSync(join(source, "uv.lock"), "version = 1\n", "utf8");
  const layout: CastingLayout = { source, venv: join(source, ".venv"), install: "checkout" };
  const order: string[] = [];
  const deps: CastingDeps = {
    layout,
    which: () => "/fake/bin/uv",
    run: (argv) => {
      if (argv[1] === "sync") {
        mkdirSync(join(layout.venv, "bin"), { recursive: true });
        writeFileSync(venvPython(layout), "", "utf8");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv[3] === "pull") return { code: 0, stdout: JSON.stringify({ ok: true, weights: [] }), stderr: "" };
      return { code: 1, stdout: JSON.stringify({ ok: false, code: 1, message: "the slow machine only streams" }), stderr: "" };
    },
    stream: async (argv, _options, onLine) => {
      const episode = Number(argv.find((a) => a.startsWith("--episode="))?.slice("--episode=".length));
      const work = argv[argv.indexOf("--work") + 1] as string;
      expect(argv).toContain("--stream");
      order.push(`start ${episode}`);
      onLine(JSON.stringify({ event: "start", episode, stream: true }));
      writeLive(work, episode);
      onLine(JSON.stringify({ event: "segment", episode, n: 0 }));
      onLine(JSON.stringify({ event: "playable", episode }));
      started[episode]?.resolve();
      await hold[episode]?.promise;
      writeMixed(work, episode);
      writeLive(work, episode, "mixed", 3);
      order.push(`end ${episode}`);
      const body = { ok: true, episode, version: 1, ttfa: { first_audio: 4.2, playable: 21.5, chapter: 30.1 } };
      onLine(JSON.stringify({ event: "chapter", episode, version: 1 }));
      onLine(JSON.stringify(body));
      return { code: 0, stdout: JSON.stringify(body), stderr: "" };
    },
    now: () => new Date("2026-10-11T12:00:00Z"),
  };
  return { deps, order };
}

function perform(deps: CastingDeps): Verb {
  return castingVerbs(() => deps).find((v) => v.name === "perform") as Verb;
}

function ctxIn(cwd: string, stdout?: string[]): VerbContext {
  return {
    cwd,
    env: { PATH: "/nowhere", XDG_STATE_HOME: join(cwd, "state") },
    stderr: { write: () => undefined },
    ...(stdout === undefined ? {} : { stdout: { write: (text: string) => void stdout.push(text) } }),
  };
}

// ---------------------------------------------------------------------------
// AC1: episode 1 is listed and playable while episode 2 still renders
// ---------------------------------------------------------------------------

describe("perform --stream --all publishes each episode as it finishes (AC1)", () => {
  test("episode 1 is listed and playable in the view while episode 2 is still rendering", async () => {
    const { vault, work } = radioVault(3);
    const hold = { 2: deferred() };
    const started = { 2: deferred() };
    const { deps, order } = slowMachine(hold, started);
    const lines: string[] = [];
    const running = perform(deps).run({ project: "ice-house", all: true, stream: true, "json-lines": true }, ctxIn(vault, lines));
    await started[2].promise;

    // Episode 2 is with the slow engine; episode 1 is mixed, published and playable.
    expect(order).toEqual(["start 1", "end 1", "start 2"]);
    const host = createReviewHost({ work, title: "The Ice House" });
    const rows = host.listChapters();
    expect(rows.map((r) => [r.episode, r.latest])).toEqual([
      [1, 1],
      [2, null],
    ]);
    const track = host.loadTrack({ episode: 1 });
    expect(Buffer.from(track.b64, "base64").toString()).toBe("fake-m4a-1-v1");
    const index = JSON.parse(readFileSync(join(streamRoot(work), "index.json"), "utf8")) as { chapters: { episode: number; audio: string }[] };
    expect(index.chapters.map((c) => c.episode)).toEqual([1]);
    expect(readFileSync(join(streamRoot(work), index.chapters[0]?.audio as string), "utf8")).toBe("fake-m4a-1-v1");
    // ... and episode 2 can already be started from its segments.
    expect(rows[1]?.stream).toMatchObject({ state: "streaming", segments: 2 });
    const live = host.loadSegments({ episode: 2 });
    expect(live.segments.map((s) => s.n)).toEqual([0, 1]);
    expect(live.complete).toBe(false);
    expect(lines.some((l) => JSON.parse(l).event === "published" && JSON.parse(l).episode === 1)).toBe(true);

    hold[2].resolve();
    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
    const body = result.body as { episodes: { episode: number; published: { chapter: { ttfa: unknown } } }[] };
    expect(body.episodes.map((e) => e.episode)).toEqual([1, 2, 3]);
    expect(body.episodes[0]?.published.chapter.ttfa).toMatchObject({ first_audio: 4.2 });
    expect(host.listChapters().map((r) => r.latest)).toEqual([1, 1, 1]);
  });

  test("--all skips performed episodes and refuses when nothing is left; --stream provisions the mix extra", async () => {
    const { vault, work } = radioVault(2);
    writeMixed(work, 1);
    const { deps, order } = slowMachine();
    const synced: string[][] = [];
    const recording: CastingDeps = { ...deps, run: (argv, options) => (synced.push([...argv]), deps.run(argv, options)) };
    const result = await perform(recording).run({ project: "ice-house", all: true, stream: true, "json-lines": false }, ctxIn(vault));
    expect(result.exitCode).toBe(0);
    expect(order).toEqual(["start 2", "end 2"]);
    expect(synced[0]).toEqual(["/fake/bin/uv", "sync", "--frozen", "--extra", "mix", "--extra", "scorers"]);
    const again = await perform(recording).run({ project: "ice-house", all: true, stream: true, "json-lines": false }, ctxIn(vault));
    expect(again.exitCode).toBe(2);
  });

  test("the CLI parses --stream and --all for perform", () => {
    const parsed = parseCliArgs(["perform", "--project", "ice-house", "--all", "--stream"]);
    const built = verbArgsFromCli(VERBS.find((v) => v.name === "perform")!, parsed.values, parsed.rest);
    expect(built).toEqual({ ok: true, args: { project: "ice-house", all: true, stream: true, "json-lines": false } });
  });
});

// ---------------------------------------------------------------------------
// The writer and the engine are separate queues
// ---------------------------------------------------------------------------

describe("runProgressive: the writer and the engine are separate queues", () => {
  const ok: StepOutcome = { ok: true, exitCode: 0, body: { ok: true } };

  test("unit N+1 is written while unit N performs; each queue runs one step at a time; the engine waits for its script", async () => {
    const log: string[] = [];
    let writing = 0;
    let performing = 0;
    const performGate: Record<number, Deferred> = { 1: deferred(), 2: deferred(), 3: deferred() };
    const written: Record<number, Deferred> = { 1: deferred(), 2: deferred(), 3: deferred() };
    const running = runProgressive({
      units: [1, 2, 3],
      write: async (unit) => {
        writing += 1;
        expect(writing).toBe(1);
        log.push(`write ${unit}`);
        await Promise.resolve();
        writing -= 1;
        written[unit]?.resolve();
        return ok;
      },
      perform: async (unit) => {
        performing += 1;
        expect(performing).toBe(1);
        log.push(`perform ${unit}`);
        await performGate[unit]?.promise;
        performing -= 1;
        return ok;
      },
    });
    // While unit 1 performs (held), the writer has gone on and written 2 and 3.
    await written[3]?.promise;
    expect([...log].sort()).toEqual(["perform 1", "write 1", "write 2", "write 3"]);
    performGate[1]?.resolve();
    performGate[2]?.resolve();
    performGate[3]?.resolve();
    const report = await running;
    expect(report.ok).toBe(true);
    expect(log.filter((e) => e.startsWith("perform"))).toEqual(["perform 1", "perform 2", "perform 3"]);
    expect(log.indexOf("write 1")).toBeLessThan(log.indexOf("perform 1"));
    // Unit 2's script was written before unit 1 finished performing: the overlap the design asks for.
    const u1 = report.units[0];
    const u2 = report.units[1];
    expect(u2?.written?.end).toBeLessThanOrEqual(u1?.performed?.end as number);
  });

  test("a failed performance stops both queues and says where", async () => {
    const writes: number[] = [];
    const performs: number[] = [];
    const report = await runProgressive({
      units: [1, 2, 3, 4],
      write: async (unit) => {
        writes.push(unit);
        await new Promise((r) => setTimeout(r, unit === 1 ? 0 : 20));
        return ok;
      },
      perform: async (unit) => {
        performs.push(unit);
        return unit === 2 ? { ok: false, exitCode: 2, body: { message: "role NED is not cast" } } : ok;
      },
    });
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(2);
    expect(report.stopped).toMatchObject({ unit: 2, queue: "engine" });
    expect(performs).toEqual([1, 2]);
    expect(writes.length).toBeLessThan(4);
  });

  test("a failed write stops the engine before that unit", async () => {
    const performs: number[] = [];
    const report = await runProgressive({
      units: [1, 2, 3],
      write: async (unit) => (unit === 2 ? { ok: false, exitCode: 1, body: { message: "the writer is down" } } : ok),
      perform: async (unit) => (performs.push(unit), ok),
    });
    expect(report.stopped).toMatchObject({ unit: 2, queue: "writer" });
    expect(performs).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// publish --target stream, and the host's live chapters
// ---------------------------------------------------------------------------

describe("publish --target stream", () => {
  test("copies each episode's newest mixed version and its ttfa into the listening directory; current ones are left alone", () => {
    const { work } = radioVault(2);
    writeMixed(work, 1);
    writeMixed(work, 1, 2);
    writeMixed(work, 2);
    const first = publishStream(work, { now: () => new Date("2026-10-11T12:00:00Z") });
    if (!first.ok) throw new Error(first.message);
    expect(first.published.map((c) => [c.episode, c.version])).toEqual([
      [1, 2],
      [2, 1],
    ]);
    expect(readFileSync(join(streamEpisodeDir(work, 1), "ep01.m4a"), "utf8")).toBe("fake-m4a-1-v2");
    expect(JSON.parse(readFileSync(join(streamEpisodeDir(work, 1), "manifest.json"), "utf8")).version).toBe(2);
    expect(first.chapters[0]?.ttfa).toMatchObject({ first_audio: 4.2, playable: 21.5 });
    const second = publishStream(work);
    if (!second.ok) throw new Error(second.message);
    expect(second.published).toEqual([]);
    expect(second.unchanged).toEqual([1, 2]);
  });

  test("nothing mixed is a refusal that writes nothing", () => {
    const { work } = radioVault(1);
    const outcome = publishStream(work);
    expect(outcome.ok).toBe(false);
    expect(existsSync(streamRoot(work))).toBe(false);
  });

  test("pablo publish --output radio --target stream reaches it; the novel's targets are untouched", () => {
    const { work } = radioVault(1);
    writeMixed(work, 1);
    const result = publishOutput(work, "stream", "radio");
    expect(result.exitCode).toBe(0);
    expect(result.body).toMatchObject({ ok: true, output: "radio", target: "stream", chapters: 1 });
    expect(result.body).toMatchObject({ files: ["ep01/ep01.m4a", "ep01/manifest.json"] });
    expect(publishOutput(work, "stream", "radio").body).toMatchObject({ ok: true, files: [], notes: ["episode 1: its newest mixed version is already published"] });
    expect(publishOutput(work, "stream", "novel").exitCode).toBe(2);
  });
});

describe("the review host's live chapters", () => {
  test("a stream is listed only once playable, never when failed, and gives way to the mixed version", () => {
    const { work } = radioVault(3);
    writeLive(work, 1, "streaming", 1, false);
    writeLive(work, 2, "failed", 2);
    writeLive(work, 3, "finished", 3);
    const host = createReviewHost({ work, title: "The Ice House" });
    expect(host.listChapters().map((r) => [r.episode, r.latest, r.stream?.state])).toEqual([[3, null, "finished"]]);
    writeMixed(work, 3);
    writeLive(work, 3, "mixed", 3);
    expect(host.listChapters().map((r) => [r.episode, r.latest, r.stream])).toEqual([[3, 1, undefined]]);
    // A listener who started it live plays on to its end.
    expect(host.loadSegments({ episode: 3, from: 2 }).segments.map((s) => s.n)).toEqual([2]);
    expect(() => host.loadSegments({ episode: 2 })).toThrow("not streaming");
  });

  test("loadSegments pages a few segments at a time and says how many exist", () => {
    const { work } = radioVault(1);
    writeLive(work, 1, "streaming", SEGMENTS_PER_CALL + 2);
    const host = createReviewHost({ work, title: "The Ice House" });
    const first = host.loadSegments({ episode: 1 });
    expect(first.segments.map((s) => s.n)).toEqual([0, 1, 2, 3].slice(0, SEGMENTS_PER_CALL));
    expect(first.available).toBe(SEGMENTS_PER_CALL + 2);
    expect(first.segments[0]?.mime).toBe("audio/wav");
    expect(Buffer.from(first.segments[0]?.b64 as string, "base64").toString()).toBe("RIFF-fake-segment-1-0");
    expect(first.lines.map((l) => l.text)).toEqual(["The ice holds for one more night."]);
    const rest = host.loadSegments({ episode: 1, from: SEGMENTS_PER_CALL });
    expect(rest.segments.map((s) => s.n)).toEqual([SEGMENTS_PER_CALL, SEGMENTS_PER_CALL + 1]);
    expect(() => host.loadSegments({ episode: 1, from: -1 })).toThrow("from must be");
  });

  test("a stream index that names a file outside segments/ is never read", () => {
    const { work } = radioVault(1);
    writeLive(work, 1);
    const path = join(streamEpisodeDir(work, 1), "stream.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.segments[0].file = "../../../../pablo.json";
    writeFileSync(path, JSON.stringify(raw));
    expect(readLiveStream(work, 1)?.segments.map((s) => s.n)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// The player's scheduling arithmetic
// ---------------------------------------------------------------------------

describe("laying segments on the audio clock", () => {
  test("segments in time are laid back to back from the origin", () => {
    expect(scheduleSegment(10, 0, 9)).toEqual({ at: 10, origin: 10 });
    expect(scheduleSegment(10, 6, 12)).toEqual({ at: 16, origin: 10 });
  });

  test("a late segment starts just ahead of now and moves the origin: a pause, never an overlap", () => {
    const late = scheduleSegment(10, 6, 17);
    expect(late.at).toBeCloseTo(17.05, 6);
    expect(late.origin).toBeCloseTo(11.05, 6);
  });

  test("the position never runs past what has been laid", () => {
    expect(streamPosition(null, 50, 12)).toBe(0);
    expect(streamPosition(10, 15, 12)).toBe(5);
    expect(streamPosition(10, 40, 12)).toBe(12);
  });
});
