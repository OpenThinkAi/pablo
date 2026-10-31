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
import type { UnitPackOptions, UnitPackOutcome, UnitParts } from "../types";
import { STORY_ID, STORY_UNIT } from "./units";

/** Words asked per beat when the request names no length; never below a chapter's default. */
export const WORDS_PER_BEAT = 600;

/**
 * A story over more beats than this is drafted beat by beat (AGT-2286): one request per beat, stitched, so every
 * beat gets its share of the words. At 8 beats one request returned 46% under target and read as a summary.
 * Up to this many, one request holds each beat well enough, and the single pack is the proven form.
 */
export const BEAT_BY_BEAT_OVER = 4;

/** Words of the text so far each later part is given to continue from. */
const PART_TAIL_WORDS = 400;

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
    // AGT-1671: the story's own ledger (outputs/story/continuity.md) plus facts.md, never the novel's.
    output: STORY_ID,
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
    { ...options, output: STORY_ID },
  );
}

/**
 * The story as one request per beat (AGT-2286), or `undefined` when it has few enough beats for one. Each part
 * carries one beat, its share of the word target, the story-time gate at that beat's date, and the end of the
 * text drafted so far. The stitched draft is still the one unit.
 */
export function storyParts(vaultRoot: string, workDir: string, unit: number, options: UnitPackOptions): UnitParts | undefined {
  if (unit !== STORY_UNIT) return undefined;
  const beats = storyBeats(workDir);
  if (beats.length <= BEAT_BY_BEAT_OVER) return undefined;
  const total = options.words ?? Math.max(DEFAULT_WORD_TARGET, beats.length * WORDS_PER_BEAT);
  const share = Math.max(1, Math.round(total / beats.length));
  return {
    count: beats.length,
    pack: (index, soFar) => {
      const inputs = readDraftingInputs({
        vaultRoot,
        workRoot: workDir,
        chapter: STORY_UNIT,
        beats: [beats[index - 1] as number],
        outputRulesPath: join(workDir, outputRulesFile(STORY_ID)),
        wordTarget: share,
        minScenes: 1,
        castEndsAt: CAST_ENDS_AT,
        work: { description: "short fiction" },
        output: STORY_ID,
      });
      const tail = soFar.trim().split(/\s+/).slice(-PART_TAIL_WORDS).join(" ");
      return packFromInputs(
        vaultRoot,
        workDir,
        {
          ...inputs,
          unitLabel: `part ${index} of ${beats.length} of the story`,
          part: { number: index, of: beats.length },
          // The beat-by-beat form carries the stitched text so far, never a previous chapter's tail.
          previousTail: tail === "" ? undefined : { path: "the story so far", text: tail },
        },
        { ...options, output: STORY_ID },
      );
    },
  };
}
