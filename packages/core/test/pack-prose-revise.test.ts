import { expect, test } from "bun:test";
import { assemblePack, PACK_BUDGETS, PROSE_CLOSING, PROSE_REVISE_CLOSING } from "../src/index";
import type { ProseInputs, TextSource } from "../src/index";

/**
 * `assemblePack("prose", ...)`'s revise loop (AGT-1244): `draft` +
 * `instruction` add two slices before `closing` and switch the closing
 * directive to `PROSE_REVISE_CLOSING`. `packages/cli/src/prose.ts` is what
 * actually reads `--draft`/strips its frontmatter/refuses a lone flag — this
 * file only pins core's deterministic half, the same split `pack-prose.test.ts`
 * already uses for the non-revise pack.
 */
const RULES: TextSource[] = [{ path: "voices/plain/voice.md", text: "Short sentences. No greeting, no sign-off." }];
const BRIEF: TextSource = { path: "brief.md", text: "Announce the new dock hours." };
const DRAFT: TextSource = { path: "prev.md", text: "The dock opens at seven starting Monday." };
const INSTRUCTION = "Shorter. Drop the second paragraph.";

function inputs(overrides: Partial<ProseInputs> = {}): ProseInputs {
  return {
    voice: { rules: RULES, exemplars: [] },
    context: [],
    brief: BRIEF,
    ...overrides,
  };
}

test("draft + instruction add two slices, in order, right before the closing", () => {
  const pack = assemblePack("prose", inputs({ draft: DRAFT, instruction: INSTRUCTION }));

  expect(pack.slices.map((slice) => slice.name)).toEqual(["rules", "brief", "draft", "instruction", "closing"]);
  const draftSlice = pack.slices.find((slice) => slice.name === "draft");
  expect(draftSlice?.text).toBe(DRAFT.text);
  expect(draftSlice?.source).toBe(DRAFT.path);
  const instructionSlice = pack.slices.find((slice) => slice.name === "instruction");
  expect(instructionSlice?.text).toBe(INSTRUCTION);
});

test("draft + instruction switch the closing to PROSE_REVISE_CLOSING; a bare brief keeps PROSE_CLOSING", () => {
  const revise = assemblePack("prose", inputs({ draft: DRAFT, instruction: INSTRUCTION }));
  const plain = assemblePack("prose", inputs());

  expect(revise.prompt).toContain(PROSE_REVISE_CLOSING);
  expect(plain.prompt).toContain(PROSE_CLOSING);
  expect(plain.prompt).not.toContain("Write the complete rewritten piece");
});

test("a draft with no instruction (or the reverse) never switches the closing, even though the lone slice still renders", () => {
  // `assembleProse` (packages/cli/src/prose.ts) is what actually refuses this
  // combination (AC2) before it ever reaches core — this module just never
  // trusts that from the outside, so a lone `draft` or `instruction` renders
  // as an ordinary (non-reducible-for-instruction, reducible-for-draft) slice
  // rather than switching to the revise closing on a half-built input.
  const draftOnly = assemblePack("prose", inputs({ draft: DRAFT }));
  expect(draftOnly.slices.map((slice) => slice.name)).toEqual(["rules", "brief", "draft", "closing"]);
  expect(draftOnly.prompt).toContain(PROSE_CLOSING);
  expect(draftOnly.prompt).not.toContain("Write the complete rewritten piece");

  const instructionOnly = assemblePack("prose", inputs({ instruction: INSTRUCTION }));
  expect(instructionOnly.slices.map((slice) => slice.name)).toEqual(["rules", "brief", "instruction", "closing"]);
  expect(instructionOnly.prompt).toContain(PROSE_CLOSING);
  expect(instructionOnly.prompt).not.toContain("Write the complete rewritten piece");
});

test("assembly is deterministic: the same draft/instruction give the same hash on two runs (AC4)", () => {
  const first = assemblePack("prose", inputs({ draft: DRAFT, instruction: INSTRUCTION }));
  const second = assemblePack("prose", inputs({ draft: DRAFT, instruction: INSTRUCTION }));

  expect(second.prompt).toBe(first.prompt);
  expect(second.hash).toBe(first.hash);
});

test("a different draft or instruction changes the hash", () => {
  const base = assemblePack("prose", inputs({ draft: DRAFT, instruction: INSTRUCTION }));

  expect(assemblePack("prose", inputs({ draft: { path: "prev.md", text: "Different previous text." }, instruction: INSTRUCTION })).hash).not.toBe(
    base.hash,
  );
  expect(assemblePack("prose", inputs({ draft: DRAFT, instruction: "A different instruction." })).hash).not.toBe(base.hash);
});

test("budget: the draft is the first slice to truncate after exemplars, before rules gives up its floor", () => {
  const longExemplars: TextSource[] = [{ path: "voices/plain/exemplars/long.md", text: "word ".repeat(3000) }];
  const longDraft: TextSource = { path: "prev.md", text: "word ".repeat(3000) };

  const pack = assemblePack(
    "prose",
    inputs({ voice: { rules: RULES, exemplars: longExemplars }, draft: longDraft, instruction: INSTRUCTION }),
    { budgetTokens: 700 },
  );

  expect(pack.withinBudget).toBe(true);
  const names = pack.adjustments.map((a) => a.name);
  expect(names).toContain("exemplars");
  expect(names).toContain("draft");
  // rules carries the 400-token floor and is never dropped outright.
  expect(pack.slices.some((slice) => slice.name === "rules")).toBe(true);
  // instruction and closing are non-reducible: never touched by the budget.
  expect(pack.slices.find((slice) => slice.name === "instruction")?.text).toBe(INSTRUCTION);
});
