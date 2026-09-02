/**
 * Reading a writing vault into pack inputs.
 *
 * This is the only file in `pack/` that touches a disk, and it is deliberately
 * separate from `assemble.ts`: assembly is pure over its inputs, so a test can
 * build a pack from literals and a caller can build one from anywhere. Every
 * function here is a small parser over a format the vault already uses, none of
 * which pablo invented:
 *
 *     <vault>/style/*.md                      the shared prose guide
 *     <work>/QWEN.md                          the work's own rules
 *     <work>/bible/timeline.md                | year | real events | in the novel |
 *     <work>/bible/places.md                  places
 *     <work>/bible/characters/family-tree.md  the cast
 *     <work>/outline/chapters.md              | # | story date | title | beat | POV | status |
 *     <work>/continuity.md                    what the text has established
 *     <work>/chapters/NN-slug.md              the manuscript
 *
 * A missing file is not an error: a work with no continuity ledger yet gets a
 * pack without that slice, and the dry-run table shows it is not there.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { BeatRow, DraftingInputs, TextSource, TimelineGate, WorkIdentity } from "./types";

/** Words of the previous chapter carried into a drafting pack, as `draft-chapter` sends. */
export const DEFAULT_TAIL_WORDS = 500;

/** Where the period-and-place facts live in a work's `QWEN.md`, per the vault's novel template. */
export const PERIOD_FACTS_SECTION = "## Setting and period facts";
const PERIOD_FACTS_END = "## The files";

export interface ReadDraftingOptions {
  /** The vault root (`~/writing`), which holds `style/`. */
  readonly vaultRoot: string;
  /** The work root (`<vault>/novels/<slug>`). */
  readonly workRoot: string;
  readonly chapter: number;
  readonly wordTarget: number;
  readonly minScenes?: number | undefined;
  readonly tailWords?: number | undefined;
  /**
   * Heading the cast file is cut at, exclusive: a family tree usually ends in
   * open questions addressed to the author, which are not facts for the model.
   */
  readonly castEndsAt?: string | undefined;
  /** Heading the places file starts at, for a file that opens with rejected options. */
  readonly placesStartsAt?: string | undefined;
  /** Overrides the title parsed from the work's `QWEN.md`. */
  readonly work?: Partial<WorkIdentity> | undefined;
}

/**
 * Assembles the drafting inputs for one chapter. Throws only when the chapter
 * has no row in the outline, which is the one thing a pack cannot be built
 * without.
 */
export function readDraftingInputs(options: ReadDraftingOptions): DraftingInputs {
  const { vaultRoot, workRoot, chapter } = options;
  const outlinePath = join(workRoot, "outline", "chapters.md");
  const beat = parseBeatRow(read(outlinePath) ?? "", chapter, label(vaultRoot, outlinePath));
  if (beat === undefined) {
    throw new Error(`pablo: chapter ${chapter} has no row in ${outlinePath}`);
  }

  const workRulesPath = join(workRoot, "QWEN.md");
  const workRules = read(workRulesPath) ?? "";
  const timelinePath = join(workRoot, "bible", "timeline.md");

  return {
    work: {
      title: options.work?.title ?? parseWorkTitle(workRules) ?? basename(workRoot),
      description: options.work?.description,
    },
    beat,
    style: readStyle(vaultRoot),
    periodFacts: source(
      vaultRoot,
      workRulesPath,
      section(workRules, { from: PERIOD_FACTS_SECTION, to: PERIOD_FACTS_END }),
    ),
    cast: sourceOfFile(vaultRoot, join(workRoot, "bible", "characters", "family-tree.md"), (text) =>
      section(text, { to: options.castEndsAt }),
    ),
    places: sourceOfFile(vaultRoot, join(workRoot, "bible", "places.md"), (text) =>
      section(text, { from: options.placesStartsAt }),
    ),
    timeline: gateTimeline(read(timelinePath) ?? "", beat.storyDate, label(vaultRoot, timelinePath)),
    continuity: sourceOfFile(vaultRoot, join(workRoot, "continuity.md")),
    previousTail: readPreviousTail(vaultRoot, workRoot, chapter, options.tailWords ?? DEFAULT_TAIL_WORDS),
    wordTarget: options.wordTarget,
    minScenes: options.minScenes,
  };
}

/** `<vault>/style/*.md`, sorted by filename so the pack is the same on every machine. */
export function readStyle(vaultRoot: string): readonly TextSource[] {
  const dir = join(vaultRoot, "style");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      const text = read(path);
      return text === undefined || text.trim() === "" ? [] : [{ path: label(vaultRoot, path), text }];
    });
}

/** The work's own rules file, for a span edit. */
export function readWorkRules(vaultRoot: string, workRoot: string): TextSource | undefined {
  return sourceOfFile(vaultRoot, join(workRoot, "QWEN.md"));
}

/** A markdown file read into a `TextSource`, or `undefined` when it is absent or empty. */
export function readTextSource(vaultRoot: string, path: string): TextSource | undefined {
  return sourceOfFile(vaultRoot, path);
}

/**
 * The slice of a markdown file between two headings: `from` inclusive, `to`
 * exclusive. Either end may be omitted. An absent heading means the whole file,
 * because a missing section is not worth failing a draft over.
 */
export function section(text: string, bounds: { from?: string | undefined; to?: string | undefined }): string {
  let result = text;
  if (bounds.from !== undefined) {
    const at = result.indexOf(bounds.from);
    if (at >= 0) result = result.slice(at);
  }
  if (bounds.to !== undefined) {
    const at = result.indexOf(bounds.to);
    if (at >= 0) result = result.slice(0, at);
  }
  return result.trim();
}

/**
 * One row of the outline's chapter table.
 *
 * The columns are the vault's, and the design doc's:
 * `| # | story date | title | beat | POV | status |`. Anything after the sixth
 * column is ignored; a short row leaves the missing fields empty.
 */
export function parseBeatRow(outline: string, chapter: number, source: string): BeatRow | undefined {
  for (const line of outline.split("\n")) {
    const match = /^\s*\|\s*(\d+)\s*\|(.*)$/.exec(line);
    if (match === null || Number(match[1]) !== chapter) continue;
    const cells = (match[2] ?? "").split("|").map((cell) => cell.trim());
    return {
      chapter,
      storyDate: cells[0] ?? "",
      title: cells[1] ?? "",
      beat: cells[2] ?? "",
      pov: cells[3] ?? "",
      status: cells[4] ?? "",
      source,
    };
  }
  return undefined;
}

/**
 * The story-time gate: `bible/timeline.md` split by the chapter's story date
 * into what is already true and what does not exist yet.
 *
 * The chapter's year is the first four-digit year in its story date; a row's
 * year is the first column. A chapter with no year in its date gates nothing
 * (every row lands in "already true"), which fails safe: the model is told
 * more than it needs rather than told a fact is forbidden when it is not.
 */
export function gateTimeline(timeline: string, storyDate: string, source: string): TimelineGate {
  const chapterYear = yearIn(storyDate) ?? Number.POSITIVE_INFINITY;
  const exists: string[] = [];
  const later: string[] = [];

  for (const line of timeline.split("\n")) {
    const match = /^\s*\|\s*(\d{4})\s*\|([^|]*)\|([^|]*)\|/.exec(line);
    if (match === null) continue;
    const year = Number(match[1]);
    const items = [(match[2] ?? "").trim(), (match[3] ?? "").trim()].filter((item) => item !== "").join("; ");
    if (items === "") continue;
    (year <= chapterYear ? exists : later).push(`- ${year}: ${items}`);
  }

  return { exists, later, source };
}

/** The last `words` words of a chapter file, frontmatter stripped. */
export function chapterTail(chapterText: string, words: number): string {
  const body = chapterText.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "");
  const tokens = body.split(/\s+/).filter((word) => word !== "");
  return tokens.slice(Math.max(0, tokens.length - words)).join(" ");
}

/** The title from a work's `QWEN.md` first heading, without the "(working title)" suffix. */
export function parseWorkTitle(workRules: string): string | undefined {
  const match = /^#\s+(.+?)\s*$/m.exec(workRules);
  if (match === null) return undefined;
  const title = (match[1] ?? "").replace(/\s*\(working title\)\s*$/i, "").trim();
  return title === "" ? undefined : title;
}

function readPreviousTail(
  vaultRoot: string,
  workRoot: string,
  chapter: number,
  words: number,
): TextSource | undefined {
  if (chapter <= 1) return undefined;
  const dir = join(workRoot, "chapters");
  if (!existsSync(dir)) return undefined;
  const prefix = `${String(chapter - 1).padStart(2, "0")}-`;
  const name = readdirSync(dir)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".md"))
    .sort()[0];
  if (name === undefined) return undefined;
  const path = join(dir, name);
  const text = read(path);
  if (text === undefined) return undefined;
  const tail = chapterTail(text, words);
  return tail === "" ? undefined : { path: label(vaultRoot, path), text: tail };
}

function sourceOfFile(
  vaultRoot: string,
  path: string,
  transform: (text: string) => string = (text) => text.trim(),
): TextSource | undefined {
  return source(vaultRoot, path, transform(read(path) ?? ""));
}

function source(vaultRoot: string, path: string, text: string): TextSource | undefined {
  return text.trim() === "" ? undefined : { path: label(vaultRoot, path), text };
}

/** Paths in a pack are vault-relative: the table stays readable and the receipt stays portable. */
function label(vaultRoot: string, path: string): string {
  const inside = relative(vaultRoot, path);
  return inside.startsWith("..") ? path : inside;
}

function read(path: string): string | undefined {
  if (!existsSync(path) || !statSync(path).isFile()) return undefined;
  return readFileSync(path, "utf8");
}

function yearIn(text: string): number | undefined {
  const match = /(1[89]\d{2}|20\d{2})/.exec(text);
  return match === null ? undefined : Number(match[1]);
}
