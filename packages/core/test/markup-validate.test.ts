import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, validateProposal } from "../src/index";

const FIXTURES = fileURLToPath(new URL("./fixtures/criticmarkup", import.meta.url));

test("well-formed CriticMarkup is a conforming answer", () => {
  expect(validateProposal("He poured the {~~diesel~>gasoline~~} into the can.")).toEqual({ ok: true });
  expect(validateProposal("{++ It always was.++}{--was cold--}{>>note<<}{==span==}")).toEqual({ ok: true });
});

test("an answer with no markup at all proposes nothing", () => {
  const result = validateProposal("Here is my suggested rewrite of the paragraph you sent.");

  expect(result.ok).toBe(false);
  expect(result.ok ? [] : result.violations).toEqual([
    { position: 0, message: "no CriticMarkup marks: the answer proposes nothing" },
  ]);
});

test("a mangled substitution is caught by its stray separator", () => {
  const result = validateProposal("{++He poured the diesel ~> gasoline into the can.++}");

  expect(result.ok).toBe(false);
  expect(result.ok ? [] : result.violations).toEqual([{ position: 24, message: "~> outside a substitution" }]);
});

test("parser violations are reported with their positions", () => {
  const result = validateProposal("The door was open.{++ Nobody would admit it.");

  expect(result.ok).toBe(false);
  expect(result.ok ? [] : result.violations).toEqual([
    { position: 18, message: "unterminated addition mark" },
    { position: 0, message: "no CriticMarkup marks: the answer proposes nothing" },
  ].sort((a, b) => a.position - b.position));
});

test("a note is prose, so an arrow inside one is not a stray separator", () => {
  expect(validateProposal("{~~a{>>weigh a ~> b<<}~>c~~}")).toEqual({ ok: true });
});

test("every fixture that parses cleanly also validates", () => {
  const names = readdirSync(FIXTURES).filter((name) => name.endsWith(".md"));
  const clean = names.filter((name) => {
    const text = readFileSync(join(FIXTURES, name), "utf8");
    const model = parse(text);
    return model.violations.length === 0 && model.marks.length > 0;
  });

  expect(clean.length).toBeGreaterThan(15);
  for (const name of clean) {
    expect(validateProposal(readFileSync(join(FIXTURES, name), "utf8"))).toEqual({ ok: true });
  }
});
