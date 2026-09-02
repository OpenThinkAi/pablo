import { expect, test } from "bun:test";
import type { Document } from "@openthink/pablo-core";
import { styledSelection } from "../src/render";

const doc: Document = { path: "/tmp/chapter-01.md", text: "The valley kept its own time." };

test("a selection splits the text into before, selected, after", () => {
  const chunks = styledSelection(doc, { start: 4, end: 10 }).chunks;

  expect(chunks.map((chunk) => chunk.text)).toEqual(["The ", "valley", " kept its own time."]);
  expect(chunks[1]?.attributes).toBeGreaterThan(0);
  expect(chunks[0]?.attributes ?? 0).toBe(0);
});

test("an empty selection produces no styled chunk", () => {
  const chunks = styledSelection(doc, { start: 0, end: 0 }).chunks;

  expect(chunks.map((chunk) => chunk.text)).toEqual([doc.text]);
});

test("selecting the whole document produces one styled chunk", () => {
  const chunks = styledSelection(doc, { start: 0, end: doc.text.length }).chunks;

  expect(chunks.map((chunk) => chunk.text)).toEqual([doc.text]);
  expect(chunks[0]?.attributes).toBeGreaterThan(0);
});

test("an out-of-bounds span is rejected by the core, not silently clamped", () => {
  expect(() => styledSelection(doc, { start: 0, end: 999 })).toThrow(RangeError);
});
