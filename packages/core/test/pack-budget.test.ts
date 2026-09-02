import { expect, test } from "bun:test";
import { assemblePack, PACK_BUDGETS, TRUNCATION_MARKER } from "../src/index";
import type { Document, SpanEditInputs, TextSource } from "../src/index";

const filler = (word: string, times: number): string => Array.from({ length: times }, () => word).join(" ");

const STYLE: TextSource[] = [{ path: "style/prose.md", text: filler("rule", 400) }];

function bigDocument(): Document {
  return {
    path: "novels/ice-house/chapters/01-the-last-full-cut.md",
    text: [filler("before", 2000), "the selected paragraph", filler("after", 2000)].join("\n\n"),
  };
}

function inputs(document: Document): SpanEditInputs {
  const start = document.text.indexOf("the selected paragraph");
  return {
    document,
    span: { start, end: start + "the selected paragraph".length },
    instruction: "tighten it",
    style: STYLE,
    workRules: { path: "novels/ice-house/QWEN.md", text: filler("work", 300) },
  };
}

test("a pack under budget reports no adjustments", () => {
  const pack = assemblePack("spanEdit", inputs(bigDocument()));

  expect(pack.totalTokens).toBeLessThanOrEqual(PACK_BUDGETS.spanEdit);
  expect(pack.withinBudget).toBe(true);
  expect(pack.adjustments).toEqual([]);
  expect(pack.prompt).not.toContain(TRUNCATION_MARKER);
});

test("over budget, the pack says which slice was cut and by how much", () => {
  const pack = assemblePack("spanEdit", inputs(bigDocument()), { budgetTokens: 1_200 });

  expect(pack.totalTokens).toBeLessThanOrEqual(1_200);
  expect(pack.withinBudget).toBe(true);
  expect(pack.adjustments.length).toBeGreaterThan(0);

  for (const adjustment of pack.adjustments) {
    expect(adjustment.droppedTokens).toBe(adjustment.beforeTokens - adjustment.afterTokens);
    expect(adjustment.droppedTokens).toBeGreaterThan(0);
  }

  // Every token that left the pack is accounted for by an adjustment: nothing
  // disappears silently.
  const unfitted = assemblePack("spanEdit", inputs(bigDocument()), { budgetTokens: 1_000_000 });
  const cut = pack.adjustments.reduce((sum, adjustment) => sum + adjustment.droppedTokens, 0);
  expect(unfitted.totalTokens - pack.totalTokens).toBe(cut);
});

test("the passage after the selection is cut before the passage before it, and the rules go last", () => {
  const order: string[] = [];
  for (const budget of [4_000, 2_000, 1_100, 600, 400]) {
    const pack = assemblePack("spanEdit", inputs(bigDocument()), { budgetTokens: budget });
    for (const adjustment of pack.adjustments) {
      if (!order.includes(adjustment.name)) order.push(adjustment.name);
    }
  }

  expect(order).toEqual(["after", "before", "workRules", "style"]);
});

test("a truncated slice is marked in the prompt, and a dropped one leaves the pack", () => {
  const pack = assemblePack("spanEdit", inputs(bigDocument()), { budgetTokens: 700 });

  const truncated = pack.adjustments.filter((adjustment) => adjustment.action === "truncated");
  const dropped = pack.adjustments.filter((adjustment) => adjustment.action === "dropped");
  expect(truncated.length + dropped.length).toBe(pack.adjustments.length);
  if (truncated.length > 0) expect(pack.prompt).toContain(TRUNCATION_MARKER);
  for (const adjustment of dropped) {
    expect(pack.slices.map((slice) => slice.name)).not.toContain(adjustment.name);
    expect(adjustment.afterTokens).toBe(0);
  }
});

test("the ask itself is never cut, however tight the budget", () => {
  const pack = assemblePack("spanEdit", inputs(bigDocument()), { budgetTokens: 50 });

  const names = pack.slices.map((slice) => slice.name);
  expect(names).toContain("passage");
  expect(names).toContain("instruction");
  expect(names).toContain("closing");
  expect(pack.prompt).toContain("the selected paragraph");
  expect(pack.prompt).toContain("tighten it");
  // A budget that cannot hold the ask is over budget, and says so, rather than
  // dropping the ask to make the number look right.
  expect(pack.withinBudget).toBe(false);
});

test("truncation keeps the end of the text nearest the selection", () => {
  const document: Document = {
    path: "novels/ice-house/chapters/01-the-last-full-cut.md",
    text: ["FIRST", filler("middle", 3000), "LAST", "the selected paragraph"].join("\n\n"),
  };
  const pack = assemblePack("spanEdit", inputs(document), { budgetTokens: 2_000 });
  const before = pack.slices.find((slice) => slice.name === "before");

  expect(before?.text).toContain("LAST");
  expect(before?.text.startsWith(TRUNCATION_MARKER)).toBe(true);
});
