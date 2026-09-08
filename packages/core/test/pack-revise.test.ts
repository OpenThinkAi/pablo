import { expect, test } from "bun:test";
import { assemblePack, hashPrompt, PACK_BUDGETS, REVISE_CLOSING } from "../src/index";
import type { ReviseInputs, TextSource } from "../src/index";

/**
 * `assemblePack("revise", ...)` (AGT-1257): rewrite one located passage in
 * place. `packages/cli` (AGT-1264) is what turns a document, a `locatePassage`
 * span and a slice of manuscript around it into these inputs — this file only
 * pins core's deterministic half, the same split `pack-prose.test.ts` and
 * `pack-prose-revise.test.ts` already use for `prose`.
 */
const STYLE: TextSource[] = [{ path: "style/prose.md", text: "Short sentences. Concrete nouns." }];
const WORK_RULES: TextSource = { path: "QWEN.md", text: "Napa Valley, 1962. Third person past tense." };
const BEFORE = "The valley kept its own time.";
const PASSAGE = "Frost came early that year, and the vines paid for it.";
const AFTER = "Nobody spoke of the harvest again.";
const INSTRUCTION = "Make it shorter and cut the second clause.";

function inputs(overrides: Partial<ReviseInputs> = {}): ReviseInputs {
  return {
    style: STYLE,
    workRules: WORK_RULES,
    before: BEFORE,
    passage: PASSAGE,
    after: AFTER,
    instruction: INSTRUCTION,
    ...overrides,
  };
}

test("a revise pack orders rules -> before -> passage -> after -> instruction -> closing", () => {
  const pack = assemblePack("revise", inputs());

  expect(pack.kind).toBe("revise");
  expect(pack.slices.map((slice) => slice.name)).toEqual([
    "rules",
    "before",
    "passage",
    "after",
    "instruction",
    "closing",
  ]);
  expect(pack.budgetTokens).toBe(PACK_BUDGETS.revise);
  expect(PACK_BUDGETS.revise).toBe(2000);
  expect(pack.withinBudget).toBe(true);

  expect(pack.prompt).toContain(PASSAGE);
  expect(pack.prompt).toContain(REVISE_CLOSING);
});

test("rules combines style and this work's own rules into one slice", () => {
  const pack = assemblePack("revise", inputs());

  const rules = pack.slices.find((slice) => slice.name === "rules");
  expect(rules?.text).toContain("Short sentences");
  expect(rules?.text).toContain("Napa Valley, 1962");
});

test("a work with no rules file still assembles, with only the style in the rules slice", () => {
  const pack = assemblePack("revise", inputs({ workRules: undefined }));

  const rules = pack.slices.find((slice) => slice.name === "rules");
  expect(rules?.text).toBe("Short sentences. Concrete nouns.");
  expect(pack.slices.map((slice) => slice.name)).toEqual(["rules", "before", "passage", "after", "instruction", "closing"]);
});

test("renderPack's prompt contains the passage verbatim (AC3)", () => {
  const pack = assemblePack("revise", inputs());

  expect(pack.prompt).toContain(PASSAGE);
});

test("a small budget cuts before first, after second, and never touches passage/instruction/closing", () => {
  const longBefore = "before ".repeat(3000);
  const longAfter = "after ".repeat(3000);

  const pack = assemblePack(
    "revise",
    inputs({ before: longBefore, after: longAfter }),
    { budgetTokens: 700 },
  );

  expect(pack.withinBudget).toBe(true);
  const names = pack.adjustments.map((a) => a.name);
  expect(names).toContain("before");
  expect(names).toContain("after");

  // rules carries the 400-token floor and is never dropped outright.
  expect(pack.slices.some((slice) => slice.name === "rules")).toBe(true);

  // passage, instruction and closing are non-reducible: never touched by the budget.
  expect(pack.slices.find((slice) => slice.name === "passage")?.text).toBe(PASSAGE);
  expect(pack.slices.find((slice) => slice.name === "instruction")?.text).toBe(INSTRUCTION);
  expect(pack.slices.find((slice) => slice.name === "closing")?.text).toBe(REVISE_CLOSING);
  expect(pack.adjustments.some((a) => a.name === "passage")).toBe(false);
  expect(pack.adjustments.some((a) => a.name === "instruction")).toBe(false);
  expect(pack.adjustments.some((a) => a.name === "closing")).toBe(false);
});

test("at the default 2,000-token budget, a long before/after is cut while passage/instruction/closing survive untouched", () => {
  const longBefore = "before ".repeat(3000);
  const longAfter = "after ".repeat(3000);

  const pack = assemblePack("revise", inputs({ before: longBefore, after: longAfter }));

  expect(pack.budgetTokens).toBe(2000);
  expect(pack.withinBudget).toBe(true);

  const names = pack.adjustments.map((a) => a.name);
  expect(names).toContain("before");
  expect(names).toContain("after");

  expect(pack.slices.find((slice) => slice.name === "passage")?.text).toBe(PASSAGE);
  expect(pack.slices.find((slice) => slice.name === "instruction")?.text).toBe(INSTRUCTION);
  expect(pack.slices.find((slice) => slice.name === "closing")?.text).toBe(REVISE_CLOSING);
  expect(pack.adjustments.some((a) => a.name === "passage")).toBe(false);
  expect(pack.adjustments.some((a) => a.name === "instruction")).toBe(false);
  expect(pack.adjustments.some((a) => a.name === "closing")).toBe(false);

  // rules keeps its 400-token floor rather than being dropped outright.
  const rules = pack.slices.find((slice) => slice.name === "rules");
  expect(rules).toBeDefined();
  expect(rules?.tokens).toBeGreaterThan(0);
});

test("a pack built from a realistic-sized chapter neighbourhood fits under the new budget (AC2)", () => {
  // A "paragraph either side" window the way `neighbourParagraphs` (packages/cli/src/revise.ts)
  // actually hands `assemblePack` — a few hundred words of manuscript, not a whole chapter.
  const realisticBefore = "The valley kept its own time, and the frost came before anyone was ready for it. ".repeat(40);
  const realisticAfter = "Nobody spoke of the harvest again, not even at the table where it mattered most. ".repeat(40);
  const realisticPassage =
    "Frost came early that year, and the vines paid for it. The pickers worked through the night, hands numb, " +
    "carrying what they could before the sun made it worse.";

  const pack = assemblePack(
    "revise",
    inputs({ before: realisticBefore, after: realisticAfter, passage: realisticPassage }),
  );

  expect(pack.totalTokens).toBeLessThanOrEqual(PACK_BUDGETS.revise);
  expect(pack.withinBudget).toBe(true);
  expect(pack.prompt).toContain(realisticPassage);
});

test("assembly is deterministic: the same inputs give the same hash on two calls", () => {
  const first = assemblePack("revise", inputs());
  const second = assemblePack("revise", inputs());

  expect(second.prompt).toBe(first.prompt);
  expect(second.hash).toBe(first.hash);
  expect(first.hash).toBe(hashPrompt(first.prompt));
  expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
});

test("a different instruction changes the hash", () => {
  const base = assemblePack("revise", inputs());
  const changed = assemblePack("revise", inputs({ instruction: "A completely different instruction." }));

  expect(changed.hash).not.toBe(base.hash);
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
    assemblePack("revise", inputs());
  } finally {
    globalThis.fetch = saved;
  }
  expect(calls).toEqual([]);
});
