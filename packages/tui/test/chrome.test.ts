import { expect, test } from "bun:test";
import { parse } from "@openthink/pablo-core";
import { briefLines, fieldLines, helpLines, overlayLines, statusSegments } from "../src/chrome";
import { openField } from "../src/field";
import { BINDINGS } from "../src/keymap";
import { frameText } from "../src/render";
import { CARET_GLYPH } from "../src/theme";
import { applyAction, initialState, type RunState, type ViewState } from "../src/view-state";

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

/** AGT-1204: the run, the receipt, the field and the dry-run page. */

function running(overrides: Partial<RunState> = {}): ViewState {
  return {
    ...state(),
    run: {
      phase: "sending",
      instruction: "tighten",
      providerId: "local",
      summary: "span edit pack: 6 slices, 1,203 of 10,000 tokens. Estimated wait: 5s total.",
      size: "1,203 tokens sent",
      elapsedMs: 4000,
      timeToFirstTokenMs: undefined,
      tokensWritten: 0,
      tokensPerSecond: undefined,
      error: undefined,
      ...overrides,
    },
  };
}

function statusText(view: ViewState): string {
  return statusSegments(view)
    .map((segment) => segment.text)
    .join("");
}

test("before a run the status carries the pack size, the estimate and a moving clock (AC6)", () => {
  const status = statusText({ ...running(), width: 200 });
  expect(status).toContain("waiting 4s");
  expect(status).toContain("span edit pack");
  expect(status).toContain("Estimated wait");
});

test("during a run the estimate gives way to the measurement (AC6)", () => {
  const status = statusText({
    ...running({ phase: "streaming", timeToFirstTokenMs: 1900, tokensPerSecond: 27.4, elapsedMs: 6000 }),
    width: 200,
  });

  expect(status).toContain("6s");
  expect(status).toContain("1,203 tokens sent");
  expect(status).toContain("first token 1.9s");
  expect(status).toContain("27 tok/s");
  expect(status).not.toContain("Estimated wait");
});

test("a failed run keeps the retry key even when the row has to be cut (AC5)", () => {
  const failed = running({
    phase: "failed",
    error: "pablo: the model at http://127.0.0.1:8002/v1 sent nothing for 60s (61s in total) — is the server running?",
  });

  expect(statusText({ ...failed, width: 200 })).toContain("R retries");
  // Narrow enough that the explanation cannot fit; the way out of it still does.
  expect(statusText({ ...failed, width: 40 })).toContain("R retries");
  for (const view of [failed, { ...failed, width: 40 }]) {
    const row = statusText(view);
    expect(row.length).toBeLessThanOrEqual(view.width);
  }
});

test("the receipt outlives the reload it paid for, and the position gives way to it (AC6)", () => {
  const after = { ...state(), width: 46, receipt: "read 4,900 tokens in 19s, wrote 1,500 in 50s" };
  const status = statusText(after);

  expect(status).toContain("read 4,900 tokens in 19s");
  expect(status.length).toBeLessThanOrEqual(46);
});

test("the field is drawn under the manuscript with its title, its text and its keys (AC1, AC2)", () => {
  const rows = frameText(fieldLines(openField("manual", "The cellar was cold."), 40));

  expect(rows).toContain("manual edit");
  expect(rows).toContain("The cellar was cold.");
  expect(rows).toContain("ctrl+s saves");
});

test("the dry-run page is the preview plus a way out (AC6)", () => {
  const rows = frameText(overlayLines({ title: "dry run — nothing was sent", lines: ["slice  tokens", "style  17"] }));

  expect(rows).toContain("dry run — nothing was sent");
  expect(rows).toContain("style  17");
  expect(rows).toContain("esc closes");
});

test("the help documents the field keys, which are a mode and not bindings", () => {
  const help = frameText(helpLines());

  expect(help).toContain("In a field");
  expect(help).toContain("save a manual edit");
  expect(help).toContain("Verbs on the selection");
});
