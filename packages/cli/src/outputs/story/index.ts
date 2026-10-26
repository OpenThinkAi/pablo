/**
 * The `story` output type (AGT-1689, pm project `pablo-story-core`): a
 * single unit. One story told over all of the core's beats (or the beats of a
 * chosen act, by editing the plan row), stages draft -> revise -> publish,
 * the whole outline given to the writer as one slice, its length from the
 * request (`--words`), published through a review round and the compiler.
 * It lives in `outputs/story/story.md`, on `draft/story`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readCoreState, undecidedPicks } from "../../core/machine";
import type { CoreState } from "../../core/machine";
import { frontmatterField } from "../novel/plan";
import type { OutputDefinition, OutputReport, OutputUnit, UnitPreconditions } from "../types";
import { buildStoryPack, storyBeats } from "./pack";
import { storyDefaultPlan, STORY_TITLE } from "./plan";
import { publishStory } from "./publish";
import { STORY_RITUALS } from "./rituals";
import {
  STORY_DIR,
  STORY_FILE,
  STORY_ID,
  STORY_PUBLISH_TARGETS,
  STORY_UNIT,
  storyBranch,
  storyUnitFileName,
  storyUnitOfBranch,
  storyUnitOfPath,
} from "./units";

/** `outputs/story/RULES.md`'s scaffold: how the one-unit story is written, layered after the work's voice. */
export const STORY_RULES_TEMPLATE = `# Story rules

Rules for the story output only, layered after the work's voice (\`QWEN.md\`)
and before the story's own slices.

- The story is one piece told from start to finish, in the order of the
  beats it is given. Wherever the pack says "chapter", it means the story.
- Tell every beat given and nothing beyond them; compress and connect, do not
  list. The length is the request's: \`pablo write --output story --words N\`.
- To tell one act only, set the beats cell of the story's row in
  \`outputs/story/plan.md\` to that act's beats (for example \`1-3\`).
- Close the piece; a story ends where its last beat ends.
`;

function storyReport(workDir: string, core: CoreState): OutputReport {
  const beats = storyBeats(workDir);
  const first = core.beats.find((b) => b.chapter === beats[0]);
  const path = join(workDir, STORY_DIR, STORY_FILE);
  const drafted = existsSync(path);
  const text = drafted ? readFileSync(path, "utf8") : undefined;
  const title = (text === undefined ? undefined : frontmatterField(text, "title")) ?? first?.title;
  const units: OutputUnit[] =
    beats.length === 0 && !drafted
      ? []
      : [
          {
            unit: STORY_UNIT,
            title: title ?? STORY_TITLE,
            ...(first !== undefined && first.storyDate !== "" ? { storyDate: first.storyDate } : {}),
            status: text === undefined ? "beat" : (frontmatterField(text, "status") ?? "unknown"),
            ...(drafted ? { file: `${STORY_DIR}/${STORY_FILE}` } : {}),
          },
        ];
  return {
    noun: "story",
    plural: "stories",
    dir: STORY_DIR,
    units,
    drafted: drafted ? 1 : 0,
    total: units.length,
    ...(units.length > 0 && !drafted ? { next: `write the story (pablo write --output story)` } : {}),
  };
}

function storyPreconditions(workDir: string, unit: number): UnitPreconditions {
  if (unit !== STORY_UNIT) return { ready: false, missing: [`the story output has one unit (${STORY_UNIT}); got ${unit}`] };
  const state = readCoreState(workDir);
  const numbers = storyBeats(workDir);
  if (numbers.length === 0) return { ready: false, missing: [`no beats for the story in ${state.outlineFile}`] };
  const rows = numbers.map((n) => ({ n, row: state.beats.find((b) => b.chapter === n) }));
  const absent = rows.filter((r) => r.row === undefined);
  if (absent.length > 0) return { ready: false, missing: absent.map((r) => `no beat ${r.n} in ${state.outlineFile}`) };
  const missing = rows.flatMap((r) => undecidedPicks(state, (r.row as NonNullable<typeof r.row>).beat));
  return { ready: missing.length === 0, missing };
}

export const STORY: OutputDefinition = {
  id: STORY_ID,
  noun: "story",
  plural: "stories",
  artifactDir: STORY_DIR,
  rulesTemplate: STORY_RULES_TEMPLATE,
  soleUnit: STORY_UNIT,
  tracks: ["fiction", "historical-fiction"],
  stages: ["draft", "revise", "publish"],
  plan: storyDefaultPlan,
  preconditions: storyPreconditions,
  pack: buildStoryPack,
  rituals: STORY_RITUALS,
  publish: { targets: STORY_PUBLISH_TARGETS, run: publishStory },
  report: storyReport,
  unitFileName: storyUnitFileName,
  unitOfPath: storyUnitOfPath,
  branch: storyBranch,
  unitOfBranch: storyUnitOfBranch,
};
