/**
 * Frame-cost bench for AC1: "a 200k-token file scrolls without dropped frames".
 *
 * Run it:
 *
 *   bun packages/tui/test/manuscript-bench.ts [tokens]
 *
 * It generates the manuscript into a temp file (never into the repo), parses
 * it once the way `pablo <file>` does, and then times the two things a frame
 * costs: laying out a screen at a cold anchor, and the scroll loop with the
 * warm line cache the view actually runs with. A frame budget at 60fps is
 * 16.7ms; the numbers here are the layout half of that.
 *
 * It is not a `.test.ts` on purpose — wall-clock thresholds do not belong in a
 * test suite. `layout-scale.test.ts` asserts the same property without a clock,
 * by counting the characters a frame wraps.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLineCache, layoutWindow } from "../src/layout";
import { applyAction, initialState, viewportOf } from "../src/view-state";
import { loadManuscript } from "../src/source";
import { generateManuscript } from "./fixtures/manuscript";

const TOKENS = Number(process.argv[2] ?? 200_000);
const WIDTH = 96;
const HEIGHT = 44;

function ms(start: number): number {
  return Number((performance.now() - start).toFixed(3));
}

function quantile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[at] ?? 0;
}

function report(label: string, samples: readonly number[]): void {
  const total = samples.reduce((sum, value) => sum + value, 0);
  console.log(
    `${label.padEnd(34)} n=${String(samples.length).padStart(5)}  ` +
      `p50 ${quantile(samples, 0.5).toFixed(3)}ms  ` +
      `p95 ${quantile(samples, 0.95).toFixed(3)}ms  ` +
      `max ${Math.max(...samples).toFixed(3)}ms  ` +
      `mean ${(total / samples.length).toFixed(3)}ms`,
  );
}

const directory = mkdtempSync(join(tmpdir(), "pablo-bench-"));
const path = join(directory, "manuscript.md");

try {
  const generated = performance.now();
  const text = generateManuscript({ tokens: TOKENS });
  writeFileSync(path, text, "utf8");
  console.log(
    `generated ${TOKENS.toLocaleString()} tokens: ${text.length.toLocaleString()} chars, ` +
      `${text.split(/\s+/).length.toLocaleString()} words, in ${ms(generated)}ms`,
  );

  const opened = performance.now();
  const manuscript = loadManuscript(path);
  const openMs = ms(opened);
  console.log(
    `open (read + parse)               ${openMs.toFixed(1)}ms  ` +
      `${manuscript.model.blocks.length.toLocaleString()} blocks, ` +
      `${manuscript.model.marks.length.toLocaleString()} marks`,
  );

  const state = initialState(manuscript, { width: WIDTH, height: HEIGHT });
  const blocks = manuscript.model.blocks.length;

  // Cold: a fresh cache at a random anchor, which is the worst case — a jump.
  const cold: number[] = [];
  for (let sample = 0; sample < 200; sample += 1) {
    const anchor = { blockIndex: Math.floor((sample / 200) * blocks), line: 0 };
    const cache = createLineCache();
    const started = performance.now();
    layoutWindow(manuscript.model, { ...viewportOf(state), anchor }, cache);
    cold.push(ms(started));
  }
  report("layout, cold cache, random jump", cold);

  // Warm: the scroll loop the view runs — one action, one frame, one cache.
  const cache = createLineCache();
  let scrolling = state;
  const warm: number[] = [];
  for (let frame = 0; frame < 2000; frame += 1) {
    const started = performance.now();
    scrolling = applyAction(scrolling, "scrollDown", cache);
    layoutWindow(scrolling.model, viewportOf(scrolling), cache);
    warm.push(ms(started));
  }
  report("scroll one line + frame (warm)", warm);

  const paging: number[] = [];
  let paged = state;
  for (let frame = 0; frame < 200; frame += 1) {
    const started = performance.now();
    paged = applyAction(paged, "pageDown", cache);
    layoutWindow(paged.model, viewportOf(paged), cache);
    paging.push(ms(started));
  }
  report("page down + frame (warm)", paging);

  const selecting: number[] = [];
  let selected = state;
  for (let frame = 0; frame < 500; frame += 1) {
    const started = performance.now();
    selected = applyAction(selected, "next", cache);
    layoutWindow(selected.model, viewportOf(selected), cache);
    selecting.push(ms(started));
  }
  report("select next paragraph + frame", selecting);

  const expanding: number[] = [];
  let expanded = state;
  for (let frame = 0; frame < 200; frame += 1) {
    const started = performance.now();
    expanded = applyAction(expanded, frame % 2 === 0 ? "expand" : "shrink", cache);
    layoutWindow(expanded.model, viewportOf(expanded), cache);
    expanding.push(ms(started));
  }
  report("expand/shrink + frame", expanding);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
