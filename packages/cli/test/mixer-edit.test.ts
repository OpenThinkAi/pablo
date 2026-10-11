import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  anchorText,
  anchorableLines,
  dirty,
  dragEdit,
  editReducer,
  findClip,
  freshId,
  initialEdit,
  isStaleRefusal,
  lineEdges,
  moveClip,
  proposal,
  riders,
  setFade,
  setGain,
  setTrack,
  shiftAnchor,
  splitClip,
  trimIn,
  trimOut,
} from "../views/mixer-edit";
import { SR, clipEnvelope, initialMixer, layoutLanes, placeClips, samples } from "../views/mixer-logic";
import type { PlacedClip } from "../views/mixer-logic";
import type { MixClip, MixDocument } from "../views/mixer-protocol";

/**
 * AGT-1769: the mixer's editing model, without a browser. Every edit op, the undo/redo history, and the round
 * trip: the AC1 edits (fade a bed out under a line, split a bed, overlap two lines) applied to the golden mix,
 * saved and reloaded. `packages/casting/tests/fixtures/mix-edit-roundtrip.json` holds the edited document and its
 * placement; `packages/casting/tests/test_mixer_edit_roundtrip.py` saves it through `mixer save`, reloads it through
 * `mixer load`, and checks `mix.py` places every clip where the window does. Regenerate the fixture (when the
 * edits change on purpose) with `REGEN_MIX_EDIT_FIXTURE=1 bun test packages/cli/test/mixer-edit.test.ts`.
 */
const G = JSON.parse(readFileSync(join(import.meta.dir, "../../casting/tests/fixtures/mix-anchors-golden.json"), "utf8"));
const DOC = G.document as MixDocument;
const FIXTURE = join(import.meta.dir, "../../casting/tests/fixtures/mix-edit-roundtrip.json");

const placed = (doc: MixDocument): readonly PlacedClip[] => {
  const p = placeClips(doc);
  expect(p.problems).toEqual([]);
  return p.placed;
};
const at = (doc: MixDocument, id: string): PlacedClip => placed(doc).find((p) => p.clip.id === id) as PlacedClip;
const clip = (doc: MixDocument, id: string): MixClip => (findClip(doc, id) as { clip: MixClip }).clip;

// The golden mix: KEEPER line-0 at 0.5–1.75; TOLLER line-1 at 1.55–2.45 (interrupting); KEEPER line-2 (lines 2, 3)
// at 2.6–4.5; beds bed-a 0–3, bed-b 2.25–4.75, bed-c 2.45–2.85 on one lane.

test("line edges are each voiced line's earliest start and latest end", () => {
  const edges = lineEdges(placeClips(DOC));
  const t = (line: number, edge: string) => edges.find((e) => e.line === line && e.edge === edge)?.t;
  expect(t(0, "start")).toBeCloseTo(0.5, 9);
  expect(t(0, "end")).toBeCloseTo(1.75, 9);
  expect(t(1, "start")).toBeCloseTo(1.55, 9);
  expect(t(3, "end")).toBeCloseTo(4.5, 9);
});

test("a clip never anchors to a line that rides on it: its own lines, or lines voiced by clips anchored to it", () => {
  expect([...riders(DOC, "line-0")].sort()).toEqual(["bed-a", "bed-b", "bed-c", "cue-0", "line-0", "line-1", "line-2", "sting"]);
  expect(anchorableLines(DOC, "line-0").size).toBe(0); // every line rides on line-0
  expect([...anchorableLines(DOC, "line-2")].sort()).toEqual([0, 1]);
  expect([...anchorableLines(DOC, "bed-c")].sort()).toEqual([0, 1, 2, 3]);
});

test("move: a dropped clip re-anchors to the nearest line edge, snapping onto it when close", () => {
  // bed-c dropped 0.05 s after line 0's end (1.75): nearest edge is line 0's end; inside the snap it sits on it.
  const snapped = moveClip(DOC, "bed-c", 1.8, { snap: 0.1 });
  expect(clip(snapped, "bed-c").anchor).toEqual({ line: 0, edge: "end", offset: 0 });
  expect(at(snapped, "bed-c").start).toBe(at(DOC, "line-0").end);
  // Outside the snap it keeps the distance as the offset.
  const offset = moveClip(DOC, "bed-c", 1.8, { snap: 0.01 });
  expect(clip(offset, "bed-c").anchor).toEqual({ line: 0, edge: "end", offset: 0.05 });
  expect(at(offset, "bed-c").start).toBe(at(DOC, "line-0").end + samples(0.05));
  // Never before the episode starts.
  const early = moveClip(DOC, "bed-c", -3);
  expect(at(early, "bed-c").start).toBe(0);
});

test("move: a re-anchored clip rides along when its line moves", () => {
  const moved = moveClip(DOC, "bed-c", 4.6, { snap: 0.2 }); // onto line-2's end (4.5: lines 2 and 3 end together)
  expect(clip(moved, "bed-c").anchor).toEqual({ line: 2, edge: "end", offset: 0 });
  const later = moveClip(moved, "line-2", at(moved, "line-2").startSeconds + 0.4, { free: true });
  expect(at(later, "bed-c").start - at(moved, "bed-c").start).toBe(samples(0.4));
});

test("move with Alt: the anchor stays, only its offset changes; an {at} clip stays {at}", () => {
  const free = moveClip(DOC, "line-1", at(DOC, "line-1").startSeconds - 0.25, { free: true });
  expect(clip(free, "line-1").anchor).toEqual({ line: 0, edge: "end", offset: -0.45 });
  // what rides on line-1 moves with it
  expect(at(free, "line-2").start - at(DOC, "line-2").start).toBe(-samples(0.25));
  const atClip = moveClip(DOC, "line-0", 0.8, { free: true });
  expect(clip(atClip, "line-0").anchor).toEqual({ at: 0.8 });
  // line-0 has nothing to anchor to (every line rides on it), so even a snapping move keeps it on the clock
  expect(clip(moveClip(DOC, "line-0", 0.9, { snap: 1 }), "line-0").anchor).toEqual({ at: 0.9 });
});

test("overlap across role lanes: KEEPER's line-2 moved to start under TOLLER's line-1", () => {
  const moved = moveClip(DOC, "line-2", at(DOC, "line-1").endSeconds - 0.3, { snap: 0.05 });
  expect(clip(moved, "line-2").anchor).toEqual({ line: 1, edge: "end", offset: -0.3 });
  const a = at(moved, "line-1");
  const b = at(moved, "line-2");
  expect(b.start).toBeLessThan(a.end);
  expect(a.lane).not.toBe(b.lane); // separate lanes: no crossfade, both play in full
  const lanes = layoutLanes(moved, placed(moved));
  const keeper = lanes[0]?.lanes.find((l) => l.lane === "KEEPER")?.clips ?? [];
  expect(clipEnvelope(keeper, keeper.findIndex((p) => p.clip.id === "line-2")).factors.filter((f) => f.kind.startsWith("xfade"))).toEqual([]);
});

test("overlap on one lane crossfades (equal power) over the overlap", () => {
  const moved = moveClip(DOC, "bed-c", 4.5, { free: true }); // bed-c over bed-b's tail
  const beds = layoutLanes(moved, placed(moved))[2]?.lanes[0]?.clips ?? [];
  const k = beds.findIndex((p) => p.clip.id === "bed-c");
  const b = beds.findIndex((p) => p.clip.id === "bed-b");
  expect(clipEnvelope(beds, k).factors.some((f) => f.kind === "xfade-in")).toBe(true);
  expect(clipEnvelope(beds, b).factors.some((f) => f.kind === "xfade-out")).toBe(true);
});

test("trim in: the head moves within the source and the audio under the clip stays put", () => {
  const trimmed = trimIn(DOC, "bed-b", 0.5);
  expect(clip(trimmed, "bed-b").in).toBe(2.0);
  expect(at(trimmed, "bed-b").start).toBe(at(DOC, "bed-b").start + samples(0.5));
  expect(at(trimmed, "bed-b").end).toBe(at(DOC, "bed-b").end);
  // Never before the source's start (in >= 0) ...
  expect(clip(trimIn(DOC, "bed-a", -1), "bed-a").in).toBe(0);
  // ... nor shorter than the shortest clip; the fade-in shrinks to fit.
  const short = trimIn(DOC, "bed-a", 10);
  expect(clip(short, "bed-a").out - clip(short, "bed-a").in).toBeCloseTo(0.02, 9);
  expect(clip(short, "bed-a").fade_in?.len).toBeCloseTo(0.02, 9);
  // Extending the head back can't put the clip before 0: bed-a starts at 0 with in 0, bed-b can grow back 1.5 s.
  expect(clip(trimIn(DOC, "bed-b", -5), "bed-b").in).toBe(0);
});

test("trim out: the tail moves, never past the end of the source", () => {
  expect(clip(trimOut(DOC, "bed-b", 1, 6), "bed-b").out).toBe(5);
  expect(clip(trimOut(DOC, "bed-b", 9, 6), "bed-b").out).toBe(6);
  const shorter = trimOut(DOC, "bed-b", -2.49);
  expect(clip(shorter, "bed-b").out).toBeCloseTo(1.52, 9);
  expect(clip(shorter, "bed-b").fade_out?.len).toBeCloseTo(0.02, 9); // the fade fits what is left
  expect(at(shorter, "bed-b").start).toBe(at(DOC, "bed-b").start);
});

test("split: two clips over one source that play exactly what the one did", () => {
  const t = 3.5;
  const split = splitClip(DOC, "bed-b", t);
  const left = clip(split, "bed-b");
  const right = clip(split, "bed-b.2");
  expect(right.source).toEqual(left.source);
  expect(left.out).toBe(right.in);
  expect(left.in).toBe(1.5);
  expect(right.out).toBe(4.0);
  expect(left.fade_in).toBeUndefined();
  expect(left.fade_out).toBeUndefined();
  expect(right.fade_out).toEqual({ len: 0.75, curve: "scurve" });
  const l = at(split, "bed-b");
  const r = at(split, "bed-b.2");
  expect(l.start).toBe(at(DOC, "bed-b").start);
  expect(l.end).toBe(r.start); // butted, no gap and no crossfade
  expect(r.start).toBe(samples(t));
  expect(r.end).toBe(at(DOC, "bed-b").end);
  // same lane, same position in the list: right after the left half
  expect(split.tracks.beds.lanes["main"]?.clips.map((c) => c.id)).toEqual(["bed-a", "bed-b", "bed-b.2", "bed-c"]);
});

test("split a dialogue clip: both halves voice its lines and what rides on them stays put", () => {
  const split = splitClip(DOC, "line-2", 3.0);
  expect(clip(split, "line-2").lines).toEqual([2, 3]);
  expect(clip(split, "line-2.2").lines).toEqual([2, 3]);
  expect(at(split, "sting").start).toBe(at(DOC, "sting").start); // anchored to line 2's end
  expect(at(split, "cue-0").start).toBe(at(DOC, "cue-0").start); // anchored to line 2's start
});

test("split outside the clip (or too near an edge) changes nothing; ids never collide", () => {
  expect(splitClip(DOC, "bed-b", 1)).toBe(DOC);
  expect(splitClip(DOC, "bed-b", at(DOC, "bed-b").startSeconds + 0.001)).toBe(DOC);
  expect(splitClip(DOC, "nope", 3)).toBe(DOC);
  const twice = splitClip(splitClip(DOC, "bed-b", 3.0), "bed-b.2", 4.0);
  expect(findClip(twice, "bed-b.3")).toBeDefined();
  expect(freshId(twice, "bed-b.3")).toBe("bed-b.4");
});

test("fades: length clamps to what the other fade leaves; every curve can be picked", () => {
  const long = setFade(DOC, "bed-b", "in", { len: 10 });
  expect(clip(long, "bed-b").fade_in).toEqual({ len: 1.75, curve: "linear" }); // 2.5 s clip - 0.75 s fade-out
  for (const curve of ["linear", "scurve", "log", "exp"] as const) expect(clip(setFade(DOC, "bed-b", "out", { curve }), "bed-b").fade_out).toEqual({ len: 0.75, curve });
  expect(clip(setFade(DOC, "bed-b", "out", { len: -1 }), "bed-b").fade_out?.len).toBe(0);
  expect(setFade(DOC, "bed-c", "in", { len: 0 })).toBe(DOC); // no fade, none asked for
  // a fade handle dragged: fade-in grows rightwards, fade-out grows leftwards
  expect(clip(dragEdit(DOC, "fade-in", "bed-a", 0.25), "bed-a").fade_in?.len).toBe(0.75);
  expect(clip(dragEdit(DOC, "fade-out", "bed-b", -0.25), "bed-b").fade_out?.len).toBe(1);
});

test("clip gain: set by number or slider, rounded to a tenth and kept in range", () => {
  expect(clip(setGain(DOC, "bed-a", -7.26), "bed-a").gain).toBe(-7.3);
  expect(clip(setGain(DOC, "bed-a", 40), "bed-a").gain).toBe(12);
  expect(clip(setGain(DOC, "bed-a", -400), "bed-a").gain).toBe(-60);
  expect(setGain(DOC, "bed-a", Number.NaN)).toBe(DOC);
  expect(setGain(DOC, "bed-a", -12)).toBe(DOC);
});

test("track volume, mute and solo are document edits (saved), and the live mixer reads them", () => {
  const doc = setTrack(setTrack(setTrack(DOC, "beds", { volume: -4.5 }), "music", { mute: true }), "dialogue", { solo: true });
  expect([doc.tracks.beds.volume, doc.tracks.music.mute, doc.tracks.dialogue.solo]).toEqual([-4.5, true, true]);
  expect(initialMixer(doc).beds.volume).toBe(-4.5);
  expect(doc.tracks.beds.lanes).toBe(DOC.tracks.beds.lanes); // clips untouched: nothing re-places
  expect(setTrack(DOC, "sfx", { volume: -2 })).toBe(DOC);
  expect(setTrack(DOC, "sfx", { volume: 99 }).tracks.sfx.volume).toBe(12);
});

test("drag gestures map to the edits, recomputed from where the drag began", () => {
  expect(dragEdit(DOC, "move", "bed-c", -0.7, { snap: 0.1 })).toEqual(moveClip(DOC, "bed-c", at(DOC, "bed-c").startSeconds - 0.7, { snap: 0.1 }));
  expect(dragEdit(DOC, "trim-in", "bed-b", 0.5)).toEqual(trimIn(DOC, "bed-b", 0.5));
  expect(dragEdit(DOC, "trim-out", "bed-b", 9, { sourceSeconds: 6 })).toEqual(trimOut(DOC, "bed-b", 9, 6));
  expect(dragEdit(DOC, "move", "missing", 1)).toBe(DOC);
});

test("anchors shift and read in plain words", () => {
  expect(shiftAnchor({ at: 0.5 }, -1)).toEqual({ at: 0 });
  expect(shiftAnchor({ line: 2, edge: "end", offset: 0.1 }, 0.2)).toEqual({ line: 2, edge: "end", offset: 0.3 });
  const lines = [{ i: 4, speaker: "CORA", text: "", take: "", stretch: 1, start: 0, end: 1 }];
  expect(anchorText({ line: 4, edge: "end", offset: 0.35 }, lines)).toBe("end of line 4 (CORA) +0.35 s");
  expect(anchorText({ line: 4, edge: "start", offset: -0.2 }, lines)).toBe("start of line 4 (CORA) −0.20 s");
  expect(anchorText({ at: 1.5 }, lines)).toBe("at 1.50 s");
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

test("undo/redo: each edit is one step, a gesture (drag, slider) is one step however many moves it makes", () => {
  let s = initialEdit(DOC);
  expect(dirty(s)).toBe(false);
  s = editReducer(s, { type: "apply", doc: setGain(DOC, "bed-a", -6), label: "gain" });
  const afterGain = s.doc;
  for (const dx of [0.1, 0.2, 0.3]) s = editReducer(s, { type: "apply", doc: dragEdit(afterGain, "move", "bed-c", dx, { free: true }), label: "move", gesture: "drag:1" });
  s = editReducer(s, { type: "end-gesture" });
  expect(s.past.map((p) => p.label)).toEqual(["gain", "move"]);
  expect(dirty(s)).toBe(true);
  s = editReducer(s, { type: "undo" });
  expect(s.doc).toBe(afterGain);
  s = editReducer(s, { type: "undo" });
  expect(s.doc).toBe(DOC);
  expect(dirty(s)).toBe(false);
  expect(editReducer(s, { type: "undo" })).toBe(s); // nothing left
  s = editReducer(s, { type: "redo" });
  expect(s.doc).toBe(afterGain);
  // a new edit drops the redo stack
  s = editReducer(s, { type: "apply", doc: setTrack(s.doc, "beds", { mute: true }), label: "mute" });
  expect(s.future).toEqual([]);
  expect(editReducer(s, { type: "redo" })).toBe(s);
  // an edit that changes nothing is not a step
  expect(editReducer(s, { type: "apply", doc: s.doc, label: "noop" })).toBe(s);
  // after a gesture ends, the same gesture key starts a new step
  const one = editReducer(initialEdit(DOC), { type: "apply", doc: setGain(DOC, "bed-a", -1), label: "gain", gesture: "gain:bed-a" });
  const two = editReducer(editReducer(one, { type: "end-gesture" }), { type: "apply", doc: setGain(DOC, "bed-a", -2), label: "gain", gesture: "gain:bed-a" });
  expect(two.past.length).toBe(2);
});

test("a save makes the saved document the base: no unsaved edits, and undo still works", () => {
  let s = editReducer(initialEdit(DOC), { type: "apply", doc: setGain(DOC, "bed-a", -6), label: "gain" });
  const written = { ...JSON.parse(JSON.stringify(s.doc)), version: 3, parent: 2, by: "human", summary: "1 changed" } as MixDocument;
  s = editReducer(s, { type: "saved", doc: written });
  expect(dirty(s)).toBe(false);
  s = editReducer(s, { type: "undo" });
  expect(dirty(s)).toBe(true);
  // loading another version starts a fresh history
  expect(editReducer(s, { type: "load", doc: DOC })).toEqual(initialEdit(DOC));
});

test("unsaved changes compare meaning, not key order or metadata", () => {
  const flip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).reverse()) as T;
  const reordered = flip({ ...DOC, tracks: flip({ ...DOC.tracks, beds: flip(DOC.tracks.beds) }) });
  const s = { ...initialEdit(DOC), doc: { ...reordered, version: 9, created: "later" } };
  expect(dirty(s)).toBe(false);
});

test("a stale save is recognised in mixer.py's words, so the window can say to reload", () => {
  expect(isStaleRefusal("mix v1 is not the newest (v2); reload v2 and apply your edits to it. Nothing was written")).toBe(true);
  expect(isStaleRefusal("mix v3 was written meanwhile; reload and apply your edits to it. Nothing was written")).toBe(true);
  expect(isStaleRefusal("nothing changed from mix v2; nothing was written")).toBe(false);
});

// ---------------------------------------------------------------------------
// AC1 + AC2: the edits, saved and reloaded
// ---------------------------------------------------------------------------

/** AC1 on the golden mix: fade the bed out under TOLLER's line, split a bed, overlap two lines, and a track volume. */
function ac1Edits(doc: MixDocument): MixDocument {
  let s = initialEdit(doc);
  const step = (next: MixDocument, label: string) => {
    s = editReducer(s, { type: "apply", doc: next, label });
  };
  // the bed (bed-a, 0–3 s) ends under TOLLER's line 1 (1.55–2.45): trimmed to 2.4 s with an S-curve fade out
  step(trimOut(s.doc, "bed-a", -0.6, 6), "trim");
  step(setFade(s.doc, "bed-a", "out", { len: 0.8, curve: "scurve" }), "fade");
  // split bed-b where it repeats, and pull its second half down
  step(splitClip(s.doc, "bed-b", 3.5), "split");
  step(setGain(s.doc, "bed-b.2", -15), "gain");
  // KEEPER's line-2 starts 0.3 s before TOLLER finishes
  step(moveClip(s.doc, "line-2", at(s.doc, "line-1").endSeconds - 0.3, { snap: 0.05 }), "move");
  step(setTrack(s.doc, "beds", { volume: -2 }), "volume");
  expect(s.past.length).toBe(6);
  return s.doc;
}

test("AC1/AC2: the edits save as a proposal and reload to the same placement, clip for clip", () => {
  const edited = ac1Edits(DOC);
  const sent = proposal(edited);
  expect(Object.keys(sent).sort()).toEqual(["manifest_version", "master", "tracks"]);
  // what saveMix writes back (mixdoc.write_mix adds its own fields) and loadMix returns
  const reloaded = JSON.parse(JSON.stringify({ schema: 1, episode: 1, version: 2, parent: 1, by: "human", created: "t", summary: "s", ...sent })) as MixDocument;
  const where = (doc: MixDocument) => Object.fromEntries(placed(doc).map((p) => [p.clip.id, [p.start, p.end]]));
  expect(where(reloaded)).toEqual(where(edited));
  expect(reloaded.tracks).toEqual(edited.tracks);
  expect(initialMixer(reloaded).beds.volume).toBe(-2);
  expect(dirty({ ...initialEdit(reloaded), doc: edited })).toBe(false);

  const fixture = { base: DOC, edited: sent, placement: where(edited) };
  if (process.env["REGEN_MIX_EDIT_FIXTURE"] === "1") writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  // the Python side saves and reloads this same fixture (test_mixer_edit_roundtrip.py)
  expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(JSON.parse(JSON.stringify(fixture)));
  // the AC1 shape: bed fades out under line 1, line-2 overlaps line-1, bed-b is two clips over one source
  const bed = at(edited, "bed-a");
  expect(bed.endSeconds).toBeGreaterThan(at(edited, "line-1").startSeconds);
  expect(bed.endSeconds).toBeLessThan(at(edited, "line-1").endSeconds);
  expect(at(edited, "line-2").start).toBeLessThan(at(edited, "line-1").end);
  expect(clip(edited, "bed-b.2").source).toEqual(clip(edited, "bed-b").source);
  expect(SR).toBe(44100);
});
