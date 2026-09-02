import { expect, test } from "bun:test";
import { isWithin, selectionText, type Document } from "../src/index";

const doc: Document = { path: "/tmp/chapter-01.md", text: "The valley kept its own time." };

test("a span selects the text it addresses", () => {
  expect(selectionText(doc, { start: 4, end: 10 })).toBe("valley");
});

test("an empty span is a legal insertion point", () => {
  expect(isWithin(doc, { start: 4, end: 4 })).toBe(true);
  expect(selectionText(doc, { start: 4, end: 4 })).toBe("");
});

test("a span ending exactly at the end of the text is in bounds", () => {
  expect(isWithin(doc, { start: 0, end: doc.text.length })).toBe(true);
});

test("out-of-bounds and inverted spans are rejected", () => {
  expect(isWithin(doc, { start: 0, end: doc.text.length + 1 })).toBe(false);
  expect(isWithin(doc, { start: 10, end: 4 })).toBe(false);
  expect(isWithin(doc, { start: -1, end: 4 })).toBe(false);
  expect(isWithin(doc, { start: 0.5, end: 4 })).toBe(false);
});

test("selecting an out-of-bounds span names the document and its length", () => {
  expect(() => selectionText(doc, { start: 0, end: 999 })).toThrow(
    /\/tmp\/chapter-01\.md \(29 characters\)/,
  );
});
