/**
 * The `novel` output type (AGT-1668, pm project `pablo-story-core`): the
 * first row of `OUTPUTS`, and exactly what pablo did before outputs existed.
 * Chapters live in `chapters/` at the work root; one chapter per core beat; a
 * chapter needs its beat, the previous chapter, a timeline row for its year
 * and no undecided pick its beat names; the pack, the after-merge rituals,
 * the publish targets and the `draft/chNN` branches are today's, unchanged.
 *
 * The machinery stays where it was built (`../../novel/machine.ts`,
 * `pack.ts`, `rituals.ts`, `../../publish.ts`); this file is the one place
 * that binds it into a registry entry.
 */

import { planBeatsFor } from "@openthink/pablo-core";
import type { CoreState } from "../../core/machine";
import { chapterPreconditions, novelNext, novelUnits, readNovelOutputState, readNovelState } from "../../novel/machine";
import { buildChapterPack } from "../../novel/pack";
import { runAfterMerge, runAfterRevision } from "../../novel/rituals";
import { publishWork } from "../../publish";
import type { OutputDefinition, OutputReport } from "../types";
import { novelDefaultPlan } from "./plan";
import {
  NOVEL_DIR,
  NOVEL_ID,
  NOVEL_PUBLISH_TARGETS,
  novelBranch,
  novelUnitFileName,
  novelUnitOfBranch,
  novelUnitOfPath,
} from "./units";

/** `outputs/novel/RULES.md`'s heading and intro; `pablo migrate outputs` appends the novel-only sections of `STYLE.md`. */
export const NOVEL_RULES_TEMPLATE = `# Novel rules

Rules for the novel output only, layered after the work's voice (\`STYLE.md\`)
and before a chapter's own slices. Copied from the work's \`STYLE.md\` by
\`pablo migrate outputs\`; the ground rules and period facts stay there as
core.
`;

function novelReport(workDir: string, core: CoreState): OutputReport {
  const state = { ...core, ...readNovelOutputState(workDir) };
  const units = novelUnits(state);
  const next = novelNext(state);
  return {
    noun: "chapter",
    plural: "chapters",
    dir: NOVEL_DIR,
    units,
    drafted: units.filter((u) => u.file !== undefined).length,
    total: units.length,
    ...(next !== undefined ? { next } : {}),
  };
}

export const NOVEL: OutputDefinition = {
  id: NOVEL_ID,
  noun: "chapter",
  plural: "chapters",
  artifactDir: NOVEL_DIR,
  rulesTemplate: NOVEL_RULES_TEMPLATE,
  tracks: ["fiction", "historical-fiction"],
  stages: ["chapter", "revise", "publish"],
  plan: novelDefaultPlan,
  preconditions: (workDir, unit) =>
    chapterPreconditions(readNovelState(workDir), unit, planBeatsFor(workDir, NOVEL_ID, unit)),
  pack: buildChapterPack,
  rituals: { afterMerge: runAfterMerge, afterRevision: runAfterRevision },
  publish: { targets: NOVEL_PUBLISH_TARGETS, run: publishWork },
  report: novelReport,
  unitFileName: novelUnitFileName,
  unitOfPath: novelUnitOfPath,
  branch: novelBranch,
  unitOfBranch: novelUnitOfBranch,
};
