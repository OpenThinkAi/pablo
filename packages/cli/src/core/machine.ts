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
 * The work's track (AGT-2099/AGT-2100, pm project `pablo-platform`, D-5)
 * picks the stage list. A `historical-fiction` work adds a period brief
 * before research, makes research required, and needs distilled period facts
 * before the bible:
 *
 *     premise        as above
 *     period         bible/period.md has text (the period/event brief)
 *     research       research/ has a sourced note (a `## Sources` list); required
 *                    and every item of research/checklist.md sourced or waived
 *     period facts   facts/period.md has at least one fact row
 *     bible, acts, beats, facts decided   as above
 *
 * A `nonfiction` work (AGT-2101) has its own core instead, with no bible,
 * acts or beats (files and parsers in `nonfiction.ts`):
 *
 *     thesis         core/thesis.md has text
 *     research       a sourced note and a closed checklist, required as on historical-fiction
 *     claims         core/claims.md rows, each citing research note ids that exist
 *     outline        core/outline.md has at least one section row
 *
 * The stages a track adds or makes required are its gate (`trackGate`):
 * `write` refuses while one is short, naming the track and the stage.
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
import { beatsFile, parseBeatRows, PERIOD_FACTS_FILE, section } from "@openthink/pablo-core";
import type { BeatRow } from "@openthink/pablo-core";
// Type-only: `tracks/registry.ts` imports this module's stage lists, so a value import here would be a cycle.
import type { TrackId } from "../tracks/registry";
import { CLAIMS_FILE, hasProse, OUTLINE_FILE, parseClaims, parseSections, researchNoteId, THESIS_FILE } from "./nonfiction";
import type { ClaimRow, SectionRow } from "./nonfiction";
import { CHECKLIST_FILE, checklistItems, itemLabel, noteHasSources, parseChecklist } from "./checklist";
import type { ChecklistItem } from "./checklist";

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

/** The `historical-fiction` core (D-5): the period brief, required research and distilled period facts come before the bible. */
export const HISTORICAL_CORE_STAGE_IDS = ["premise", "period", "research", "period-facts", "bible", "acts", "beats", "facts"] as const;

/**
 * The `nonfiction` core (AGT-2101, D-5): no bible, acts or beats. A thesis, required research, claims that each cite a
 * research note, and an outline of sections (`core/nonfiction.ts` holds the files and parsers).
 */
export const NONFICTION_CORE_STAGE_IDS = ["thesis", "research", "claims", "outline"] as const;

export type CoreStageId =
  | (typeof CORE_STAGE_IDS)[number]
  | (typeof HISTORICAL_CORE_STAGE_IDS)[number]
  | (typeof NONFICTION_CORE_STAGE_IDS)[number];

/** The period brief a historical work's `period` stage needs. */
export const PERIOD_BRIEF_FILE = "bible/period.md";

/** One core stage as `status` and `resume` report it. */
export interface CoreStage {
  readonly id: CoreStageId;
  /** Met. An optional stage (research) that is not met is never what makes the core short. */
  readonly done: boolean;
  /** The stage is optional per policy: unmet, it is reported but does not block. */
  readonly optional?: true;
  /** The track adds this stage or makes it required: unmet, `write` refuses naming the track (`trackGate`). */
  readonly gate?: true;
  /** One short line: `ok`, `3 files, 1 [pick] row`, `4 rows`. */
  readonly summary: string;
  /** What is absent, by file, when the stage is not met. */
  readonly missing: readonly string[];
}

export interface CoreState {
  /** The work's track, which picks the stage list (`pablo.json` `track`, else `fiction`). */
  readonly track: TrackId;
  /** `bible/overview.md` exists and has non-empty text under `## Logline`. */
  readonly premise: boolean;
  /** `bible/period.md` exists and has text (the historical period brief). */
  readonly period: boolean;
  /** Work-relative paths of the files under `research/` (never sent to a writer; presence only). */
  readonly research: readonly string[];
  /** The research notes (`.md`) among `research` with at least one entry under `## Sources`. */
  readonly sourcedResearch: readonly string[];
  /**
   * `research/checklist.md` (AGT-2111, D-9) with each item's status worked out against the sourced notes;
   * `undefined` when the work has no checklist yet.
   */
  readonly checklist: { readonly file: string; readonly items: readonly ChecklistItem[] } | undefined;
  /** The fact rows in `facts/period.md` (table rows or bullets); 0 when it does not exist. */
  readonly periodFacts: number;
  /** `core/thesis.md` has text other than headings (the nonfiction thesis). */
  readonly thesis: boolean;
  /** The claim rows of `core/claims.md` (nonfiction), each with the research note ids it cites. */
  readonly claims: readonly ClaimRow[];
  /** The section rows of `core/outline.md` (nonfiction). */
  readonly sections: readonly SectionRow[];
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

/**
 * The fact rows in a period-facts file: table data rows (not the header or
 * its `---` separator) and bullets. The row format is `distill_facts`'s
 * (AGT-2109); the gate only needs to know there is at least one.
 */
function countFactRows(text: string): number {
  const lines = text.split("\n");
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (/^[-*]\s+\S/.test(line)) {
      n++;
      continue;
    }
    if (!line.startsWith("|")) continue;
    // A separator row, or a row of empty cells: neither is a fact.
    if (/^\|[\s:|-]*$/.test(line)) continue;
    // A header row is the one directly above a separator.
    if (/^\|[\s:|-]*$/.test((lines[i + 1] ?? "").trim())) continue;
    if (line.split("|").some((cell) => cell.trim() !== "")) n++;
  }
  return n;
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
export function readCoreState(workDir: string, track: TrackId = "fiction"): CoreState {
  const overviewText = read(join(workDir, "bible", "overview.md"));
  const premise = overviewText !== undefined && hasLogline(overviewText);
  // Frontmatter and headings alone are not a brief.
  const period = (read(join(workDir, PERIOD_BRIEF_FILE)) ?? "").replace(/^---\n[\s\S]*?\n---\n?/, "").replace(/^#[^\n]*$/gm, "").trim() !== "";
  const research = listFiles(workDir, join(workDir, "research"));
  const sourcedResearch = research.filter((rel) => rel.endsWith(".md") && noteHasSources(read(join(workDir, rel)) ?? ""));
  const checklistText = read(join(workDir, CHECKLIST_FILE));
  const sourcedIds = new Set(sourcedResearch.map((rel) => researchNoteId(rel.split("\\").join("/"))));
  const checklist = checklistText === undefined ? undefined : { file: CHECKLIST_FILE, items: checklistItems(parseChecklist(checklistText), sourcedIds) };
  const periodFacts = countFactRows(read(join(workDir, PERIOD_FACTS_FILE)) ?? "");
  const thesis = hasProse(read(join(workDir, THESIS_FILE)) ?? "");
  const claims = parseClaims(read(join(workDir, CLAIMS_FILE)) ?? "");
  const sections = parseSections(read(join(workDir, OUTLINE_FILE)) ?? "");

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
    period,
    research,
    sourcedResearch,
    checklist,
    periodFacts,
    thesis,
    claims,
    sections,
    bible: { files, picks, timelineText },
    acts: parseActs(outlineText),
    beats: parseBeatRows(outlineText, relative(workDir, outlinePath)),
    outlineFile,
    // Last, so the JSON a status/resume reader already parses still opens with `premise`.
    track,
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `no checklist`, or `checklist 3 sourced, 1 waived, 2 open`. */
function checklistSummary(state: CoreState): string {
  if (state.checklist === undefined) return "no checklist";
  const items = state.checklist.items;
  const count = (status: string) => items.filter((i) => i.status === status).length;
  return `checklist ${count("sourced")} sourced, ${count("waived")} waived, ${count("open")} open`;
}

/** The stage ids `track`'s core runs, in order. */
export function coreStageIds(track: TrackId): readonly CoreStageId[] {
  if (track === "historical-fiction") return HISTORICAL_CORE_STAGE_IDS;
  if (track === "nonfiction") return NONFICTION_CORE_STAGE_IDS;
  return CORE_STAGE_IDS;
}

/**
 * What keeps a nonfiction work's claims short: an unsourced claim, or a cited id that names no research note
 * (a note's id is its path under `research/` without `.md`).
 */
function claimProblems(state: CoreState): string[] {
  const ids = new Set(state.research.filter((f) => f.endsWith(".md") && f.split("\\").join("/") !== CHECKLIST_FILE).map((f) => researchNoteId(f.split("\\").join("/"))));
  const problems: string[] = [];
  for (const claim of state.claims) {
    if (claim.sources.length === 0) problems.push(`claim ${claim.number} cites no research note`);
    for (const source of claim.sources) {
      if (!ids.has(source)) problems.push(`claim ${claim.number} cites ${source}, which is not a note under research/`);
    }
  }
  return problems;
}

/** The core's stages over `state`, in its track's order (`coreStageIds`). Pure. */
export function coreStages(state: CoreState): CoreStage[] {
  // Research is required (gated) on both factual tracks: a sourced note, as `research save` writes.
  const researchRequired = state.track === "historical-fiction" || state.track === "nonfiction";
  const bibleMissing = state.bible.files.filter((f) => !f.exists).map((f) => `${f.file} does not exist`);
  if (!state.bible.files.some((f) => f.exists && f.file.includes("characters/"))) {
    bibleMissing.push("bible/characters/ has no character files");
  }
  const bibleFiles = state.bible.files.filter((f) => f.exists).length;
  const picks = state.bible.picks;
  const sourced = state.sourcedResearch.length;
  const openItems = (state.checklist?.items ?? []).filter((i) => i.status === "open");
  // Guided research (AGT-2111, D-9): plan the checklist first, then source or waive every item on it.
  const researchMissing = [
    ...(state.checklist === undefined ? [`${CHECKLIST_FILE} does not exist yet (pablo research plan)`] : []),
    ...(state.checklist !== undefined && state.checklist.items.length === 0 ? [`${CHECKLIST_FILE} has no items`] : []),
    ...(sourced > 0 ? [] : ["research has no sourced notes yet"]),
    ...openItems.map((i) => `checklist item ${itemLabel(i)} is open`),
  ];
  const claimIssues = claimProblems(state);
  const claimsDone = state.claims.length > 0 && claimIssues.length === 0;

  const all: Record<CoreStageId, CoreStage> = {
    premise: {
      id: "premise",
      done: state.premise,
      summary: state.premise ? "ok" : "missing",
      missing: state.premise ? [] : ["bible/overview.md has no text under ## Logline"],
    },
    period: {
      id: "period",
      done: state.period,
      gate: true,
      summary: state.period ? "ok" : "missing",
      missing: state.period ? [] : [`${PERIOD_BRIEF_FILE} has no period brief yet`],
    },
    research: researchRequired
      ? {
          id: "research",
          done: researchMissing.length === 0,
          gate: true,
          summary: `${plural(sourced, "sourced note")}, ${checklistSummary(state)}`,
          missing: researchMissing,
        }
      : {
          id: "research",
          done: state.research.length > 0,
          optional: true,
          summary: plural(state.research.length, "file"),
          missing: state.research.length > 0 ? [] : ["research/ has no files"],
        },
    "period-facts": {
      id: "period-facts",
      done: state.periodFacts > 0,
      gate: true,
      summary: plural(state.periodFacts, "fact"),
      missing: state.periodFacts > 0 ? [] : [`${PERIOD_FACTS_FILE} has no sourced period facts yet`],
    },
    bible: {
      id: "bible",
      // Any bible file is enough to start acts; the stage's `missing` still names every absent one.
      done: bibleFiles > 0,
      summary: `${plural(bibleFiles, "file")}, ${plural(picks.length, "[pick] row")}`,
      missing: bibleMissing,
    },
    acts: {
      id: "acts",
      done: state.acts.length > 0,
      summary: String(state.acts.length),
      missing: state.acts.length > 0 ? [] : [`${state.outlineFile} has no | Act | table`],
    },
    beats: {
      id: "beats",
      done: state.beats.length > 0,
      summary: String(state.beats.length),
      missing: state.beats.length > 0 ? [] : [`${state.outlineFile} has no beat rows`],
    },
    thesis: {
      id: "thesis",
      done: state.thesis,
      gate: true,
      summary: state.thesis ? "ok" : "missing",
      missing: state.thesis ? [] : [`${THESIS_FILE} has no text`],
    },
    claims: {
      id: "claims",
      done: claimsDone,
      gate: true,
      summary:
        claimIssues.length === 0
          ? plural(state.claims.length, "claim")
          : `${plural(state.claims.length, "claim")}, ${plural(claimIssues.length, "unsupported source")}`,
      missing: state.claims.length === 0 ? [`${CLAIMS_FILE} has no claim rows`] : claimIssues,
    },
    outline: {
      id: "outline",
      done: state.sections.length > 0,
      gate: true,
      summary: plural(state.sections.length, "section"),
      missing: state.sections.length > 0 ? [] : [`${OUTLINE_FILE} has no section rows`],
    },
    facts: {
      id: "facts",
      done: picks.length === 0,
      summary: picks.length === 0 ? "decided" : `${plural(picks.length, "open [pick]", "open [pick]s")} (checked per unit)`,
      missing: picks.map((pick) => `${pick.name} still has a [pick] in ${pick.file}`),
    },
  };
  return coreStageIds(state.track).map((id) => all[id]);
}

/**
 * The first core stage that makes the core short, and what to do about it;
 * `undefined` once every required stage up to beats is in. Research is
 * optional on fiction (required on historical-fiction) and facts are checked
 * per unit (a `[pick]` blocks only the units whose beat names it), so facts
 * never makes the whole core short.
 */
export function coreNext(state: CoreState): string | undefined {
  const stages = coreStages(state);
  const short = stages.find((s) => !s.done && s.optional !== true && s.id !== "facts");
  if (short === undefined) return undefined;
  switch (short.id) {
    case "premise":
      return "write bible/overview.md";
    case "period":
      return `write the period brief (${PERIOD_BRIEF_FILE})`;
    case "research":
      if (state.checklist === undefined || state.checklist.items.length === 0) return "plan the research checklist (pablo research plan)";
      if (state.checklist.items.some((i) => i.status === "open")) {
        return "source or waive the open checklist items (pablo research save --item N, pablo research waive N \"<reason>\")";
      }
      return "save sourced research notes (pablo research save)";
    case "thesis":
      return "save the thesis (pablo save --stage thesis)";
    case "claims":
      return "save the claims, each citing a research note (pablo save --stage claims)";
    case "outline":
      return "save the outline sections (pablo save --stage outline)";
    case "period-facts":
      return `distill the research into sourced period facts (${PERIOD_FACTS_FILE})`;
    case "bible":
      return "write the bible (bible/characters/, bible/places.md, bible/timeline.md)";
    case "acts":
      return "save the acts table (pablo save --stage acts)";
    default:
      return "save the beats (pablo save --stage beats)";
  }
}

/** A track gate that is shut: the stage, the refusal line naming the track, and what is missing. */
export interface TrackGate {
  readonly stage: CoreStageId;
  /** `historical-fiction: research has no sourced notes yet`. */
  readonly message: string;
  readonly missing: readonly string[];
}

/**
 * The first stage the work's track adds or makes required that is still
 * short, or `undefined` when the track lets drafting go ahead. Fiction has no
 * gate (its research stays optional); the output's own preconditions cover
 * the rest of the core.
 */
export function trackGate(state: CoreState): TrackGate | undefined {
  const shut = coreStages(state).find((s) => s.gate === true && !s.done);
  if (shut === undefined) return undefined;
  return { stage: shut.id, message: `${state.track}: ${shut.missing[0] ?? `${shut.id} is not met`}`, missing: shut.missing };
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
