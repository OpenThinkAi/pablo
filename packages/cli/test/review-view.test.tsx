import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import Review from "../views/review";
import type { ReviewData } from "../views/review-protocol";

/**
 * AGT-1693: the view rendered to static markup (react-dom/server: no browser, no window), and bundled the way
 * the ui-leaf binary bundles it (react left to the binary, which embeds its own). What a live window does
 * with audio, keys and polling needs a real Chrome and is not covered here; the host and the pure logic have
 * their own tests (`review-host.test.ts`, `review-logic.test.ts`).
 */
const DATA: ReviewData = {
  title: "The Lamp Room",
  start: 1,
  chapters: [
    { episode: 1, title: "The First Night", versions: [{ version: 1, duration: 12, created: null, changedLines: 3 }], latest: 1, flags: { human: 1, auto: 2 } },
    { episode: 2, title: "The Second Night", versions: [{ version: 1, duration: 9, created: null, changedLines: 3 }], latest: 1, flags: { human: 0, auto: 0 } },
  ],
};

const noMutate = (async () => []) as never;

test("the chapter list, the dial title, the flag key and the five reasons render on open", () => {
  const html = renderToStaticMarkup(<Review data={DATA} mutate={noMutate} />);
  expect(html).toContain("The Lamp Room");
  expect(html).toContain("Chapters (2)");
  expect(html).toContain("The First Night");
  expect(html).toContain("The Second Night");
  for (const reason of ["Clipped", "Wrong voice", "Flat", "Rushed", "Other"]) expect(html).toContain(reason);
  expect(html).toContain("2 auto"); // the performer's flags are counted per chapter, in their own colour
  expect(html).toContain("1 flagged");
  expect(html).toContain("Tuning in…"); // the first chapter is being fetched
});

test("an empty work says it is waiting and that the list fills in by itself", () => {
  const html = renderToStaticMarkup(<Review data={{ title: "The Lamp Room", start: null, chapters: [] }} mutate={noMutate} />);
  expect(html).toContain("waiting for the first chapter");
  expect(html).toContain("This list fills in by itself.");
  expect(html).toContain("Chapters (0)");
});

test("the view bundles the way the ui-leaf binary bundles it (React is the binary's) and calls only the five mutations", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../views/review.tsx", import.meta.url).pathname],
    external: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"],
    target: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  expect(result.success).toBe(true);
  const text = (await result.outputs[0]?.text()) ?? "";
  const called = new Set([...text.matchAll(/mutate\(\s*"([A-Za-z]+)"/g)].map((m) => m[1]));
  expect([...called].sort()).toEqual(["flag", "listChapters", "loadTrack", "setVersion", "unflag"]);
});
