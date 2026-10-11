/**
 * `pablo migrate outputs` (AGT-1666): turns a one-format novel into a story
 * core plus a `novel` output, in one commit of exactly the paths it touches.
 * Design: the `pablo-story-core` pm doc, "Migration: today's novel into core +
 * novel output"; the beats rename is Matt's 2026-10-10 decision 3.
 *
 *   pablo.json                    `format` dropped, `outputs.novel = {dir: <the novel's artifactDir>, added}`
 *                                 (`added`: the first chapter's `generated` date, else today)
 *   outputs/novel/plan.md         one unit per beat; a unit whose chapter exists carries its status
 *   outputs/novel/RULES.md        the novel-only sections of the work's `QWEN.md` (point of view,
 *                                 chapter length, scene conventions), copied
 *   continuity.md              -> outputs/novel/continuity.md
 *   outline/chapters.md        -> outline/beats.md   (content unchanged; readers shim the old name)
 *   facts.md                      the promoted-facts ledger, header only
 *
 * The novel's chapters, `bible/`, `research/`, `notes/` and the work's `QWEN.md` are
 * never written (the QWEN.md sections stay where they are until the pack layers
 * `RULES.md`, pablo-story-core S6, so the writer's voice does not change here).
 *
 * Each step runs only when it is still needed, so a second run (or a run on a
 * work `pablo init` created with `outputs` already) does only what is left,
 * and a fully migrated work changes and commits nothing. A step whose old and
 * new paths both exist is a refusal: pablo will not pick one for the author.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { BEATS_FILE, LEGACY_BEATS_FILE, LEGACY_CONTINUITY_FILE, NOVEL_CONTINUITY_FILE } from "@openthink/pablo-core";
import { gitCommit } from "./init";
import { markerPath, readMarker } from "./marker";
import { dirtyPaths } from "./migrate";
import { frontmatterField, novelPlanRows, novelUnitFiles, renderNovelPlan } from "./outputs/novel/plan";
import { OUTPUTS } from "./outputs/registry";

export const MIGRATE_OUTPUTS_COMMIT_MESSAGE = "migrate: story core and novel output";

export const NOVEL_PLAN_FILE = "outputs/novel/plan.md";
export const NOVEL_RULES_FILE = "outputs/novel/RULES.md";
export const FACTS_FILE = "facts.md";

/** A `## ` heading of `QWEN.md` whose section is a novel-only rule (moved to `outputs/novel/RULES.md`). */
export const NOVEL_RULES_HEADING = /point of view|\bpov\b|chapter length|\blength\b|scene/i;

/** One change the migration makes; paths are work-relative. */
export type OutputsChange =
  | { readonly op: "rewrite"; readonly path: string }
  | { readonly op: "create"; readonly path: string }
  | { readonly op: "move"; readonly from: string; readonly path: string };

export type MigrateOutputsResult =
  | {
      readonly ok: true;
      readonly dryRun: boolean;
      readonly changes: readonly OutputsChange[];
      /** Every work-relative path the commit holds (both sides of a move), sorted. */
      readonly paths: readonly string[];
      readonly committed: boolean;
      readonly notice?: string;
    }
  | { readonly ok: false; readonly code: 2; readonly message: string };

export interface MigrateOutputsOptions {
  readonly dryRun: boolean;
  /** The clock for `outputs.novel.added` when no chapter carries a `generated` date. */
  readonly now?: () => Date;
}

const FACTS_TEXT = `# Facts

Facts every output of this work must honour: continuity an output established
that the author (or the harness, with the author) promoted to the story core.
Each fact names where it came from, e.g. \`established-by: novel/ch03\`.
Nothing lands here by itself; promotion is explicit.
`;

function refuse(message: string): MigrateOutputsResult {
  return { ok: false, code: 2, message: `pablo: migrate outputs: ${message}` };
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The first chapter's `generated` date (YYYY-MM-DD), else today. */
function addedDate(workDir: string, now: () => Date): string {
  const chapters = novelUnitFiles(workDir);
  const first = [...chapters.keys()].sort((a, b) => a - b)[0];
  if (first !== undefined) {
    const generated = frontmatterField(readFileSync(chapters.get(first) as string, "utf8"), "generated");
    const date = generated === undefined ? undefined : /^(\d{4}-\d{2}-\d{2})/.exec(generated)?.[1];
    if (date !== undefined) return date;
  }
  return localDate(now());
}

/** `pablo.json` with `format` replaced by `outputs` in the same position, every other key as written. */
function rewrittenMarker(raw: Record<string, unknown>, added: string): string {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "format") out["outputs"] = { novel: { dir: OUTPUTS.novel.artifactDir, added } };
    else out[key] = value;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** `outputs/novel/plan.md`: one unit per beat, the unit's status the chapter's when it exists, else `beat`. */
export function novelPlan(workDir: string, beatsText: string): string {
  return renderNovelPlan(novelPlanRows(workDir, beatsText));
}

/** `outputs/novel/RULES.md`: the intro, then each `## ` section of `QWEN.md` whose heading is a novel-only rule, verbatim. */
export function novelRules(qwen: string): string {
  const sections: string[] = [];
  const lines = qwen.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const heading = /^##\s+(.+?)\s*$/.exec(lines[i] as string);
    if (!heading || !NOVEL_RULES_HEADING.test(heading[1] as string)) continue;
    let end = i + 1;
    while (end < lines.length && !/^#{1,2}\s/.test(lines[end] as string)) end++;
    sections.push(lines.slice(i, end).join("\n").trimEnd());
    i = end - 1;
  }
  return sections.length === 0
    ? `${OUTPUTS.novel.rulesTemplate}\n(No novel-only section was found in \`QWEN.md\`; add the novel's rules here.)\n`
    : `${OUTPUTS.novel.rulesTemplate}\n${sections.join("\n\n")}\n`;
}

/**
 * Migrates the work at `projectPath` (inside the git repository at
 * `vaultRoot`). `--dry-run` returns the same `changes` and writes nothing.
 */
export function migrateOutputs(vaultRoot: string, projectPath: string, opts: MigrateOutputsOptions): MigrateOutputsResult {
  const now = opts.now ?? (() => new Date());
  const found = readMarker(projectPath);
  if (!found.ok) return { ok: false, code: 2, message: found.message };

  const raw = JSON.parse(readFileSync(markerPath(projectPath), "utf8")) as Record<string, unknown>;
  const legacy = raw["format"] !== undefined;
  const novel = legacy || found.marker.outputs.novel !== undefined;
  const has = (rel: string): boolean => existsSync(join(projectPath, rel));

  for (const [from, to] of [
    [LEGACY_BEATS_FILE, BEATS_FILE],
    ...(novel ? [[LEGACY_CONTINUITY_FILE, NOVEL_CONTINUITY_FILE]] : []),
  ] as const) {
    if (has(from) && has(to)) return refuse(`both ${from} and ${to} exist; keep one and run it again`);
  }

  const changes: OutputsChange[] = [];
  const writes: { rel: string; content: string }[] = [];
  const moves: { from: string; to: string }[] = [];

  if (legacy) {
    changes.push({ op: "rewrite", path: "pablo.json" });
    writes.push({ rel: "pablo.json", content: rewrittenMarker(raw, addedDate(projectPath, now)) });
  }

  const beatsFrom = has(LEGACY_BEATS_FILE) ? LEGACY_BEATS_FILE : BEATS_FILE;
  if (novel && !has(NOVEL_PLAN_FILE)) {
    const beatsText = has(beatsFrom) ? readFileSync(join(projectPath, beatsFrom), "utf8") : "";
    changes.push({ op: "create", path: NOVEL_PLAN_FILE });
    writes.push({ rel: NOVEL_PLAN_FILE, content: novelPlan(projectPath, beatsText) });
  }
  if (novel && !has(NOVEL_RULES_FILE)) {
    const qwen = has("QWEN.md") ? readFileSync(join(projectPath, "QWEN.md"), "utf8") : "";
    changes.push({ op: "create", path: NOVEL_RULES_FILE });
    writes.push({ rel: NOVEL_RULES_FILE, content: novelRules(qwen) });
  }
  if (novel && has(LEGACY_CONTINUITY_FILE)) {
    changes.push({ op: "move", from: LEGACY_CONTINUITY_FILE, path: NOVEL_CONTINUITY_FILE });
    moves.push({ from: LEGACY_CONTINUITY_FILE, to: NOVEL_CONTINUITY_FILE });
  }
  if (has(LEGACY_BEATS_FILE)) {
    changes.push({ op: "move", from: LEGACY_BEATS_FILE, path: BEATS_FILE });
    moves.push({ from: LEGACY_BEATS_FILE, to: BEATS_FILE });
  }
  if (!has(FACTS_FILE)) {
    changes.push({ op: "create", path: FACTS_FILE });
    writes.push({ rel: FACTS_FILE, content: FACTS_TEXT });
  }

  const paths = [...new Set(changes.flatMap((c) => (c.op === "move" ? [c.from, c.path] : [c.path])))].sort();
  if (opts.dryRun || changes.length === 0) {
    return { ok: true, dryRun: opts.dryRun, changes, paths, committed: false };
  }

  const toVault = (rel: string): string => relative(vaultRoot, join(projectPath, rel));
  const dirty = dirtyPaths(vaultRoot, paths.filter(has).map(toVault));
  if (dirty.length > 0) {
    return refuse(`uncommitted changes in ${dirty.join(", ")}; commit or discard them first so the migration commit holds only the migration`);
  }

  for (const m of moves) {
    mkdirSync(dirname(join(projectPath, m.to)), { recursive: true });
    renameSync(join(projectPath, m.from), join(projectPath, m.to));
  }
  for (const w of writes) {
    mkdirSync(dirname(join(projectPath, w.rel)), { recursive: true });
    writeFileSync(join(projectPath, w.rel), w.content, "utf8");
  }

  // Both sides of each move go in the pathspec: the old path stages as a removal, git records the rename.
  const { committed, notice } = gitCommit(
    vaultRoot,
    MIGRATE_OUTPUTS_COMMIT_MESSAGE,
    paths.map((rel) => join(projectPath, rel)),
  );
  return { ok: true, dryRun: false, changes, paths, committed, ...(notice ? { notice } : {}) };
}
