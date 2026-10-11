/**
 * The story output's pack (AGT-1689): the whole outline, or the beats its
 * plan row names, told as one piece. The beats go to the writer as one slice
 * (the multi-beat form the pack already has), the story-time gate runs at the
 * last beat's date (the piece spans them all), and the length is the
 * request's: `--words`, else a default that grows with the beats.
 */

import { join } from "node:path";
import { gateTimeline, outputRulesFile, planBeatsFor, readDraftingInputs, DEFAULT_MIN_SCENES } from "@openthink/pablo-core";
import { readCoreState } from "../../core/machine";
import { CAST_ENDS_AT, DEFAULT_WORD_TARGET, packFromInputs } from "../../novel/pack";
import type { UnitPackOptions, UnitPackOutcome } from "../types";
import { STORY_ID, STORY_UNIT } from "./units";

/** Words asked per beat when the request names no length; never below a chapter's default. */
export const WORDS_PER_BEAT = 600;

/** The beats the story tells: its plan row's, else every beat of the core. */
export function storyBeats(workDir: string): readonly number[] {
  return planBeatsFor(workDir, STORY_ID, STORY_UNIT) ?? readCoreState(workDir).beats.map((b) => b.chapter);
}

export function buildStoryPack(vaultRoot: string, workDir: string, unit: number, options: UnitPackOptions): UnitPackOutcome {
  if (unit !== STORY_UNIT) {
    return { ok: false, code: 2, message: `pablo: the story output has one unit (${STORY_UNIT}); got ${unit}` };
  }
  const beats = storyBeats(workDir);
  const inputs = readDraftingInputs({
    vaultRoot,
    workRoot: workDir,
    chapter: STORY_UNIT,
    beats,
    outputRulesPath: join(workDir, outputRulesFile(STORY_ID)),
    wordTarget: options.words ?? Math.max(DEFAULT_WORD_TARGET, beats.length * WORDS_PER_BEAT),
    minScenes: options.scenes ?? DEFAULT_MIN_SCENES,
    castEndsAt: CAST_ENDS_AT,
    work: { description: "short fiction" },
  });
  const last = [inputs.beat, ...(inputs.moreBeats ?? [])].at(-1) ?? inputs.beat;
  return packFromInputs(
    vaultRoot,
    workDir,
    {
      ...inputs,
      unitLabel: "the whole piece",
      timeline: gateTimeline(readCoreState(workDir).bible.timelineText, last.storyDate, inputs.timeline.source),
    },
    options,
  );
}
