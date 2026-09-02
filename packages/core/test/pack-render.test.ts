import { expect, test } from "bun:test";
import { assemblePack, duration, estimateWait, packTimeoutMs, RateMeter, renderPack, thousands } from "../src/index";
import type { Document, SpanEditInputs } from "../src/index";

const document: Document = {
  path: "novels/ice-house/chapters/01-the-last-full-cut.md",
  text: ["The pond rang under the horse.", "The hoist chain took up.", "She wrote the number down."].join("\n\n"),
};

const inputs: SpanEditInputs = {
  document,
  span: { start: document.text.indexOf("The hoist"), end: document.text.indexOf("The hoist") + 24 },
  instruction: "cut this by a third",
  style: [{ path: "style/prose.md", text: "Straight quotes, never curly." }],
};

const pack = assemblePack("spanEdit", inputs);

test("the preview is the exact prompt, a per-slice table, and a summary", () => {
  const preview = renderPack(pack);

  expect(preview.prompt).toBe(pack.prompt);
  expect(preview.table).toContain("slice");
  expect(preview.table).toContain("tokens");
  for (const slice of pack.slices) expect(preview.table).toContain(slice.name);
  expect(preview.table).toContain("style/prose.md");
  expect(preview.table).toContain(`of ${thousands(pack.budgetTokens)} budget`);
  expect(preview.summary).toContain(`${thousands(pack.totalTokens)} of ${thousands(pack.budgetTokens)} tokens`);
  expect(preview.text.endsWith(pack.prompt)).toBe(true);
});

test("with no measured rates the preview says so instead of guessing", () => {
  const preview = renderPack(pack);

  expect(preview.wait).toBeUndefined();
  expect(preview.summary).toContain("Estimated wait: unknown");
  expect(estimateWait(pack, { promptTokensPerSecond: undefined, outputTokensPerSecond: undefined })).toBeUndefined();
});

test("the wait comes from the endpoint's measured rates", () => {
  const preview = renderPack(pack, { promptTokensPerSecond: 260, outputTokensPerSecond: 30 });

  expect(preview.wait).toBeDefined();
  expect(preview.wait?.prefillMs).toBeCloseTo((pack.totalTokens / 260) * 1000, 6);
  expect(preview.wait?.generateMs).toBeCloseTo((pack.expectedOutputTokens / 30) * 1000, 6);
  expect(preview.wait?.totalMs).toBeCloseTo((preview.wait?.prefillMs ?? 0) + (preview.wait?.generateMs ?? 0), 6);
  expect(preview.summary).toContain("reading");
  expect(preview.summary).toContain("writing");
});

test("a RateMeter's own rates drive the estimate, without the pack importing the registry", () => {
  const meter = new RateMeter();
  meter.record({
    timeToFirstTokenMs: 1000,
    elapsedMs: 3000,
    tokensRead: 260,
    tokensWritten: 60,
    tokensPerSecond: 30,
  });

  const wait = estimateWait(pack, meter.rates());

  expect(wait?.prefillMs).toBeCloseTo((pack.totalTokens / 260) * 1000, 6);
});

test("the table names every cut the budget took", () => {
  const long: Document = {
    path: document.path,
    text: [Array.from({ length: 3000 }, () => "before").join(" "), "the selected paragraph"].join("\n\n"),
  };
  const start = long.text.indexOf("the selected paragraph");
  const squeezed = assemblePack(
    "spanEdit",
    { ...inputs, document: long, span: { start, end: start + "the selected paragraph".length } },
    { budgetTokens: 600 },
  );
  const preview = renderPack(squeezed);

  expect(squeezed.adjustments.length).toBeGreaterThan(0);
  for (const adjustment of squeezed.adjustments) {
    expect(preview.text).toContain(adjustment.name);
    expect(preview.text).toMatch(new RegExp(`${adjustment.action === "dropped" ? "dropped" : "truncated"}:`));
  }
});

test("a pack sizes its own timeout, generously, until the endpoint has been measured", () => {
  // Before the meter has samples the adapter's first-byte timeout falls back to
  // its configured 60s, and a big pack is minutes of prefill that is work, not a
  // hang. So the callsite passes a timeout sized from the pack.
  const big = { ...pack, totalTokens: 37_000 };

  expect(packTimeoutMs(pack)).toBe(60_000);
  expect(packTimeoutMs(big)).toBeGreaterThan(60_000);
  expect(packTimeoutMs(big, { promptTokensPerSecond: 260, outputTokensPerSecond: 30 })).toBe(
    Math.ceil((37_000 / 260) * 2000),
  );
  // The floor is a floor, not a cap: a pack that needs longer gets longer.
  expect(packTimeoutMs(pack, undefined, 600_000)).toBe(600_000);
});

test("numbers and durations render the same everywhere", () => {
  expect(thousands(4888)).toBe("4,888");
  expect(thousands(37_000)).toBe("37,000");
  expect(thousands(7)).toBe("7");
  expect(duration(450)).toBe("450ms");
  expect(duration(19_000)).toBe("19s");
  expect(duration(69_000)).toBe("1m 09s");
});
