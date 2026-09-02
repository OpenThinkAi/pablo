import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "@openthink/pablo-core";
import { createLineCache, layoutWindow } from "../src/layout";
import { frameText } from "../src/render";
import { CARET_GLYPH } from "../src/theme";
import type { Manuscript } from "../src/source";
import { applyAction, initialState, reloaded, stepUnit, unitAt, viewportOf } from "../src/view-state";

const FIXTURES = fileURLToPath(new URL("../../core/test/fixtures/criticmarkup/", import.meta.url));

function manuscript(text: string, path = "/tmp/chapter.md"): Manuscript {
  return { doc: { path, text }, model: parse(text) };
}

function fixture(name: string): Manuscript {
  return manuscript(readFileSync(`${FIXTURES}${name}`, "utf8"), `${FIXTURES}${name}`);
}

const SIZE = { width: 60, height: 24 };

function open(source: Manuscript = fixture("01-clean-chapter.md")) {
  return { state: initialState(source, SIZE), cache: createLineCache() };
}

test("a selection exists the moment the view opens, and it is a paragraph (AC3)", () => {
  const { state } = open();

  expect(state.selection.granularity).toBe("paragraph");
  expect(state.selection.span.end).toBeGreaterThan(state.selection.span.start);
  expect(state.running).toBe(true);
});

test("expand walks sentence → paragraph → scene → chapter and stops there (AC3)", () => {
  const { state, cache } = open(fixture("14-scene-breaks-asterisks.md"));

  let ladder = applyAction(state, "shrink", cache);
  expect(ladder.selection.granularity).toBe("sentence");

  const seen: string[] = [];
  for (let step = 0; step < 4; step += 1) {
    ladder = applyAction(ladder, "expand", cache);
    seen.push(ladder.selection.granularity);
  }
  expect(seen).toEqual(["paragraph", "scene", "chapter", "chapter"]);
});

test("shrink walks back down and character is the floor (AC3)", () => {
  const { state, cache } = open(fixture("14-scene-breaks-asterisks.md"));

  let ladder = applyAction(applyAction(state, "expand", cache), "expand", cache);
  expect(ladder.selection.granularity).toBe("chapter");

  const seen: string[] = [];
  for (let step = 0; step < 5; step += 1) {
    ladder = applyAction(ladder, "shrink", cache);
    seen.push(ladder.selection.granularity);
  }
  expect(seen).toEqual(["scene", "paragraph", "sentence", "character", "character"]);
});

test("an expanded selection always contains the one it grew from", () => {
  const { state, cache } = open();
  const wider = applyAction(state, "expand", cache);

  expect(wider.selection.span.start).toBeLessThanOrEqual(state.selection.span.start);
  expect(wider.selection.span.end).toBeGreaterThanOrEqual(state.selection.span.end);
});

test("next and previous move a whole unit and come back", () => {
  const { state, cache } = open();

  const second = applyAction(state, "next", cache);
  expect(second.selection.span.start).toBeGreaterThan(state.selection.span.start);

  const back = applyAction(second, "previous", cache);
  expect(back.selection.span).toEqual(state.selection.span);
});

test("character-level adjustment is the fallback (AC3)", () => {
  const { state, cache } = open();

  const nudged = applyAction(applyAction(state, "endForward", cache), "startForward", cache);
  expect(nudged.selection.granularity).toBe("character");
  expect(nudged.selection.span.start).toBe(state.selection.span.start + 1);
  expect(nudged.selection.span.end).toBe(state.selection.span.end + 1);

  // At character granularity, `next` is one character.
  const stepped = applyAction(nudged, "next", cache);
  expect(stepped.selection.span.start).toBe(nudged.selection.span.start + 1);
});

test("an edge never crosses the other edge", () => {
  const { state, cache } = open();
  let squeezed = { ...state };
  for (let step = 0; step < 400; step += 1) squeezed = applyAction(squeezed, "startForward", cache);

  expect(squeezed.selection.span.start).toBe(squeezed.selection.span.end);
  expect(squeezed.selection.span.start).toBeLessThanOrEqual(state.selection.span.end);
});

test("a zero-width selection at a block boundary is reachable and drawn (AC3)", () => {
  const { state, cache } = open();
  const boundary = applyAction(state, "collapseEnd", cache);

  expect(boundary.selection.span.start).toBe(boundary.selection.span.end);
  expect(boundary.selection.span.start).toBe(state.selection.span.end);

  const drawn = frameText(layoutWindow(boundary.model, viewportOf(boundary), cache));
  expect(drawn).toContain(CARET_GLYPH);

  // And it is a real selection: the ladder still works from it.
  const grown = applyAction(boundary, "expand", cache);
  expect(grown.selection.span.end).toBeGreaterThan(grown.selection.span.start);
});

test("the selection is scrolled back into view when it moves off screen", () => {
  const source = fixture("26-long-substitution.md");
  const { state, cache } = open(source);
  const small = { ...state, height: 3 };

  let walked = small;
  for (let step = 0; step < 6; step += 1) walked = applyAction(walked, "next", cache);

  const offset = walked.selection.span.start;
  const visible = layoutWindow(walked.model, viewportOf(walked), cache).some(
    (line) => offset >= line.span.start && offset <= line.span.end,
  );
  expect(visible).toBe(true);
});

test("scrolling stops at the end instead of running off it", () => {
  const { state, cache } = open();
  let scrolled = { ...state, height: 5 };
  for (let step = 0; step < 500; step += 1) scrolled = applyAction(scrolled, "scrollDown", cache);

  expect(layoutWindow(scrolled.model, viewportOf(scrolled), cache).length).toBe(5);
});

test("a reload keeps the cursor position (AC4)", () => {
  const before = manuscript("# One\n\nAlpha beta gamma.\n\nDelta epsilon zeta.\n");
  const { state, cache } = open(before);
  const moved = applyAction(state, "next", cache);

  const after = reloaded(moved, manuscript("# One\n\nAlpha beta gamma!\n\nDelta epsilon zeta.\n"), cache);

  expect(after.selection.span).toEqual(moved.selection.span);
  expect(after.selection.granularity).toBe(moved.selection.granularity);
  expect(after.doc.text).toContain("gamma!");
  expect(after.message).toBe("reloaded from disk");
});

test("a reload clamps the selection when the file shrank (AC4)", () => {
  const before = manuscript("# One\n\nAlpha beta gamma.\n\nDelta epsilon zeta.\n");
  const { state, cache } = open(before);
  const moved = applyAction(state, "next", cache);
  expect(moved.selection.span.end).toBeGreaterThan(10);

  const shrunk = manuscript("# One\n");
  const after = reloaded(moved, shrunk, cache);

  expect(after.selection.span.start).toBeLessThanOrEqual(shrunk.doc.text.length);
  expect(after.selection.span.end).toBeLessThanOrEqual(shrunk.doc.text.length);
  expect(after.selection.span.start).toBeLessThanOrEqual(after.selection.span.end);
  expect(after.anchor.blockIndex).toBeLessThan(after.model.blocks.length);

  // And the view still draws: an out-of-bounds span would throw in the core.
  expect(() => layoutWindow(after.model, viewportOf(after), cache)).not.toThrow();
});

test("quit is the only thing that clears `running`", () => {
  const { state, cache } = open();
  expect(applyAction(state, "quit", cache).running).toBe(false);
  expect(applyAction(state, "next", cache).running).toBe(true);
});

test("an unknown action is ignored rather than thrown", () => {
  const { state, cache } = open();
  expect(applyAction(state, "conjure", cache)).toBe(state);
});

test("unitAt lands on the unit around an offset, and stepUnit walks them in order", () => {
  const source = manuscript("# One\n\nAlpha beta.\n\nGamma delta.\n\nEpsilon zeta.\n");
  const paragraph = unitAt(source.model, 10, "paragraph");
  expect(source.doc.text.slice(paragraph.span.start, paragraph.span.end)).toBe("Alpha beta.");

  const next = stepUnit(source.model, paragraph, 1);
  expect(source.doc.text.slice(next.span.start, next.span.end)).toBe("Gamma delta.");

  const back = stepUnit(source.model, next, -1);
  expect(back.span).toEqual(paragraph.span);
});
