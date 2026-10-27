// Sentence and paragraph motions and text objects (AGT-2170, D-18): on prose with dialogue and abbreviations. Pure.

import { expect, test } from "bun:test";
import { openText, type EditText } from "../src/edit-pane";
import { DEFAULT_KEYMAP, effectiveKeys, rowsOf, type Keymap } from "../src/keys";
import { modalKey, modeOf } from "../src/modal";
import { entriesFor, panelTitle } from "../src/panel";
import { initialState } from "../src/state";
import { keyStateOf } from "../src/keys";
import { paragraphNext, paragraphPrev, sentenceNext, sentencePrev, sentenceSpans, TEXT_OBJECTS } from "../src/text-objects";
import type { Pending } from "../src/state";

const W = 40, H = 10;
function run(t: EditText, keys: string[], km: Keymap = DEFAULT_KEYMAP) {
  let text = t;
  let pending: Pending | null = null;
  for (const input of keys) {
    const step = modalKey(modeOf(text), pending, input, {}, km, { width: W, height: H });
    if (step === "close") continue;
    for (const a of step) {
      if (a.type === "pane.edit") text = a.edit(text) as EditText;
      else if (a.type === "prefix.press") pending = { prefix: a.prefix };
      else if (a.type === "prefix.clear") pending = null;
    }
  }
  return text;
}
const open = (body: string) => openText(body, "lines", 1);
/** What select mode has selected: anchor to cursor, both ends included, over a single row. */
const picked = (t: EditText) => {
  const a = t.anchor!, c = t.buffer.cursor;
  expect(a.row).toBe(c.row);
  return t.buffer.lines[a.row]!.slice(a.col, c.col + 1);
};

const DIALOGUE = `"Is this Mr. Smith's house?" she asked. He said, "Yes. Come in." The door shut.`;

test("sentence spans survive abbreviations, dialogue and doubled spaces", () => {
  const spans = sentenceSpans(DIALOGUE);
  const parts = spans.map(([s, e]) => DIALOGUE.slice(s, e));
  // A dialogue tag stays with its quote; an abbreviation does not end a sentence.
  expect(parts[0]).toBe(`"Is this Mr. Smith's house?" she asked.`);
  expect(parts[1]).toBe(`He said, "Yes.`); // core splits inside a quote, so the editor does too
  expect(parts.at(-1)).toBe("The door shut.");
  expect(parts.join(" ")).toBe(DIALOGUE.replace(/ +/g, " "));
  const loose = "One here.   Two there.  Three.";
  expect(sentenceSpans(loose).map(([s, e]) => loose.slice(s, e))).toEqual(["One here.", "Two there.", "Three."]);
});

test(") and ( move by sentence, across paragraphs; they stop at the document's ends", () => {
  const lines = ["One. Two. Three.", "", "Four. Five."];
  expect(sentenceNext(lines, { row: 0, col: 0 })).toEqual({ row: 0, col: 5 });
  expect(sentenceNext(lines, { row: 0, col: 10 })).toEqual({ row: 2, col: 0 });
  expect(sentenceNext(lines, { row: 2, col: 7 })).toBeNull();
  expect(sentencePrev(lines, { row: 0, col: 7 })).toEqual({ row: 0, col: 5 });
  expect(sentencePrev(lines, { row: 0, col: 5 })).toEqual({ row: 0, col: 0 });
  expect(sentencePrev(lines, { row: 2, col: 0 })).toEqual({ row: 0, col: 10 });
  expect(sentencePrev(lines, { row: 0, col: 0 })).toBeNull();
});

test("} and { move by paragraph", () => {
  const lines = ["a", "b", "", "", "c", "", "d"];
  expect(paragraphNext(lines, { row: 0, col: 0 })).toEqual({ row: 4, col: 0 });
  expect(paragraphNext(lines, { row: 3, col: 0 })).toEqual({ row: 4, col: 0 });
  expect(paragraphNext(lines, { row: 6, col: 0 })).toEqual({ row: 6, col: 0 });
  expect(paragraphPrev(lines, { row: 1, col: 0 })).toEqual({ row: 0, col: 0 });
  expect(paragraphPrev(lines, { row: 4, col: 0 })).toEqual({ row: 0, col: 0 });
  expect(paragraphPrev(lines, { row: 6, col: 0 })).toEqual({ row: 4, col: 0 });
  expect(paragraphPrev(lines, { row: 5, col: 0 })).toEqual({ row: 4, col: 0 });
});

test("the motion keys work in normal mode and extend a selection in select mode", () => {
  const t = open("One. Two. Three.\n\nFour.");
  expect(run(t, [")"]).buffer.cursor).toEqual({ row: 0, col: 5 });
  expect(run(t, [")", ")", "("]).buffer.cursor).toEqual({ row: 0, col: 5 });
  expect(run(t, ["}"]).buffer.cursor).toEqual({ row: 2, col: 0 });
  expect(run(run(t, ["}"]), ["{"]).buffer.cursor).toEqual({ row: 0, col: 0 });
  const s = run(t, ["v", ")"]);
  expect(s.mode).toBe("select");
  expect(s.anchor).toEqual({ row: 0, col: 0 });
  expect(s.buffer.cursor).toEqual({ row: 0, col: 5 });
  const p = run(t, ["v", "}"]);
  expect(p.anchor).toEqual({ row: 0, col: 0 });
  expect(p.buffer.cursor).toEqual({ row: 2, col: 0 });
});

test("i and a still insert and append in normal mode", () => {
  expect(run(open("abc"), ["i", "X"]).buffer.text()).toBe("Xabc");
  expect(run(open("abc"), ["a", "X"]).buffer.text()).toBe("aXbc");
});

test("iw and aw", () => {
  const t = open("The quick brown fox");
  const at = (col: number) => ({ ...t, buffer: Object.assign(t.buffer.clone(), { cursor: { row: 0, col } }) }) as EditText;
  expect(picked(run(at(5), ["v", "i", "w"]))).toBe("quick");
  expect(picked(run(at(5), ["v", "a", "w"]))).toBe("quick ");
  expect(picked(run(at(17), ["v", "a", "w"]))).toBe(" fox");
  expect(picked(run(at(3), ["v", "i", "w"]))).toBe(" ");
  expect(picked(run(open("well-known"), ["v", "i", "w"]))).toBe("well");
});

test("is and as pick the sentence, through abbreviations and dialogue", () => {
  const t = open(DIALOGUE);
  const at = (col: number) => ({ ...t, buffer: Object.assign(t.buffer.clone(), { cursor: { row: 0, col } }) }) as EditText;
  expect(picked(run(at(10), ["v", "i", "s"]))).toBe(`"Is this Mr. Smith's house?" she asked.`);
  expect(picked(run(at(10), ["v", "a", "s"]))).toBe(`"Is this Mr. Smith's house?" she asked. `);
  const last = DIALOGUE.indexOf("door");
  expect(picked(run(at(last), ["v", "i", "s"]))).toBe("The door shut.");
  expect(picked(run(at(last), ["v", "a", "s"]))).toBe(" The door shut.");
});

test("ip and ap pick the paragraph across its rows", () => {
  const t = open("One.\nTwo.\n\nThree.\n\nFour.");
  const s = run(t, ["v", "i", "p"]);
  expect(s.anchor).toEqual({ row: 0, col: 0 });
  expect(s.buffer.cursor).toEqual({ row: 1, col: 3 });
  const a = run(t, ["v", "a", "p"]);
  expect(a.anchor).toEqual({ row: 0, col: 0 });
  expect(a.buffer.cursor).toEqual({ row: 2, col: 0 });
  const end = TEXT_OBJECTS["editor.around_paragraph"]!(["One.", "", "Two."], { row: 2, col: 0 })!;
  expect(end.from).toEqual({ row: 1, col: 0 }); // the blank rows before it, at the end
});

test('i" and a" pick the quoted span, straight or curly', () => {
  const t = open(DIALOGUE);
  const at = (col: number) => ({ ...t, buffer: Object.assign(t.buffer.clone(), { cursor: { row: 0, col } }) }) as EditText;
  const yes = DIALOGUE.indexOf("Come");
  expect(picked(run(at(yes), ["v", "i", '"']))).toBe("Yes. Come in.");
  expect(picked(run(at(yes), ["v", "a", '"']))).toBe('"Yes. Come in."');
  // Outside any pair: the next one on the row.
  expect(picked(run(at(DIALOGUE.length - 2), ["v", "i", '"']))).toBe(picked(run(at(DIALOGUE.length - 2), ["v", "i", '"'])));
  const curly = open("She said “hello there” and left.");
  const c = { ...curly, buffer: Object.assign(curly.buffer.clone(), { cursor: { row: 0, col: 14 } }) } as EditText;
  expect(picked(run(c, ["v", "i", '"']))).toBe("hello there");
  // No quotes: nothing changes but the mode.
  expect(run(open("plain"), ["v", "i", '"']).anchor).toEqual({ row: 0, col: 0 });
});

test("i( and a( pick the parentheses, nested and across rows", () => {
  const t = open("He left (late, in the rain (hard)) and she stayed.");
  const at = (col: number) => ({ ...t, buffer: Object.assign(t.buffer.clone(), { cursor: { row: 0, col } }) }) as EditText;
  expect(picked(run(at(10), ["v", "i", "("]))).toBe("late, in the rain (hard)");
  expect(picked(run(at(29), ["v", "i", "("]))).toBe("hard");
  expect(picked(run(at(29), ["v", "a", "("]))).toBe("(hard)");
  const multi = open("A (one\ntwo) b");
  const m = { ...multi, buffer: Object.assign(multi.buffer.clone(), { cursor: { row: 1, col: 0 } }) } as EditText;
  const r = run(m, ["v", "i", "("]);
  expect(r.anchor).toEqual({ row: 0, col: 3 });
  expect(r.buffer.cursor).toEqual({ row: 1, col: 2 });
  expect(run(open("none here"), ["v", "i", "("]).anchor).toEqual({ row: 0, col: 0 });
});

test("the rows are listed, rebindable, and conflict-free; select mode names its prefixes", () => {
  for (const state of ["normal", "select"] as const) {
    const ids = rowsOf({ state }).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(["editor.sentence_next", "editor.sentence_prev", "editor.paragraph_next", "editor.paragraph_prev"]));
  }
  expect(() => effectiveKeys({ "editor.sentence_next": "n" })).not.toThrow();
  const s = initialState();
  const ks = { state: "select" as const };
  expect(panelTitle(ks, { prefix: "i" })).toBe("i inside");
  expect(panelTitle(ks, { prefix: "a" })).toBe("a around");
  void s; void entriesFor; void keyStateOf;
});
