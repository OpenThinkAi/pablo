import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assemblePack,
  chapterTail,
  CRAFT_RULES,
  gateTimeline,
  PACK_BUDGETS,
  parseBeatRow,
  readDraftingInputs,
  readStyle,
  section,
} from "../src/index";

/**
 * The fixture vault under `fixtures/vault` is synthetic: the real layout,
 * filenames, frontmatter and table shapes, with an invented novel in them. The
 * pack is tested against the *structure* of a writing vault, never against a
 * manuscript.
 */
const VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const WORK = join(VAULT, "novels", "ice-house");

test("the shared style guide is read in a stable order, with vault-relative paths", () => {
  const style = readStyle(VAULT);

  expect(style.map((source) => source.path)).toEqual(["style/anti-tells.md", "style/prose.md"]);
  expect(style[1]?.text).toContain("No em-dashes anywhere");
});

test("a beat row is read out of the outline's chapter table", () => {
  const outline = `| # | Story date | Title (working) | Beat | POV | Status |
|---|---|---|---|---|---|
| 2 | Winter 1931 | Black Ice | Wilfred puts the crew out on thin ice. | Odile | outline |`;

  expect(parseBeatRow(outline, 2, "outline/chapters.md")).toEqual({
    chapter: 2,
    storyDate: "Winter 1931",
    title: "Black Ice",
    beat: "Wilfred puts the crew out on thin ice.",
    pov: "Odile",
    status: "outline",
    source: "outline/chapters.md",
  });
  expect(parseBeatRow(outline, 9, "outline/chapters.md")).toBeUndefined();
});

test("the timeline is gated by the chapter's story date", () => {
  const timeline = `| Year | Real events | In the novel |
|---|---|---|
| 1922 | first electric refrigerators sold | the route loses a third of its stops |
| 1931 | | the January cut is thin |
| 1938 | the September hurricane | the schooner is lost |`;

  const gate = gateTimeline(timeline, "Winter 1931", "bible/timeline.md");

  expect(gate.exists).toEqual([
    "- 1922: first electric refrigerators sold; the route loses a third of its stops",
    "- 1931: the January cut is thin",
  ]);
  expect(gate.later).toEqual(["- 1938: the September hurricane; the schooner is lost"]);
});

test("a story date with no year gates nothing away", () => {
  const timeline = "| Year | Real | Novel |\n|---|---|---|\n| 1938 | a storm | |";
  expect(gateTimeline(timeline, "harvest, some autumn", "t.md").later).toEqual([]);
});

test("a section is cut between two headings, and a missing heading is not an error", () => {
  const text = "# Title\n\nlead\n\n## Facts\n\none\n\n## The files\n\nlisting\n";

  expect(section(text, { from: "## Facts", to: "## The files" })).toBe("## Facts\n\none");
  expect(section(text, { from: "## Nowhere" })).toBe(text.trim());
  expect(section(text, { to: "## Nowhere" })).toBe(text.trim());
});

test("the previous chapter's tail is the last N words, without its frontmatter", () => {
  const chapter = "---\nchapter: 1\ntitle: The Last Full Cut\n---\n\nalpha beta gamma delta epsilon\n";

  expect(chapterTail(chapter, 3)).toBe("gamma delta epsilon");
  expect(chapterTail(chapter, 99)).toBe("alpha beta gamma delta epsilon");
  expect(chapterTail(chapter, 3)).not.toContain("chapter: 1");
});

test("reading the vault produces the drafting inputs for a chapter", () => {
  const inputs = readDraftingInputs({ vaultRoot: VAULT, workRoot: WORK, chapter: 2, wordTarget: 1800 });

  expect(inputs.work.title).toBe("The Ice House");
  expect(inputs.beat.title).toBe("Black Ice");
  expect(inputs.beat.storyDate).toBe("Winter 1931");
  expect(inputs.beat.pov).toBe("Odile");
  expect(inputs.periodFacts?.path).toBe("novels/ice-house/QWEN.md");
  expect(inputs.periodFacts?.text).toContain("Penobscot Bay");
  expect(inputs.periodFacts?.text).not.toContain("## The files");
  expect(inputs.cast?.text).toContain("Odile Nadeau");
  expect(inputs.places?.text).toContain("Sable Pond");
  expect(inputs.continuity?.text).toContain("green ledger");
  expect(inputs.previousTail?.path).toBe("novels/ice-house/chapters/01-the-last-full-cut.md");
  expect(inputs.previousTail?.text).toContain("three hundred and four pounds");
  expect(inputs.timeline.exists.some((row) => row.startsWith("- 1929"))).toBe(true);
  expect(inputs.timeline.later.some((row) => row.startsWith("- 1942"))).toBe(true);
});

test("the cast file can be cut at the author's own open questions", () => {
  const inputs = readDraftingInputs({
    vaultRoot: VAULT,
    workRoot: WORK,
    chapter: 2,
    wordTarget: 1800,
    castEndsAt: "## Decisions for the author",
  });

  expect(inputs.cast?.text).toContain("Marcel Thibodeau");
  expect(inputs.cast?.text).not.toContain("Decisions for the author");
});

test("chapter one has no previous tail, and an unknown chapter is an error", () => {
  expect(readDraftingInputs({ vaultRoot: VAULT, workRoot: WORK, chapter: 1, wordTarget: 900 }).previousTail).toBeUndefined();
  expect(() => readDraftingInputs({ vaultRoot: VAULT, workRoot: WORK, chapter: 44, wordTarget: 900 })).toThrow(
    /chapter 44 has no row/,
  );
});

test("the drafting pack assembles draft-chapter's slices, in draft-chapter's order", () => {
  const inputs = readDraftingInputs({ vaultRoot: VAULT, workRoot: WORK, chapter: 2, wordTarget: 1800 });
  const pack = assemblePack("drafting", inputs);

  expect(pack.slices.map((slice) => slice.name)).toEqual([
    "brief",
    "chapter",
    "style",
    "craft",
    "period",
    "cast",
    "places",
    "timeline",
    "continuity",
    "previousTail",
    "task",
  ]);
  expect(pack.kind).toBe("drafting");
  expect(pack.budgetTokens).toBe(PACK_BUDGETS.drafting);
  expect(pack.withinBudget).toBe(true);
  expect(pack.adjustments).toEqual([]);
  expect(pack.context).toBe(pack.prompt);

  expect(pack.prompt).toContain('working title "The Ice House"');
  expect(pack.prompt).toContain("- Beat: A thin January.");
  expect(pack.prompt).toContain("# What exists at this chapter's date");
  expect(pack.prompt).toContain("## Already true by this chapter");
  expect(pack.prompt).toContain("Do not mention or foreshadow them.");
  expect(pack.prompt).toContain("- 1942: the cannery converts to mechanical ice");

  // The story-time gate: a 1942 fact is in the "not yet" half, not the "already
  // true" half, for a chapter dated 1931.
  const timeline = pack.slices.find((slice) => slice.name === "timeline")?.text ?? "";
  const boundary = timeline.indexOf("## Not yet");
  expect(timeline.indexOf("- 1929:")).toBeLessThan(boundary);
  expect(timeline.indexOf("- 1942:")).toBeGreaterThan(boundary);
});

test("a drafting pack always carries the anti-tell rules and asks for scenes as well as words", () => {
  const bare = readDraftingInputs({ vaultRoot: VAULT, workRoot: WORK, chapter: 1, wordTarget: 1200, minScenes: 4 });
  const withoutVaultStyle = assemblePack("drafting", { ...bare, style: [] });

  expect(withoutVaultStyle.slices.map((slice) => slice.name)).toContain("craft");
  expect(withoutVaultStyle.prompt).toContain(CRAFT_RULES);
  expect(withoutVaultStyle.prompt).toContain("Do not restate the brief.");
  expect(withoutVaultStyle.prompt).toContain("on what it meant");
  expect(withoutVaultStyle.prompt).toContain("in at least 4 scenes");
  expect(withoutVaultStyle.prompt).toContain("About 1200 words");
  expect(withoutVaultStyle.expectedOutputTokens).toBe(Math.ceil(1200 * 2.2));

  // Even squeezed to nothing, the craft rules and the ask survive.
  const squeezed = assemblePack("drafting", bare, { budgetTokens: 300 });
  expect(squeezed.prompt).toContain(CRAFT_RULES);
  expect(squeezed.prompt).toContain("in at least 4 scenes");
  expect(squeezed.adjustments.length).toBeGreaterThan(0);
});

test("the drafting pack is deterministic over the fixture vault", () => {
  const first = assemblePack("drafting", readDraftingInputs({ vaultRoot: VAULT, workRoot: WORK, chapter: 2, wordTarget: 1800 }));
  const second = assemblePack("drafting", readDraftingInputs({ vaultRoot: VAULT, workRoot: WORK, chapter: 2, wordTarget: 1800 }));

  expect(second.hash).toBe(first.hash);
  expect(second.prompt).toBe(first.prompt);
});
