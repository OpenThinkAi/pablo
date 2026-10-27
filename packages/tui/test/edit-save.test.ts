// AGT-2168: the edit pane's storage round-trip. Property-style: every paragraph of the fixture chapter (hard-wrapped,
// not one sentence per line) is edited in turn, and the stored file must differ only on that paragraph's lines.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { splitManuscript } from "@openthink/pablo-core";
import { loadForEdit, saveEdited } from "../src/edit-save";

const FIXTURE = fileURLToPath(new URL("../../core/test/fixtures/vault/novels/ice-house/chapters/01-the-last-full-cut.md", import.meta.url));
const chapter = readFileSync(FIXTURE, "utf8");

const frontmatterOf = (raw: string) => raw.slice(0, raw.indexOf("\n---", 4) + 5);

/** The lines that differ between two texts, as the unchanged prefix and suffix around them: a minimal line diff. */
function changedRange(before: string, after: string): { prefix: number; a: string[]; b: string[] } {
  const a = before.split("\n"), b = after.split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { prefix, a: a.slice(prefix, a.length - suffix), b: b.slice(prefix, b.length - suffix) };
}

/** A tiny seeded PRNG, so the "random" edits are the same every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("sentences storage", () => {
  test("the fixture is hard-wrapped, so a whole-body re-split would change it (the spike's bug)", () => {
    const { text } = loadForEdit(chapter);
    expect(frontmatterOf(chapter) + "\n" + splitManuscript(text) + "\n").not.toBe(chapter);
  });

  test("opening and saving an unedited hard-wrapped chapter is a zero diff", () => {
    const { text } = loadForEdit(chapter);
    expect(text.split("\n\n").every((p) => !p.includes("\n"))).toBe(true);
    expect(saveEdited(chapter, text)).toBe(chapter);
  });

  test("a zero diff for files with no frontmatter, CRLF line ends, no final line end, trailing blank lines and Markdown blocks", () => {
    const cases = [
      "One line\nwrapped here.\n\nTwo.\n",
      "---\na: 1\n---\nNo blank line under the frontmatter.\nWrapped.\n",
      "---\r\na: 1\r\n---\r\n\r\nCRLF prose\r\nwrapped. Two sentences.\r\n\r\nNext.\r\n",
      "No final line end.\n\nLast paragraph",
      "\n\nLeading blanks.\n\n\n\nThree blank lines above.\n\n\n",
      "# Heading\n\n- a list\n- of items\n\n| a | b |\n|---|---|\n\nProse after.\n",
      "﻿---\nbom: true\n---\n\nText.\n",
      "",
      "---\nonly: frontmatter\n---\n",
    ];
    for (const raw of cases) expect(saveEdited(raw, loadForEdit(raw).text)).toBe(raw);
  });

  test("editing any one paragraph changes only that paragraph's lines, and the frontmatter is byte for byte", () => {
    const paragraphs = loadForEdit(chapter).text.split("\n\n");
    const original = chapter.split("\n");
    expect(paragraphs.length).toBeGreaterThan(2);
    const next = rng(2168);
    for (let i = 0; i < paragraphs.length; i++) {
      const words = paragraphs[i]!.split(" ");
      const at = Math.floor(next() * words.length);
      const edited = paragraphs.map((p, k) => (k === i ? [...words.slice(0, at), "Quietly.", ...words.slice(at)].join(" ") : p)).join("\n\n");
      const saved = saveEdited(chapter, edited);
      expect(saved.startsWith(frontmatterOf(chapter))).toBe(true);
      const { prefix, a, b } = changedRange(chapter, saved);
      // The removed lines are exactly paragraph i's stored lines, nothing either side.
      const storedBlocks = chapter.slice(frontmatterOf(chapter).length).trim().split("\n\n");
      expect(a.join("\n")).toBe(storedBlocks[i]!);
      expect(original[prefix - 1]).toBe("");
      // ...and the added lines are that paragraph, one sentence per line.
      expect(b.join("\n")).toBe(splitManuscript(edited.split("\n\n")[i]!));
    }
  });

  test("random multi-paragraph edits: untouched paragraphs keep their stored bytes", () => {
    const next = rng(7);
    const stored = chapter.slice(frontmatterOf(chapter).length).trim().split("\n\n");
    for (let round = 0; round < 40; round++) {
      let paragraphs = loadForEdit(chapter).text.split("\n\n").map((text, k) => ({ text, k }));
      const op = Math.floor(next() * 3);
      const at = Math.floor(next() * paragraphs.length);
      if (op === 0) paragraphs.splice(at, 1);
      else if (op === 1) paragraphs.splice(at, 0, { text: "A new paragraph. It has two sentences.", k: -1 });
      else paragraphs[at] = { text: paragraphs[at]!.text + " Added.", k: -1 };
      const saved = saveEdited(chapter, paragraphs.map((p) => p.text).join("\n\n"));
      expect(saved.startsWith(frontmatterOf(chapter))).toBe(true);
      const out = saved.slice(frontmatterOf(chapter).length).trim().split("\n\n");
      expect(out.length).toBe(paragraphs.length);
      paragraphs.forEach((p, j) => expect(out[j]).toBe(p.k >= 0 ? stored[p.k]! : splitManuscript(p.text)));
      // Saving the saved file's own text again is stable.
      expect(saveEdited(saved, loadForEdit(saved).text)).toBe(saved);
    }
  });

  test("CRLF files get CRLF in re-split paragraphs too", () => {
    const raw = "---\r\na: 1\r\n---\r\n\r\nFirst one.\r\n\r\nSecond.\r\n";
    const saved = saveEdited(raw, "First one.\n\nSecond. And a third.");
    expect(saved).toBe("---\r\na: 1\r\n---\r\n\r\nFirst one.\r\n\r\nSecond.\r\nAnd a third.\r\n");
  });

  test("a body written into an empty file sits a blank line under the frontmatter", () => {
    expect(saveEdited("---\na: 1\n---\n", "Hello there. Bye.")).toBe("---\na: 1\n---\n\nHello there.\nBye.\n");
    expect(saveEdited("", "Hello.")).toBe("Hello.\n");
  });
});

const RADIO = "---\nepisode: 1\n---\n\nCAST: NED (gruff), MAE (bright)\n\nNED: Hold the lamp. No, higher.\nMAE: [laugh] It's as high as it goes.\n\n(SFX: ice cracking)\n";
const FOUNTAIN = "---\nscene: 1\n---\n\nINT. ICE HOUSE - NIGHT\n\nOdile counts. Twice. She stops.\n\nMARCEL\n(quietly)\nIt rang. Did you hear it?\n";

describe.each([["lines", RADIO], ["screenplay", FOUNTAIN]] as const)("%s storage", (storage, raw) => {
  test("the pane shows the stored lines as they are", () => {
    expect(loadForEdit(raw, storage).text).toBe(raw.slice(raw.indexOf("---\n\n", 4) + 5).replace(/\n$/, ""));
  });

  test("an unedited save is a zero diff", () => {
    expect(saveEdited(raw, loadForEdit(raw, storage).text, storage)).toBe(raw);
  });

  test("the edit is stored exactly as typed, never joined or sentence-split", () => {
    const text = loadForEdit(raw, storage).text;
    const edited = text.replace(/\. /, ". Then two. Sentences on one line.\nAnd a new line ");
    const saved = saveEdited(raw, edited, storage);
    expect(saved).toBe(frontmatterOf(raw) + "\n" + edited + "\n");
    // A line with several sentences stays one line.
    expect(saved).toContain(". Then two. Sentences on one line.\n");
  });

  test("frontmatter is byte for byte", () => {
    const saved = saveEdited(raw, "Totally new.\nLines.", storage);
    expect(saved.startsWith(frontmatterOf(raw) + "\n")).toBe(true);
    expect(saved.endsWith("Totally new.\nLines.\n")).toBe(true);
  });
});
