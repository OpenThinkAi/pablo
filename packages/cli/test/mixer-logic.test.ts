import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SR,
  audible,
  automationCurve,
  clampZoom,
  clipEnvelope,
  clipLabel,
  clipPeaks,
  distinctSources,
  envelopeAt,
  envelopeCurve,
  flatEnvelope,
  initialMixer,
  layoutLanes,
  mixerReducer,
  placeClips,
  rulerTicks,
  samples,
  schedulePlan,
  timecode,
  timelineSeconds,
  trackAutomation,
  trackGain,
  zoomAround,
} from "../views/mixer-logic";
import type { PlacedClip } from "../views/mixer-logic";
import { automationGainAt, dbToGain, equalPowerCrossfade } from "../views/mixmath";
import type { MixClip, MixDocument, MixPayload } from "../views/mixer-protocol";

/**
 * AGT-1768: the mixer view's state model, without a browser. Placement, envelopes and automation are checked
 * against `mix.py`'s own answers for the same document (`packages/casting/tests/fixtures/mix-anchors-golden.json`,
 * asserted on the Python side by `test_mixer_view_parity.py`); the rest is the window's own arithmetic.
 */
const G = JSON.parse(readFileSync(join(import.meta.dir, "../../casting/tests/fixtures/mix-anchors-golden.json"), "utf8"));
const DOC = G.document as MixDocument;
const KEY = (n: number): string => n.toString(16).padStart(64, "0");

const byId = (placed: readonly PlacedClip[], id: string): PlacedClip => placed.find((p) => p.clip.id === id) as PlacedClip;

test("golden: every clip lands on the sample mix.py puts it on, anchors chasing anchors", () => {
  const { placed, problems } = placeClips(DOC);
  expect(problems).toEqual([]);
  const got = Object.fromEntries(placed.map((p) => [p.clip.id, [p.start, p.end]]));
  expect(got).toEqual(G.expected.placement);
  // line-2 rides on line-1, which rides on line-0's end minus 0.2 s (an interruption on another lane)
  expect(byId(placed, "line-1").startSeconds).toBeCloseTo(1.55, 9);
  expect(byId(placed, "line-1").startSeconds).toBeLessThan(byId(placed, "line-0").endSeconds);
});

test("golden: each clip's envelope (gain, fades, same-lane equal-power crossfades) matches mix.py's", () => {
  const { placed } = placeClips(DOC);
  const rows = layoutLanes(DOC, placed);
  let checked = 0;
  for (const track of rows) {
    for (const lane of track.lanes) {
      lane.clips.forEach((p, k) => {
        const env = clipEnvelope(lane.clips, k);
        const want = G.expected.envelopes[p.clip.id] as [number, number][];
        for (const [j, gain] of want) {
          expect(Math.abs(envelopeAt(env, j) - gain)).toBeLessThan(1e-4);
          checked += 1;
        }
      });
    }
  }
  expect(checked).toBeGreaterThan(80);
});

test("golden: a track's automation breakpoints resolve through the anchors and interpolate as mix.py's", () => {
  const { when } = placeClips(DOC);
  const points = trackAutomation(DOC, "beds", when);
  expect(points.map((p) => [Number(p.t.toFixed(9)), p.db, p.curve])).toEqual(G.expected.automation.points);
  for (const [t, gain] of G.expected.automation.gains as [number, number][]) expect(Math.abs(automationGainAt(points, t) - gain)).toBeLessThan(1e-6);
  expect(trackAutomation(DOC, "dialogue", when)).toEqual([]);
});

test("the crossfade envelope is built from the overlap with each neighbour on the lane, and nothing else", () => {
  const { placed } = placeClips(DOC);
  const beds = layoutLanes(DOC, placed).find((t) => t.track === "beds")?.lanes[0]?.clips ?? [];
  expect(beds.map((p) => p.clip.id)).toEqual(["bed-a", "bed-b", "bed-c"]);
  const b = clipEnvelope(beds, 1);
  const kinds = b.factors.map((f) => f.kind).sort();
  expect(kinds).toEqual(["fade-out", "xfade-in", "xfade-out"]);
  const xin = b.factors.find((f) => f.kind === "xfade-in");
  // bed-a ends at 3.0 s, bed-b starts at 2.25 s: 0.75 s of crossfade, equal power
  expect(xin?.n).toBe(samples(3.0) - samples(2.25));
  const j = samples(0.1); // before bed-c (0.2 s into bed-b) brings its own crossfade-out
  expect(envelopeAt(b, j) / b.gain).toBeCloseTo(equalPowerCrossfade(j / (xin?.n ?? 1))[1], 9);
  // separate lanes never crossfade: line-0 and line-1 overlap but sit on KEEPER and TOLLER
  const dialogue = layoutLanes(DOC, placed).find((t) => t.track === "dialogue")?.lanes ?? [];
  for (const lane of dialogue) lane.clips.forEach((_, k) => expect(clipEnvelope(lane.clips, k).factors.every((f) => !f.kind.startsWith("xfade"))).toBe(true));
  expect(flatEnvelope(clipEnvelope(dialogue[1]?.clips ?? [], 0))).toBe(true);
  expect(envelopeAt(b, -1)).toBe(0);
  expect(envelopeAt(b, b.length)).toBe(0);
});

test("layout: the fixed tracks in order, dialogue one lane per role in document order, clips sorted by start", () => {
  const { placed } = placeClips(DOC);
  const rows = layoutLanes(DOC, placed);
  expect(rows.map((r) => [r.track, r.label])).toEqual([
    ["dialogue", "Dialogue"],
    ["sfx", "SFX"],
    ["beds", "Beds"],
    ["music", "Music"],
  ]);
  expect(rows[0]?.lanes.map((l) => l.lane)).toEqual(["KEEPER", "TOLLER"]);
  expect(rows[0]?.lanes[0]?.clips.map((p) => p.clip.id)).toEqual(["line-0", "line-2"]);
  expect(timelineSeconds(placed, null)).toBeCloseTo(264600 / SR, 9);
  expect(timelineSeconds(placed, 99)).toBe(99);
  expect(timelineSeconds([], null)).toBe(1);
});

test("placement problems are named by field and the rest still opens: a cycle, an unvoiced line, a start before zero", () => {
  const clip = (id: string, lines: number[], anchor: MixClip["anchor"]): MixClip => ({ id, source: { kind: "take", key: KEY(1), stretch: 1 }, lines, in: 0, out: 1, anchor });
  const doc = {
    ...DOC,
    tracks: {
      dialogue: { lanes: { A: { clips: [clip("ok", [0], { at: 0 }), clip("x", [1], { line: 2, edge: "end", offset: 0 }), clip("y", [2], { line: 1, edge: "end", offset: 0 })] } } },
      sfx: { lanes: { main: { clips: [{ id: "lost", source: { kind: "cue", key: KEY(2) }, in: 0, out: 1, anchor: { line: 9, edge: "start", offset: 0 } }] } } },
      beds: { lanes: { main: { clips: [{ id: "early", source: { kind: "cue", key: KEY(3) }, in: 0, out: 1, anchor: { line: 0, edge: "start", offset: -0.5 } }] } } },
      music: { lanes: {} },
    },
  } as MixDocument;
  const { placed, problems } = placeClips(doc);
  expect(placed.map((p) => p.clip.id)).toEqual(["ok"]);
  const fields = Object.fromEntries(problems.map((p) => [p.field, p.message]));
  expect(fields["tracks.dialogue.lanes.A.clips[1].anchor"]).toContain("cycle");
  expect(fields["tracks.sfx.lanes.main.clips[0].anchor"]).toContain("line 9, which no dialogue clip voices");
  expect(fields["tracks.beds.lanes.main.clips[0].anchor"]).toContain("0.500 s before the start");
});

test("scheduling from the top: every buffer starts at its clip's start, at its `in`, for its length", () => {
  const { placed } = placeClips(DOC);
  const plan = schedulePlan(placed, 0);
  expect(plan).toHaveLength(placed.length);
  expect(plan.map((s) => s.when)).toEqual([...plan.map((s) => s.when)].sort((a, b) => a - b));
  for (const s of plan) {
    const p = byId(placed, s.id);
    expect(s.when).toBeCloseTo(p.start / SR, 12);
    expect(s.offset).toBeCloseTo(p.inSeconds, 12);
    expect(s.duration).toBeCloseTo(p.length / SR, 12);
    expect(s.into).toBe(0);
    expect(s.source).toEqual(p.clip.source);
  }
  // a paced take keeps its stretch: the host serves it paced, so the buffer is asked for by (key, stretch)
  expect(plan.find((s) => s.id === "line-2")?.source).toEqual({ kind: "take", key: KEY(3), stretch: 0.9 });
  expect(plan.find((s) => s.id === "line-2")?.offset).toBeCloseTo(0.1, 12);
});

test("scheduling from a seek: finished clips are skipped, a clip under the playhead starts now, part-way in", () => {
  const { placed } = placeClips(DOC);
  const from = 2.0;
  const plan = schedulePlan(placed, from);
  const ids = plan.map((s) => s.id).sort();
  expect(ids).toEqual(["bed-a", "bed-b", "bed-c", "cue-0", "line-1", "line-2", "sting"]); // line-0 ended at 1.75 s
  const a = plan.find((s) => s.id === "bed-a");
  expect(a?.when).toBe(0);
  expect(a?.into).toBeCloseTo(2.0, 12);
  expect(a?.offset).toBeCloseTo(2.0, 12);
  expect(a?.duration).toBeCloseTo(3.0 - 2.0, 12);
  const sting = plan.find((s) => s.id === "sting");
  expect(sting?.when).toBeCloseTo(198450 / SR - from, 12);
  // the curve handed to Web Audio starts where the envelope is at the playhead and ends at the clip's end
  const env = a?.envelope;
  if (env === undefined) throw new Error("no envelope");
  const curve = envelopeCurve(env, a?.into ?? 0);
  expect(curve[0]).toBeCloseTo(envelopeAt(env, samples(2.0)), 6);
  expect(curve[curve.length - 1]).toBeCloseTo(envelopeAt(env, env.length - 1), 6);
  expect(curve.length).toBeGreaterThanOrEqual(1000);
  expect(schedulePlan(placed, 100)).toEqual([]);
});

test("mute and solo: any solo silences the unsoloed tracks, mute always wins, volume is live dB", () => {
  let m = initialMixer(DOC);
  expect(m.sfx).toEqual({ volume: -2, mute: false, solo: false });
  expect(trackGain(m, "sfx")).toBeCloseTo(dbToGain(-2), 12);
  m = mixerReducer(m, { type: "solo", track: "dialogue" });
  expect(audible(m, "dialogue")).toBe(true);
  expect(["sfx", "beds", "music"].map((t) => trackGain(m, t as "sfx"))).toEqual([0, 0, 0]);
  m = mixerReducer(m, { type: "solo", track: "music" });
  expect(trackGain(m, "music")).toBe(1);
  m = mixerReducer(m, { type: "mute", track: "music" });
  expect(trackGain(m, "music")).toBe(0); // muted beats soloed
  m = mixerReducer(m, { type: "solo", track: "dialogue" });
  m = mixerReducer(m, { type: "solo", track: "music" });
  m = mixerReducer(m, { type: "mute", track: "music" });
  expect(["dialogue", "sfx", "beds", "music"].map((t) => audible(m, t as "sfx"))).toEqual([true, true, true, true]);
  m = mixerReducer(m, { type: "volume", track: "beds", db: -6 });
  expect(trackGain(m, "beds")).toBeCloseTo(dbToGain(-6), 12);
  expect(mixerReducer(m, { type: "volume", track: "beds", db: 99 }).beds.volume).toBe(12);
  expect(mixerReducer(m, { type: "volume", track: "beds", db: -99 }).beds.volume).toBe(-40);
  expect(mixerReducer(m, { type: "reset", mixer: initialMixer(DOC) })).toEqual(initialMixer(DOC));
  // a document that saved a mute and a solo opens with them
  const saved = { ...DOC, tracks: { ...DOC.tracks, beds: { ...DOC.tracks.beds, mute: true }, music: { ...DOC.tracks.music, solo: true } } } as MixDocument;
  const opened = initialMixer(saved);
  expect(["dialogue", "sfx", "beds", "music"].map((t) => audible(opened, t as "sfx"))).toEqual([false, false, false, true]);
});

test("automation sampling: the curve for Web Audio follows the envelope from the playhead", () => {
  const points = [
    { t: 0, db: 0 },
    { t: 1, db: -6, curve: "exp" as const },
    { t: 3, db: 0 },
  ];
  const curve = automationCurve(points, 0.5, 2, 100);
  expect(curve.length).toBe(201);
  expect(curve[0]).toBeCloseTo(automationGainAt(points, 0.5), 6);
  expect(curve[100]).toBeCloseTo(automationGainAt(points, 1.5), 6);
  expect(curve[200]).toBeCloseTo(automationGainAt(points, 2.5), 6);
  expect(automationCurve(points, 0, 0).length).toBe(2);
});

test("the time axis: ruler steps by zoom, zoom keeps the time under the cursor, timecodes", () => {
  const coarse = rulerTicks(120, 4);
  expect(coarse[1]?.t).toBe(30); // 30 s * 4 px = 120 px >= 70
  expect(coarse.at(-1)?.t).toBe(120);
  const fine = rulerTicks(2, 400);
  expect(fine[1]?.t).toBe(0.25);
  expect(fine[1]?.label).toBe("0:00.2");
  const z = zoomAround(40, 400, 2, 100);
  expect(z.pxPerSecond).toBe(80);
  expect((z.scrollPx + 100) / 80).toBeCloseTo((400 + 100) / 40, 12);
  expect(zoomAround(40, 0, 0.5, 0)).toEqual({ pxPerSecond: 20, scrollPx: 0 });
  expect(clampZoom(1)).toBe(4);
  expect(clampZoom(10_000)).toBe(600);
  expect(timecode(0)).toBe("0:00");
  expect(timecode(75.36, true)).toBe("1:15.3");
});

test("sources and labels: one fetch per distinct (kind, key, stretch); a clip's peaks are its slice; labels from the manifest", () => {
  const { placed } = placeClips(DOC);
  const sources = distinctSources(placed);
  expect(sources).toHaveLength(6); // bed-a/b/c share one cue
  const peaks = Array.from({ length: 500 }, (_, k) => k / 500);
  expect(clipPeaks(peaks, 100, 1.5, 2.0)).toEqual(peaks.slice(150, 200));
  const payload = {
    manifest: {
      version: 1,
      duration: null,
      lines: [{ i: 2, speaker: "KEEPER", text: "The lamp is lit.", take: KEY(3), stretch: 0.9, start: null, end: null }],
      cues: [{ index: 0, kind: "SFX", desc: "a door creaks", key: KEY(0xa0), after: 1, line: null, start: null, end: null }],
    },
  } as unknown as MixPayload;
  expect(clipLabel(payload, byId(placed, "line-2").clip)).toBe("The lamp is lit. (+1)");
  expect(clipLabel(payload, byId(placed, "cue-0").clip)).toBe("a door creaks");
  expect(clipLabel(payload, byId(placed, "sting").clip)).toBe("sting");
});

test("samples rounds half to even, as Python's round does", () => {
  expect(samples(0.5 / SR)).toBe(0);
  expect(samples(1.5 / SR)).toBe(2);
  expect(samples(2.5 / SR)).toBe(2);
  expect(samples(1)).toBe(SR);
  expect(samples(-1.5 / SR)).toBe(-2);
});
