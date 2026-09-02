import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { flattenMarks, parse, resolveAll, serialize } from "../src/index";

/**
 * The round-trip corpus. Proposals live inline in the manuscript, so a parser
 * that loses a byte loses the author's prose — every fixture here has to come
 * back out of `serialize` exactly as it went in, malformed ones included.
 */

const FIXTURES = fileURLToPath(new URL("./fixtures/criticmarkup", import.meta.url));

const names = readdirSync(FIXTURES).filter((name) => name.endsWith(".md")).sort();
const read = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

test("the corpus is big enough to mean something", () => {
  expect(names.length).toBeGreaterThanOrEqual(20);
});

test("the corpus covers every shape the parser has to survive", () => {
  const corpus = names.map(read);
  const kinds = new Set(corpus.flatMap((text) => flattenMarks(parse(text).marks)).map((mark) => mark.kind));

  expect([...kinds].sort()).toEqual(["addition", "deletion", "highlight", "note", "substitution"]);
  expect(corpus.some((text) => parse(text).marks.length === 0 && parse(text).violations.length === 0)).toBe(
    true,
  );
  expect(corpus.some((text) => parse(text).marks.some((mark) => mark.children.length > 0))).toBe(true);
  expect(corpus.some((text) => parse(text).violations.length > 0)).toBe(true);
  expect(
    corpus.some((text) => {
      const model = parse(text);
      return model.marks.some((mark) =>
        model.blocks.some((block) => block.span.start > mark.span.start && block.span.start < mark.span.end),
      );
    }),
  ).toBe(true);
});

for (const name of names) {
  test(`${name} round-trips byte for byte`, () => {
    const text = read(name);
    expect(serialize(parse(text))).toBe(text);
  });

  test(`${name} is tiled by its blocks`, () => {
    const model = parse(read(name));
    expect(model.blocks.map((block) => model.text.slice(block.span.start, block.span.end)).join("")).toBe(
      model.text,
    );
    for (const [index, block] of model.blocks.entries()) {
      expect(block.span.start).toBe(model.blocks[index - 1]?.span.end ?? 0);
      expect(block.span.end).toBeGreaterThan(block.span.start);
    }
    expect(model.blocks[model.blocks.length - 1]?.span.end).toBe(model.text.length);
  });

  test(`${name} resolves to plain prose`, () => {
    const model = parse(read(name));
    if (model.violations.length > 0) return;

    for (const decision of ["accept", "reject"] as const) {
      const plain = resolveAll({ path: `/tmp/${name}`, text: model.text }, decision);
      expect(parse(plain.text).marks).toEqual([]);
      expect(parse(plain.text).violations).toEqual([]);
    }
  });
}
