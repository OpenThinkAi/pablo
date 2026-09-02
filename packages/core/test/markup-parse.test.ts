import { expect, test } from "bun:test";
import { flattenMarks, parse, serialize, type Mark, type MarkupDocument } from "../src/index";

const at = (model: MarkupDocument, span: { start: number; end: number }): string =>
  model.text.slice(span.start, span.end);

const only = (model: MarkupDocument): Mark => {
  const [mark] = model.marks;
  if (mark === undefined) throw new Error("expected exactly one mark");
  return mark;
};

test("an addition is anchored to the text it adds", () => {
  const model = parse("The press was cold.{++ It always was.++}");
  const mark = only(model);

  expect(mark.kind).toBe("addition");
  expect(at(model, mark.span)).toBe("{++ It always was.++}");
  expect(at(model, mark.body)).toBe(" It always was.");
  expect(mark.replacement).toBeUndefined();
});

test("a deletion is anchored to the text it removes", () => {
  const model = parse("He waited {--a long time --}for the fog.");
  const mark = only(model);

  expect(mark.kind).toBe("deletion");
  expect(at(model, mark.body)).toBe("a long time ");
});

test("a substitution carries both halves of the proposal", () => {
  const model = parse("He poured the {~~diesel~>gasoline~~} into the can.");
  const mark = only(model);

  expect(mark.kind).toBe("substitution");
  expect(at(model, mark.body)).toBe("diesel");
  expect(mark.replacement === undefined ? null : at(model, mark.replacement)).toBe("gasoline");
});

test("a note and a highlight parse as their own kinds", () => {
  const model = parse("{==the hillside turned==}{>>check her age<<}");

  expect(model.marks.map((mark) => mark.kind)).toEqual(["highlight", "note"]);
  expect(at(model, model.marks[1]?.body ?? { start: 0, end: 0 })).toBe("check her age");
});

test("adjacent marks stay separate", () => {
  const model = parse("{++one++}{--two--}{~~three~>four~~}{>>five<<}{==six==}");

  expect(model.marks).toHaveLength(5);
  expect(model.marks.map((mark) => mark.kind)).toEqual([
    "addition",
    "deletion",
    "substitution",
    "note",
    "highlight",
  ]);
});

test("nested marks hang off their parent, in document order", () => {
  const model = parse("{==patience{>>the turn<<} until you {~~need~>needed~~} it==}");
  const mark = only(model);

  expect(mark.kind).toBe("highlight");
  expect(mark.children.map((child) => child.kind)).toEqual(["note", "substitution"]);
  expect(flattenMarks(model.marks).map((child) => child.kind)).toEqual([
    "highlight",
    "note",
    "substitution",
  ]);
});

test("a nested mark inside a substitution knows which half it is in", () => {
  const model = parse("{~~the {--old--} press~>the {++new++} press~~}");
  const mark = only(model);
  const [original, proposed] = mark.children;

  expect(original?.span.end).toBeLessThanOrEqual(mark.body.end);
  expect(proposed?.span.start).toBeGreaterThanOrEqual(mark.replacement?.start ?? -1);
  expect(serialize(model)).toBe("{~~the {--old--} press~>the {++new++} press~~}");
});

test("a substitution separator inside a nested mark is not the separator", () => {
  const model = parse("{~~a {>>not ~> this one<<} b~>c~~}");
  const mark = only(model);

  expect(at(model, mark.body)).toBe("a {>>not ~> this one<<} b");
  expect(mark.replacement === undefined ? null : at(model, mark.replacement)).toBe("c");
});

test("a mark may span a paragraph break", () => {
  const text = "{~~one\n\ntwo~>ONE\n\nTWO~~}\n";
  const model = parse(text);
  const mark = only(model);

  expect(at(model, mark.body)).toBe("one\n\ntwo");
  expect(model.blocks.filter((block) => block.kind === "paragraph")).toHaveLength(3);
  expect(serialize(model)).toBe(text);
});

test("an unterminated mark is reported with a position and does not throw", () => {
  const model = parse("The door was open.{++ Nobody would admit it.\n");

  expect(model.marks).toEqual([]);
  expect(model.violations).toEqual([{ position: 18, message: "unterminated addition mark" }]);
  expect(serialize(model)).toBe("The door was open.{++ Nobody would admit it.\n");
});

test("a mismatched closer abandons the inner mark and keeps the outer one", () => {
  const model = parse("{++key {--behind the frame ++}");
  const mark = only(model);

  expect(mark.kind).toBe("addition");
  expect(at(model, mark.body)).toBe("key {--behind the frame ");
  expect(model.violations).toEqual([{ position: 7, message: "unterminated deletion mark" }]);
});

test("marks inside an abandoned mark are kept, not lost", () => {
  const model = parse("{++a {-- b {>>note<<} c ++}");
  const mark = only(model);

  expect(mark.children.map((child) => child.kind)).toEqual(["note"]);
  expect(model.violations.map((violation) => violation.message)).toEqual(["unterminated deletion mark"]);
});

test("a closer with nothing open is reported and left as text", () => {
  const model = parse("The letter said very little. ++}It said nothing else.");

  expect(model.marks).toEqual([]);
  expect(model.violations).toEqual([{ position: 29, message: "unmatched addition closer" }]);
});

test("a substitution with no separator is reported and left as text", () => {
  const model = parse("The heat came {~~and stayed~~} early.");

  expect(model.marks).toEqual([]);
  expect(model.violations).toEqual([
    { position: 14, message: "substitution is missing its ~> separator" },
  ]);
  expect(serialize(model)).toBe("The heat came {~~and stayed~~} early.");
});

test("empty marks are well-formed, if pointless", () => {
  const model = parse("The road bent twice{++++} and ran straight{----}.{>><<}");

  expect(model.violations).toEqual([]);
  expect(model.marks.map((mark) => mark.kind)).toEqual(["addition", "deletion", "note"]);
  expect(model.marks.every((mark) => mark.body.start === mark.body.end)).toBe(true);
});

test("violations come back in position order", () => {
  const model = parse("++} then {~~no arrow~~} then {--open");

  expect(model.violations.map((violation) => violation.position)).toEqual([0, 9, 29]);
});

test("blocks name the structure structural selection needs", () => {
  const model = parse("---\ntitle: x\n---\n\n# One\n\nProse.\n\n* * *\n\n## Two\n\nMore.\n");
  const kinds = model.blocks.filter((block) => block.kind !== "blank").map((block) => block.kind);

  expect(kinds).toEqual(["frontmatter", "heading", "paragraph", "sceneBreak", "heading", "paragraph"]);

  const headings = model.blocks.filter((block) => block.kind === "heading");
  expect(headings.map((block) => block.level)).toEqual([1, 2]);
  expect(headings.map((block) => at(model, block.content ?? { start: 0, end: 0 }))).toEqual(["One", "Two"]);
});

test("a lone --- is a scene break, not frontmatter", () => {
  const model = parse("# One\n\nProse.\n\n---\n\nMore prose.\n");

  expect(model.blocks.some((block) => block.kind === "frontmatter")).toBe(false);
  expect(model.blocks.filter((block) => block.kind === "sceneBreak")).toHaveLength(1);
});

test("an empty document parses", () => {
  const model = parse("");

  expect(model.blocks).toEqual([]);
  expect(model.marks).toEqual([]);
  expect(serialize(model)).toBe("");
});
