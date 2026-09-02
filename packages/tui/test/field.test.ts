import { expect, test } from "bun:test";
import { backspace, deleteForward, fieldRows, insertInto, moveCaret, openField, toLineEdge } from "../src/field";

/**
 * The field is the only text entry pablo has, and it is deliberately small.
 * These tests pin the small: what it opens with, where the caret lands, and
 * that a long value wraps rather than running off the row.
 */

test("a prompt field opens empty and on one line; a manual field opens on the span (AC1, AC2)", () => {
  const prompt = openField("prompt", "");
  expect(prompt.multiline).toBe(false);
  expect(prompt.value).toBe("");
  expect(prompt.hint).toContain("enter");

  const manual = openField("manual", "The cellar was cold.");
  expect(manual.multiline).toBe(true);
  expect(manual.value).toBe("The cellar was cold.");
  expect(manual.cursor).toBe("The cellar was cold.".length);
  expect(manual.hint).toContain("ctrl+s");
});

test("typing, deleting and moving the caret all act at the caret", () => {
  let field = insertInto(openField("prompt", ""), "tighten");
  expect(field.value).toBe("tighten");

  field = moveCaret(field, -1);
  field = insertInto(field, "!");
  expect(field.value).toBe("tighte!n");
  expect(field.cursor).toBe(7);

  field = backspace(field);
  expect(field.value).toBe("tighten");
  field = deleteForward(field);
  expect(field.value).toBe("tighte");

  expect(moveCaret(openField("prompt", ""), -1).cursor).toBe(0);
});

test("home and end move within the caret's own line, not the whole value", () => {
  const field = openField("manual", "first line\nsecond line");
  expect(toLineEdge(field, "start").cursor).toBe("first line\n".length);
  expect(toLineEdge(field, "end").cursor).toBe(field.value.length);

  const onFirst = { ...field, cursor: 3 };
  expect(toLineEdge(onFirst, "start").cursor).toBe(0);
  expect(toLineEdge(onFirst, "end").cursor).toBe("first line".length);
});

test("the value wraps to the field's width and the caret keeps its row", () => {
  const field = { ...openField("manual", "abcdefghij"), cursor: 7 };
  const { rows, caret } = fieldRows(field, 4);

  expect(rows).toEqual(["abcd", "efgh", "ij"]);
  expect(caret).toEqual({ row: 1, column: 3 });
});

test("an empty field is still one row, so the box does not collapse", () => {
  const { rows, caret } = fieldRows(openField("prompt", ""), 20);
  expect(rows).toEqual([""]);
  expect(caret).toEqual({ row: 0, column: 0 });
});

test("a newline in a manual edit starts a row, and the caret follows it", () => {
  const field = insertInto(openField("manual", "one"), "\n");
  const { rows, caret } = fieldRows(field, 20);
  expect(rows).toEqual(["one", ""]);
  expect(caret).toEqual({ row: 1, column: 0 });
});
