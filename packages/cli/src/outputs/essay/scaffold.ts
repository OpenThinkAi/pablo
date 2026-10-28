/**
 * An essay on a fiction track starts from a thesis and an outline (AGT-2135, pm project `pablo-platform`, D-7).
 *
 * `pablo output add essay` on a fiction or historical-fiction work asks for the thesis (`--thesis "<text>"`; the
 * CLI prompts for it on a terminal) and writes two files beside the plan:
 *
 *     outputs/essay/thesis.md    the one thing the essay argues about the story
 *     outputs/essay/outline.md   | # | Section | What it covers |, the essay's sections
 *
 * The outline is drawn from the story core: the story itself (`bible/overview.md`), the world it is drawn from (the
 * timeline and the distilled period facts), one section per act (`outline/beats.md`'s acts table) and what the
 * story argues. The author edits it like any core outline; a section's pack carries it whole. Nothing here reads
 * `research/`: the essay draws on what the core distilled from it (D-10).
 *
 * On nonfiction the thesis and outline are the core's (`core/thesis.md`, `core/outline.md`), so `--thesis` is
 * refused there.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readCoreState } from "../../core/machine";
import type { ActRow } from "../../core/machine";
import { hasProse, THESIS_FILE } from "../../core/nonfiction";
import type { ScaffoldOptions, ScaffoldOutcome } from "../types";
import { essayTrack, ESSAY_OUTLINE_FILE, ESSAY_THESIS_FILE } from "./sections";

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** An act's section title: `Act I` for an act named `I`, the act's own name when it already says so. */
export function actTitle(act: ActRow): string {
  const name = act.act.trim();
  return /^act\b/i.test(name) ? name : `Act ${name}`;
}

/** The default outline's rows over the core's acts: the story, its world, each act, the argument. Titles are unique. */
export function fictionEssaySections(acts: readonly ActRow[]): { readonly title: string; readonly covers: string }[] {
  const rows = [
    { title: "The story", covers: "what the story is and what happens in it (the overview and the cast), set against the thesis" },
    { title: "The world it is drawn from", covers: "the period and place the story keeps to: the timeline and the period facts" },
    ...acts.map((a) => ({ title: actTitle(a), covers: [a.summary.trim(), a.years.trim() === "" ? "" : `(${a.years.trim()})`].filter((p) => p !== "").join(" ") })),
    { title: "What the story argues", covers: "what the story shows about the thesis, and why it is told" },
  ];
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const key = r.title.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n === 1 ? r : { ...r, title: `${r.title} (${n})` };
  });
}

/** `outputs/essay/outline.md`'s text for `acts`. */
export function renderFictionEssayOutline(acts: readonly ActRow[]): string {
  return [
    "# Essay outline",
    "",
    "The essay's sections, in order, drawn from the story core. Edit them freely: a section's",
    "title is its heading in `essay.md`, and what it covers is its brief to the writer.",
    "",
    "| # | Section | What it covers |",
    "|---|---|---|",
    ...fictionEssaySections(acts).map((r, i) => `| ${i + 1} | ${cell(r.title)} | ${cell(r.covers)} |`),
    "",
  ].join("\n");
}

/**
 * The thesis an on-demand `pablo story` run assumes when it adds the essay with nobody to ask (AGT-2135): the work's
 * premise (`bible/overview.md`'s `## Premise`, else its `## Logline`), first paragraph. Undefined when it has neither.
 */
export function assumedThesis(workDir: string): string | undefined {
  const path = join(workDir, "bible", "overview.md");
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  for (const heading of ["Premise", "Logline"]) {
    const match = new RegExp(`^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "m").exec(text);
    const paragraph = (match?.[1] ?? "").trim().split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim();
    if (paragraph !== undefined && paragraph !== "") return paragraph;
  }
  return undefined;
}

/** `outputs/essay/thesis.md`'s text for `thesis`. */
export function renderThesis(thesis: string): string {
  return `# Thesis\n\n${thesis.trim()}\n`;
}

/** `OUTPUTS.essay.scaffold`: on a fiction track the thesis and the outline; on nonfiction nothing (the core has both). */
export function essayScaffold(workDir: string, options: ScaffoldOptions): ScaffoldOutcome {
  const track = essayTrack(workDir);
  const thesis = options.thesis?.trim() || undefined;
  if (track === "nonfiction") {
    if (thesis !== undefined) {
      return { ok: false, message: `on nonfiction the essay argues ${THESIS_FILE}; --thesis is for an essay on a fiction track`, missing: [] };
    }
    return { ok: true, files: [] };
  }
  const thesisPath = join(workDir, ESSAY_THESIS_FILE);
  const written = existsSync(thesisPath) && hasProse(readFileSync(thesisPath, "utf8"));
  if (written && thesis !== undefined) {
    return { ok: false, message: `${ESSAY_THESIS_FILE} already has a thesis; edit it there instead of passing --thesis`, missing: [] };
  }
  if (!written && thesis === undefined) {
    return {
      ok: false,
      message: "an essay on a fiction track argues a thesis about the story; give it with --thesis \"<the one thing the essay argues>\"",
      missing: ["--thesis: the one thing the essay argues about the story"],
      ask: "thesis",
    };
  }
  const files: { rel: string; content: string }[] = [];
  if (thesis !== undefined) files.push({ rel: ESSAY_THESIS_FILE, content: renderThesis(thesis) });
  files.push({ rel: ESSAY_OUTLINE_FILE, content: renderFictionEssayOutline(readCoreState(workDir, track).acts) });
  return { ok: true, files };
}
