import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MountOptions, View } from "@openthink/ui-leaf";
import { parseCliArgs, runReviewView } from "../src/cli";
import { NO_CHROME_MESSAGE, createReviewHost, failingFromReason, flagsFile, openReview, reviewMutations } from "../src/review-host";
import { MUTATIONS } from "../views/review-protocol";
import type { ReviewData, ReviewFlag, TrackPayload } from "../views/review-protocol";

/**
 * AGT-1693: the review player's host side. The window is a fake `mount` (nothing opens, no Chrome, no ui-leaf
 * binary); the work is a temp directory holding invented manifests and tiny stand-in audio. The view's calls
 * are made straight at the mutation handlers the host registers, which is the whole wire protocol.
 */
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pablo-review-host-test-"));
  dirs.push(dir);
  return dir;
};

const TAKE = (n: number): string => n.toString(16).padStart(64, "0");

interface LineSpec {
  readonly i: number;
  readonly take: number;
  readonly start: number;
  readonly end: number;
  readonly failing?: readonly string[];
}

/** A work with the casting layout; nothing in it is a real story or voice. */
function work(): string {
  const dir = join(temp(), "novels", "lamp-room");
  mkdirSync(join(dir, "outputs", "radio", "casting", "renders"), { recursive: true });
  mkdirSync(join(dir, "outputs", "radio", "episodes"), { recursive: true });
  writeFileSync(join(dir, "pablo.json"), JSON.stringify({ title: "The Lamp Room", slug: "lamp-room", format: "novel" }));
  writeFileSync(join(dir, "outputs", "radio", "episodes", "01-the-first-night.md"), "---\ntitle: \"The First Night\"\n---\n\nCAST: HOST, GUEST\n");
  writeFileSync(join(dir, "outputs", "radio", "episodes", "02-the-second-night.md"), "# The Second Night\n\nCAST: HOST, GUEST\n");
  return dir;
}

const TEXTS = ["Good evening, listeners.", "The lamp room is open.", "Please mind the stairs."];

/** Writes `renders/epNN/v<k>.json` (+ its audio file with `audioBytes`, unless null) the way mix leaves them. */
function version(w: string, episode: number, k: number, specs: readonly LineSpec[], audioBytes: string | null = `audio-v${k}`, parent: number | null = k > 1 ? k - 1 : null): void {
  const dir = join(w, "outputs", "radio", "casting", "renders", `ep${String(episode).padStart(2, "0")}`);
  mkdirSync(dir, { recursive: true });
  const audio = audioBytes === null ? null : `ep${String(episode).padStart(2, "0")}.v${k}.m4a`;
  const manifest = {
    episode,
    version: k,
    parent,
    changed_lines: k === 1 ? specs.map((s) => s.i) : specs.filter((s) => s.take > 100).map((s) => s.i),
    flags_applied: [],
    duration: Math.max(...specs.map((s) => s.end)) + 1,
    audio,
    created: `2026-10-1${k}T10:00:00Z`,
    lines: specs.map((s) => ({
      i: s.i,
      speaker: s.i % 2 === 0 ? "HOST" : "GUEST",
      text: TEXTS[s.i] ?? `Line ${s.i}`,
      take: TAKE(s.take),
      start: s.start,
      end: s.end,
      gates: { sim_card: 0.81, wps: 2.7, tail_ok: true, label: "ignored" },
      ...(s.failing === undefined ? {} : { failing: s.failing }),
    })),
  };
  writeFileSync(join(dir, `v${k}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  if (audioBytes !== null) writeFileSync(join(dir, audio as string), audioBytes);
}

const V1: LineSpec[] = [
  { i: 0, take: 1, start: 0.5, end: 3 },
  { i: 1, take: 2, start: 3.4, end: 7, failing: ["pace", "artefacts"] },
  { i: 2, take: 3, start: 7.5, end: 11 },
];
// v2 re-recorded line 1 only: a longer take, so every later line moves
const V2: LineSpec[] = [
  { i: 0, take: 1, start: 0.5, end: 3 },
  { i: 1, take: 102, start: 3.4, end: 9 },
  { i: 2, take: 3, start: 9.5, end: 13 },
];

function autoFlag(episode: number, line: number, reason: string): Record<string, unknown> {
  return { id: `f-auto-20261011-000000-ep0${episode}-${line}`, episode, line, reason, by: "auto", take: TAKE(2), at: "2026-10-11T00:00:00.000Z" };
}

function writeFlags(w: string, flags: unknown[], extra: Record<string, unknown> = {}): void {
  writeFileSync(flagsFile(w), `${JSON.stringify({ ...extra, flags }, null, 2)}\n`);
}

const readFlags = (w: string): { flags: Record<string, unknown>[] } => JSON.parse(readFileSync(flagsFile(w), "utf8"));
const fixedNow = (iso = "2026-10-12T09:30:15.250Z") => () => new Date(iso);

// --- AC1: flagging writes flags.json with line, reason, time and source; unflag removes it ---------------

test("AC1: flag writes flags.json with the line, reason, time and source; unflag removes it", () => {
  const w = work();
  version(w, 1, 1, V1);
  const host = createReviewHost({ work: w, title: "The Lamp Room", now: fixedNow() });

  const rows = host.flag({ episode: 1, line: 2, reason: "wrong voice", time: 7.5 });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ episode: 1, line: 2, reason: "wrong voice", time: 7.5, source: "human", failing: [] });

  const written = readFlags(w).flags;
  expect(written).toHaveLength(1);
  expect(written[0]).toEqual({
    id: "f-20261012-093015-ep01-2",
    episode: 1,
    line: 2,
    reason: "wrong voice",
    time: 7.5,
    source: "human",
    by: "human",
    at: "2026-10-12T09:30:15.250Z",
  });

  expect(host.unflag({ episode: 1, line: 2 })).toEqual([]);
  expect(readFlags(w).flags).toEqual([]);
});

test("a reason defaults to clipped, the time to the line's start, and a bad reason or line is refused naming it", () => {
  const w = work();
  version(w, 1, 1, V1);
  const host = createReviewHost({ work: w, title: "t", now: fixedNow() });
  host.flag({ episode: 1, line: 1 });
  expect(readFlags(w).flags[0]).toMatchObject({ reason: "clipped", time: 3.4 });
  expect(() => host.flag({ episode: 1, line: 1, reason: "boring" })).toThrow("reason must be one of: clipped, wrong voice, flat, rushed, other");
  expect(() => host.flag({ episode: 1, line: 9 })).toThrow("episode 1 has no line 9");
  expect(() => host.flag({ episode: 4, line: 0 })).toThrow("episode 4 has no mixed audio yet");
  expect(() => host.flag({ episode: 1, line: 0, time: -2 })).toThrow("time must be");
  expect(readFlags(w).flags).toHaveLength(1); // the refusals wrote nothing
});

test("flagging a line again updates its reason and time (one listener flag per line); other fields and flags survive", () => {
  const w = work();
  version(w, 1, 1, V1);
  writeFlags(w, [autoFlag(1, 1, "best of 4 failed: pace"), { id: "f-other", episode: 2, line: 0, reason: "flat", time: 1, source: "human", custom: "kept" }], { note: "kept too" });
  const host = createReviewHost({ work: w, title: "t", now: fixedNow() });
  host.flag({ episode: 1, line: 0, reason: "flat" });
  host.flag({ episode: 1, line: 0, reason: "rushed" });
  const file = readFlags(w) as { flags: Record<string, unknown>[]; note?: string };
  expect(file.note).toBe("kept too");
  expect(file.flags.filter((f) => f["episode"] === 1 && f["line"] === 0)).toHaveLength(1);
  expect(file.flags.find((f) => f["line"] === 0 && f["episode"] === 1)).toMatchObject({ reason: "rushed" });
  expect(file.flags.find((f) => f["id"] === "f-other")).toMatchObject({ custom: "kept" });
  expect(file.flags.some((f) => f["by"] === "auto")).toBe(true);
});

test("unflag by id removes only that flag; by line removes every flag on the line, auto included", () => {
  const w = work();
  version(w, 1, 1, V1);
  const host = createReviewHost({ work: w, title: "t", now: fixedNow() });
  writeFlags(w, [autoFlag(1, 1, "best of 4 failed: pace")]);
  const afterFlag = host.flag({ episode: 1, line: 1, reason: "flat" });
  expect(afterFlag.map((f) => f.source).sort()).toEqual(["auto", "human"]);
  const human = afterFlag.find((f) => f.source === "human") as ReviewFlag;
  expect(host.unflag({ episode: 1, line: 1, id: human.id }).map((f) => f.source)).toEqual(["auto"]);
  host.flag({ episode: 1, line: 1, reason: "flat" });
  expect(host.unflag({ episode: 1, line: 1 })).toEqual([]);
  expect(readFlags(w).flags).toEqual([]);
});

test("a flags.json that is not JSON is never overwritten: flag and unflag refuse, the chapter list still shows", () => {
  const w = work();
  version(w, 1, 1, V1);
  writeFileSync(flagsFile(w), "{ not json");
  const host = createReviewHost({ work: w, title: "t" });
  expect(() => host.flag({ episode: 1, line: 0 })).toThrow("flags.json is not valid JSON");
  expect(() => host.unflag({ episode: 1, line: 0 })).toThrow("flags.json is not valid JSON");
  expect(readFileSync(flagsFile(w), "utf8")).toBe("{ not json");
  expect(host.listChapters().map((c) => c.episode)).toEqual([1]);
});

// --- AC2: switching versions plays the chosen epNN.v<k>.m4a with its own timings -------------------------

test("AC2: setVersion returns the chosen version's own audio and its own line timings", () => {
  const w = work();
  version(w, 1, 1, V1);
  version(w, 1, 2, V2);
  const host = createReviewHost({ work: w, title: "t" });

  const newest = host.loadTrack({ episode: 1 });
  expect(newest.version).toBe(2);
  expect(Buffer.from(newest.b64, "base64").toString()).toBe("audio-v2");
  expect(newest.mime).toBe("audio/mp4");
  expect(newest.versions.map((v) => v.version)).toEqual([1, 2]);
  expect(newest.versions.map((v) => v.changedLines)).toEqual([3, 1]);

  const v1 = host.setVersion({ episode: 1, version: 1 });
  expect(v1.version).toBe(1);
  expect(Buffer.from(v1.b64, "base64").toString()).toBe("audio-v1");
  expect(v1.lines.map((l) => [l.i, l.start, l.end])).toEqual([[0, 0.5, 3], [1, 3.4, 7], [2, 7.5, 11]]);
  expect(newest.lines.map((l) => [l.i, l.start, l.end])).toEqual([[0, 0.5, 3], [1, 3.4, 9], [2, 9.5, 13]]);
  expect(v1.duration).toBe(12);
  expect(newest.duration).toBe(14);

  expect(() => host.setVersion({ episode: 1, version: 7 })).toThrow("episode 1 has no mixed version 7 (it has v1, v2)");
  expect(() => host.setVersion({ episode: 1 })).toThrow("version must be");
});

test("a version that is not mixed yet (no audio) is not offered, and its manifest does not hide the mixed ones", () => {
  const w = work();
  version(w, 1, 1, V1);
  version(w, 1, 2, V2, null); // performed, not mixed
  const host = createReviewHost({ work: w, title: "t" });
  expect(host.loadTrack({ episode: 1 }).version).toBe(1);
  expect(host.listChapters()[0]?.versions.map((v) => v.version)).toEqual([1]);
});

test("a manifest cannot point the host at a file outside its episode directory", () => {
  const w = work();
  version(w, 1, 1, V1);
  const path = join(w, "outputs", "radio", "casting", "renders", "ep01", "v1.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...manifest, audio: "../../../../../pablo.json" }));
  const host = createReviewHost({ work: w, title: "t" });
  expect(host.listChapters()).toEqual([]);
  expect(() => host.loadTrack({ episode: 1 })).toThrow("no mixed audio yet");
});

// --- AC3: auto-flagged lines are visible on open with their failing gate named ---------------------------

test("AC3: auto-flags are in the track on open, in a second source, naming the failing gates", () => {
  const w = work();
  version(w, 1, 1, V1);
  writeFlags(w, [autoFlag(1, 1, "best of 4 failed: artefacts, pace; needed stretch 1.15 outside 0.75-1.05"), autoFlag(2, 0, "best of 4 failed: words")]);
  const host = createReviewHost({ work: w, title: "t" });

  const track = host.loadTrack({ episode: 1 });
  expect(track.flags).toHaveLength(1); // only this episode's
  expect(track.flags[0]).toMatchObject({ line: 1, source: "auto", failing: ["artefacts", "pace"], time: 3.4 });
  expect(track.flags[0]?.reason).toContain("best of 4 failed");
  // the line carries its own gate scores and failing gates for the "current line" panel
  expect(track.lines[1]).toMatchObject({ failing: ["pace", "artefacts"], gates: { sim_card: 0.81, wps: 2.7, tail_ok: true } });
  expect(track.lines[1]?.gates).not.toHaveProperty("label"); // only numbers and booleans are scores

  const row = host.listChapters()[0];
  expect(row?.flags).toEqual({ human: 0, auto: 1 });
});

test("an auto flag's failing gates come from the manifest line when its reason has no sentence", () => {
  expect(failingFromReason("best of 4 failed: words, tail")).toEqual(["words", "tail"]);
  expect(failingFromReason("best of 4 failed: pace; needed stretch 0.7 outside 0.75-1.05")).toEqual(["pace"]);
  expect(failingFromReason("odd")).toEqual([]);
  const w = work();
  version(w, 1, 1, V1);
  writeFlags(w, [{ id: "f-x", episode: 1, line: 1, by: "auto", reason: "flagged" }]);
  const flag = createReviewHost({ work: w, title: "t" }).loadTrack({ episode: 1 }).flags[0];
  expect(flag).toMatchObject({ source: "auto", failing: ["pace", "artefacts"] });
});

test("a flag from another version's timings still lands on the line the shown version has", () => {
  const w = work();
  version(w, 1, 1, V1);
  version(w, 1, 2, V2);
  const host = createReviewHost({ work: w, title: "t", now: fixedNow() });
  host.flag({ episode: 1, line: 2, reason: "flat", version: 1 });
  expect(host.setVersion({ episode: 1, version: 1 }).flags[0]).toMatchObject({ line: 2, time: 7.5 });
  expect(host.setVersion({ episode: 1, version: 2 }).flags[0]).toMatchObject({ line: 2, time: 7.5 }); // the flag's own time
});

// --- AC4: a chapter published while the view is open appears without a reload ----------------------------

test("AC4: a chapter published while the view is open shows in the next listChapters", () => {
  const w = work();
  version(w, 1, 1, V1);
  const host = createReviewHost({ work: w, title: "t" });
  const data = host.data();
  expect(data.chapters.map((c) => c.episode)).toEqual([1]);
  expect(data.start).toBe(1);
  expect(host.listChapters().map((c) => c.episode)).toEqual([1]);

  // perform writes the manifest first, mix then adds the audio: only a mixed chapter is listed
  version(w, 2, 1, V1, null);
  expect(host.listChapters().map((c) => c.episode)).toEqual([1]);
  version(w, 2, 1, V1);
  const after = host.listChapters();
  expect(after.map((c) => [c.episode, c.title, c.latest])).toEqual([[1, "The First Night", 1], [2, "The Second Night", 1]]);
  expect(host.loadTrack({ episode: 2 }).episode).toBe(2);

  // a new version of an existing chapter also appears, in its version list
  version(w, 1, 2, V2);
  expect(host.listChapters()[0]).toMatchObject({ latest: 2 });
  expect(host.listChapters()[0]?.versions).toHaveLength(2);
});

test("an empty work opens an empty, waiting list that fills in; a title falls back to Episode N", () => {
  const w = work();
  const host = createReviewHost({ work: w, title: "The Lamp Room" });
  expect(host.data()).toEqual({ title: "The Lamp Room", chapters: [], start: null });
  version(w, 3, 1, V1);
  expect(host.listChapters()[0]).toMatchObject({ episode: 3, title: "Episode 3" });
  expect(host.data(3).start).toBe(3);
});

// --- the wire: exactly five mutations, and the window -------------------------------------------------------

test("the host registers exactly loadTrack, setVersion, flag, unflag and listChapters", async () => {
  const w = work();
  version(w, 1, 1, V1);
  const handlers = reviewMutations(createReviewHost({ work: w, title: "t", now: fixedNow() }));
  expect(Object.keys(handlers).sort()).toEqual([...MUTATIONS].sort());
  const track = (await handlers["loadTrack"]?.({ episode: 1 })) as TrackPayload;
  expect(track.episode).toBe(1);
  await handlers["flag"]?.({ episode: 1, line: 0, reason: "flat" });
  expect(readFlags(w).flags).toHaveLength(1);
  await expect(handlers["flag"]?.({ episode: "1", line: 0 })).rejects.toThrow("episode must be");
  expect(await handlers["listChapters"]?.(undefined)).toHaveLength(1);
});

function fakeMount(): { mount: (options: MountOptions) => Promise<View>; calls: MountOptions[]; closeView: () => void } {
  const calls: MountOptions[] = [];
  let resolveClosed: (v: { reason: string }) => void = () => undefined;
  const closed = new Promise<{ reason: string }>((r) => {
    resolveClosed = r;
  });
  const view = {
    url: "http://127.0.0.1:1/#token=x",
    id: "v",
    port: 1,
    closed,
    onDisconnect: () => undefined,
    onReconnect: () => undefined,
    close: async () => resolveClosed({ reason: "closed" }),
  } as unknown as View;
  return { mount: async (o) => (calls.push(o), view), calls, closeView: () => resolveClosed({ reason: "closed" }) };
}

test("openReview mounts the review view with the host's data, its five mutations and a CSP that lets <audio> play blobs", async () => {
  const w = work();
  version(w, 1, 1, V1);
  version(w, 2, 1, V1);
  const fake = fakeMount();
  const out = await openReview(w, "The Lamp Room", 2, undefined, { mount: fake.mount, existsExecutable: () => true, binaryPath: () => undefined, env: {} });
  expect(out.ok).toBe(true);
  const options = fake.calls[0] as MountOptions;
  expect(options.view).toBe("review");
  expect(options.shell).toBe("app");
  expect(options.csp).toContain("media-src 'self' data: blob:");
  expect(Object.keys(options.mutations ?? {}).sort()).toEqual([...MUTATIONS].sort());
  const data = options.data as ReviewData;
  expect(data.start).toBe(2);
  expect(data.chapters.map((c) => c.episode)).toEqual([1, 2]);
});

test("openReview refuses (2) an episode with no mixed audio and a Mac without Chrome, and opens an empty work", async () => {
  const w = work();
  version(w, 1, 1, V1);
  const fake = fakeMount();
  const deps = { mount: fake.mount, existsExecutable: () => true, binaryPath: () => undefined, env: {} };
  const missing = await openReview(w, "t", 5, undefined, deps);
  expect(missing).toMatchObject({ ok: false, code: 2 });
  expect((missing as { message: string }).message).toContain("episode 5 has no mixed audio yet");
  expect(fake.calls).toHaveLength(0);

  const noChrome = await openReview(w, "t", undefined, undefined, { ...deps, existsExecutable: () => false });
  expect(noChrome).toEqual({ ok: false, code: 2, message: NO_CHROME_MESSAGE });
  // headless (UI_LEAF_NO_OPEN set) needs no Chrome: smoke runs and CI
  expect((await openReview(w, "t", undefined, undefined, { ...deps, existsExecutable: () => false, env: { UI_LEAF_NO_OPEN: "1" } })).ok).toBe(true);

  const empty = work();
  const opened = await openReview(empty, "t", undefined, undefined, deps);
  expect(opened.ok).toBe(true);
  expect((fake.calls.at(-1)?.data as ReviewData).chapters).toEqual([]);
});

test("pablo review: --episode is parsed, the window holds the process until it closes, refusals exit 2", async () => {
  const w = work();
  version(w, 1, 1, V1);
  expect(parseCliArgs(["review", "--project", "lamp-room", "--episode", "1"]).values["episode"]).toBe("1");

  let asked: { work: string; title: string; episode: number | undefined } | undefined;
  const closed = Promise.resolve();
  const open = (async (work: string, title: string, episode: number | undefined) => {
    asked = { work, title, episode };
    return { ok: true, view: { url: "http://127.0.0.1:1/#t" }, closed, host: createReviewHost({ work, title }) };
  }) as unknown as typeof openReview;
  expect(await runReviewView(parseCliArgs(["review", "--project", "lamp-room", "--episode", "1"]), w, open)).toBe(0);
  expect(asked).toEqual({ work: w, title: "The Lamp Room", episode: 1 });

  expect(await runReviewView(parseCliArgs(["review"]), undefined, open)).toBe(2);
  expect(await runReviewView(parseCliArgs(["review", "--project", "x", "--episode", "zero"]), w, open)).toBe(2);
  const refusing = (async () => ({ ok: false, code: 2, message: "pablo: review: nope" })) as unknown as typeof openReview;
  expect(await runReviewView(parseCliArgs(["review", "--project", "x"]), w, refusing)).toBe(2);
});

test("the host only ever writes flags.json: the manifests and audio are byte-identical after flag and unflag", () => {
  const w = work();
  version(w, 1, 1, V1);
  const manifest = join(w, "outputs", "radio", "casting", "renders", "ep01", "v1.json");
  const before = readFileSync(manifest, "utf8");
  const host = createReviewHost({ work: w, title: "t", now: fixedNow() });
  host.flag({ episode: 1, line: 0 });
  host.unflag({ episode: 1, line: 0 });
  expect(readFileSync(manifest, "utf8")).toBe(before);
  expect(dirname(flagsFile(w))).toBe(join(w, "outputs", "radio", "casting"));
});
