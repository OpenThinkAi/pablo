import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse, type MarkupDocument } from "@openthink/pablo-core";
import { blockRuns, createLineCache, layoutWindow, type DisplayLine } from "../src/layout";
import { frameText } from "../src/render";
import { CARET_GLYPH, THEME } from "../src/theme";

const FIXTURES = fileURLToPath(new URL("../../core/test/fixtures/criticmarkup/", import.meta.url));

function fixture(name: string): MarkupDocument {
  return parse(readFileSync(`${FIXTURES}${name}`, "utf8"));
}

function frame(model: MarkupDocument, width = 60, height = 200): DisplayLine[] {
  return layoutWindow(model, {
    width,
    height,
    anchor: { blockIndex: 0, line: 0 },
    selection: { start: 0, end: 0 },
  });
}

function styles(lines: readonly DisplayLine[]): Set<string> {
  const found = new Set<string>();
  for (const line of lines) for (const segment of line.segments) found.add(segment.style);
  return found;
}

const DELIMITERS = ["{++", "++}", "{--", "--}", "{~~", "~~}", "{>>", "<<}", "{==", "==}", "~>"];

test("the raw mark syntax is never shown (AC2), across the whole corpus", () => {
  const names = readdirSync(FIXTURES).filter((name) => name.endsWith(".md"));
  expect(names.length).toBeGreaterThan(20);

  for (const name of names) {
    const model = fixture(name);
    // A malformed mark is not a mark: the parser reports a violation and leaves
    // the text literal, and literal text is exactly what should be shown.
    if (model.violations.length > 0) continue;

    const text = frameText(frame(model));
    for (const delimiter of DELIMITERS) {
      expect(`${name}: ${text}`).not.toContain(delimiter);
    }
  }
});

test("each CriticMarkup form renders in its own style (AC2)", () => {
  const found = styles(frame(fixture("07-all-five-forms.md")));

  for (const style of ["addition", "deletion", "substitutionOld", "substitutionNew", "note", "highlight"]) {
    expect(found).toContain(style);
  }

  // Distinct means distinct to the eye: no two forms share both colour and
  // attributes, so a terminal that drops one still tells them apart.
  const shapes = ["addition", "deletion", "substitutionOld", "substitutionNew", "note", "highlight"].map(
    (name) => JSON.stringify(THEME[name as keyof typeof THEME]),
  );
  expect(new Set(shapes).size).toBe(shapes.length);
});

test("both halves of a substitution are shown, old struck through and new marked", () => {
  const model = parse("He set the lamp on the {~~table~>barrel head~~} and waited.\n");
  const segments = frame(model).flatMap((line) => line.segments);

  const old = segments.find((segment) => segment.style === "substitutionOld");
  const fresh = segments.find((segment) => segment.style === "substitutionNew");
  expect(old?.text).toBe("table");
  expect(fresh?.text).toBe("barrel head");
});

test("a mark that crosses a paragraph break styles both blocks (fixture 12)", () => {
  const model = fixture("12-mark-spans-paragraph-break.md");
  const lines = frame(model);

  const blocksTouched = new Set(
    lines
      .filter((line) => line.segments.some((segment) => segment.style !== "prose" && segment.style !== "heading"))
      .map((line) => line.blockIndex),
  );
  expect(blocksTouched.size).toBeGreaterThan(1);
});

test("a mark that crosses a scene break keeps its style on the far side (fixture 13)", () => {
  const model = fixture("13-mark-spans-scene-break.md");
  // The last paragraph of the mark is block 6; laying out from there alone must
  // still know it is inside a highlight that opened four blocks earlier.
  const lines = layoutWindow(model, {
    width: 60,
    height: 4,
    anchor: { blockIndex: 6, line: 0 },
    selection: { start: 0, end: 0 },
  });

  expect(styles(lines)).toContain("highlight");
  expect(frameText(lines)).toContain("Forty years later");
});

test("prose wraps to the terminal width (AC2)", () => {
  for (const width of [20, 41, 80]) {
    for (const line of frame(fixture("01-clean-chapter.md"), width)) {
      const drawn = line.segments.reduce((total, segment) => total + segment.text.length, 0);
      expect(drawn).toBeLessThanOrEqual(width);
    }
  }
});

test("a heading shows its title and not its hashes", () => {
  const lines = frame(fixture("17-headings-multilevel.md"));
  const text = frameText(lines);

  expect(text).toContain("Seventeen");
  expect(text).not.toContain("# ");
  expect(styles(lines)).toContain("heading");
});

test("a zero-width selection is drawn exactly once (AC3)", () => {
  const model = fixture("01-clean-chapter.md");
  const boundary = model.blocks[2]?.span.start ?? 0;

  const lines = layoutWindow(model, {
    width: 60,
    height: 40,
    anchor: { blockIndex: 0, line: 0 },
    selection: { start: boundary, end: boundary },
  });

  const carets = frameText(lines).split(CARET_GLYPH).length - 1;
  expect(carets).toBe(1);
});

test("the selection overlay covers exactly the selected characters", () => {
  const model = parse("The valley kept its own time.\n");
  const lines = layoutWindow(model, {
    width: 60,
    height: 4,
    anchor: { blockIndex: 0, line: 0 },
    selection: { start: 4, end: 10 },
  });

  const selected = lines
    .flatMap((line) => line.segments)
    .filter((segment) => segment.selected)
    .map((segment) => segment.text)
    .join("");
  expect(selected).toBe("valley");
});

test("blockRuns drops delimiters and keeps every visible character in order", () => {
  const model = parse("a {++b++} c {--d--} e\n");
  const runs = blockRuns(model, model.blocks[0]!);

  expect(runs.map((run) => run.text).join("")).toBe("a b c d e");
  for (const run of runs) {
    expect(model.text.slice(run.start, run.start + run.text.length)).toBe(run.text);
  }
});

test("the line cache is dropped when the model or the width changes", () => {
  const cache = createLineCache();
  const first = parse("one two three\n");
  const rows = cache.rows(first, 0, 60);
  expect(cache.rows(first, 0, 60)).toBe(rows);
  expect(cache.rows(first, 0, 20)).not.toBe(rows);
  expect(cache.rows(parse("four five\n"), 0, 60)).not.toBe(rows);
});
