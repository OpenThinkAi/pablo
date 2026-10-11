/**
 * The novel output's stage machine (AGT-1228; split from the core by
 * AGT-1667, pm project `pablo-story-core`). The story core's stages
 * (premise, research, bible, acts, beats, facts decided) live in
 * `core/machine.ts`; this file adds what only the novel needs: its units
 * (`NN-*.md` in its artifact directory, `outputs/novel/units.ts`) and a chapter's own preconditions (the previous
 * chapter, the timeline year gate) on top of the core's (a beat row, no
 * undecided `[pick]` the beat names).
 *
 * `readNovelState` is the core state plus the novel output's, the shape every
 * novel caller (write, book, status --for) reads; `chapterPreconditions` is
 * pure over it, so a caller can build one state and check every chapter
 * against it without re-reading the vault each time.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gateTimeline } from "@openthink/pablo-core";
import { readCoreState, undecidedPicks } from "../core/machine";
import type { CoreState } from "../core/machine";
import { NOVEL_UNIT_FILE, novelUnitDir } from "../outputs/novel/units";

export type { ActRow, BibleFile, PickRow } from "../core/machine";

/** One chapter file (`NN-*.md`), parsed just enough to gate on it. */
export interface ChapterFile {
  readonly number: number;
  readonly file: string;
  readonly status: string | undefined;
  readonly title: string | undefined;
}

/** The novel output's own state: its units on disk. */
export interface NovelOutputState {
  readonly chapters: readonly ChapterFile[];
}

/** The core's state plus the novel output's. */
export interface NovelState extends CoreState, NovelOutputState {}

export interface ChapterPreconditions {
  readonly ready: boolean;
  readonly missing: readonly string[];
}

function read(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * A chapter file's (`NN-*.md`, NN = 2+ digits) frontmatter, parsed by a small hand
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

function readChapters(workDir: string): ChapterFile[] {
  const dir = novelUnitDir(workDir);
  if (!existsSync(dir)) return [];

  const chapters: ChapterFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    const match = NOVEL_UNIT_FILE.exec(name);
    if (!match) continue;
    const path = join(dir, name);
    const fields = parseFrontmatter(read(path) ?? "");
    chapters.push({
      number: Number(match[1]),
      file: relative(workDir, path),
      status: fields["status"],
      title: fields["title"],
    });
  }
  return chapters;
}

/** Same rule as `gateTimeline`'s private `yearIn` (not exported): the first four-digit year in a story date. */
function yearIn(text: string): number | undefined {
  const match = /(1[89]\d{2}|20\d{2})/.exec(text);
  return match === null ? undefined : Number(match[1]);
}

/** Reads the novel output's own state: the chapter files in its artifact directory. */
export function readNovelOutputState(workDir: string): NovelOutputState {
  return { chapters: readChapters(workDir) };
}

/**
 * Reads `<workDir>`'s vault files into the core state plus the novel
 * output's. A missing file is not an error anywhere here — an absent
 * `bible/overview.md` just makes `premise` false, an absent chapter directory makes
 * `chapters` empty — because `status` exists to report what is missing.
 */
export function readNovelState(workDir: string): NovelState {
  return { ...readCoreState(workDir), ...readNovelOutputState(workDir) };
}

/**
 * The preconditions for `chapter` in `state`: beat row N exists (core);
 * chapter N-1 exists (or N=1) and the timeline has a row dated at or before
 * the chapter's year (novel); no `[pick]` on a cast row whose name appears in
 * beat N's text (core, facts decided).
 *
 * When no beat exists for `chapter`, that is the ONLY missing entry — the
 * other checks all need the beat's story date or text and cannot run
 * without it.
 */
export function chapterPreconditions(
  state: NovelState,
  chapter: number,
  /** The beats the unit tells when its plan row maps it onto others (AGT-1670); default `[chapter]`. */
  beatNumbers: readonly number[] = [chapter],
): ChapterPreconditions {
  const numbers = beatNumbers.length > 0 ? beatNumbers : [chapter];
  const found = numbers.map((n) => ({ n, row: state.beats.find((row) => row.chapter === n) }));
  const absent = found.filter((f) => f.row === undefined);
  if (absent.length > 0) {
    return {
      ready: false,
      missing: absent.map((f) => `no beat for chapter ${f.n} in ${state.outlineFile}`),
    };
  }
  const beats = found.map((f) => f.row as NonNullable<typeof f.row>);
  const beat = beats[0] as NonNullable<(typeof beats)[number]>;

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

  // The core's "facts decided" stage, checked for this unit's beat.
  for (const b of beats) missing.push(...undecidedPicks(state, b.beat));

  return { ready: missing.length === 0, missing };
}

/** One novel unit (a chapter) as `status` and `resume` report it: a beat row, a chapter file, or both. */
export interface NovelUnit {
  readonly unit: number;
  readonly title?: string;
  readonly storyDate?: string;
  /** The chapter file's frontmatter `status` (`"unknown"` when it has none), or `"beat"` when only the beat exists. */
  readonly status: string;
  /** The chapter file, work-relative, when it is drafted. */
  readonly file?: string;
}

/** Every chapter number with a beat row or a file, ascending, as units. Pure. */
export function novelUnits(state: NovelState): NovelUnit[] {
  const numbers = [...new Set([...state.beats.map((b) => b.chapter), ...state.chapters.map((c) => c.number)])].sort((a, b) => a - b);
  return numbers.map((n) => {
    const beat = state.beats.find((b) => b.chapter === n);
    const file = state.chapters.find((c) => c.number === n);
    const title = file?.title ?? beat?.title;
    return {
      unit: n,
      ...(title !== undefined && title !== "" ? { title } : {}),
      ...(beat !== undefined && beat.storyDate !== "" ? { storyDate: beat.storyDate } : {}),
      status: file !== undefined ? (file.status ?? "unknown") : "beat",
      ...(file !== undefined ? { file: file.file } : {}),
    };
  });
}

/** The lowest-numbered beat with no chapter file, as the action that drafts it; `undefined` when every beat is drafted. Pure. */
export function novelNext(state: NovelState): string | undefined {
  const written = new Set(state.chapters.map((chapter) => chapter.number));
  const beat = [...state.beats].sort((a, b) => a.chapter - b.chapter).find((b) => !written.has(b.chapter));
  return beat === undefined ? undefined : `write chapter ${beat.chapter} (pablo write --chapter ${beat.chapter})`;
}
