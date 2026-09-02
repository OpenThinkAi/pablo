import { expect, test } from "bun:test";
import {
  expand,
  insertAt,
  parse,
  replaceSpan,
  resolveAll,
  resolveMark,
  shrink,
  type Document,
  type Granularity,
  type Mark,
  type Selection,
} from "../src/index";

const CHAPTERS = `# One

The first paragraph. It has two sentences.

* * *

A second scene. Mrs. Ferrante said nothing.

# Two

The second chapter opens here.
`;

const doc = (text: string): Document => ({ path: "/tmp/chapter.md", text });

const firstMark = (text: string): Mark => {
  const [mark] = parse(text).marks;
  if (mark === undefined) throw new Error("expected a mark");
  return mark;
};

const spanOf = (text: string, needle: string): { start: number; end: number } => {
  const start = text.indexOf(needle);
  if (start === -1) throw new Error(`no ${needle}`);
  return { start, end: start + needle.length };
};

const selected = (text: string, selection: Selection): string =>
  text.slice(selection.span.start, selection.span.end);

const ladder = (text: string, from: Selection, steps: number): Selection => {
  const model = parse(text);
  let selection = from;
  for (let step = 0; step < steps; step += 1) selection = expand(model, selection);
  return selection;
};

test("replaceSpan swaps the selected text and leaves the rest alone", () => {
  const before = doc("He poured the diesel into the can.");

  expect(replaceSpan(before, spanOf(before.text, "diesel"), "gasoline").text).toBe(
    "He poured the gasoline into the can.",
  );
  expect(before.text).toBe("He poured the diesel into the can.");
});

test("replaceSpan refuses a span that does not address the document", () => {
  expect(() => replaceSpan(doc("short"), { start: 0, end: 99 }, "x")).toThrow(/does not address/);
});

test("insertAt drafts into a zero-width selection at a block boundary", () => {
  const before = doc("First.\n\nThird.\n");
  const boundary = { start: 8, end: 8 };

  expect(insertAt(before, boundary, "Second.\n\n").text).toBe("First.\n\nSecond.\n\nThird.\n");
});

test("insertAt refuses a selection that is not zero-width", () => {
  expect(() => insertAt(doc("First."), { start: 0, end: 5 }, "x")).toThrow(/zero-width/);
});

test("accepting and rejecting each of the three change forms", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["The press was cold.{++ It always was.++}", "The press was cold. It always was.", "The press was cold."],
    ["He waited {--a long time --}for the fog.", "He waited for the fog.", "He waited a long time for the fog."],
    ["He poured the {~~diesel~>gasoline~~}.", "He poured the gasoline.", "He poured the diesel."],
  ];

  for (const [text, accepted, rejected] of cases) {
    expect(resolveMark(doc(text), firstMark(text), "accept").text).toBe(accepted);
    expect(resolveMark(doc(text), firstMark(text), "reject").text).toBe(rejected);
  }
});

test("a note is discarded either way; a highlight keeps its prose either way", () => {
  const note = "She was nineteen{>>check her age<<} that summer.";
  const highlight = "{==The wind came off the water.==}";

  for (const decision of ["accept", "reject"] as const) {
    expect(resolveMark(doc(note), firstMark(note), decision).text).toBe("She was nineteen that summer.");
    expect(resolveMark(doc(highlight), firstMark(highlight), decision).text).toBe(
      "The wind came off the water.",
    );
  }
});

test("resolving one hunk leaves the proposals nested inside it alone", () => {
  const text = "The train came.{++ It came like the {~~river~>creek~~} came.++}";

  expect(resolveMark(doc(text), firstMark(text), "accept").text).toBe(
    "The train came. It came like the {~~river~>creek~~} came.",
  );
});

test("resolveAll resolves nested marks too, down to plain prose", () => {
  const text = "{==The harvest was {++small, {--barely worth picking, --}and late++}, and nobody said so.==}";

  expect(resolveAll(doc(text), "accept").text).toBe("The harvest was small, and late, and nobody said so.");
  expect(resolveAll(doc(text), "reject").text).toBe("The harvest was , and nobody said so.");
});

test("expand walks character to sentence to paragraph to scene to chapter", () => {
  const inside = spanOf(CHAPTERS, "first paragraph");
  const start: Selection = { span: inside, granularity: "character" };
  const steps: ReadonlyArray<readonly [Granularity, string]> = [
    ["sentence", "The first paragraph."],
    ["paragraph", "The first paragraph. It has two sentences."],
    ["scene", "The first paragraph. It has two sentences."],
    ["chapter", "# One\n\nThe first paragraph. It has two sentences.\n\n* * *\n\nA second scene. Mrs. Ferrante said nothing."],
  ];

  steps.forEach(([granularity, text], index) => {
    const selection = ladder(CHAPTERS, start, index + 1);
    expect(selection.granularity).toBe(granularity);
    expect(selected(CHAPTERS, selection)).toBe(text);
  });
});

test("expand stops at chapter", () => {
  const chapter = ladder(CHAPTERS, { span: spanOf(CHAPTERS, "first"), granularity: "character" }, 5);

  expect(ladder(CHAPTERS, chapter, 1)).toEqual(chapter);
});

test("a sentence boundary is not an honorific's period", () => {
  const sentence = ladder(
    CHAPTERS,
    { span: spanOf(CHAPTERS, "Ferrante"), granularity: "character" },
    1,
  );

  expect(selected(CHAPTERS, sentence)).toBe("Mrs. Ferrante said nothing.");
});

test("a selection across two paragraphs expands to both of them", () => {
  const text = "First one. Second one.\n\nThird one. Fourth one.\n";
  const across = { start: text.indexOf("Second"), end: text.indexOf("Third") + 5 };
  const paragraph = expand(parse(text), { span: across, granularity: "sentence" });

  expect(selected(text, paragraph)).toBe("First one. Second one.\n\nThird one. Fourth one.");
});

test("a zero-width selection at a boundary expands to the paragraph it came from", () => {
  const boundary = CHAPTERS.indexOf("\n\n* * *");
  const paragraph = expand(parse(CHAPTERS), {
    span: { start: boundary, end: boundary },
    granularity: "sentence",
  });

  expect(selected(CHAPTERS, paragraph)).toBe("The first paragraph. It has two sentences.");
});

test("shrink walks back down and stops at character", () => {
  const model = parse(CHAPTERS);
  const chapter = ladder(CHAPTERS, { span: spanOf(CHAPTERS, "first"), granularity: "character" }, 4);

  const scene = shrink(model, chapter);
  expect(selected(CHAPTERS, scene)).toBe("The first paragraph. It has two sentences.");
  expect(scene.granularity).toBe("scene");

  const paragraph = shrink(model, scene);
  expect(paragraph.granularity).toBe("paragraph");

  const sentence = shrink(model, paragraph);
  expect(selected(CHAPTERS, sentence)).toBe("The first paragraph.");

  const character = shrink(model, sentence);
  expect(character).toEqual({ span: sentence.span, granularity: "character" });
  expect(shrink(model, character)).toEqual(character);
});

test("a structural selection never cuts a mark in half", () => {
  const text = "Before.\n\n{~~one\n\ntwo~>ONE\n\nTWO~~}\n\nAfter.\n";
  const model = parse(text);
  const paragraph = expand(model, { span: spanOf(text, "one"), granularity: "sentence" });

  expect(selected(text, paragraph)).toContain("{~~one\n\ntwo~>ONE\n\nTWO~~}");
  expect(serializeSafe(text, paragraph.span)).toBe(true);
});

function serializeSafe(text: string, span: { start: number; end: number }): boolean {
  return parse(text.slice(span.start, span.end)).violations.length === 0;
}

test("a document with no headings is one chapter", () => {
  const text = "Only a paragraph here.\n\nAnd another.\n";
  const chapter = expand(parse(text), { span: { start: 0, end: 4 }, granularity: "scene" });

  expect(selected(text, chapter)).toBe("Only a paragraph here.\n\nAnd another.");
});
