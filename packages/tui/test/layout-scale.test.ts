import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLineCache, layoutWindow, type LayoutStats } from "../src/layout";
import { loadManuscript } from "../src/source";
import { applyAction, initialState, viewportOf } from "../src/view-state";
import { generateManuscript } from "./fixtures/manuscript";

/**
 * AC1 is a claim about cost: a 200k-token file must lay out like a small one.
 *
 * The claim is asserted by counting the characters a frame wraps, not by timing
 * it — a clock in a test suite is a flake, and the count is the thing that
 * actually has to stay bounded. `manuscript-bench.ts` produces the wall-clock
 * numbers for the ticket.
 */

const directory = mkdtempSync(join(tmpdir(), "pablo-scale-"));
const path = join(directory, "manuscript.md");
writeFileSync(path, generateManuscript({ tokens: 200_000 }), "utf8");

afterAll(() => rmSync(directory, { recursive: true, force: true }));

const manuscript = loadManuscript(path);
const WIDTH = 96;
const HEIGHT = 44;

test("the generated manuscript really is book-sized", () => {
  expect(manuscript.doc.text.length).toBeGreaterThan(700_000);
  expect(manuscript.model.blocks.length).toBeGreaterThan(2_000);
  expect(manuscript.model.marks.length).toBeGreaterThan(100);
});

test("a frame lays out the visible window and nothing else (AC1)", () => {
  const blocks = manuscript.model.blocks.length;
  const state = initialState(manuscript, { width: WIDTH, height: HEIGHT });

  for (const fraction of [0, 0.25, 0.5, 0.75, 0.99]) {
    const stats: LayoutStats = { blocksWrapped: 0, charactersWrapped: 0 };
    const lines = layoutWindow(
      manuscript.model,
      { ...viewportOf(state), anchor: { blockIndex: Math.floor(blocks * fraction), line: 0 } },
      createLineCache(),
      stats,
    );

    // A screen holds at most HEIGHT rows, so a frame can never need more than
    // HEIGHT blocks — and a block is a paragraph, not a chapter.
    expect(stats.blocksWrapped).toBeLessThanOrEqual(HEIGHT + 1);
    expect(stats.charactersWrapped).toBeLessThan(40_000);
    if (fraction < 0.9) expect(lines.length).toBe(HEIGHT);
  }
});

test("scrolling a screen costs a screen, however far in you are", () => {
  const cache = createLineCache();
  let state = initialState(manuscript, { width: WIDTH, height: HEIGHT });
  for (let jump = 0; jump < 60; jump += 1) state = applyAction(state, "pageDown", cache);

  const stats: LayoutStats = { blocksWrapped: 0, charactersWrapped: 0 };
  state = applyAction(state, "scrollDown", cache);
  layoutWindow(manuscript.model, viewportOf(state), cache, stats);

  expect(state.anchor.blockIndex).toBeGreaterThan(100);
  expect(stats.blocksWrapped).toBeLessThanOrEqual(HEIGHT + 1);
  expect(stats.charactersWrapped).toBeLessThan(40_000);
});
