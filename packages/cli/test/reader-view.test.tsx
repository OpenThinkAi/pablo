import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import Reader from "../views/reader";
import type { ReaderData } from "../views/reader-protocol";

/**
 * AGT-1586: the view rendered to static markup (react-dom/server: no browser, no window), and bundled the
 * way the ui-leaf binary bundles it (react left to the binary, which embeds its own). What a live window does
 * with a selection or typing needs a real Chrome and is not covered here.
 */
const PATH = "novels/ice-house/chapters/03-the-thaw.md";
const PATH4 = "novels/ice-house/chapters/04-the-flood.md";
const sel = (p: number, a: number, b: number) => ({ start: { paragraph: p, offset: a }, end: { paragraph: p, offset: b } });

const DATA: ReaderData = {
  round: { ref: "OpenThinkAi/ice-house-reading#7", title: "Ice House: chapters 3-4", sender: "matt", id: "atara-2026-10-02" },
  chapters: [
    { path: PATH, number: 3, title: "The Thaw", paragraphs: [{ text: "# The Thaw", prose: false }, { text: "Ice gave way by March. The river rose.", prose: true }] },
    { path: PATH4, number: 4, title: "", paragraphs: [{ text: "The flood came.", prose: true }] },
  ],
  draft: {
    summary: "Mostly lovely.",
    marks: [
      { kind: "comment", path: PATH, selection: sel(1, 0, 22), tag: "keep", body: "I like the opening" },
      { kind: "suggestion", path: PATH, selection: sel(1, 23, 38), replacement: "The river climbed." },
      { kind: "chapter", path: PATH, tag: "fix", body: "The middle drags" },
    ],
  },
};

const noMutate = (async () => ({ ok: true })) as never;
const render = (data: ReaderData): string => renderToStaticMarkup(<Reader data={data} mutate={noMutate} />);

test("a chapter list when the round has several; one chapter's paragraphs with the title, no git or diff words", () => {
  const html = render(DATA);
  expect(html).toContain("Chapters");
  expect(html).toContain("The Thaw");
  expect(html).toContain("Chapter 4"); // untitled chapter: numbered
  expect(html).toContain('data-p="1"');
  expect(html).toContain("Ice gave way by March.");
  expect(html).toContain("Submit");
  for (const word of ["diff", "commit", "branch", "sentence"]) expect(html.toLowerCase()).not.toContain(word);
});

test("a single-chapter round has no chapter list", () => {
  const html = render({ ...DATA, chapters: [DATA.chapters[1] as ReaderData["chapters"][number]], draft: { summary: "", marks: [] } });
  expect(html).not.toContain('aria-label="Chapters"');
  expect(html).toContain("The flood came.");
});

test("marks show inline: comment highlight with its number and tag colour, struck text with the replacement beside it", () => {
  const html = render(DATA);
  expect(html).toContain('class="seg cm keep"');
  expect(html).toContain('data-n="1"');
  expect(html).toContain('class="seg strike ghost"');
  expect(html).toContain('data-ins="The river climbed."');
  // the paragraph's own text is untouched by the markup: struck text is still there, the replacement is CSS-only
  expect(html).toContain(">The river rose.<");
  const paragraph = /<p data-p="1".*?<\/p>/.exec(html)?.[0] ?? "";
  expect(paragraph.replace(/data-ins="[^"]*"/g, "")).not.toContain("climbed");
});

test("restored marks fill the side list, the chapter note and the summary", () => {
  const html = render(DATA);
  expect(html).toContain("Your marks in this chapter");
  expect(html).toContain("I like the opening");
  expect(html).toContain("The middle drags");
  expect(html).toContain("Mostly lovely.");
  expect(html).toContain("2 marks".replace("2", "3")); // comment, suggestion and the chapter note
  expect(html).toContain("Remove");
});

test("a sent round is read-only: no Submit, no Remove, every field disabled, and it says so", () => {
  const html = render({ ...DATA, sent: { reviewUrl: "https://github.com/x/y/pull/7#pullrequestreview-1", sentAt: "2026-10-02T12:00:00Z" } });
  expect(html).toContain("Sent to matt");
  expect(html).not.toContain(">Submit<");
  expect(html).not.toContain("Remove");
  expect(html).not.toContain('contentEditable="plaintext-only"');
  expect(html.match(/<textarea/g)?.length).toBe(html.match(/<textarea[^>]*disabled/g)?.length);
});

test("an empty round and an unsent one render their prompts", () => {
  expect(render({ ...DATA, chapters: [] })).toContain("no chapters");
  const fresh = render({ ...DATA, draft: { summary: "", marks: [] } });
  expect(fresh).toContain("Select some text");
  expect(fresh).toContain("No marks yet");
  expect(fresh).toMatch(/<button[^>]*disabled[^>]*>Submit<\/button>/); // nothing to send yet
});

test("the view bundles the way the ui-leaf binary bundles it (React is the binary's)", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../views/reader.tsx", import.meta.url).pathname],
    external: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"],
    target: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  expect(result.success).toBe(true);
  const text = await result.outputs[0]?.text();
  expect(text).toContain("saveDraft");
  expect(text).toContain("submit");
});
