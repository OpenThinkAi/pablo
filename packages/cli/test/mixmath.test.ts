import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CURVES,
  applyFade,
  automationDbAt,
  automationGainAt,
  dbToGain,
  equalPowerCrossfade,
  fadeCurve,
  fadeInGain,
  fadeOutGain,
  gainToDb,
  sampleAutomation,
} from "../views/mixmath";
import type { AutomationPoint, FadeCurve } from "../views/mixmath";

// The same file the Python suite reads (packages/casting/tests/test_mixmath.py).
const G = JSON.parse(readFileSync(join(import.meta.dir, "../../casting/tests/fixtures/mixmath-golden.json"), "utf8"));
const TOL: number = G.tolerance;
const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(TOL);

test("golden: dB <-> gain", () => {
  for (const r of G.db) close(dbToGain(r.db), r.gain);
  for (const r of G.gain_to_db) close(gainToDb(r.gain), r.db);
  expect(dbToGain(-Infinity)).toBe(0);
  expect(gainToDb(0)).toBe(-Infinity);
});

test("golden: every fade curve", () => {
  expect(Object.keys(G.curves).sort()).toEqual([...CURVES].sort());
  for (const c of CURVES) for (const r of G.curves[c]) close(fadeCurve(c, r.x), r.gain);
  for (const r of G.fade_in) close(fadeInGain(r.curve as FadeCurve, r.length, r.t), r.gain);
  for (const r of G.fade_out) close(fadeOutGain(r.curve as FadeCurve, r.length, r.t), r.gain);
});

test("golden: buffer fades", () => {
  for (const r of G.buffer_fades) {
    const out = applyFade(Float32Array.from(r.input), r.curve, r.length, r.direction);
    expect(out.length).toBe(r.output.length);
    out.forEach((v, i) => close(v, r.output[i]));
  }
});

test("golden: equal-power crossfade", () => {
  for (const r of G.crossfade) {
    const [o, i] = equalPowerCrossfade(r.x);
    close(o, r.out);
    close(i, r.in);
    close(o * o + i * i, 1);
  }
});

test("golden: automation envelope at a time and over a buffer", () => {
  const pts: AutomationPoint[] = G.automation.points;
  for (const r of G.automation.samples) {
    close(automationDbAt(pts, r.t), r.db);
    close(automationGainAt(pts, r.t), r.gain);
  }
  const b = G.automation.buffer;
  const out = sampleAutomation(pts, b.sample_rate, b.frames, b.start);
  expect(out.length).toBe(b.gains.length);
  out.forEach((v, i) => close(v, b.gains[i]));
});

test("edges: no fade at length 0, unknown curve throws, empty automation is 0 dB", () => {
  expect(fadeInGain("exp", 0, 0)).toBe(1);
  expect(() => fadeCurve("nope" as FadeCurve, 0.5)).toThrow();
  expect(automationDbAt([], 3)).toBe(0);
});
