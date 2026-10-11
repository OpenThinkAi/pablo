/**
 * The mixer's Web Audio playback (AGT-1768). Browser-only (it needs `AudioContext`); every decision it acts on
 * is `mixer-logic.ts`'s and tested there, so this file only wires nodes:
 *
 *   clip buffer -> clip gain (its envelope: gain, fades, crossfades) -> track automation -> track gain -> master
 *
 * Track gain is set live from volume/mute/solo (a short ramp, no click), so they are heard at once with no
 * re-render. The context runs at the mix rate, so a clip's edges fall on the same samples as the export's.
 *
 * The master: `master.gain` dB, then (as `mix.py`'s `master` does with `peak_db`) the one gain that puts the
 * mix's peak at `peak_db` dBFS. The peak is measured after the buffers are decoded, and again after edits settle
 * (AGT-1769: the export normalises the edited mix, so the preview does too), by rendering the document's own mix
 * offline through the same graph.
 */

import { dbToGain } from "./mixmath";
import { automationCurve, envelopeCurve, flatEnvelope, schedulePlan, SR, sourceId, TRACK_ORDER, trackGain } from "./mixer-logic";
import type { Mixer, PlacedClip } from "./mixer-logic";
import type { AutomationPoint } from "./mixmath";
import type { MixDocument, MixSource, TrackName } from "./mixer-protocol";

type Ctx = BaseAudioContext;

export function decodeB64(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

interface Graph {
  readonly master: GainNode;
  readonly tracks: Record<TrackName, { readonly gain: GainNode; readonly automation: GainNode }>;
  readonly sources: AudioBufferSourceNode[];
}

/** Builds the track buses and schedules every clip from timeline second `from`, starting at context time `at`. */
function build(
  ctx: Ctx,
  placed: readonly PlacedClip[],
  buffers: ReadonlyMap<string, AudioBuffer>,
  automation: Readonly<Record<TrackName, readonly AutomationPoint[]>>,
  mixer: Mixer,
  masterGain: number,
  from: number,
  at: number,
  span: number,
): Graph {
  const master = ctx.createGain();
  master.gain.value = masterGain;
  master.connect(ctx.destination);
  const tracks = {} as Graph["tracks"];
  for (const name of TRACK_ORDER) {
    const gain = ctx.createGain();
    gain.gain.value = trackGain(mixer, name);
    gain.connect(master);
    const auto = ctx.createGain();
    auto.connect(gain);
    const points = automation[name];
    if (points.length > 0 && span > from) auto.gain.setValueCurveAtTime(automationCurve(points, from, span - from), at, span - from);
    tracks[name] = { gain, automation: auto };
  }
  const sources: AudioBufferSourceNode[] = [];
  for (const s of schedulePlan(placed, from)) {
    const buffer = buffers.get(sourceId(s.source));
    if (buffer === undefined || s.duration <= 0) continue;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    const clipGain = ctx.createGain();
    if (flatEnvelope(s.envelope)) clipGain.gain.value = s.envelope.gain;
    else clipGain.gain.setValueCurveAtTime(envelopeCurve(s.envelope, s.into), at + s.when, s.duration);
    node.connect(clipGain);
    clipGain.connect(tracks[s.track].automation);
    node.start(at + s.when, s.offset, s.duration);
    sources.push(node);
  }
  return { master, tracks, sources };
}

export interface EngineInput {
  readonly doc: MixDocument;
  readonly placed: readonly PlacedClip[];
  readonly automation: Readonly<Record<TrackName, readonly AutomationPoint[]>>;
  /** Timeline length in seconds. */
  readonly span: number;
}

export class MixEngine {
  private readonly ctx = new AudioContext({ sampleRate: SR, latencyHint: "interactive" });
  private readonly buffers = new Map<string, AudioBuffer>();
  private graph: Graph | null = null;
  private origin = 0; // context time at which timeline second `from` plays
  private from = 0;
  private paused = 0;
  private masterGain: number;
  private mixer: Mixer;
  private onEnd: (() => void) | null = null;
  private endTimer: ReturnType<typeof setTimeout> | undefined;
  private measuring = 0;

  constructor(
    private input: EngineInput,
    mixer: Mixer,
  ) {
    this.mixer = mixer;
    this.masterGain = dbToGain(input.doc.master.gain);
  }

  /** Decodes one source's audio (a base64 WAV from `clipAudio`). */
  async add(source: MixSource, b64: string): Promise<void> {
    this.buffers.set(sourceId(source), await this.ctx.decodeAudioData(decodeB64(b64)));
  }

  has(source: MixSource): boolean {
    return this.buffers.has(sourceId(source));
  }

  /**
   * Measures the document's mix peak offline (same graph, the document's own volume/mute/solo) and sets the
   * master to `mix.py`'s: `peak_db` dBFS at the peak, or just `master.gain` when `peak_db` is null.
   */
  async measure(documentMixer: Mixer): Promise<{ peak: number; gain: number }> {
    this.measuring += 1;
    const ticket = this.measuring;
    const base = dbToGain(this.input.doc.master.gain);
    const peakDb = this.input.doc.master.peak_db;
    const frames = Math.ceil(this.input.span * SR);
    if (peakDb === null || frames <= 0) return { peak: NaN, gain: (this.masterGain = base) };
    const offline = new OfflineAudioContext(1, frames, SR);
    build(offline, this.input.placed, this.buffers, this.input.automation, documentMixer, 1, 0, 0, this.input.span);
    const rendered = await offline.startRendering();
    if (ticket !== this.measuring) return { peak: NaN, gain: this.masterGain }; // a newer edit is being measured
    const data = rendered.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] as number));
    this.masterGain = peak * base > 0 ? dbToGain(peakDb) / peak : base;
    if (this.graph !== null) this.graph.master.gain.value = this.masterGain;
    return { peak, gain: this.masterGain };
  }

  get playing(): boolean {
    return this.graph !== null;
  }

  /** Seconds into the timeline. */
  time(): number {
    if (this.graph === null) return this.paused;
    return Math.min(this.input.span, this.from + Math.max(0, this.ctx.currentTime - this.origin));
  }

  async play(from = this.paused, onEnd?: () => void): Promise<void> {
    this.stop();
    await this.ctx.resume();
    this.from = Math.max(0, Math.min(from, this.input.span));
    this.origin = this.ctx.currentTime + 0.05;
    this.graph = build(this.ctx, this.input.placed, this.buffers, this.input.automation, this.mixer, this.masterGain, this.from, this.origin, this.input.span);
    this.onEnd = onEnd ?? null;
    this.endTimer = setTimeout(() => {
      this.paused = this.input.span;
      this.stop();
      this.onEnd?.();
    }, (this.input.span - this.from + 0.1) * 1000);
  }

  pause(): void {
    this.paused = this.time();
    this.stop();
  }

  /** Moves the playhead; playing carries on from there. */
  async seek(t: number): Promise<void> {
    const was = this.playing;
    this.paused = Math.max(0, Math.min(t, this.input.span));
    if (was) await this.play(this.paused, this.onEnd ?? undefined);
  }

  /**
   * An edited mix (AGT-1769): the clips, automation and length to play from now on. While playing, everything is
   * rescheduled from the current playhead, so an edit is heard at once with no re-render; the decoded buffers
   * stay (an edit never adds a source: a split is two clips over one).
   */
  update(input: EngineInput): void {
    this.input = input;
    this.paused = Math.min(this.paused, input.span);
    if (this.graph !== null) void this.play(this.time(), this.onEnd ?? undefined);
  }

  /** Live volume/mute/solo: ramps each track's gain, no rescheduling. */
  setMixer(mixer: Mixer): void {
    this.mixer = mixer;
    if (this.graph === null) return;
    for (const name of TRACK_ORDER) this.graph.tracks[name].gain.gain.setTargetAtTime(trackGain(mixer, name), this.ctx.currentTime, 0.015);
  }

  private stop(): void {
    if (this.endTimer !== undefined) clearTimeout(this.endTimer);
    this.endTimer = undefined;
    if (this.graph === null) return;
    for (const node of this.graph.sources) {
      try {
        node.stop();
      } catch {
        /* never started */
      }
      node.disconnect();
    }
    this.graph.master.disconnect();
    this.graph = null;
  }

  close(): void {
    this.stop();
    void this.ctx.close();
  }
}
