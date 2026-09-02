import { expect, test } from "bun:test";
import { parse } from "@openthink/pablo-core";
import { briefLines, helpLines, statusSegments } from "../src/chrome";
import { BINDINGS } from "../src/keymap";
import { frameText } from "../src/render";
import { CARET_GLYPH } from "../src/theme";
import { applyAction, initialState } from "../src/view-state";

const text = "# One\n\nAlpha beta gamma.\n\nDelta epsilon zeta.\n";
const manuscript = { doc: { path: "/tmp/chapter-01.md", text }, model: parse(text) };

function state() {
  return initialState(manuscript, { width: 60, height: 12 });
}

test("the status line names the file, the granularity and the position", () => {
  const status = statusSegments(state())
    .map((segment) => segment.text)
    .join("");

  expect(status).toContain("chapter-01.md");
  expect(status).toContain("paragraph");
  expect(status).toContain("%");
  expect(status).toContain("? keys");
});

test("a zero-width selection is called out in the status line (AC3)", () => {
  const status = statusSegments(applyAction(state(), "collapseEnd"))
    .map((segment) => segment.text)
    .join("");

  expect(status).toContain(CARET_GLYPH);
  expect(status).toContain("boundary at");
});

test("a message replaces nothing and is shown alongside the position", () => {
  const status = statusSegments({ ...state(), message: "reloaded from disk" })
    .map((segment) => segment.text)
    .join("");

  expect(status).toContain("reloaded from disk");
  expect(status).toContain("paragraph");
});

test("the help screen documents every binding (AC5)", () => {
  const help = frameText(helpLines());

  for (const binding of BINDINGS) {
    expect(help).toContain(binding.label);
    for (const chord of binding.chords) expect(help).toContain(chord);
  }
  expect(help).toContain("No action needs a function key or a number key.");
});

test("the brief screen renders like the help screen, and says where it came from", () => {
  const brief = briefLines(
    { open: true, offset: 0, status: "ready", slug: "ice-house", text: "── repo lessons ──\nthe cellar is cold" },
    60,
  );
  const shown = frameText(brief);

  expect(shown).toContain("pablo — brief: ice-house");
  expect(shown).toContain("the cellar is cold");
  expect(shown).toContain("think brief --cortex writing --context ice-house");
  expect(shown).toContain("never written into the manuscript.");
});

test("the brief screen wraps to the terminal rather than running off it", () => {
  const brief = briefLines(
    { open: true, offset: 0, status: "ready", slug: "ice-house", text: "word ".repeat(60).trim() },
    40,
  );

  for (const line of brief) {
    expect(line.segments.reduce((total, segment) => total + segment.text.length, 0)).toBeLessThanOrEqual(40);
  }
  expect(brief.length).toBeGreaterThan(6);
});

test("a brief that is not ready says why instead of showing an empty pane (AC3)", () => {
  const shown = frameText(
    briefLines({ open: true, offset: 0, status: "unavailable", slug: "ice-house", notice: "think is not on PATH" }),
  );

  expect(shown).toContain("think is not on PATH");
});

test("the status line names the brief while its pane is open (AC2)", () => {
  const status = statusSegments({
    ...state(),
    brief: { open: true, offset: 0, status: "ready", slug: "ice-house", text: "x" },
  })
    .map((segment) => segment.text)
    .join("");

  expect(status).toContain("brief");
  expect(status).toContain("ice-house");
  expect(status).toContain("esc to close");
});
