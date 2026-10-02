// The main pane's document: frontmatter hidden, sentence lines read as paragraphs, text sanitised, ids mapped to files.

import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { displayLines, sourceOf, stripFrontmatter } from "../src/document";
import { loadDocument } from "../src/source";

const VAULT = fileURLToPath(new URL("../../cli/test/fixtures/vault", import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), "pablo-tui-doc-"));
  dirs.push(dir);
  cpSync(join(VAULT, "novels", "ice-house"), dir, { recursive: true });
  return dir;
};

test("frontmatter is hidden; text with none, or an unclosed block, is whole", () => {
  expect(stripFrontmatter("---\nchapter: 1\ntitle: x\n---\n\nThe well.")).toBe("The well.");
  expect(stripFrontmatter("The well.\n---\nmore")).toBe("The well.\n---\nmore");
  expect(stripFrontmatter("---\nnever closed\nThe well.")).toBe("---\nnever closed\nThe well.");
  expect(displayLines("---\nstatus: draft\n---\n\nShe waited.", 40)).toEqual(["She waited."]);
});

test("consecutive lines are one wrapped paragraph: a chapter reads the same before and after the sentence split", () => {
  const joined = "The well had been dry since June. She did not look up when the door opened.\n\nEdwin stood in the doorway.";
  const split = "The well had been dry since June.\nShe did not look up when the door opened.\n\nEdwin stood in the doorway.";
  expect(displayLines(split, 30)).toEqual(displayLines(joined, 30));
  expect(displayLines(split, 30)).toEqual(["The well had been dry since", "June. She did not look up when", "the door opened.", "", "Edwin stood in the doorway."]);
  expect(displayLines(split, 80)).toEqual(["The well had been dry since June. She did not look up when the door opened.", "", "Edwin stood in the doorway."]);
});

test("headings and tables keep their own lines; control characters never reach the pane", () => {
  const lines = displayLines("# Acts\n\n| Act | Years |\n| I | 1929 |\n\nOne.\nTwo.\x1b]0;pwned\x07", 40);
  expect(lines).toEqual(["# Acts", "", "| Act | Years |", "| I | 1929 |", "", "One. Two."]);
  expect(lines.join("\n")).not.toContain("\x1b");
});

test("row ids name their files", () => {
  expect(sourceOf("premise")).toEqual({ kind: "files", files: ["bible/overview.md"] });
  expect(sourceOf("beats")).toEqual({ kind: "files", files: ["outline/chapters.md"] });
  expect(sourceOf("chapter:3")).toEqual({ kind: "chapter", number: 3 });
  expect(sourceOf("ch2")).toEqual({ kind: "chapter", number: 2 });
  expect(sourceOf("chapter-12")).toEqual({ kind: "chapter", number: 12 });
  expect(sourceOf("bible")).toEqual({ kind: "bible" });
  expect(sourceOf("notes/x.md")).toEqual({ kind: "path", path: "notes/x.md" });
});

test("loadDocument reads the fixture project: a chapter with its status, a missing one as a notice, nothing outside the project", () => {
  const root = project();
  const ch1 = loadDocument(root, "chapter:1")!;
  expect(ch1.title).toBe("chapters/01-the-last-full-cut.md · draft");
  expect(displayLines(ch1.text, 60)[0]).toContain("The pond rang under the horse");
  expect(displayLines(ch1.text, 60).join("\n")).not.toContain("pov: Odile");
  expect(loadDocument(root, "chapter:2")).toEqual({ title: "chapter 2", text: "Chapter 2 has no draft yet." });
  expect(loadDocument(root, "premise")!.title).toBe("bible/overview.md");
  const bible = loadDocument(root, "bible")!;
  expect(bible.text).toContain("# bible/overview.md");
  expect(bible.text).toContain("# bible/timeline.md");
  expect(loadDocument(root, "../../etc/passwd")).toBeUndefined();
  writeFileSync(join(root, "outline", "chapters.md"), "# Beats\n");
  expect(loadDocument(root, "beats")!.text).toBe("# Beats\n");
});
