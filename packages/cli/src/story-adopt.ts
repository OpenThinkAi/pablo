/**
 * `pablo story --project <slug> --from <stage>` (AGT-2289, D-22): adopting a work `pablo story` did not build (or whose
 * `.pablo/story.json` is gone) and running it from a core stage. Everything before the stage is kept; what the stage and
 * every later stage produced is archived under `_archived/<stage>-<date>[-K]/`, never deleted (the same rule as
 * `pablo output remove`, which archives under `outputs/_removed/`). This module holds the pure part: which files each
 * stage owns, and the move into the archive. The run itself (prerequisites, state, advancing) is `story.ts`.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beatsFile } from "@openthink/pablo-core";

/** Where adopted stages' files go, work-relative. */
export const ARCHIVE_DIR = "_archived";

const CHECKLIST = "research/checklist.md";
const PERIOD_FACTS = "facts/period.md";

/** Every non-dot file under `rel` (work-relative, forward slashes), sorted. */
function filesUnder(work: string, rel: string): string[] {
  const dir = join(work, rel);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    const child = `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...filesUnder(work, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/** The first table in `text` whose header's first cell is `#` (the beats table), as a line span, else undefined. */
function beatsSpan(lines: readonly string[]): { start: number; end: number } | undefined {
  const cell = (line: string): string => (line.trim().replace(/^\|/, "").split("|")[0] ?? "").trim();
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!lines[i]!.trim().startsWith("|") || cell(lines[i]!) !== "#") continue;
    if (!/^\|?[\s:|-]+\|?$/.test(lines[i + 1]!.trim()) || !lines[i + 1]!.includes("-")) continue;
    let end = i + 2;
    while (end < lines.length && lines[end]!.trim().startsWith("|")) end += 1;
    return { start: i, end };
  }
  return undefined;
}

/** The outline text with the beats table's data rows removed (its heading, header and the acts table stay). */
export function withoutBeats(text: string): string {
  const lines = text.split("\n");
  const span = beatsSpan(lines);
  if (span === undefined) return text;
  return [...lines.slice(0, span.start + 2), ...lines.slice(span.end)].join("\n");
}

/** A file whose live copy is rewritten after a copy goes to the archive: the outline, shared by the acts and beats stages. */
export interface Rewrite {
  readonly rel: string;
  readonly next: string;
}

export interface ArchivePlan {
  /** Files moved whole into the archive. */
  readonly moves: readonly string[];
  /** Files copied into the archive and rewritten in place. */
  readonly rewrites: readonly Rewrite[];
}

/**
 * What the stages `stages` (the adopted stage and every later core stage) produced in `work`, as files to move and
 * files to copy-and-rewrite. Only files that exist appear. Research notes are everything under `research/` except the
 * checklist, which belongs to `research-plan` (so a restart from `research` re-opens the checklist's items rather than
 * discarding the plan).
 */
export function planArchive(work: string, stages: readonly string[]): ArchivePlan {
  const moves = new Set<string>();
  const rewrites: Rewrite[] = [];
  const has = (stage: string): boolean => stages.includes(stage);

  if (has("research")) for (const rel of filesUnder(work, "research")) if (rel !== CHECKLIST) moves.add(rel);
  if (has("research-plan") && existsSync(join(work, CHECKLIST))) moves.add(CHECKLIST);
  if (has("premise") && existsSync(join(work, "bible/overview.md"))) moves.add("bible/overview.md");
  if (has("period") && existsSync(join(work, "bible/period.md"))) moves.add("bible/period.md");
  if (has("period-facts") && existsSync(join(work, PERIOD_FACTS))) moves.add(PERIOD_FACTS);
  if (has("bible")) for (const rel of filesUnder(work, "bible")) if (rel !== "bible/overview.md" && rel !== "bible/period.md") moves.add(rel);

  // The acts and beats tables share one file: an acts restart resets it, a beats restart keeps the acts.
  if (has("acts") || has("beats")) {
    const rel = beatsFile(work);
    if (existsSync(join(work, rel))) {
      const text = readFileSync(join(work, rel), "utf8");
      rewrites.push({ rel, next: has("acts") ? "# Outline\n" : withoutBeats(text) });
    }
  }
  return { moves: [...moves].sort(), rewrites };
}

/** The first free `_archived/<stage>-<date>[-K]`, work-relative. */
export function archiveDest(work: string, stage: string, date: string): string {
  const base = `${ARCHIVE_DIR}/${stage}-${date}`;
  if (!existsSync(join(work, base))) return base;
  for (let k = 2; ; k += 1) if (!existsSync(join(work, `${base}-${k}`))) return `${base}-${k}`;
}

/** Moves `rels` into `dest` (work-relative), keeping their paths; returns every work-relative path that changed, both sides of a move. */
export function applyArchive(work: string, plan: ArchivePlan, dest: string): string[] {
  const touched: string[] = [];
  for (const rel of plan.moves) {
    const to = `${dest}/${rel}`;
    mkdirSync(dirname(join(work, to)), { recursive: true });
    renameSync(join(work, rel), join(work, to));
    touched.push(rel, to);
  }
  for (const { rel, next } of plan.rewrites) {
    const to = `${dest}/${rel}`;
    mkdirSync(dirname(join(work, to)), { recursive: true });
    copyFileSync(join(work, rel), join(work, to));
    writeFileSync(join(work, rel), next, "utf8");
    touched.push(rel, to);
  }
  return touched;
}

/** Moves every file under `rel` into `dest`, keeping paths; returns the work-relative paths touched, both sides. */
export function moveDirToArchive(work: string, rel: string, dest: string): string[] {
  const touched: string[] = [];
  for (const file of filesUnder(work, rel)) {
    const to = `${dest}/${file}`;
    mkdirSync(dirname(join(work, to)), { recursive: true });
    renameSync(join(work, file), join(work, to));
    touched.push(file, to);
  }
  return touched;
}
