/**
 * The story core's stage machine (AGT-1667, pm project `pablo-story-core`,
 * "The core: what lives there and its stage machine"): what is true of the
 * story regardless of how it is told, shared by every output the work has.
 *
 *     premise        bible/overview.md has text under ## Logline
 *     research       research/ has files (optional: never short)
 *     bible          bible/characters/*.md, places.md, timeline.md
 *     acts           the | Act | table in the beats file
 *     beats          one row per story unit in the beats file
 *     facts decided  no [pick] left; checked per unit (`undecidedPicks`)
 *
 * The output layer (the novel's chapters today, `novel/machine.ts`) sits on
 * top: a unit's own preconditions (the previous unit, the timeline year gate)
 * are the output's, not the core's.
 *
 * `readCoreState` does the only disk I/O here; everything else is pure over
 * the state it returns.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { beatsFile, parseBeatRows, section } from "@openthink/pablo-core";
import type { BeatRow } from "@openthink/pablo-core";

/** One of `bible/characters/*.md`, `bible/places.md`, `bible/timeline.md`. */
export interface BibleFile {
  readonly file: string;
  readonly exists: boolean;
}

/** One `[pick]` placeholder found in a bible file's table rows. */
export interface PickRow {
  readonly file: string;
  readonly name: string;
}

/** One row of the first `| Act | ... |` table in the beats file (`outline/beats.md`, or `outline/chapters.md` unmigrated). */
export interface ActRow {
  readonly act: string;
  readonly years: string;
  readonly summary: string;
}

/** The core's stages, in the order the design's core table lists them. */
export const CORE_STAGE_IDS = ["premise", "research", "bible", "acts", "beats", "facts"] as const;
export type CoreStageId = (typeof CORE_STAGE_IDS)[number];

/** One core stage as `status` and `resume` report it. */
export interface CoreStage {
  readonly id: CoreStageId;
  /** Met. An optional stage (research) that is not met is never what makes the core short. */
  readonly done: boolean;
  /** The stage is optional per policy: unmet, it is reported but does not block. */
  readonly optional?: true;
  /** One short line: `ok`, `3 files, 1 [pick] row`, `4 rows`. */
  readonly summary: string;
  /** What is absent, by file, when the stage is not met. */
  readonly missing: readonly string[];
}

export interface CoreState {
  /** `bible/overview.md` exists and has non-empty text under `## Logline`. */
  readonly premise: boolean;
  /** Work-relative paths of the files under `research/` (never sent to a writer; presence only). */
  readonly research: readonly string[];
  readonly bible: {
    readonly files: readonly BibleFile[];
    readonly picks: readonly PickRow[];
    /**
     * The raw text of `bible/timeline.md` (`""` if it does not exist), so an
     * output's preconditions can run the story-time gate purely over the
     * state, without a second disk read.
     */
    readonly timelineText: string;
  };
  readonly acts: readonly ActRow[];
  readonly beats: readonly BeatRow[];
  /**
   * The work-relative beats file the acts and beats were read from:
   * `outline/beats.md` on a migrated work, `outline/chapters.md` (the old
   * name, shimmed) on an unmigrated one. Messages name it.
   */
  readonly outlineFile: string;
}

const PICK_TOKEN = "[pick]";

function read(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** The next `## ` heading line after the first occurrence of `heading`, if any. */
function nextHeadingAfter(text: string, heading: string): string | undefined {
  const idx = text.indexOf(heading);
  if (idx < 0) return undefined;
  const match = /\n(##\s[^\n]*)/.exec(text.slice(idx + heading.length));
  return match?.[1];
}

/** True if `overviewText` has a `## Logline` heading with non-empty prose under it. */
function hasLogline(overviewText: string): boolean {
  if (!overviewText.includes("## Logline")) return false;
  const raw = section(overviewText, { from: "## Logline", to: nextHeadingAfter(overviewText, "## Logline") });
  const body = raw.replace(/^##[^\n]*\n?/, "").trim();
  return body !== "";
}

/**
 * `[pick]` rows in `text`'s TABLE ROWS ONLY (lines starting with `|`) — a
 * bullet like family-tree.md's own "`[pick]` marks a placeholder" legend is
 * not a cast row and must not be flagged. `name` is the row's first cell
 * with the literal `[pick]` token removed, whitespace-collapsed and trimmed
 * (`"Ortega grandchild [pick]"` -> `"Ortega grandchild"`).
 */
function parsePicks(text: string, fileLabel: string): PickRow[] {
  const picks: PickRow[] = [];
  for (const line of text.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    if (!line.includes(PICK_TOKEN)) continue;
    const cells = line.split("|");
    const firstCell = (cells[1] ?? "").split(PICK_TOKEN).join("").replace(/\s+/g, " ").trim();
    if (firstCell !== "") picks.push({ file: fileLabel, name: firstCell });
  }
  return picks;
}

/**
 * Rows of the first markdown table in `outline` whose header starts with
 * `| Act |` (case-insensitive) — detected by the table header, not by a
 * heading, because the real vault's heading text
 * ("## The five acts (Matt, 2026-09-01)") and the fixture's ("## The acts")
 * don't match each other.
 */
function parseActs(outline: string): ActRow[] {
  const lines = outline.split("\n");
  const headerIndex = lines.findIndex((line) => /^\s*\|\s*act\s*\|/i.test(line));
  if (headerIndex === -1) return [];

  const rows: ActRow[] = [];
  for (let i = headerIndex + 2; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trimStart().startsWith("|")) break;
    const cells = line.split("|").map((cell) => cell.trim());
    const act = cells[1] ?? "";
    if (act === "") continue;
    rows.push({ act, years: cells[2] ?? "", summary: cells[3] ?? "" });
  }
  return rows;
}

/** Every non-dot file under `dir`, recursively, work-relative and sorted. */
function listFiles(workDir: string, dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(workDir, full));
    else if (entry.isFile()) out.push(relative(workDir, full));
  }
  return out;
}

/** Case-insensitive whole-word-phrase match: `name` must appear as a full word (or run of words), not as a substring of a longer word. */
function containsPhrase(haystack: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
}

/**
 * Reads `<workDir>`'s core files into the core machine's state. A missing
 * file is never an error — an absent `bible/overview.md` makes `premise`
 * false — because `status` exists to report what is missing, not to throw.
 */
export function readCoreState(workDir: string): CoreState {
  const overviewText = read(join(workDir, "bible", "overview.md"));
  const premise = overviewText !== undefined && hasLogline(overviewText);

  const files: BibleFile[] = [];
  const picks: PickRow[] = [];

  const charactersDir = join(workDir, "bible", "characters");
  const characterNames = existsSync(charactersDir)
    ? readdirSync(charactersDir)
        .filter((name) => name.endsWith(".md"))
        .sort()
    : [];
  for (const name of characterNames) {
    const path = join(charactersDir, name);
    const label = relative(workDir, path);
    files.push({ file: label, exists: true });
    picks.push(...parsePicks(read(path) ?? "", label));
  }

  const placesPath = join(workDir, "bible", "places.md");
  const placesLabel = relative(workDir, placesPath);
  const placesExists = existsSync(placesPath);
  files.push({ file: placesLabel, exists: placesExists });
  if (placesExists) picks.push(...parsePicks(read(placesPath) ?? "", placesLabel));

  const timelinePath = join(workDir, "bible", "timeline.md");
  const timelineLabel = relative(workDir, timelinePath);
  const timelineExists = existsSync(timelinePath);
  const timelineText = timelineExists ? (read(timelinePath) ?? "") : "";
  files.push({ file: timelineLabel, exists: timelineExists });
  if (timelineExists) picks.push(...parsePicks(timelineText, timelineLabel));

  const outlineFile = beatsFile(workDir);
  const outlinePath = join(workDir, outlineFile);
  const outlineText = read(outlinePath) ?? "";

  return {
    premise,
    research: listFiles(workDir, join(workDir, "research")),
    bible: { files, picks, timelineText },
    acts: parseActs(outlineText),
    beats: parseBeatRows(outlineText, relative(workDir, outlinePath)),
    outlineFile,
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The core's stages over `state`, in the design table's order. Pure. */
export function coreStages(state: CoreState): CoreStage[] {
  const bibleMissing = state.bible.files.filter((f) => !f.exists).map((f) => `${f.file} does not exist`);
  if (!state.bible.files.some((f) => f.exists && f.file.includes("characters/"))) {
    bibleMissing.push("bible/characters/ has no character files");
  }
  const bibleFiles = state.bible.files.filter((f) => f.exists).length;
  const picks = state.bible.picks;

  return [
    {
      id: "premise",
      done: state.premise,
      summary: state.premise ? "ok" : "missing",
      missing: state.premise ? [] : ["bible/overview.md has no text under ## Logline"],
    },
    {
      id: "research",
      done: state.research.length > 0,
      optional: true,
      summary: plural(state.research.length, "file"),
      missing: state.research.length > 0 ? [] : ["research/ has no files"],
    },
    {
      id: "bible",
      // Any bible file is enough to start acts; the stage's `missing` still names every absent one.
      done: bibleFiles > 0,
      summary: `${plural(bibleFiles, "file")}, ${plural(picks.length, "[pick] row")}`,
      missing: bibleMissing,
    },
    {
      id: "acts",
      done: state.acts.length > 0,
      summary: String(state.acts.length),
      missing: state.acts.length > 0 ? [] : [`${state.outlineFile} has no | Act | table`],
    },
    {
      id: "beats",
      done: state.beats.length > 0,
      summary: String(state.beats.length),
      missing: state.beats.length > 0 ? [] : [`${state.outlineFile} has no beat rows`],
    },
    {
      id: "facts",
      done: picks.length === 0,
      summary: picks.length === 0 ? "decided" : `${plural(picks.length, "open [pick]", "open [pick]s")} (checked per unit)`,
      missing: picks.map((pick) => `${pick.name} still has a [pick] in ${pick.file}`),
    },
  ];
}

/**
 * The first core stage that makes the core short, and what to do about it;
 * `undefined` once premise, bible, acts and beats are in. Research is
 * optional and facts are checked per unit (a `[pick]` blocks only the units
 * whose beat names it), so neither makes the whole core short.
 */
export function coreNext(state: CoreState): string | undefined {
  const stages = coreStages(state);
  const short = stages.find((s) => !s.done && s.optional !== true && s.id !== "facts");
  if (short === undefined) return undefined;
  switch (short.id) {
    case "premise":
      return "write bible/overview.md";
    case "bible":
      return "write the bible (bible/characters/, bible/places.md, bible/timeline.md)";
    case "acts":
      return "save the acts table (pablo save --stage acts)";
    default:
      return "save the beats (pablo save --stage beats)";
  }
}

/**
 * The core's "facts decided" check for one unit: one entry per `[pick]` row
 * whose name appears (as a whole phrase) in `text`, the unit's beat.
 *
 * DELIBERATE DEVIATION from the original ticket's "first word" wording: the
 * real family tree has rows like "Ortega grandchild [pick]" and "The film
 * star [pick]" — matching only the first word would flag "Ortega" (a
 * resolved character) in every beat that names him, and "The" in nearly
 * every beat. Matching the full name phrase is what the numbers require.
 */
export function undecidedPicks(state: CoreState, text: string): string[] {
  return state.bible.picks.filter((pick) => containsPhrase(text, pick.name)).map((pick) => `${pick.name} still has a [pick] in ${pick.file}`);
}
