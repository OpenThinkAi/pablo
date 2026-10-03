import { describe, expect, test } from "bun:test";
import {
  applySuggestion,
  applySuggestions,
  decodeBody,
  encodeBody,
  inParagraph,
  joinManuscript,
  lineAt,
  parseReview,
  parseSuggestionBody,
  partitionComments,
  readingChapter,
  readingText,
  resolveReview,
  reviewPayload,
  safeReviewPath,
  selectionLines,
  splitManuscript,
  suggestionBody,
  toReviewPayload,
  type GitHubReviewComment,
  type ReaderMark,
  type ReadingChapter,
  type ReadingSelection,
  type ResolvedReview,
  type ResolvedSuggestion,
} from "../src/index";

/**
 * Reader marks ↔ sentence lines ↔ a GitHub review (AGT-1584). Every chapter below is invented for this test — no
 * manuscript text belongs in this repo, whose GitHub mirror is public.
 *
 * SALT_ROAD's file lines, for reading the tables:
 *
 *    1 ---                                5 (blank)
 *    2 title: The Salt Road               6 # Three
 *    3 chapter: 3                         7 (blank)
 *    4 ---                                8 Wren kept the lantern low.
 *    9 The road ran white under the moon, and the salt crusted the ruts.
 *   10 (blank)
 *   11 "Is that the ferry?" Tobias asked.
 *   12 "It is.
 *   13 We're late."
 *   14 She said nothing.
 *   15 (blank)
 *   16 * * *
 *   17 (blank)
 *   18 Mr. Hale met them at the gate.
 *   19 He had a ledger under one arm and no patience at all.
 *
 * Its reading paragraphs: 0 `# Three`, 1 Wren…ruts., 2 "Is that…nothing., 3 `* * *`, 4 Mr. Hale…all.
 */

const SALT_BODY = `# Three

Wren kept the lantern low. The road ran white under the moon, and the salt crusted the ruts.

"Is that the ferry?" Tobias asked. "It is. We're late." She said nothing.

* * *

Mr. Hale met them at the gate. He had a ledger under one arm and no patience at all.`;

const SALT_ROAD = `---\ntitle: The Salt Road\nchapter: 3\n---\n\n${splitManuscript(SALT_BODY)}\n`;

/** A second chapter: more dialogue, an ellipsis stammer, a question run, and no frontmatter. */
const LIGHTHOUSE_BODY = `The keeper's daughter climbed the stair at dusk. Ninety-one steps, she counted, the way her father had.

"You're early," said the keeper. "Or I'm slow. One of us is wrong." He laughed, and the lamp hissed.

"I... I saw a sail," she said. "Out past the reef. Did you see it?" He had not. Nobody had, that week.

The gulls went quiet. Somewhere below, a door banged twice and then held.`;

const LIGHTHOUSE = `${splitManuscript(LIGHTHOUSE_BODY)}\n`;

const CH3 = "chapters/03-the-salt-road.md";
const CH7 = "chapters/07-the-lighthouse.md";
const CHAPTERS = { [CH3]: SALT_ROAD, [CH7]: LIGHTHOUSE };

const salt = readingChapter(SALT_ROAD);
const light = readingChapter(LIGHTHOUSE);

/** The selection of the `nth` occurrence of `needle` in paragraph `p`. */
function sel(chapter: ReadingChapter, p: number, needle: string, nth = 0): ReadingSelection {
  const text = chapter.paragraphs[p]!.text;
  let at = -1;
  for (let i = 0; i <= nth; i++) at = text.indexOf(needle, at + 1);
  if (at < 0) throw new Error(`fixture: ${JSON.stringify(needle)} is not in paragraph ${p}`);
  return inParagraph(p, at, at + needle.length);
}

/** A caret just before (or, with `after`, just after) `needle` in paragraph `p`. */
function caret(chapter: ReadingChapter, p: number, needle: string, after = false): ReadingSelection {
  const s = sel(chapter, p, needle);
  return after ? inParagraph(p, s.end.offset) : inParagraph(p, s.start.offset);
}

/** From the start of `a` in paragraph `pa` to the end of `b` in paragraph `pb`. */
function across(chapter: ReadingChapter, pa: number, a: string, pb: number, b: string): ReadingSelection {
  return { start: sel(chapter, pa, a).start, end: sel(chapter, pb, b).end };
}

describe("fixtures", () => {
  test("are stored exactly as pablo saves them: one sentence per line", () => {
    for (const body of [SALT_BODY, LIGHTHOUSE_BODY]) expect(splitManuscript(joinManuscript(splitManuscript(body)))).toBe(splitManuscript(body));
    expect(SALT_ROAD.split("\n").slice(11, 14)).toEqual(['"It is.', "We're late.\"", "She said nothing."]);
  });
});

describe("readingChapter", () => {
  test("paragraphs read as joined prose, structure as it is, frontmatter hidden", () => {
    expect(salt.paragraphs.map((p) => p.text)).toEqual([
      "# Three",
      "Wren kept the lantern low. The road ran white under the moon, and the salt crusted the ruts.",
      '"Is that the ferry?" Tobias asked. "It is. We\'re late." She said nothing.',
      "* * *",
      "Mr. Hale met them at the gate. He had a ledger under one arm and no patience at all.",
    ]);
    expect(salt.paragraphs.map((p) => p.prose)).toEqual([false, true, true, false, true]);
    expect(readingText(salt)).toBe(joinManuscript(SALT_BODY));
  });

  test("every stored line maps to its character range, file lines counted with the frontmatter", () => {
    const p = salt.paragraphs[2]!;
    expect(p.lines.map((l) => [l.line, p.text.slice(l.start, l.end)])).toEqual([
      [11, '"Is that the ferry?" Tobias asked.'],
      [12, '"It is.'],
      [13, "We're late.\""],
      [14, "She said nothing."],
    ]);
    expect(salt.paragraphs.flatMap((q) => q.lines.map((l) => l.line))).toEqual([6, 8, 9, 11, 12, 13, 14, 16, 18, 19]);
    expect(salt.fileLines).toHaveLength(19);
  });

  test("each line's range is that file line, whitespace collapsed", () => {
    for (const chapter of [salt, light]) {
      for (const p of chapter.paragraphs) {
        for (const l of p.lines) expect(p.text.slice(l.start, l.end)).toBe(chapter.fileLines[l.line - 1]!.replace(/\s+/g, " ").trim());
      }
    }
  });

  test("no frontmatter, CRLF, a BOM, an unclosed `---`, and messy whitespace", () => {
    expect(light.paragraphs[0]!.lines[0]!.line).toBe(1);
    const crlf = readingChapter("﻿---\r\na: 1\r\n---\r\nOne.\r\nTwo  \t words.\r\n\r\n\r\nThree.\r\n");
    expect(crlf.paragraphs.map((p) => p.text)).toEqual(["One. Two words.", "Three."]);
    expect(crlf.paragraphs.flatMap((p) => p.lines.map((l) => l.line))).toEqual([4, 5, 8]);
    expect(readingChapter("---\nNot frontmatter.\n").paragraphs[0]!.text).toBe("---\nNot frontmatter.");
    expect(readingChapter("").paragraphs).toEqual([]);
  });

  test("lineAt: the line under an offset, the line before on the space between", () => {
    const p = salt.paragraphs[1]!; // line 8 is [0, 26), line 9 from 27
    expect([0, 10, 25, 26, 27, 40, p.text.length].map((o) => lineAt(p, o))).toEqual([8, 8, 8, 8, 9, 9, 9]);
  });
});

describe("selectionLines (comments)", () => {
  const cases: readonly [string, ReadingSelection, number, number][] = [
    ["a word inside one sentence", sel(salt, 1, "lantern"), 8, 8],
    ["a whole sentence", sel(salt, 1, "Wren kept the lantern low."), 8, 8],
    ["a whole sentence and its trailing space", sel(salt, 1, "low. "), 8, 8],
    ["across two sentences", sel(salt, 1, "low. The road"), 8, 9],
    ["inside a quote split over two lines", sel(salt, 2, "It is"), 12, 12],
    ["across the split inside a quote", sel(salt, 2, "is. We're"), 12, 13],
    ["dialogue and its tag", sel(salt, 2, "ferry?\" Tobias asked"), 11, 11],
    ["a caret mid-word", caret(salt, 2, "nothing"), 14, 14],
    ["a caret just after a sentence", caret(salt, 1, "low.", true), 8, 8],
    ["only the space between two sentences", sel(salt, 1, " The"), 9, 9],
    ["a space alone, between two sentences", inParagraph(1, 26, 27), 8, 8],
    ["the heading", sel(salt, 0, "Three"), 6, 6],
    ["the scene break", sel(salt, 3, "* * *"), 16, 16],
    ["across a paragraph break", across(salt, 1, "the ruts", 2, "Tobias"), 9, 11],
    ["across a scene break", across(salt, 2, "nothing", 4, "Hale"), 14, 18],
    ["a whole chapter", { start: { paragraph: 0, offset: 0 }, end: { paragraph: 4, offset: salt.paragraphs[4]!.text.length } }, 6, 19],
    ["a chapter with no frontmatter", sel(light, 2, "I... I saw"), 9, 9],
    ["a quote holding three sentences", sel(light, 1, "early,\" said the keeper. \"Or I'm slow. One"), 4, 6],
  ];
  for (const [name, selection, start, end] of cases) {
    test(name, () => expect(selectionLines(name.includes("no frontmatter") || name.includes("three sentences") ? light : salt, selection)).toEqual({ start, end }));
  }

  test("an out-of-range or backwards selection is refused", () => {
    expect(() => selectionLines(salt, inParagraph(9, 0))).toThrow(RangeError);
    expect(() => selectionLines(salt, inParagraph(1, 0, 999))).toThrow(RangeError);
    expect(() => selectionLines(salt, inParagraph(1, 5, 2))).toThrow(RangeError);
    expect(() => selectionLines(salt, { start: { paragraph: 2, offset: 0 }, end: { paragraph: 1, offset: 3 } })).toThrow(RangeError);
    expect(() => selectionLines(readingChapter("---\na: 1\n---\n"), inParagraph(0, 0))).toThrow(RangeError);
  });
});

describe("marks to GitHub review comments", () => {
  const payload = toReviewPayload(CHAPTERS, {
    summary: "Loved the road. The ferry scene drags a little.",
    marks: [
      { kind: "comment", path: CH3, selection: sel(salt, 1, "lantern"), tag: "keep", body: "I can see this." },
      { kind: "comment", path: CH3, selection: sel(salt, 2, "is. We're"), tag: "fix", body: "Who says this?" },
      { kind: "comment", path: CH3, selection: sel(salt, 4, "ledger"), body: "Untagged aside." },
      { kind: "suggestion", path: CH3, selection: sel(salt, 1, "lantern"), replacement: "lamp" },
      { kind: "suggestion", path: CH3, selection: sel(salt, 1, "low. The road"), replacement: "low, and the road", tag: "fix", note: "One breath." },
      { kind: "chapter", path: CH3, tag: "keep", body: "Strong chapter." },
      { kind: "chapter", path: CH7, body: "Not sure about the ending." },
    ],
  });

  test("the summary is the review body", () => expect(payload.body).toBe("Loved the road. The ferry scene drags a little."));

  test("a comment on one sentence is {path, line, side: RIGHT, body}", () => {
    expect(payload.comments[0]).toEqual({ path: CH3, line: 8, side: "RIGHT", body: "**[keep]** I can see this." });
  });

  test("a comment spanning sentences is {path, start_line, line, side: RIGHT, body}", () => {
    expect(payload.comments[1]).toEqual({ path: CH3, start_line: 12, start_side: "RIGHT", line: 13, side: "RIGHT", body: "**[fix]** Who says this?" });
  });

  test("an untagged comment's body is its text", () => expect(payload.comments[2]).toEqual({ path: CH3, line: 19, side: "RIGHT", body: "Untagged aside." }));

  test("a suggestion is a ```suggestion block replacing exactly the commented lines", () => {
    expect(payload.comments[3]).toEqual({ path: CH3, line: 8, side: "RIGHT", body: "```suggestion\nWren kept the lantern low.".replace("lantern", "lamp") + "\n```" });
    expect(payload.comments[4]).toEqual({
      path: CH3,
      start_line: 8,
      start_side: "RIGHT",
      line: 9,
      side: "RIGHT",
      body: "**[fix]** One breath.\n\n```suggestion\nWren kept the lantern low, and the road ran white under the moon, and the salt crusted the ruts.\n```",
    });
  });

  test("a chapter comment is {path, subject_type: file, body}", () => {
    expect(payload.comments[5]).toEqual({ path: CH3, subject_type: "file", body: "**[keep]** Strong chapter." });
    expect(payload.comments[6]).toEqual({ path: CH7, subject_type: "file", body: "Not sure about the ending." });
  });

  test("partitionComments separates what the create-review call takes from file comments", () => {
    const { line, file } = partitionComments(payload);
    expect(line).toHaveLength(5);
    expect(file.map((c) => c.path)).toEqual([CH3, CH7]);
  });

  test("a mark on a chapter not in the round, or an empty untagged comment, is refused", () => {
    expect(() => toReviewPayload(CHAPTERS, { summary: "", marks: [{ kind: "chapter", path: "chapters/99.md", body: "x" }] })).toThrow(/not a chapter of this round/);
    expect(() => toReviewPayload(CHAPTERS, { summary: "", marks: [{ kind: "chapter", path: "toString", body: "x" }] })).toThrow(/not a chapter of this round/);
    expect(() => toReviewPayload(CHAPTERS, { summary: "", marks: [{ kind: "comment", path: CH3, selection: sel(salt, 1, "low"), body: "" }] })).toThrow(/neither a tag nor any text/);
  });
});

describe("suggestions (strike or free edit)", () => {
  const cases: readonly [string, ReadingChapter, ReadingSelection, string, number, number, string[]][] = [
    ["a word inside one sentence: the whole sentence, changed", salt, sel(salt, 1, "lantern"), "lamp", 8, 8, ["Wren kept the lamp low."]],
    ["inside dialogue, half of a split quote", salt, sel(salt, 2, "late"), "early", 13, 13, ["We're early.\""]],
    ["dialogue tag changed", salt, sel(salt, 2, "Tobias asked"), "asked Tobias", 11, 11, ['"Is that the ferry?" asked Tobias.']],
    ["an edit that removes a sentence (two lines become one)", salt, sel(salt, 1, "low. The road"), "low, and the road", 8, 9, ["Wren kept the lantern low, and the road ran white under the moon, and the salt crusted the ruts."]],
    ["an edit that adds sentences (one line becomes three)", salt, sel(salt, 1, "low."), "low. It guttered. She cupped it.", 8, 8, ["Wren kept the lantern low.", "It guttered.", "She cupped it."]],
    ["deleting a whole sentence deletes its line", salt, sel(salt, 2, "She said nothing."), "", 14, 14, []],
    ["deleting a sentence with the space before it touches both lines", salt, sel(salt, 2, " She said nothing."), "", 13, 14, ["We're late.\""]],
    ["a caret insertion at the start of a paragraph", salt, caret(salt, 4, "Mr."), "Old ", 18, 18, ["Old Mr. Hale met them at the gate."]],
    ["a caret insertion after a sentence adds a line", salt, caret(salt, 1, "low.", true), " It guttered.", 8, 8, ["Wren kept the lantern low.", "It guttered."]],
    ["a new paragraph typed after a sentence", salt, caret(salt, 1, "low.", true), "\n\n", 8, 8, ["Wren kept the lantern low.", ""]],
    ["a new paragraph typed before a sentence", salt, caret(salt, 1, "The road"), "\n\n", 9, 9, ["", "The road ran white under the moon, and the salt crusted the ruts."]],
    ["a sentence replaced by a paragraph break", salt, sel(salt, 2, '"It is. '), "\n\n", 12, 13, ["", "We're late.\""]],
    ["a middle line replaced by only a break keeps the break", light, sel(light, 1, "Or I'm slow. "), "\n\n", 5, 6, ['"', "", "One of us is wrong.\""]],
    ["across a paragraph break, the two paragraphs merge", salt, across(salt, 1, "ruts.", 2, "ferry?\""), "ruts, and the ferry was there.", 9, 11, ["The road ran white under the moon, and the salt crusted the ruts, and the ferry was there.", "Tobias asked."]],
    ["across a paragraph break, joined with a space", salt, { start: { paragraph: 1, offset: salt.paragraphs[1]!.text.length }, end: { paragraph: 2, offset: 0 } }, " ", 9, 11, ["The road ran white under the moon, and the salt crusted the ruts.", '"Is that the ferry?" Tobias asked.']],
    ["across a paragraph break, the break kept", salt, across(salt, 1, "ruts.", 2, "ferry?"), "ruts. A bell.\n\n\"Is that the boat?", 9, 11, ["The road ran white under the moon, and the salt crusted the ruts.", "A bell.", "", '"Is that the boat?" Tobias asked.']],
    ["across a scene break, structure kept as structure", salt, across(salt, 2, "nothing", 4, "Mr."), "nothing.\n\n* * *\n\nOld Mr.", 14, 18, ["She said nothing.", "", "* * *", "", "Old Mr. Hale met them at the gate."]],
    ["a heading edited stays a heading", salt, sel(salt, 0, "Three"), "Three: The Road", 6, 6, ["# Three: The Road"]],
    ["an honorific in the replacement does not split", light, sel(light, 3, "The gulls"), "Mr. Gull and the gulls", 15, 15, ["Mr. Gull and the gulls went quiet."]],
    ["a stammer stays one sentence", light, sel(light, 2, "saw a sail"), "saw... saw a sail", 9, 9, ['"I... I saw... saw a sail," she said.']],
  ];
  for (const [name, chapter, selection, replacement, start, end, lines] of cases) {
    test(name, () => {
      const path = chapter === salt ? CH3 : CH7;
      const { marks } = resolveReview(CHAPTERS, { summary: "", marks: [{ kind: "suggestion", path, selection, replacement }] });
      expect(marks[0]).toEqual({ kind: "suggestion", path, lines: { start, end }, replacement: lines });
    });
  }

  test("a backtick run in the replacement gets a longer fence, and still round-trips", () => {
    const body = suggestionBody(["She said ```nothing``` at all."], "fix", "odd");
    expect(body).toBe("**[fix]** odd\n\n````suggestion\nShe said ```nothing``` at all.\n````");
    expect(parseSuggestionBody(body)).toEqual({ replacement: ["She said ```nothing``` at all."], tag: "fix", note: "odd" });
  });

  test("an empty suggestion block deletes the lines; a body with no block is not a suggestion", () => {
    expect(suggestionBody([])).toBe("```suggestion\n```");
    expect(parseSuggestionBody("```suggestion\n```")).toEqual({ replacement: [] });
    expect(parseSuggestionBody("```suggestion\n\n```")).toEqual({ replacement: [""] });
    expect(parseSuggestionBody("just a note")).toBeUndefined();
    expect(parseSuggestionBody("```js\nx\n```")).toBeUndefined();
  });
});

describe("tags in bodies", () => {
  const cases: readonly [string, "fix" | "keep" | undefined, string][] = [
    ["tagged", "fix", "Clarify who speaks."],
    ["tagged, no text", "keep", ""],
    ["tagged, leading spaces kept", "fix", "  indented"],
    ["tagged, multi-line", "keep", "Line one.\n\nLine two."],
    ["untagged", undefined, "Plain."],
    ["untagged that looks tagged", undefined, "**[fix]** is how pablo tags"],
    ["untagged starting with a backslash", undefined, "\\escape"],
    ["untagged bold that is not a tag", undefined, "**fix** this"],
  ];
  for (const [name, tag, text] of cases) {
    test(name, () => expect(decodeBody(encodeBody(tag, text))).toEqual(tag === undefined ? { text } : { tag, text }));
  }
  test("the visible form", () => {
    expect(encodeBody("keep", "Nice.")).toBe("**[keep]** Nice.");
    expect(encodeBody(undefined, "**[keep]** x")).toBe("\\**[keep]** x");
  });
});

describe("parseReview: GitHub's review back into marks", () => {
  test("reads the API's shape: CRLF bodies, outdated lines, file comments, replies skipped", () => {
    const comments: GitHubReviewComment[] = [
      { path: CH3, body: "**[fix]** Who says this?\r\nUnclear.", line: 13, start_line: 12, subject_type: "line" },
      { path: CH3, body: "```suggestion\r\nWren kept the lamp low.\r\n```", line: null, start_line: null, original_line: 8, original_start_line: null, subject_type: "line" },
      { path: CH3, body: "**[keep]** Strong.", line: null, subject_type: "file" },
      { path: CH3, body: "Agreed.", line: 13, in_reply_to_id: 42 },
    ];
    expect(parseReview({ body: "Summary\r\nhere", comments })).toEqual({
      summary: "Summary\nhere",
      marks: [
        { kind: "comment", path: CH3, lines: { start: 12, end: 13 }, tag: "fix", body: "Who says this?\nUnclear." },
        { kind: "suggestion", path: CH3, lines: { start: 8, end: 8 }, replacement: ["Wren kept the lamp low."] },
        { kind: "chapter", path: CH3, tag: "keep", body: "Strong." },
      ],
    });
    expect(parseReview({ body: null, comments: [] })).toEqual({ summary: "", marks: [] });
  });

  test("a path that could leave the reading repo is refused", () => {
    for (const path of ["/etc/passwd", "../outside.md", "chapters/../../x.md", "chapters/./03.md", "chapters//03.md", "chapters\\03.md", "", "chapters/03.md\0"]) {
      expect(() => parseReview({ comments: [{ path, body: "x", line: 1 }] }), path).toThrow(/not a path inside the reading repo/);
    }
    expect(safeReviewPath(CH3)).toBe(CH3);
    expect(safeReviewPath("chapters/03..draft.md")).toBe("chapters/03..draft.md");
  });
});

describe("applySuggestion", () => {
  test("replaces exactly the lines, keeps everything else and the final newline", () => {
    const out = applySuggestion(SALT_ROAD, { lines: { start: 12, end: 13 }, replacement: ['"It is, and we are late."'] });
    const lines = out.split("\n");
    expect(lines.slice(10, 13)).toEqual(['"Is that the ferry?" Tobias asked.', '"It is, and we are late."', "She said nothing."]);
    expect(lines.slice(0, 10)).toEqual(SALT_ROAD.split("\n").slice(0, 10));
    expect(out.endsWith("at all.\n")).toBe(true);
  });

  test("CRLF files keep CRLF", () => {
    expect(applySuggestion("a.\r\nb.\r\nc.\r\n", { lines: { start: 2, end: 2 }, replacement: ["B.", "BB."] })).toBe("a.\r\nB.\r\nBB.\r\nc.\r\n");
  });

  test("several at once use the original line numbers; overlap and out-of-range are refused", () => {
    const both = applySuggestions(SALT_ROAD, [
      { lines: { start: 18, end: 18 }, replacement: ["Old Mr. Hale met them at the gate."] },
      { lines: { start: 8, end: 9 }, replacement: ["One line now."] },
    ]);
    expect(both.split("\n")[7]).toBe("One line now.");
    expect(both.split("\n")[16]).toBe("Old Mr. Hale met them at the gate.");
    expect(() => applySuggestions(SALT_ROAD, [{ lines: { start: 8, end: 9 }, replacement: [] }, { lines: { start: 9, end: 9 }, replacement: [] }])).toThrow(/overlap/);
    expect(() => applySuggestion(SALT_ROAD, { lines: { start: 19, end: 20 }, replacement: [] })).toThrow(RangeError);
  });
});

// ─── Round trips ──────────────────────────────────────────────────────────────────────────────────────────

/** marks → payload → marks, the property `notes pull` stands on. */
function roundTrip(draft: { summary: string; marks: readonly ReaderMark[] }): { resolved: ResolvedReview; back: ResolvedReview } {
  const resolved = resolveReview(CHAPTERS, draft);
  const payload = reviewPayload(resolved);
  // GitHub hands comments back with its own fields; a line comment has start_line null.
  const back = parseReview({
    body: payload.body,
    comments: payload.comments.map((c): GitHubReviewComment => ("subject_type" in c ? { ...c, line: null } : { start_line: null, subject_type: "line", ...c })),
  });
  return { resolved, back };
}

describe("round trip: marks → payload → marks", () => {
  const named: readonly [string, ReaderMark][] = [
    ["dialogue: a comment on a quote's second line", { kind: "comment", path: CH3, selection: sel(salt, 2, "We're late"), tag: "fix", body: "Tone?" }],
    ["dialogue: a suggestion across a quote split over lines", { kind: "suggestion", path: CH3, selection: sel(salt, 2, "is. We're"), replacement: "is, and we're", tag: "fix", note: "Run on." }],
    ["a selection inside one sentence", { kind: "suggestion", path: CH7, selection: sel(light, 3, "banged twice"), replacement: "banged once" }],
    ["one crossing a paragraph break (comment)", { kind: "comment", path: CH3, selection: across(salt, 1, "ruts", 2, "asked"), tag: "keep", body: "Lovely turn." }],
    ["one crossing a paragraph break (suggestion)", { kind: "suggestion", path: CH3, selection: across(salt, 1, "ruts.", 2, "ferry?\""), replacement: "ruts, and the ferry was there." }],
    ["an edit that adds sentences", { kind: "suggestion", path: CH3, selection: sel(salt, 1, "low."), replacement: "low. It guttered. She cupped it." }],
    ["an edit that removes sentences", { kind: "suggestion", path: CH7, selection: sel(light, 2, "He had not. Nobody had, that week."), replacement: "" }],
    ["an edit that removes a sentence by merging", { kind: "suggestion", path: CH7, selection: sel(light, 1, "slow. One"), replacement: "slow, and one" }],
    ["a new paragraph", { kind: "suggestion", path: CH3, selection: caret(salt, 1, "The road"), replacement: "\n\n" }],
    ["a chapter comment", { kind: "chapter", path: CH7, tag: "fix", body: "The sail needs paying off." }],
    ["an untagged comment that looks tagged", { kind: "comment", path: CH7, selection: sel(light, 0, "Ninety-one"), body: "**[keep]** is not a tag here" }],
  ];
  for (const [name, mark] of named) {
    test(name, () => {
      const { resolved, back } = roundTrip({ summary: "A summary.\n\nTwo paragraphs.", marks: [mark] });
      expect(back).toEqual(resolved);
    });
  }

  test("a whole round of marks over two chapters", () => {
    const { resolved, back } = roundTrip({ summary: "Both chapters.", marks: named.map(([, m]) => m) });
    expect(back).toEqual(resolved);
    expect(back.marks).toHaveLength(named.length);
  });
});

// ─── Properties over random selections ────────────────────────────────────────────────────────────────────

/** A small seeded PRNG (mulberry32), so a failure reproduces. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL = ["the", "salt", "Wren", "ferry", "ran", "late", "quietly", ".", ". ", "? ", "! ", ", ", " ", "\"", "\"Wait!\" ", "Mr. ", "...", "\n\n", "She ", "It is. ", "'"];

function randomSelection(chapter: ReadingChapter, rnd: () => number): ReadingSelection {
  const pick = () => {
    const paragraph = Math.floor(rnd() * chapter.paragraphs.length);
    return { paragraph, offset: Math.floor(rnd() * (chapter.paragraphs[paragraph]!.text.length + 1)) };
  };
  let a = pick();
  let b = rnd() < 0.7 ? { paragraph: a.paragraph, offset: Math.min(chapter.paragraphs[a.paragraph]!.text.length, a.offset + Math.floor(rnd() * 40)) } : pick();
  if (b.paragraph < a.paragraph || (b.paragraph === a.paragraph && b.offset < a.offset)) [a, b] = [b, a];
  return { start: a, end: b };
}

function randomReplacement(rnd: () => number): string {
  const n = Math.floor(rnd() * 6);
  let out = "";
  for (let i = 0; i < n; i++) out += POOL[Math.floor(rnd() * POOL.length)]!;
  return out;
}

/** The reading text, flattened offsets of a selection in it, and the text with the selection replaced. */
function editReading(chapter: ReadingChapter, s: ReadingSelection, replacement: string): string {
  const text = readingText(chapter);
  const at = (p: { paragraph: number; offset: number }) => chapter.paragraphs.slice(0, p.paragraph).reduce((n, q) => n + q.text.length + 2, 0) + p.offset;
  return text.slice(0, at(s.start)) + replacement + text.slice(at(s.end));
}

/** Text compared up to whitespace: paragraphs on blank lines, runs collapsed, empties dropped. */
const normalize = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p !== "")
    .join("\n\n");

describe("properties over random selections", () => {
  const RUNS = 400;
  for (const [path, stored, chapter] of [[CH3, SALT_ROAD, salt], [CH7, LIGHTHOUSE, light]] as const) {
    test(`${path}: a comment's range is exactly the lines its non-space characters fall on`, () => {
      const rnd = prng(1584);
      for (let i = 0; i < RUNS; i++) {
        const s = randomSelection(chapter, rnd);
        const range = selectionLines(chapter, s);
        const hit = new Set<number>();
        chapter.paragraphs.forEach((p, k) => {
          const from = k === s.start.paragraph ? s.start.offset : k > s.start.paragraph ? 0 : Infinity;
          const to = k === s.end.paragraph ? s.end.offset : k < s.end.paragraph ? p.text.length : -1;
          for (let o = from; o < to; o++) if (/\S/.test(p.text[o]!)) hit.add(lineAt(p, o));
        });
        if (hit.size > 0) expect(range).toEqual({ start: Math.min(...hit), end: Math.max(...hit) });
        else expect(range.start).toBe(range.end);
      }
    });

    test(`${path}: taking a suggestion gives the file the reader's edited text, and it round-trips`, () => {
      const rnd = prng(5841);
      for (let i = 0; i < RUNS; i++) {
        const selection = randomSelection(chapter, rnd);
        const replacement = randomReplacement(rnd);
        const mark: ReaderMark = { kind: "suggestion", path, selection, replacement };
        const { resolved, back } = roundTrip({ summary: "", marks: [mark] });
        const ctx = JSON.stringify({ selection, replacement });
        expect(back, ctx).toEqual(resolved);
        const suggestion = resolved.marks[0] as ResolvedSuggestion;
        // Untouched lines stay, the range is the only thing that changes.
        const applied = applySuggestion(stored, suggestion);
        const before = stored.split("\n");
        const after = applied.split("\n");
        expect(after.slice(0, suggestion.lines.start - 1), ctx).toEqual(before.slice(0, suggestion.lines.start - 1));
        expect(after.slice(after.length - (before.length - suggestion.lines.end)), ctx).toEqual(before.slice(suggestion.lines.end));
        // What the reader saw after their edit is what the file reads as once the suggestion is taken.
        expect(normalize(readingText(readingChapter(applied))), ctx).toBe(normalize(editReading(chapter, selection, replacement)));
        // The replacement is stored one sentence per line.
        for (const line of suggestion.replacement) if (line !== "" && !/^(#|\* \* \*)/.test(line)) expect(splitManuscript(line), ctx).toBe(line);
      }
    });

    test(`${path}: comments round-trip over random selections`, () => {
      const rnd = prng(4815);
      for (let i = 0; i < RUNS; i++) {
        const tag = rnd() < 0.33 ? "fix" : rnd() < 0.5 ? "keep" : undefined;
        const mark: ReaderMark = { kind: "comment", path, selection: randomSelection(chapter, rnd), ...(tag ? { tag } : {}), body: `note ${i}` };
        const { resolved, back } = roundTrip({ summary: "s", marks: [mark] });
        expect(back).toEqual(resolved);
      }
    });
  }
});
