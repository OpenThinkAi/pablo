import { expect, test } from "bun:test";
import { normalizeOutput, normalizeProposal } from "../src/index";
import type { Intent, Proposal } from "../src/index";

/**
 * The rules under test are the mechanical ones in `style/prose.md`:
 *
 *   "Straight quotes ("like this"), never curly. No em-dashes anywhere; use a
 *    comma, a period, or parentheses. Year ranges: "1920 to 1933", not "1920-1933"."
 *
 * and, from `style/anti-tells.md`, "Em-dashes, especially as a substitute for a
 * comma or a period" and "Curly quotes" as reasons to revise a draft.
 */

test("an em-dash becomes a comma", () => {
  expect(normalizeOutput("The pond rang under the horse—a long note.")).toBe(
    "The pond rang under the horse, a long note.",
  );
  expect(normalizeOutput("She wrote the time — then the weight.")).toBe("She wrote the time, then the weight.");
  expect(normalizeOutput("Four thousand ton―he said it twice.")).toBe("Four thousand ton, he said it twice.");
});

test("an en-dash becomes \"to\", which is what a year range wants", () => {
  expect(normalizeOutput("The trade held from 1920–1933.")).toBe("The trade held from 1920 to 1933.");
  expect(normalizeOutput("nine – eleven stops")).toBe("nine to eleven stops");
});

test("curly quotes and apostrophes become straight", () => {
  expect(normalizeOutput("“The instructions are clear.”")).toBe('"The instructions are clear."');
  expect(normalizeOutput("It was the clerk’s hand.")).toBe("It was the clerk's hand.");
  expect(normalizeOutput("‘Crystal,’ she said.")).toBe("'Crystal,' she said.");
});

test("a flagged line comes back clean", () => {
  // Flagged in `style/prose.md` under "Endings do not editorialize", here with
  // the two kinds of punctuation the local writer adds to it.
  const flagged =
    "“It was a careful dance they all performed—a quiet agreement to look the other way,” she wrote, 1929–1934.";

  expect(normalizeOutput(flagged)).toBe(
    '"It was a careful dance they all performed, a quiet agreement to look the other way," she wrote, 1929 to 1934.',
  );
});

test("trailing whitespace goes, on every line and at the end", () => {
  expect(normalizeOutput("first line   \nsecond line\t\n\nthird   \n\n  ")).toBe("first line\nsecond line\n\nthird");
});

test("a dash opening a line is dropped rather than turned into a leading comma", () => {
  expect(normalizeOutput("— Four thousand ton.\n— You'll fill her.")).toBe(
    "Four thousand ton.\nYou'll fill her.",
  );
});

test("a dash standing next to punctuation does not leave a seam", () => {
  expect(normalizeOutput("She set the poise,—and read the bar.")).toBe("She set the poise, and read the bar.");
  expect(normalizeOutput("He stopped—.")).toBe("He stopped.");
});

test("normalization is pure and idempotent", () => {
  const source = "“Four thousand ton—we fill her,” he said, 1929–1931.   ";
  const once = normalizeOutput(source);

  expect(normalizeOutput(once)).toBe(once);
  expect(normalizeOutput(source)).toBe(once);
  expect(once).not.toMatch(/[—―–“”‘’]/);
});

test("clean prose is left exactly as it is", () => {
  const clean = 'She wrote three hundred and four pounds in the green book.\n\n"Weigh it," Wilfred said.';
  expect(normalizeOutput(clean)).toBe(clean);
});

test("every variant of a proposal is normalized on its way to the review surface", () => {
  const intent: Intent = { name: "tighten", kind: "revising" };
  const proposal: Proposal = {
    span: { start: 0, end: 4 },
    variants: ["A—B", "“C”", "D 1920–1933"],
    intent,
    providerId: "local",
    model: "fake-writer",
  };

  const normalized = normalizeProposal(proposal);

  expect(normalized.variants).toEqual(["A, B", '"C"', "D 1920 to 1933"]);
  expect(normalized.span).toEqual(proposal.span);
  expect(normalized.model).toBe(proposal.model);
  expect(proposal.variants[0]).toBe("A—B");
});
