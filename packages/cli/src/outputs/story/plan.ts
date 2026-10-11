/**
 * The story output's default plan (AGT-1689): one unit, the whole story,
 * mapped onto every beat of the core. A story told from one act is the same
 * plan with that act's beats in the row (`outputs/story/plan.md`'s beats
 * cell, e.g. `1-3`), which the author edits and `pablo output plan story`
 * keeps. Reads only, never writes.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readCoreState } from "../../core/machine";
import type { PlanRow } from "../types";
import { frontmatterField } from "../novel/plan";
import { STORY_DIR, STORY_FILE, STORY_UNIT } from "./units";

/** The row's title: the story has one unit, so one name for it. */
export const STORY_TITLE = "The story";

/** The story file's frontmatter status when the file exists, else `beat`. */
export function storyStatus(workDir: string): string {
  const path = join(workDir, STORY_DIR, STORY_FILE);
  return existsSync(path) ? (frontmatterField(readFileSync(path, "utf8"), "status") ?? "draft") : "beat";
}

/** `OUTPUTS.story.plan`: unit 1 over every beat of the core, in order; no rows while the core has no beats. */
export function storyDefaultPlan(workDir: string): PlanRow[] {
  const beats = readCoreState(workDir).beats.map((b) => b.chapter);
  if (beats.length === 0) return [];
  return [{ unit: STORY_UNIT, title: STORY_TITLE, beats, status: storyStatus(workDir) }];
}
