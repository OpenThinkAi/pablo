/**
 * Plays a chapter that is still being performed (AGT-1697, `pablo perform --stream`): asks the host for its
 * segments as they are cut (`loadSegments`), decodes each and lays it on the Web Audio clock right after the
 * last, so the chapter plays without gaps while its later lines are still with the engine. Browser-only (it
 * needs `AudioContext`); the scheduling arithmetic is `review-logic.ts`'s, tested there.
 */

import { scheduleSegment, streamPosition } from "./review-logic";
import { STREAM_POLL_MS } from "./review-protocol";
import type { SegmentsPayload } from "./review-protocol";

export type FetchSegments = (episode: number, from: number) => Promise<SegmentsPayload>;

function bytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export class SegmentStream {
  private readonly ctx = new AudioContext();
  private readonly gain: GainNode;
  private next = 0;
  private origin: number | null = null;
  private queued: { readonly start: number; readonly buffer: AudioBuffer }[] = [];
  private readonly sources: AudioBufferSourceNode[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private complete = false;
  /** Seconds of the chapter decoded so far. */
  private decoded = 0;
  /** Seconds of the chapter laid on the clock so far. */
  private scheduled = 0;

  constructor(
    private readonly episode: number,
    private readonly fetch: FetchSegments,
    private readonly onUpdate: (payload: SegmentsPayload) => void,
    private readonly onError: (error: unknown) => void,
    volume: number,
  ) {
    this.gain = this.ctx.createGain();
    this.gain.gain.value = volume;
    this.gain.connect(this.ctx.destination);
    void this.poll();
  }

  private async poll(): Promise<void> {
    if (this.closed) return;
    let again = STREAM_POLL_MS;
    try {
      const payload = await this.fetch(this.episode, this.next);
      for (const segment of payload.segments) {
        const buffer = await this.ctx.decodeAudioData(bytes(segment.b64));
        if (this.closed) return;
        this.queued.push({ start: segment.start, buffer });
        this.next = segment.n + 1;
        this.decoded = segment.start + segment.seconds;
      }
      this.complete = payload.complete && this.next >= payload.available;
      this.onUpdate(payload);
      if (this.origin !== null) this.lay();
      if (this.next < payload.available) again = 0;
      else if (this.complete) return;
    } catch (error) {
      this.onError(error);
    }
    if (!this.closed) this.timer = setTimeout(() => void this.poll(), again);
  }

  /** Lays every decoded segment on the clock after the one before it. */
  private lay(): void {
    for (const { start, buffer } of this.queued) {
      const placed = scheduleSegment(this.origin as number, start, this.ctx.currentTime);
      this.origin = placed.origin;
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain);
      source.start(placed.at);
      this.sources.push(source);
      this.scheduled = start + buffer.duration;
    }
    this.queued = [];
  }

  async play(): Promise<void> {
    await this.ctx.resume();
    if (this.origin === null) this.origin = this.ctx.currentTime + 0.1;
    this.lay();
  }

  pause(): void {
    void this.ctx.suspend();
  }

  get playing(): boolean {
    return this.origin !== null && this.ctx.state === "running";
  }

  /** Seconds into the chapter. */
  time(): number {
    return streamPosition(this.origin, this.ctx.currentTime, this.scheduled);
  }

  /** Every segment is cut, laid and played. */
  ended(): boolean {
    return this.complete && this.origin !== null && this.queued.length === 0 && this.ctx.currentTime - this.origin >= this.decoded;
  }

  set volume(value: number) {
    this.gain.gain.value = value;
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        /* never started */
      }
    }
    void this.ctx.close();
  }
}
