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
 *     <work>/STYLE.md                         the work's own rules (QWEN.md on an unmigrated work)
 *     <work>/bible/timeline.md                | year | real events | in the novel |
 *     <work>/bible/places.md                  places
 *     <work>/bible/characters/family-tree.md  the cast
 *     <work>/outline/beats.md                 | # | story date | title | beat | POV | status |
 *                                             (outline/chapters.md on an unmigrated work)
 *     <work>/outputs/novel/continuity.md      what the text has established
 *                                             (continuity.md on an unmigrated work;
 *                                             outputs/<type>/continuity.md for another
 *                                             output: only the unit's own output's ledger)
 *     <work>/facts.md                         promoted facts every output honours
 *     <work>/facts/period.md                  | Fact | Source | Story date |: distilled period facts,
 *                                             the rows dated on or before the unit's (AGT-2110)
 *     <work>/chapters/NN-slug.md              the manuscript
 *
 * A missing file is not an error: a work with no continuity ledger yet gets a
 * pack without that slice, and the dry-run table shows it is not there.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { joinParagraphs } from "../sentences";
import { PERIOD_FACTS_FILE, parsePeriodFacts, periodFactsAt } from "../period-facts";
import { FACTS_FILE, beatsFile, continuityFile, workRulesFile } from "../work-paths";
import type { BeatRow, DistilledFacts, DraftingInputs, TextSource, TimelineGate, WorkIdentity } from "./types";

/** Words of the previous chapter carried into a drafting pack, as `draft-chapter` sends. */
export const DEFAULT_TAIL_WORDS = 500;

/** Where the period-and-place facts live in a work's `STYLE.md`, per the vault's novel template. */
export const PERIOD_FACTS_SECTION = "## Setting and period facts";
const PERIOD_FACTS_END = "## The files";

/**
 * The period section alone (AGT-2189): from its heading to the next `## ` heading, so the rules that follow it
 * (point of view, dialogue) are not sent a second time in the `period` slice. A file with no such section sends
 * nothing; the old cut ran to the file map and carried every later section with it.
 */
function periodFactsSection(workRules: string): string {
  const at = workRules.indexOf(PERIOD_FACTS_SECTION);
  if (at < 0) return "";
  const rest = workRules.slice(at + PERIOD_FACTS_SECTION.length);
  const next = rest.search(/\n## /);
  const end = next < 0 ? rest.length : next;
  const fileMap = rest.indexOf(PERIOD_FACTS_END);
  return workRules.slice(at, at + PERIOD_FACTS_SECTION.length + (fileMap >= 0 && fileMap < end ? fileMap : end)).trim();
}

/** A `## ` section heading that addresses the agent, not the writer: never part of the voice. */
export const AGENT_SECTION_HEADING = /repl(y|ies)|agent/i;

/**
 * `STYLE.md` sections that are operating instructions for the agent working in
 * the work (the vault templates' memory-brief, memory-command and session-order
 * sections, pablo's own drafting notes), not prose rules for the writer.
 */
const AGENT_PROCESS_HEADING = /brief from memory|memory commands|per-session|drafting through pablo/i;

/** The heading that opens the file map; everything from here on is agent orientation. */
const FILES_HEADING = /^(the )?files$/i;

const WRITER_ONLY_MARKER = /^[ \t]*<!--\s*\/?writer-only\s*-->[ \t]*\n?/gm;

export interface ReadDraftingOptions {
  /** The vault root (`~/writing`), which holds `style/`. */
  readonly vaultRoot: string;
  /** The work root (`<vault>/novels/<slug>`). */
  readonly workRoot: string;
  readonly chapter: number;
  /**
   * The core beat numbers the unit tells (AGT-1670: a plan row's `beats`), the
   * first the primary. Defaults to `[chapter]`: one unit per beat.
   */
  readonly beats?: readonly number[] | undefined;
  /** The output's `RULES.md` (absolute path), layered after the work's rules; absent or empty means none. */
  readonly outputRulesPath?: string | undefined;
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
  /** Overrides the title parsed from the work's `STYLE.md`. */
  readonly work?: Partial<WorkIdentity> | undefined;
  /**
   * The output the unit belongs to (AGT-1671), default `novel`: its own ledger
   * (`continuityFile(work, output)`) is the continuity slice, and no other
   * output's ledger is ever read.
   */
  readonly output?: string | undefined;
}

const FICTION_ONLY_BLOCK = /^[ \t]*<!--\s*fiction-only\s*-->[ \t]*\n?[\s\S]*?^[ \t]*<!--\s*\/fiction-only\s*-->[ \t]*\n?/gm;
const FICTION_ONLY_MARKER = /^[ \t]*<!--\s*\/?fiction-only\s*-->[ \t]*\n?/gm;

/**
 * Style text for an output (AGT-2189): a block fenced by `<!-- fiction-only -->` ... `<!-- /fiction-only -->`
 * (dialogue rules, scene endings) is prose-fiction craft. `keep: false`, an essay's pack, removes the block;
 * `keep: true` removes only the two fence lines, so the marker never reaches a writer.
 */
export function applyFictionOnly(text: string, keep: boolean): string {
  return (keep ? text.replace(FICTION_ONLY_MARKER, "") : text.replace(FICTION_ONLY_BLOCK, "").replace(FICTION_ONLY_MARKER, ""))
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Assembles the drafting inputs for one chapter. Throws only when the chapter
 * has no row in the outline, which is the one thing a pack cannot be built
 * without.
 */
export function readDraftingInputs(options: ReadDraftingOptions): DraftingInputs {
  const { vaultRoot, workRoot, chapter } = options;
  const outlinePath = join(workRoot, beatsFile(workRoot));
  const outlineText = read(outlinePath) ?? "";
  const beatNumbers = options.beats !== undefined && options.beats.length > 0 ? options.beats : [chapter];
  const rows = beatNumbers.map((n) => parseBeatRow(outlineText, n, label(vaultRoot, outlinePath)));
  const beat = rows[0];
  if (beat === undefined) {
    throw new Error(`pablo: chapter ${chapter} has no row in ${outlinePath}`);
  }
  const moreBeats: BeatRow[] = [];
  for (const [i, row] of rows.slice(1).entries()) {
    if (row === undefined) throw new Error(`pablo: beat ${beatNumbers[i + 1]} has no row in ${outlinePath}`);
    moreBeats.push(row);
  }

  const workRulesPath = join(workRoot, workRulesFile(workRoot));
  const workRules = read(workRulesPath) ?? "";
  // The period facts have their own slice, so the rules slice leaves that section out.
  const ruleText = workRuleSections(workRules, { exclude: [PERIOD_FACTS_SECTION] });
  const timelinePath = join(workRoot, "bible", "timeline.md");
  const distilledFacts = readDistilledFacts(vaultRoot, workRoot, [beat, ...moreBeats].map((row) => row.storyDate));

  return {
    work: {
      title: options.work?.title ?? parseWorkTitle(workRules) ?? basename(workRoot),
      description: options.work?.description,
    },
    beat,
    ...(moreBeats.length > 0 ? { moreBeats } : {}),
    ...(beat.chapter !== chapter ? { unit: chapter } : {}),
    style: readStyle(vaultRoot),
    workRules: source(vaultRoot, workRulesPath, ruleText),
    outputRules:
      options.outputRulesPath === undefined ? undefined : sourceOfFile(vaultRoot, options.outputRulesPath),
    periodFacts: source(
      vaultRoot,
      workRulesPath,
      periodFactsSection(workRules),
    ),
    ...(distilledFacts === undefined ? {} : { distilledFacts }),
    cast: sourceOfFile(vaultRoot, join(workRoot, "bible", "characters", "family-tree.md"), (text) =>
      section(text, { to: options.castEndsAt }),
    ),
    places: sourceOfFile(vaultRoot, join(workRoot, "bible", "places.md"), (text) =>
      section(text, { from: options.placesStartsAt }),
    ),
    timeline: gateTimeline(read(timelinePath) ?? "", beat.storyDate, label(vaultRoot, timelinePath)),
    continuity: sourceOfFile(vaultRoot, join(workRoot, continuityFile(workRoot, options.output ?? "novel"))),
    facts: sourceOfFile(vaultRoot, join(workRoot, FACTS_FILE)),
    previousTail: readPreviousTail(vaultRoot, workRoot, chapter, options.tailWords ?? DEFAULT_TAIL_WORDS),
    wordTarget: options.wordTarget,
    minScenes: options.minScenes,
  };
}

/**
 * `facts/period.md` (AGT-2110, D-10): the distilled period facts a unit told at `storyDates` may rely on, every
 * undated row and every row dated on or before the latest of them. `undefined` when the work has no such file; a
 * file with no row left is an empty list, so the receipt can still say none were sent.
 */
export function readDistilledFacts(
  vaultRoot: string,
  workRoot: string,
  storyDates: readonly string[],
): DistilledFacts | undefined {
  const path = join(workRoot, PERIOD_FACTS_FILE);
  const text = read(path);
  if (text === undefined) return undefined;
  return { path: label(vaultRoot, path), facts: periodFactsAt(parsePeriodFacts(text), storyDates) };
}

/** One row of an output's `plan.md`: `| unit | title | beats | status |`. */
export interface PlanFileRow {
  readonly unit: number;
  readonly title: string;
  /** The core beat numbers the row names, in order, deduplicated. */
  readonly beats: readonly number[];
  readonly status: string;
}

/** `2`, `2, 3`, `2-3`, `1, 3-4` as beat numbers; a descending or oversized range is ignored whole. */
export function parseBeatList(cell: string): number[] {
  const out: number[] = [];
  for (const part of cell.split(",")) {
    const m = /^\s*(\d+)\s*(?:[-\u2013\u2014]\s*(\d+)\s*)?$/.exec(part);
    if (m === null) continue;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (to < from || to - from > 999) continue;
    for (let n = from; n <= to; n += 1) if (!out.includes(n)) out.push(n);
  }
  return out;
}

/** The rows of an output's `plan.md` text, in file order; the header, separator and prose are skipped. */
export function parsePlanRows(text: string): PlanFileRow[] {
  const rows: PlanFileRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*\|\s*(\d+)\s*\|(.*)$/.exec(line);
    if (match === null) continue;
    // `\|` inside a cell is a literal pipe.
    const cells = (match[2] ?? "").replace(/\\\|/g, "\u0000").split("|").map((c) => c.replace(/\u0000/g, "|").trim());
    rows.push({ unit: Number(match[1]), title: cells[0] ?? "", beats: parseBeatList(cells[1] ?? ""), status: cells[2] ?? "" });
  }
  return rows;
}

/** `outputs/<id>/plan.md`, work-relative. */
export function outputPlanFile(outputId: string): string {
  return `outputs/${outputId}/plan.md`;
}

/** `outputs/<id>/RULES.md`, work-relative. */
export function outputRulesFile(outputId: string): string {
  return `outputs/${outputId}/RULES.md`;
}

/**
 * The beats `unit` tells according to `outputs/<outputId>/plan.md`, or
 * `undefined` when the work has no plan, the plan has no row for the unit, or
 * its beats cell names none (the caller then uses the default: beat N for unit
 * N). The plan's rows are the author's to edit, so an unreadable cell falls
 * back instead of failing a draft.
 */
export function planBeatsFor(workRoot: string, outputId: string, unit: number): readonly number[] | undefined {
  const text = read(join(workRoot, outputPlanFile(outputId)));
  if (text === undefined) return undefined;
  const row = parsePlanRows(text).find((r) => r.unit === unit);
  return row === undefined || row.beats.length === 0 ? undefined : row.beats;
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

/**
 * The work's own rules, for a span edit or a revise: `STYLE.md`'s rule sections
 * only (see `workRuleSections`), labelled by path. `undefined` when the work
 * has no rules file (`STYLE.md`, else `QWEN.md`) or it holds no rule sections.
 */
export function readWorkRules(vaultRoot: string, workRoot: string): TextSource | undefined {
  return sourceOfFile(vaultRoot, join(workRoot, workRulesFile(workRoot)), (text) => workRuleSections(text));
}

/**
 * The prose rules a work's `STYLE.md` adds to the shared `style/` (AGT-1593: the
 * work's own voice layer is its `STYLE.md`). The `## ` sections kept are the
 * rules (ground rules, setting and period facts, point of view and voice, and
 * any a work adds); dropped are the title/preamble, sections that address the
 * agent (`AGENT_SECTION_HEADING`), the template's agent process sections
 * (memory brief and commands, per-session order, pablo drafting notes), and
 * the file map and anything after it. `<!-- writer-only -->` fence lines are
 * removed but their content stays: writer-only text is for exactly this reader.
 * `options.exclude` drops sections whose heading starts with one of the given
 * strings (the drafting pack sends period facts in a slice of their own).
 */
export function workRuleSections(text: string, options: { readonly exclude?: readonly string[] } = {}): string {
  const exclude = (options.exclude ?? []).map((heading) => heading.replace(/^#+\s*/, "").toLowerCase());
  const parts = `\n${text.replace(/\r\n/g, "\n").replace(WRITER_ONLY_MARKER, "")}`.split(/\n(?=## )/).slice(1);
  const kept: string[] = [];
  for (const part of parts) {
    const heading = (part.split("\n", 1)[0] ?? "").replace(/^##\s*/, "").trim();
    if (FILES_HEADING.test(heading)) break;
    if (AGENT_SECTION_HEADING.test(heading) || AGENT_PROCESS_HEADING.test(heading)) continue;
    if (exclude.some((prefix) => heading.toLowerCase().startsWith(prefix))) continue;
    kept.push(part.trim());
  }
  return kept.join("\n\n");
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
 * Every row of the outline's chapter table, in file order — the same table
 * `parseBeatRow` reads one row from, for callers (the novel stage machine,
 * in particular) that need the whole beat list rather than one chapter.
 * A row counts if its first cell parses as an integer; anything else
 * (the acts table, prose, open-question bullets) is skipped.
 */
export function parseBeatRows(outline: string, source: string): readonly BeatRow[] {
  const rows: BeatRow[] = [];
  for (const line of outline.split("\n")) {
    const match = /^\s*\|\s*(\d+)\s*\|(.*)$/.exec(line);
    if (match === null) continue;
    const cells = (match[2] ?? "").split("|").map((cell) => cell.trim());
    rows.push({
      chapter: Number(match[1]),
      storyDate: cells[0] ?? "",
      title: cells[1] ?? "",
      beat: cells[2] ?? "",
      pov: cells[3] ?? "",
      status: cells[4] ?? "",
      source,
    });
  }
  return rows;
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

/** What `timelineAt` answers: the gate's two halves, plus a ready-to-send rendering. */
export interface TimelineAt {
  /** The date asked about, as given. */
  readonly date: string;
  /** Rows dated at or before the date, one per line. */
  readonly exists: readonly string[];
  /** Rows dated after it: they do not exist yet and must not be mentioned. */
  readonly notYet: readonly string[];
  readonly source: string;
  /** The same two halves as text, the later rows marked as not existing yet. */
  readonly text: string;
}

/**
 * The story-time gate as a question (AGT-1555): what exists at `date`. Pure,
 * and built on `gateTimeline`, the exact code behind the drafting pack's
 * timeline slice, so the harness's tool and the pack can never disagree.
 */
export function timelineAt(timeline: string, date: string, source: string): TimelineAt {
  const gate = gateTimeline(timeline, date, source);
  const blocks: string[] = [];
  if (gate.exists.length > 0) blocks.push([`## Exists at ${date}`, ...gate.exists].join("\n"));
  if (gate.later.length > 0) {
    blocks.push(
      [`## Does not exist yet at ${date}: do not mention or foreshadow`, ...gate.later].join("\n"),
    );
  }
  return { date, exists: gate.exists, notYet: gate.later, source, text: blocks.join("\n\n") };
}

/**
 * The last `words` words of a chapter file, frontmatter stripped. Sentence
 * lines are joined into paragraphs first (AGT-1532) so a split chapter reads
 * to the model as ordinary prose; paragraph breaks inside the tail are kept.
 */
export function chapterTail(chapterText: string, words: number): string {
  const body = chapterText.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, "");
  const paragraphs = joinParagraphs(body)
    .split("\n\n")
    .filter((paragraph) => paragraph !== "");
  const kept: string[] = [];
  let remaining = words;
  for (let i = paragraphs.length - 1; i >= 0 && remaining > 0; i--) {
    const tokens = (paragraphs[i] as string).split(" ");
    kept.unshift(tokens.slice(Math.max(0, tokens.length - remaining)).join(" "));
    remaining -= tokens.length;
  }
  return kept.join("\n\n");
}

/** The title from a work's `STYLE.md` first heading, without the "(working title)" suffix. */
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
