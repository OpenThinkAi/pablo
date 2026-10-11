// Shared mix maths (AGT-1765), the preview twin of packages/casting/src/pablo_casting/mixmath.py.
// The spec is in that file's docstring; both are tested against
// packages/casting/tests/fixtures/mixmath-golden.json within 1e-4. Pure functions, no DOM,
// so the mixer view can import it and the tests can run it under bun.

export type FadeCurve = "linear" | "scurve" | "log" | "exp";
export const CURVES: readonly FadeCurve[] = ["linear", "scurve", "log", "exp"];

export type AutomationPoint = { t: number; db: number; curve?: FadeCurve };

export function dbToGain(db: number): number {
  if (db === -Infinity) return 0;
  return 10 ** (db / 20);
}

export function gainToDb(gain: number): number {
  if (gain <= 0) return -Infinity;
  return 20 * Math.log10(gain);
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Gain (0 -> 1) at fade progress x, clamped to [0, 1]. */
export function fadeCurve(curve: FadeCurve, x: number): number {
  const p = clamp01(x);
  switch (curve) {
    case "linear":
      return p;
    case "scurve":
      return p * p * (3 - 2 * p);
    case "log":
      return Math.log10(1 + 9 * p);
    case "exp":
      return (10 ** p - 1) / 9;
    default:
      throw new Error(`unknown fade curve: ${String(curve)}`);
  }
}

export function fadeInGain(curve: FadeCurve, length: number, t: number): number {
  if (length <= 0) return 1;
  return fadeCurve(curve, t / length);
}

/** `t` is seconds since the fade-out began. */
export function fadeOutGain(curve: FadeCurve, length: number, t: number): number {
  if (length <= 0) return 1;
  return fadeCurve(curve, 1 - t / length);
}

/** A copy of `buffer` with a `length`-sample fade at its start ("in") or end ("out"). */
export function applyFade(buffer: Float32Array, curve: FadeCurve, length: number, direction: "in" | "out"): Float32Array {
  if (direction !== "in" && direction !== "out") throw new Error(`direction must be 'in' or 'out', got ${String(direction)}`);
  const out = Float32Array.from(buffer);
  const n = Math.min(Math.floor(length), out.length);
  if (n <= 0) return out;
  const base = direction === "in" ? 0 : out.length - n;
  for (let j = 0; j < n; j++) {
    const g = fadeCurve(curve, direction === "in" ? j / length : 1 - j / length);
    out[base + j] = (out[base + j] as number) * g;
  }
  return out;
}

/** `[outgoing, incoming]` gains at crossfade progress x in [0, 1]. */
export function equalPowerCrossfade(x: number): [number, number] {
  const p = clamp01(x);
  return [Math.cos((p * Math.PI) / 2), Math.sin((p * Math.PI) / 2)];
}

export function automationDbAt(points: readonly AutomationPoint[], t: number): number {
  const pts = [...points].sort((a, b) => a.t - b.t); // stable: equal t keeps input order
  const first = pts[0];
  if (!first) return 0;
  if (t < first.t) return first.db;
  let k = 0;
  for (let i = 0; i < pts.length; i++) if ((pts[i] as AutomationPoint).t <= t) k = i;
  const a = pts[k] as AutomationPoint;
  const b = pts[k + 1];
  if (!b) return a.db;
  const x = (t - a.t) / (b.t - a.t);
  return a.db + (b.db - a.db) * fadeCurve(a.curve ?? "linear", x);
}

export function automationGainAt(points: readonly AutomationPoint[], t: number): number {
  return dbToGain(automationDbAt(points, t));
}

/** Linear gain per frame for `frames` frames starting at `start` seconds. */
export function sampleAutomation(points: readonly AutomationPoint[], sampleRate: number, frames: number, start = 0): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = automationGainAt(points, start + i / sampleRate);
  return out;
}
