/**
 * `pablo migrate style` (AGT-2141, pablo-platform D-15): renames a work's rules
 * file from `QWEN.md` to the model-neutral `STYLE.md` with `git mv`, and points
 * the work's `pablo.json` `voice` entry at the new name. Every reader already
 * falls back to `QWEN.md` (`workRulesFile`), so a work that is never migrated
 * keeps working; this verb is the author's choice to move it.
 *
 * Idempotent: a work that already has `STYLE.md` and no `QWEN.md` changes and
 * commits nothing. A work with both is a refusal, because pablo will not pick
 * one of two rule files for the author. Committed on its own, by path.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_WORK_RULES_FILE, WORK_RULES_FILE } from "@openthink/pablo-core";
import { gitCommit } from "./init";
import { markerPath } from "./marker";

export const MIGRATE_STYLE_COMMIT_MESSAGE = "migrate: QWEN.md -> STYLE.md";

export interface MigrateStyleOptions {
  readonly dryRun: boolean;
}

export type MigrateStyleResult =
  | {
      readonly ok: true;
      readonly dryRun: boolean;
      /** Work-relative paths that changed (or, dry-run, would): the rename, then `pablo.json`. */
      readonly changes: readonly string[];
      readonly committed: boolean;
      readonly notice?: string;
    }
  | { readonly ok: false; readonly code: 2; readonly message: string };

function refuse(message: string): MigrateStyleResult {
  return { ok: false, code: 2, message: `pablo: migrate style: ${message}` };
}

/** `pablo.json` text with every `voice` entry naming `QWEN.md` renamed, or `undefined` when none does. */
function rewrittenMarker(projectPath: string): string | undefined {
  const file = markerPath(projectPath);
  if (!existsSync(file)) return undefined;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw["voice"]) || !raw["voice"].includes(LEGACY_WORK_RULES_FILE)) return undefined;
  const voice = raw["voice"].map((entry) => (entry === LEGACY_WORK_RULES_FILE ? WORK_RULES_FILE : entry));
  return `${JSON.stringify({ ...raw, voice }, null, 2)}\n`;
}

/**
 * Moves `from` to `to` with `git mv`; a file git does not track is renamed on disk instead.
 * `git mv` stages the removal of `from`, which a pathspec commit cannot then name, so the
 * removal is un-staged again: the commit by path stages both sides itself, and git records the rename.
 */
function move(vaultRoot: string, from: string, to: string): void {
  try {
    execFileSync("git", ["-C", vaultRoot, "mv", "--", from, to], { stdio: "pipe" });
    execFileSync("git", ["-C", vaultRoot, "reset", "-q", "--", from], { stdio: "pipe" });
  } catch {
    if (existsSync(from)) renameSync(from, to);
  }
}

/** Renames the work's `QWEN.md` to `STYLE.md` (inside the git repository at `vaultRoot`). `--dry-run` writes nothing. */
export function migrateStyle(vaultRoot: string, projectPath: string, opts: MigrateStyleOptions): MigrateStyleResult {
  const from = join(projectPath, LEGACY_WORK_RULES_FILE);
  const to = join(projectPath, WORK_RULES_FILE);
  const hasOld = existsSync(from);
  const hasNew = existsSync(to);
  if (hasOld && hasNew) return refuse(`both ${LEGACY_WORK_RULES_FILE} and ${WORK_RULES_FILE} exist; keep one and run it again`);

  const marker = rewrittenMarker(projectPath);
  const changes: string[] = [];
  if (hasOld) changes.push(`${LEGACY_WORK_RULES_FILE} -> ${WORK_RULES_FILE}`);
  if (marker !== undefined) changes.push("pablo.json");
  if (opts.dryRun) return { ok: true, dryRun: true, changes, committed: false };
  if (changes.length === 0) return { ok: true, dryRun: false, changes, committed: false };

  if (hasOld) move(vaultRoot, from, to);
  const paths = hasOld ? [from, to] : [];
  if (marker !== undefined) {
    writeFileSync(markerPath(projectPath), marker, "utf8");
    paths.push(markerPath(projectPath));
  }
  // Both sides of the rename go in the pathspec: the old path stages as a removal, git records the rename.
  const { committed, notice } = gitCommit(vaultRoot, MIGRATE_STYLE_COMMIT_MESSAGE, paths);
  return { ok: true, dryRun: false, changes, committed, ...(notice ? { notice } : {}) };
}
