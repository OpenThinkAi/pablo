import { expect, test } from "bun:test";
import { classify, hasEscapedNewlines, hasExtraProse, isTruncated, lostQuotes } from "./classify";
import { countWords, parseSpan } from "./spans";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SPANS = fileURLToPath(new URL("./spans", import.meta.url));

const passage = [
  'He put the lamp down. "You\'ll wear it through," Tom said.',
  "",
  "She did not turn around.",
].join("\n");

test("a literal backslash-n is an escaped newline; a real one is not", () => {
  expect(hasEscapedNewlines("He put the lamp down.\\n\\nShe did not turn.")).toBe(true);
  expect(hasEscapedNewlines("He put the lamp down.\n\nShe did not turn.")).toBe(false);
  expect(hasEscapedNewlines("a tab\\there")).toBe(true);
});

test("quotes are lost when the passage had them and the answer has none, or has them escaped", () => {
  expect(lostQuotes(passage, "He put the lamp down. You will wear it through, Tom said.")).toBe(true);
  expect(lostQuotes(passage, 'He put the lamp down. \\"You will wear it through,\\" Tom said.')).toBe(true);
  expect(lostQuotes(passage, 'He put the lamp down. "You will wear it through," Tom said.')).toBe(false);
  expect(lostQuotes("A passage with no quotation marks in it at all.", "Nor does the answer.")).toBe(false);
});

test("truncation is a missing terminal stop or a fraction of the passage", () => {
  expect(isTruncated(passage, "He put the lamp down and then he")).toBe(true);
  expect(isTruncated(passage, "")).toBe(true);
  expect(isTruncated(passage, "He stopped.")).toBe(true);
  expect(isTruncated(passage, 'He put the lamp down and did not look at her. "Enough," he said.')).toBe(false);
  expect(isTruncated(passage, "He put the lamp down and left the room without looking at her at all…")).toBe(false);
  expect(isTruncated(passage, 'He put the lamp down and left the room without looking at her once.")')).toBe(false);
});

test("extra prose is any chat wrapping around the replacement", () => {
  expect(hasExtraProse("Here is a tighter version of the passage. He put the lamp down.")).toBe(true);
  expect(hasExtraProse("Sure! He put the lamp down.")).toBe(true);
  expect(hasExtraProse("```\nHe put the lamp down.\n```")).toBe(true);
  expect(hasExtraProse("He put the lamp down.\n\nNote: I kept the tide times.")).toBe(true);
  expect(hasExtraProse("He put the lamp down. Let me know if you want it shorter.")).toBe(true);
  expect(hasExtraProse("He put the lamp down and did not look at her again.")).toBe(false);
});

test("a clean answer falls into no class at all", () => {
  expect(classify({ passage, replacement: 'He set the lamp down. "You\'ll wear it through," Tom said.', raw: "" })).toEqual([]);
});

test("classes are reported together, in a stable order", () => {
  const mangled = 'Here is the rewrite:\\n\\nHe set the lamp down and then he';
  expect(classify({ passage, replacement: mangled, raw: mangled })).toEqual([
    "escaped-newlines",
    "lost-quotes",
    "truncated",
    "extra-prose",
  ]);
});

test("with nothing decoded, the raw answer is what gets classified", () => {
  expect(classify({ passage, replacement: undefined, raw: "Sure! Here is the JSON:" })).toContain("extra-prose");
});

test("a fixture parses into a document with the markers gone and the span addressing the passage", () => {
  const fixture = parseSpan(join(SPANS, "01-lighthouse.md"));

  expect(fixture.id).toBe("01-lighthouse");
  expect(fixture.instruction).toContain("Nan does");
  expect(fixture.document.text).not.toContain("<<<span");
  expect(fixture.document.text).not.toContain("span>>>");
  expect(fixture.document.text.slice(fixture.span.start, fixture.span.end)).toBe(fixture.passage);
  expect(fixture.passage).toContain("eighty-two steps");
  expect(fixture.document.text).toContain("The light had been automatic");
  expect(fixture.words).toBe(countWords(fixture.passage));
});
