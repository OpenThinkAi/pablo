/**
 * The novel stage machine (AGT-1228): reads a work's vault files into the
 * state the framework checks against — see the design doc's "Novel" stage
 * table (`~/saltline-digital-vault/projects/ai-terminal/README.md`) — and
 * evaluates the preconditions for drafting one chapter.
 *
 * `readNovelState` does the only disk I/O in this file; `chapterPreconditions`
 * is pure over the state it returns, so a caller (a test, `pablo status`) can
 * build one state and check every chapter against it without re-reading the
 * vault each time.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { gateTimeline, parseBeatRows, section } from "@openthink/pablo-core";
import type { BeatRow } from "@openthink/pablo-core";
import { stateReviewPath } from "../paths";
import { readEvents } from "../review";
import type { DecisionEvent, QueuedEvent, ReviewEvent } from "../review";

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

/** One row of the first `| Act | ... |` table in `outline/chapters.md`. */
export interface ActRow {
  readonly act: string;
  readonly years: string;
  readonly summary: string;
}

/**
 * A written chapter's standing in the review queue (AGT-1255's
 * `packages/cli/src/review.ts`): `pending` (queued, no decision yet),
 * `approved`, `rejected`, or `none` (never queued at all).
 */
export type ReviewState = "pending" | "approved" | "rejected" | "none";

/** One `chapters/NN-*.md` file, parsed just enough to gate on it. */
export interface ChapterFile {
  readonly number: number;
  readonly file: string;
  readonly status: string | undefined;
  readonly title: string | undefined;
  readonly review: ReviewState;
}

export interface NovelState {
  /** `bible/overview.md` exists and has non-empty text under `## Logline`. */
  readonly premise: boolean;
  readonly bible: {
    readonly files: readonly BibleFile[];
    readonly picks: readonly PickRow[];
    /**
     * The raw text of `bible/timeline.md` (`""` if it does not exist). Kept
     * here — beyond the `{file, exists}` shape the design doc describes —
     * so `chapterPreconditions` can re-run the story-time gate purely over
     * `state`, without a second disk read.
     */
    readonly timelineText: string;
  };
  readonly acts: readonly ActRow[];
  readonly beats: readonly BeatRow[];
  readonly chapters: readonly ChapterFile[];
}

export interface ChapterPreconditions {
  readonly ready: boolean;
  readonly missing: readonly string[];
}

const PICK_TOKEN = "[pick]";

function read(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

function relLabel(workDir: string, path: string): string {
  return relative(workDir, path);
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
 * `chapters/NN-*.md` (NN = 2+ digits) frontmatter, parsed by a small hand
 * parser. Exported so other frontmatter readers (`check.ts`'s
 * `isUnprovenanced`) reuse this instead of writing a second one.
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trim() !== "---") return {};
  const fields: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") break;
    const match = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (match) fields[match[1] as string] = (match[2] ?? "").trim();
  }
  return fields;
}

/**
 * The review status of one written piece (AGT-1263): the `queued` event in
 * `events` whose `path` resolves to the same file as `chapterPath` wins —
 * when more than one does (the chapter was queued, decided, and queued
 * again), the one with the latest `at` is authoritative, and its own
 * decision (if any) is what's reported. `none` when no `queued` event
 * matches at all. Pure — no disk I/O, so it's testable with hand-built
 * events (AC3).
 */
export function reviewStateFor(events: ReviewEvent[], chapterPath: string): ReviewState {
  const target = resolve(chapterPath);

  const matches = events.filter((event): event is QueuedEvent => event.type === "queued" && resolve(event.path) === target);
  if (matches.length === 0) return "none";

  const latest = matches.slice().sort((a, b) => a.at.localeCompare(b.at))[matches.length - 1] as QueuedEvent;

  const decision = events.find(
    (event): event is DecisionEvent => (event.type === "approved" || event.type === "rejected") && event.id === latest.id,
  );
  return decision === undefined ? "pending" : decision.type;
}

function readChapters(workDir: string, events: ReviewEvent[]): ChapterFile[] {
  const dir = join(workDir, "chapters");
  if (!existsSync(dir)) return [];

  const chapters: ChapterFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    const match = /^(\d{2,})-.*\.md$/.exec(name);
    if (!match) continue;
    const path = join(dir, name);
    const fields = parseFrontmatter(read(path) ?? "");
    chapters.push({
      number: Number(match[1]),
      file: relLabel(workDir, path),
      status: fields["status"],
      title: fields["title"],
      review: reviewStateFor(events, path),
    });
  }
  return chapters;
}

/** Same rule as `gateTimeline`'s private `yearIn` (not exported): the first four-digit year in a story date. */
function yearIn(text: string): number | undefined {
  const match = /(1[89]\d{2}|20\d{2})/.exec(text);
  return match === null ? undefined : Number(match[1]);
}

/** Case-insensitive whole-word-phrase match: `name` must appear as a full word (or run of words), not as a substring of a longer word. */
function containsPhrase(haystack: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(haystack);
}

/**
 * Reads `<workDir>`'s vault files into the novel machine's stage state. A
 * missing file is not an error anywhere here — an absent `bible/overview.md`
 * just makes `premise` false, an absent `chapters/` makes `chapters` empty —
 * because `status` exists to report what is missing, not to throw on it.
 *
 * `env` resolves the review queue (`stateReviewPath`, AGT-1263) each chapter
 * is checked against; it defaults to `process.env` so every existing caller
 * (the real CLI) is unaffected, and a test points it at a temp
 * `XDG_STATE_HOME` instead of ever touching the author's real queue. A
 * missing or malformed queue file degrades to every chapter reading `review:
 * "none"` — `readEvents` already tolerates both, so this never throws.
 */
export function readNovelState(workDir: string, env: Record<string, string | undefined> = process.env): NovelState {
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
    const label = relLabel(workDir, path);
    files.push({ file: label, exists: true });
    picks.push(...parsePicks(read(path) ?? "", label));
  }

  const placesPath = join(workDir, "bible", "places.md");
  const placesLabel = relLabel(workDir, placesPath);
  const placesExists = existsSync(placesPath);
  files.push({ file: placesLabel, exists: placesExists });
  if (placesExists) picks.push(...parsePicks(read(placesPath) ?? "", placesLabel));

  const timelinePath = join(workDir, "bible", "timeline.md");
  const timelineLabel = relLabel(workDir, timelinePath);
  const timelineExists = existsSync(timelinePath);
  const timelineText = timelineExists ? (read(timelinePath) ?? "") : "";
  files.push({ file: timelineLabel, exists: timelineExists });
  if (timelineExists) picks.push(...parsePicks(timelineText, timelineLabel));

  const outlinePath = join(workDir, "outline", "chapters.md");
  const outlineText = read(outlinePath) ?? "";
  const outlineLabel = relLabel(workDir, outlinePath);

  const events = readEvents(stateReviewPath(env));

  return {
    premise,
    bible: { files, picks, timelineText },
    acts: parseActs(outlineText),
    beats: parseBeatRows(outlineText, outlineLabel),
    chapters: readChapters(workDir, events),
  };
}

/**
 * The preconditions for `chapter` in `state`: beat row N exists; chapter N-1
 * exists (or N=1); the timeline has a row dated at or before the chapter's
 * year; no `[pick]` on a cast row whose name appears in beat N's text.
 *
 * When no beat exists for `chapter`, that is the ONLY missing entry — the
 * other checks all need the beat's story date or text and cannot run
 * without it.
 */
export function chapterPreconditions(state: NovelState, chapter: number): ChapterPreconditions {
  const beat = state.beats.find((row) => row.chapter === chapter);
  if (beat === undefined) {
    return { ready: false, missing: [`no beat for chapter ${chapter} in outline/chapters.md`] };
  }

  const missing: string[] = [];

  if (chapter > 1 && !state.chapters.some((c) => c.number === chapter - 1)) {
    missing.push(`chapter ${chapter - 1} is not written`);
  }

  const year = yearIn(beat.storyDate);
  if (year !== undefined) {
    const gate = gateTimeline(state.bible.timelineText, beat.storyDate, "bible/timeline.md");
    if (gate.exists.length === 0) {
      missing.push(`bible/timeline.md has no row dated ${year} or earlier`);
    }
  }

  // DELIBERATE DEVIATION from the ticket's "first word" wording: the real
  // family tree has rows like "Ortega grandchild [pick]" and "The film star
  // [pick]" — matching only the first word would flag "Ortega" (a resolved
  // character) in every beat that names him, and "The" in nearly every beat.
  // Matching the full name phrase is what the AC4 numbers actually require.
  for (const pick of state.bible.picks) {
    if (containsPhrase(beat.beat, pick.name)) {
      missing.push(`${pick.name} still has a [pick] in ${pick.file}`);
    }
  }

  return { ready: missing.length === 0, missing };
}
