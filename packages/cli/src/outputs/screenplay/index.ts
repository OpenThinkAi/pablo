/**
 * The `screenplay` output type (AGT-2132, pm project `pablo-platform`, D-7):
 * a screenplay told from the work's story core, stored as Fountain, one scene
 * per core beat by default, its scenes in `outputs/screenplay/scenes/` as
 * `NN-<slug>.fountain`, drafted on `draft/screenplay-scNN`.
 *
 * Stages after the core: draft (each scene, written with the screenplay
 * rules), revise, publish (`fountain`: every scene in one Fountain file).
 * Its storage mode is `screenplay`: `write` keeps the writer's Fountain line
 * for line (a cue, its dialogue and the blank lines between elements are the
 * structure), never one sentence per line. `pablo check` adds the Fountain
 * lint (`./fountain.ts`) to every scene.
 */

import type { CoreState } from "../../core/machine";
import type { OutputDefinition, OutputReport, OutputUnit } from "../types";
import { buildScreenplayPack, screenplayDefaultPlan, screenplayPreconditions, screenplayUnitFiles, screenplayUnitStatus } from "./pack";
import { publishScreenplay } from "./publish";
import { SCREENPLAY_RITUALS } from "./rituals";
import { SCREENPLAY_RULES_TEMPLATE } from "./rules";
import {
  SCREENPLAY_DIR,
  SCREENPLAY_ID,
  SCREENPLAY_PUBLISH_TARGETS,
  screenplayBranch,
  screenplayUnitFileName,
  screenplayUnitOfBranch,
  screenplayUnitOfPath,
} from "./units";

function screenplayReport(workDir: string, core: CoreState): OutputReport {
  const plan = screenplayDefaultPlan(workDir);
  const files = screenplayUnitFiles(workDir);
  const numbers = [...new Set([...plan.map((r) => r.unit), ...files.keys()])].sort((a, b) => a - b);
  const units: OutputUnit[] = numbers.map((unit) => {
    const row = plan.find((r) => r.unit === unit);
    const beat = core.beats.find((b) => b.chapter === unit);
    const file = files.get(unit);
    return {
      unit,
      ...(row?.title !== undefined ? { title: row.title } : beat !== undefined ? { title: beat.title } : {}),
      ...(beat !== undefined && beat.storyDate !== "" ? { storyDate: beat.storyDate } : {}),
      status: screenplayUnitStatus(file),
      ...(file !== undefined ? { file: `${SCREENPLAY_DIR}/${file.slice(file.lastIndexOf("/") + 1)}` } : {}),
    };
  });
  const undrafted = units.find((u) => u.file === undefined);
  const drafted = units.filter((u) => u.file !== undefined).length;
  return {
    noun: "scene",
    plural: "scenes",
    dir: SCREENPLAY_DIR,
    units,
    drafted,
    total: units.length,
    ...(undrafted !== undefined ? { next: `write scene ${undrafted.unit} (pablo write --output screenplay --unit ${undrafted.unit})` } : {}),
  };
}

export const SCREENPLAY: OutputDefinition = {
  id: SCREENPLAY_ID,
  noun: "scene",
  plural: "scenes",
  artifactDir: SCREENPLAY_DIR,
  rulesTemplate: SCREENPLAY_RULES_TEMPLATE,
  tracks: ["fiction", "historical-fiction"],
  stages: ["draft", "revise", "publish"],
  plan: screenplayDefaultPlan,
  preconditions: screenplayPreconditions,
  pack: buildScreenplayPack,
  rituals: SCREENPLAY_RITUALS,
  publish: { targets: SCREENPLAY_PUBLISH_TARGETS, run: publishScreenplay },
  report: screenplayReport,
  unitFileName: screenplayUnitFileName,
  unitOfPath: screenplayUnitOfPath,
  branch: screenplayBranch,
  unitOfBranch: screenplayUnitOfBranch,
  manuscript: "screenplay",
};
