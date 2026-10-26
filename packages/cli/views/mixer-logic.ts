/**
 * The mixer view's state model (AGT-1768, `pm project show pablo-mixer`, "The mixer view"): everything the window
 * decides that is not drawing or Web Audio, as pure functions so `bun test` checks it without a browser.
 *
 *  - **Placement.** `placeClips` gives every clip of a mix document its start and end on the timeline from its
 *    anchor, in whole samples at the mix rate, exactly as `mix.py`'s `_resolve` does (a line's `start`/`end` edge
 *    is the earliest start / latest end of the take clips that list it; `{at}` is clock time; anchors chase
 *    each other until they settle). `packages/casting/tests/fixtures/mix-anchors-golden.json` holds both sides
 *    to the same answers. A clip that cannot be placed (a cycle, a line nobody voices, a start before zero) is
 *    a `problem`, never a throw: the window still opens and says which clip.
 *  - **Layout.** `layoutLanes` orders the fixed tracks (dialogue, sfx, beds, music) and their lanes in document
 *    order: dialogue is one lane per role.
 *  - **Envelopes.** `clipEnvelope` is a clip's gain as `mix.py`'s `_clip_audio` shapes it: its dB gain, its
 *    fade-in and fade-out (`mixmath` curves, the fade length rounded to samples), and an equal-power crossfade
 *    over any overlap with its neighbours on the same lane. `envelopeAt` evaluates it; `envelopeCurve` samples it
 *    for `AudioParam.setValueCurveAtTime`.
 *  - **Scheduling.** `schedulePlan(placed, from)` says which buffers start when (seconds after play), at what
 *    offset into their source, for how long, and with which envelope: the play/seek arithmetic.
 *  - **Tracks.** `trackGain` is per-track volume with mute and solo (any solo silences the unsoloed tracks, mute
 *    wins), the gain the window sets live with no re-render; `trackAutomation` resolves a track's breakpoints to
 *    times and `automationCurve` samples them.
 *  - **The time axis.** `rulerTicks`, `clampZoom`, `zoomAround` and `timecode`.
 */

import { automationGainAt, dbToGain, equalPowerCrossfade, fadeCurve } from "./mixmath";
import type { AutomationPoint, FadeCurve } from "./mixmath";
import type { MixAnchor, MixClip, MixDocument, MixPayload, MixSource, MixTrack, TrackName } from "./mixer-protocol";

/** The mix rate (`mix.py`'s `SR`): every anchor and clip edge is rounded to it, as the export does. */
export const SR = 44100;
export const TRACK_ORDER: readonly TrackName[] = ["dialogue", "sfx", "beds", "music"];
export const TRACK_LABEL: Readonly<Record<TrackName, string>> = { dialogue: "Dialogue", sfx: "SFX", beds: "Beds", music: "Music" };

/** `mix.py`'s `_samples`: seconds to whole samples (Python's `round` is half-to-even; so is this). */
export function samples(seconds: number): number {
  const x = seconds * SR;
  const r = Math.round(x);
  return Math.abs(x - Math.trunc(x)) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export const sourceId = (source: MixSource): string => `${source.kind}:${source.key}:${source.kind === "take" ? (source.stretch ?? 1) : 1}`;

/** A clip on the timeline. `start`/`end` are whole samples; the second fields are the same in seconds. */
export interface PlacedClip {
  readonly clip: MixClip;
  readonly track: TrackName;
  readonly lane: string;
  /** `tracks.<track>.lanes.<lane>.clips[<k>]`, as `mixdoc.py` names a field. */
  readonly field: string;
  readonly start: number;
  readonly length: number;
  readonly end: number;
  readonly startSeconds: number;
  readonly endSeconds: number;
  /** Seconds into the (paced) source where the clip begins: its `in`, on the sample grid. */
  readonly inSeconds: number;
}

export interface Problem {
  readonly field: string;
  readonly message: string;
}

export interface Placement {
  readonly placed: readonly PlacedClip[];
  readonly problems: readonly Problem[];
  /** The anchor resolver (samples, or null when it cannot be resolved), for automation breakpoints. */
  readonly when: (anchor: MixAnchor) => number | null;
}

interface Pending {
  readonly clip: MixClip;
  readonly track: TrackName;
  readonly lane: string;
  readonly field: string;
  readonly length: number;
  start: number;
}

const trackOf = (doc: MixDocument, name: TrackName): MixTrack => doc.tracks[name] ?? { lanes: {} };

/** Every clip of the document, placed by its anchor, the way `mix.py` places it. */
export function placeClips(doc: MixDocument): Placement {
  const pending: Pending[] = [];
  for (const track of TRACK_ORDER) {
    for (const [lane, body] of Object.entries(trackOf(doc, track).lanes)) {
      body.clips.forEach((clip, k) => {
        pending.push({ clip, track, lane, field: `tracks.${track}.lanes.${lane}.clips[${k}]`, length: samples(clip.out) - samples(clip.in), start: -1 });
      });
    }
  }
  const voicing = new Map<number, Pending[]>();
  for (const p of pending) {
    if (p.track !== "dialogue") continue;
    for (const line of p.clip.lines ?? []) {
      const group = voicing.get(line) ?? [];
      group.push(p);
      voicing.set(line, group);
    }
  }
  const when = (anchor: MixAnchor): number | null => {
    if ("at" in anchor) return samples(anchor.at);
    const group = voicing.get(anchor.line) ?? [];
    if (group.length === 0 || group.some((p) => p.start < 0)) return null;
    const edge = anchor.edge === "start" ? Math.min(...group.map((p) => p.start)) : Math.max(...group.map((p) => p.start + p.length));
    return edge + samples(anchor.offset ?? 0);
  };

  const problems: Problem[] = [];
  const dropped = new Set<Pending>();
  let unresolved = pending;
  while (unresolved.length > 0) {
    const waiting: Pending[] = [];
    for (const p of unresolved) {
      const start = when(p.clip.anchor);
      if (start === null) waiting.push(p);
      else if (start < 0) {
        problems.push({ field: `${p.field}.anchor`, message: `puts the clip ${(-start / SR).toFixed(3)} s before the start of the episode` });
        dropped.add(p);
        p.start = 0; // still an edge for clips anchored to it, as the export would refuse the whole document
      } else p.start = start;
    }
    if (waiting.length === unresolved.length) {
      for (const p of waiting) {
        const line = "line" in p.clip.anchor ? p.clip.anchor.line : undefined;
        const message = line !== undefined && !voicing.has(line) ? `anchors to line ${line}, which no dialogue clip voices` : "the anchors form a cycle: this clip is anchored, through others, to itself";
        problems.push({ field: `${p.field}.anchor`, message });
        dropped.add(p);
      }
      break;
    }
    unresolved = waiting;
  }

  const placed = pending
    .filter((p) => !dropped.has(p))
    .map((p): PlacedClip => ({
      clip: p.clip,
      track: p.track,
      lane: p.lane,
      field: p.field,
      start: p.start,
      length: p.length,
      end: p.start + p.length,
      startSeconds: p.start / SR,
      endSeconds: (p.start + p.length) / SR,
      inSeconds: samples(p.clip.in) / SR,
    }));
  return { placed, problems, when };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface LaneRow {
  readonly track: TrackName;
  readonly lane: string;
  /** Placed clips on the lane, sorted by start (stable: equal starts keep document order). */
  readonly clips: readonly PlacedClip[];
}

export interface TrackRows {
  readonly track: TrackName;
  readonly label: string;
  readonly lanes: readonly LaneRow[];
}

/** The fixed tracks in order, each with its lanes in document order (dialogue: one per role). */
export function layoutLanes(doc: MixDocument, placed: readonly PlacedClip[]): TrackRows[] {
  return TRACK_ORDER.map((track) => ({
    track,
    label: TRACK_LABEL[track],
    lanes: Object.keys(trackOf(doc, track).lanes).map((lane) => ({
      track,
      lane,
      clips: placed.filter((p) => p.track === track && p.lane === lane).sort((a, b) => a.start - b.start),
    })),
  }));
}

/** Seconds of timeline the view spans: the last clip end, the manifest's duration if longer, and never 0. */
export function timelineSeconds(placed: readonly PlacedClip[], duration: number | null): number {
  const last = placed.reduce((m, p) => Math.max(m, p.endSeconds), 0);
  return Math.max(last, duration ?? 0, 1);
}

// ---------------------------------------------------------------------------
// Clip envelopes
// ---------------------------------------------------------------------------

/** One multiplicative factor of a clip's gain, over `[start, start + n)` samples into the clip. */
export type Factor =
  | { readonly kind: "fade-in" | "fade-out"; readonly start: number; readonly n: number; readonly length: number; readonly curve: FadeCurve }
  | { readonly kind: "xfade-in" | "xfade-out"; readonly start: number; readonly n: number };

export interface Envelope {
  /** The clip's own gain, linear. */
  readonly gain: number;
  /** Samples in the clip. */
  readonly length: number;
  readonly factors: readonly Factor[];
}

/** Clip `k` of a lane (sorted by start) as `mix.py`'s `_clip_audio` shapes it: gain, fades, crossfades. */
export function clipEnvelope(members: readonly PlacedClip[], k: number): Envelope {
  const p = members[k] as PlacedClip;
  const factors: Factor[] = [];
  for (const [name, kind] of [
    ["fade_in", "fade-in"],
    ["fade_out", "fade-out"],
  ] as const) {
    const fade = p.clip[name];
    if (fade === undefined || !(fade.len > 0)) continue;
    const length = samples(fade.len);
    const n = Math.min(length, p.length);
    if (n <= 0) continue;
    factors.push({ kind, start: kind === "fade-in" ? 0 : p.length - n, n, length, curve: fade.curve ?? "linear" });
  }
  const before = members[k - 1];
  if (before !== undefined) {
    const n = Math.min(before.end, p.end) - p.start;
    if (n > 0) factors.push({ kind: "xfade-in", start: 0, n });
  }
  const after = members[k + 1];
  if (after !== undefined) {
    const n = Math.min(p.end, after.end) - after.start;
    if (n > 0) factors.push({ kind: "xfade-out", start: after.start - p.start, n });
  }
  return { gain: dbToGain(p.clip.gain ?? 0), length: p.length, factors };
}

function factorAt(f: Factor, j: number): number {
  if (j < f.start || j >= f.start + f.n) return 1;
  const i = j - f.start;
  switch (f.kind) {
    case "fade-in":
      return fadeCurve(f.curve, i / f.length);
    case "fade-out":
      return fadeCurve(f.curve, 1 - i / f.length);
    case "xfade-in":
      return equalPowerCrossfade(i / f.n)[1];
    case "xfade-out":
      return equalPowerCrossfade(i / f.n)[0];
  }
}

/** The clip's gain at sample `j` into it (outside the clip: 0). */
export function envelopeAt(env: Envelope, j: number): number {
  if (j < 0 || j >= env.length) return 0;
  let g = env.gain;
  for (const f of env.factors) g *= factorAt(f, j);
  return g;
}

/** True when the envelope never changes: a plain gain, no curve needed. */
export const flatEnvelope = (env: Envelope): boolean => env.factors.length === 0;

/** Control points per second for the curves handed to Web Audio (it interpolates linearly between them). */
export const CONTROL_RATE = 1000;

/** The envelope from `fromSeconds` into the clip to its end, sampled at `rate` per second (at least 2 points). */
export function envelopeCurve(env: Envelope, fromSeconds: number, rate = CONTROL_RATE): Float32Array {
  const from = Math.max(0, Math.round(fromSeconds * SR));
  const seconds = Math.max(0, (env.length - from) / SR);
  const n = Math.max(2, Math.ceil(seconds * rate) + 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = envelopeAt(env, Math.min(env.length - 1, from + Math.round(((i / (n - 1)) * seconds) * SR)));
  return out;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export interface ScheduledClip {
  readonly id: string;
  readonly track: TrackName;
  readonly lane: string;
  readonly source: MixSource;
  /** Seconds after the play button (timeline `from`) at which the buffer starts. */
  readonly when: number;
  /** Seconds into the source buffer at which it starts playing. */
  readonly offset: number;
  /** Seconds it plays for. */
  readonly duration: number;
  /** Seconds into the clip the envelope starts at (non-zero when playback starts inside the clip). */
  readonly into: number;
  readonly envelope: Envelope;
}

/** Which buffers start when, from timeline second `from`: every clip that has not ended, with its envelope. */
export function schedulePlan(placed: readonly PlacedClip[], from: number): ScheduledClip[] {
  const lanes = new Map<string, PlacedClip[]>();
  for (const p of placed) {
    const id = `${p.track}\u0000${p.lane}`;
    const members = lanes.get(id) ?? [];
    members.push(p);
    lanes.set(id, members);
  }
  const plan: ScheduledClip[] = [];
  for (const members of lanes.values()) {
    members.sort((a, b) => a.start - b.start);
    members.forEach((p, k) => {
      if (p.endSeconds <= from || p.length <= 0) return;
      const into = Math.max(0, from - p.startSeconds);
      plan.push({
        id: p.clip.id,
        track: p.track,
        lane: p.lane,
        source: p.clip.source,
        when: Math.max(0, p.startSeconds - from),
        offset: p.inSeconds + into,
        duration: p.length / SR - into,
        into,
        envelope: clipEnvelope(members, k),
      });
    });
  }
  return plan.sort((a, b) => a.when - b.when || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Tracks: volume, mute, solo, automation
// ---------------------------------------------------------------------------

export interface TrackState {
  readonly volume: number;
  readonly mute: boolean;
  readonly solo: boolean;
}

export type Mixer = Readonly<Record<TrackName, TrackState>>;

/** The document's own volume/mute/solo per track: where the window starts. */
export function initialMixer(doc: MixDocument): Mixer {
  const state = (name: TrackName): TrackState => {
    const t = trackOf(doc, name);
    return { volume: t.volume ?? 0, mute: t.mute === true, solo: t.solo === true };
  };
  return { dialogue: state("dialogue"), sfx: state("sfx"), beds: state("beds"), music: state("music") };
}

/** Whether a track is heard: not muted, and soloed when anything is (as the export decides). */
export function audible(mixer: Mixer, track: TrackName): boolean {
  const soloed = TRACK_ORDER.some((t) => mixer[t].solo);
  const s = mixer[track];
  return !s.mute && (!soloed || s.solo);
}

/** The track's live gain: its volume in dB, or 0 when muted or outside a solo. */
export function trackGain(mixer: Mixer, track: TrackName): number {
  return audible(mixer, track) ? dbToGain(mixer[track].volume) : 0;
}

export type MixerAction =
  | { readonly type: "volume"; readonly track: TrackName; readonly db: number }
  | { readonly type: "mute" | "solo"; readonly track: TrackName }
  | { readonly type: "reset"; readonly mixer: Mixer };

export const VOLUME_MIN_DB = -40;
export const VOLUME_MAX_DB = 12;

export function mixerReducer(state: Mixer, action: MixerAction): Mixer {
  if (action.type === "reset") return action.mixer;
  const t = state[action.track];
  switch (action.type) {
    case "volume":
      return { ...state, [action.track]: { ...t, volume: Math.min(VOLUME_MAX_DB, Math.max(VOLUME_MIN_DB, action.db)) } };
    case "mute":
      return { ...state, [action.track]: { ...t, mute: !t.mute } };
    case "solo":
      return { ...state, [action.track]: { ...t, solo: !t.solo } };
  }
}

/** A track's breakpoints with their anchors resolved to seconds (as `mix.py` does: an unresolvable one at 0). */
export function trackAutomation(doc: MixDocument, track: TrackName, when: Placement["when"]): AutomationPoint[] {
  return (trackOf(doc, track).automation ?? []).map((point) => ({ t: (when(point.anchor) ?? 0) / SR, db: point.db, curve: point.curve ?? "linear" }));
}

/** Automation gain from timeline second `from` for `seconds`, sampled at `rate` per second (at least 2 points). */
export function automationCurve(points: readonly AutomationPoint[], from: number, seconds: number, rate = 100): Float32Array {
  const n = Math.max(2, Math.ceil(Math.max(0, seconds) * rate) + 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = automationGainAt(points, from + (i / (n - 1)) * seconds);
  return out;
}

// ---------------------------------------------------------------------------
// The time axis
// ---------------------------------------------------------------------------

export const ZOOM_MIN = 4;
export const ZOOM_MAX = 600;
export const clampZoom = (pxPerSecond: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pxPerSecond));

/** Zoom by `factor` keeping the time under `anchorPx` (pixels from the lanes' left edge, on screen) still. */
export function zoomAround(pxPerSecond: number, scrollPx: number, factor: number, anchorPx: number): { pxPerSecond: number; scrollPx: number } {
  const next = clampZoom(pxPerSecond * factor);
  const t = (scrollPx + anchorPx) / pxPerSecond;
  return { pxPerSecond: next, scrollPx: Math.max(0, t * next - anchorPx) };
}

const STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Ruler ticks over `[0, seconds]`: the finest step at least `minPx` apart; every fifth (or minute) is labelled. */
export function rulerTicks(seconds: number, pxPerSecond: number, minPx = 70): { t: number; label: string | null }[] {
  const step = STEPS.find((s) => s * pxPerSecond >= minPx) ?? (STEPS[STEPS.length - 1] as number);
  const ticks: { t: number; label: string | null }[] = [];
  const count = Math.floor(seconds / step + 1e-9);
  for (let i = 0; i <= count; i++) {
    const t = Number((i * step).toFixed(3));
    ticks.push({ t, label: timecode(t, step < 1) });
  }
  return ticks;
}

/** `m:ss` (or `m:ss.t` when tenths matter). */
export function timecode(seconds: number, tenths = false): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const whole = Math.floor(rest);
  const head = `${m}:${String(whole).padStart(2, "0")}`;
  return tenths ? `${head}.${Math.floor((rest - whole) * 10 + 1e-6)}` : head;
}

/** The peaks of a clip's slice of its source, `[in, out)`, at the source's `perSecond`. */
export function clipPeaks(peaks: readonly number[], perSecond: number, inSeconds: number, outSeconds: number): readonly number[] {
  return peaks.slice(Math.floor(inSeconds * perSecond), Math.ceil(outSeconds * perSecond));
}

/** What a payload needs from the host: one entry per distinct source (a take at a stretch, or a cue). */
export function distinctSources(placed: readonly PlacedClip[]): MixSource[] {
  const seen = new Map<string, MixSource>();
  for (const p of placed) if (!seen.has(sourceId(p.clip.source))) seen.set(sourceId(p.clip.source), p.clip.source);
  return [...seen.values()];
}

/** The label a clip block shows: its line's speaker and text, or its cue's description. */
export function clipLabel(payload: Pick<MixPayload, "manifest">, clip: MixClip): string {
  const first = clip.lines?.[0];
  if (first !== undefined) {
    const line = payload.manifest.lines.find((l) => l.i === first);
    if (line !== undefined) return clip.lines !== undefined && clip.lines.length > 1 ? `${line.text} (+${clip.lines.length - 1})` : line.text;
  }
  if (clip.cue !== undefined) {
    const cue = payload.manifest.cues.find((c) => c.index === clip.cue);
    if (cue !== undefined) return cue.desc;
  }
  return clip.id;
}

/**
 * Whether the episode audio on disk is older than the mix the window shows (AGT-2152): there are unsaved edits,
 * there is no audio rendered from a mix document, or the newest audio was rendered from an earlier mix version.
 * An older version opened by `--version` is not "newer" than audio rendered from a later one.
 */
export function audioOlderThanMix(payload: Pick<MixPayload, "version" | "rendered">, unsaved: boolean): boolean {
  if (unsaved) return true;
  const from = payload.rendered.mix;
  return from === null || from < payload.version;
}
