import { expect, test } from "bun:test";
import { assemblePack, hashPrompt, PACK_BUDGETS } from "../src/index";
import type { ProseInputs, TextSource } from "../src/index";

const RULES: TextSource[] = [{ path: "voices/plain/voice.md", text: "Short sentences. No greeting, no sign-off." }];

const EXEMPLARS: TextSource[] = [
  { path: "voices/plain/exemplars/2026-09-02-ice-delivery-change.md", text: "Ice delivery moves to Thursdays." },
  { path: "voices/plain/exemplars/2026-08-01-scale-house-hours.md", text: "Scale house open 6am to 2pm." },
];

const BRIEF: TextSource = { path: "brief.md", text: "Announce the new dock hours." };

function inputs(overrides: Partial<ProseInputs> = {}): ProseInputs {
  return {
    voice: { rules: RULES, exemplars: EXEMPLARS },
    context: [],
    brief: BRIEF,
    ...overrides,
  };
}

test("a prose pack orders rules -> exemplars -> never -> format -> context -> brief -> closing", () => {
  const pack = assemblePack("prose", {
    voice: { rules: RULES, exemplars: EXEMPLARS, never: { path: "voices/plain/never.md", text: "Never apologize." } },
    format: "Write this as an email.",
    context: [
      { path: "thread.md", text: "The previous email in the thread." },
      { path: "product.md", text: "The product page." },
    ],
    brief: BRIEF,
  });

  expect(pack.kind).toBe("prose");
  expect(pack.slices.map((slice) => slice.name)).toEqual([
    "rules",
    "exemplars",
    "never",
    "format",
    "context-0",
    "context-1",
    "brief",
    "closing",
  ]);
  expect(pack.budgetTokens).toBe(PACK_BUDGETS.prose);
  expect(pack.withinBudget).toBe(true);

  const context0 = pack.slices.find((slice) => slice.name === "context-0");
  expect(context0?.source).toBe("thread.md");
  expect(context0?.text).toBe("The previous email in the thread.");
  const context1 = pack.slices.find((slice) => slice.name === "context-1");
  expect(context1?.source).toBe("product.md");

  const exemplars = pack.slices.find((slice) => slice.name === "exemplars");
  // Newest first, as given.
  expect(exemplars?.text.indexOf("Ice delivery")).toBeLessThan(exemplars?.text.indexOf("Scale house") ?? -1);

  expect(pack.prompt).toContain("Announce the new dock hours");
  expect(pack.prompt).toContain("Write this as an email");
  expect(pack.prompt).toContain("No preamble, no markup, no commentary");
});

test("a voice with no exemplars, no never.md, and no format or context still assembles (only what's present shows up)", () => {
  const pack = assemblePack("prose", inputs({ voice: { rules: RULES, exemplars: [] } }));

  expect(pack.slices.map((slice) => slice.name)).toEqual(["rules", "brief", "closing"]);
});

test("assembly is deterministic: same inputs, same bytes, same hash (AC3)", () => {
  const first = assemblePack("prose", inputs());
  const second = assemblePack("prose", inputs());

  expect(second.prompt).toBe(first.prompt);
  expect(second.hash).toBe(first.hash);
  expect(first.hash).toBe(hashPrompt(first.prompt));
  expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
});

test("a different brief is a different hash; a different voice/context/format also changes it", () => {
  const base = assemblePack("prose", inputs());

  expect(assemblePack("prose", inputs({ brief: { path: "brief.md", text: "A different ask." } })).hash).not.toBe(base.hash);
  expect(assemblePack("prose", inputs({ voice: { rules: [{ path: "v.md", text: "Different rules." }], exemplars: [] } })).hash).not.toBe(
    base.hash,
  );
  expect(assemblePack("prose", inputs({ format: "Write this as a reply." })).hash).not.toBe(base.hash);
  expect(assemblePack("prose", inputs({ context: [{ path: "c.md", text: "Some context." }] })).hash).not.toBe(base.hash);
});

test("expectedOutputTokens follows wordTarget (or the 300-word default) at drafting's words-to-tokens ratio", () => {
  const withDefault = assemblePack("prose", inputs());
  const withTarget = assemblePack("prose", inputs({ wordTarget: 100 }));

  expect(withDefault.expectedOutputTokens).toBe(Math.ceil(300 * 2.2));
  expect(withTarget.expectedOutputTokens).toBe(Math.ceil(100 * 2.2));
});

test("a budget squeeze truncates or drops the reducible slices and records a SliceAdjustment, never silently", () => {
  const longExemplars: TextSource[] = [{ path: "voices/plain/exemplars/long.md", text: "word ".repeat(6000) }];
  const pack = assemblePack("prose", inputs({ voice: { rules: RULES, exemplars: longExemplars } }), { budgetTokens: 600 });

  expect(pack.withinBudget).toBe(true);
  expect(pack.adjustments.length).toBeGreaterThan(0);
  const exemplarsAdjustment = pack.adjustments.find((a) => a.name === "exemplars");
  expect(exemplarsAdjustment).toBeDefined();
  expect(["truncated", "dropped"]).toContain(exemplarsAdjustment?.action ?? "");

  // rules is required (a 400-token floor) and reducible, but never dropped
  // outright — it always survives as a present slice.
  expect(pack.slices.some((slice) => slice.name === "rules")).toBe(true);
  // brief and closing are non-reducible: never touched by the budget.
  expect(pack.slices.find((slice) => slice.name === "brief")?.text).toBe(BRIEF.text);
});

test("assembly touches no model and no clock", () => {
  const calls: string[] = [];
  const noNetwork = ((input: unknown) => {
    calls.push(String(input));
    throw new Error("assembly must not reach the network");
  }) as unknown as typeof fetch;

  const saved = globalThis.fetch;
  globalThis.fetch = noNetwork;
  try {
    assemblePack("prose", inputs());
  } finally {
    globalThis.fetch = saved;
  }
  expect(calls).toEqual([]);
});
