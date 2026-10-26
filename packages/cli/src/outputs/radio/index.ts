/**
 * The `radio` output type (AGT-1686, pm project `pablo-casting`): a radio
 * show told from the work's story core, one episode per core beat by
 * default, its scripts in `outputs/radio/episodes/`, its casting state in
 * `outputs/radio/casting/`, drafted on `draft/radio-epNN`.
 *
 * Its stage machine runs after the core's:
 *
 *     script N   the ordinary output write with the radio rules (outputs/radio/RULES.md)
 *     cast       every role the script needs bound to a library voice (pablo cast, bind)
 *     perform    takes, gates, retakes and the episode's manifest (pablo perform)
 *     mix        the episode file (pablo mix)
 *     fix        flagged lines re-recorded into a new version (pablo fix)
 *     publish    bundle (scripts, mixed audio, manifests in one directory); player; stream
 *
 * `preconditions` is the script stage (what the writer needs); the stages
 * after it are `./state.ts`'s `radioStageCheck`, which the casting verbs ask
 * before they provision or run anything. `status --for "radio N"` and
 * `resume` report each episode's stage, render and open flags, and the
 * Python side's state, all read from disk. `ensure()` only looks: the first
 * casting verb provisions the Python side, never a writing verb.
 */

import type { CoreState } from "../../core/machine";
import type { OutputDefinition, OutputReport, OutputUnit, UnitStatusReport } from "../types";
import { castingReadiness, ensureRadio } from "./casting-side";
import type { CastingReadiness } from "./casting-side";
import { buildRadioPack, radioPreconditions } from "./pack";
import { radioDefaultPlan, radioUnitFiles, radioUnitStatus } from "./plan";
import { publishRadio } from "./publish";
import { RADIO_RITUALS } from "./rituals";
import { RADIO_RULES_TEMPLATE } from "./rules";
import { episodeState, RADIO_STAGES } from "./state";
import type { EpisodeState, RadioStage } from "./state";
import {
  RADIO_DIR,
  RADIO_ID,
  RADIO_PUBLISH_TARGETS,
  radioBranch,
  radioUnitFileName,
  radioUnitOfBranch,
  radioUnitOfPath,
} from "./units";

/** The command a stage's next step is, for `next` lines. */
function stageCommand(stage: RadioStage, episode: number): string {
  switch (stage) {
    case "script":
      return `write episode ${episode} (pablo write --output radio --unit ${episode})`;
    case "cast":
      return `cast episode ${episode}'s roles (pablo cast --auto --episode ${episode}, or pablo bind)`;
    case "perform":
      return `perform episode ${episode} (pablo perform --output radio --unit ${episode})`;
    case "mix":
      return `mix episode ${episode} (pablo mix --output radio --unit ${episode})`;
    case "fix":
      return `fix episode ${episode}'s flagged lines (pablo fix --output radio --unit ${episode})`;
    case "publish":
      return "publish the show (pablo publish --output radio --target bundle)";
  }
}

function radioReport(workDir: string, core: CoreState): OutputReport {
  const plan = radioDefaultPlan(workDir);
  const files = radioUnitFiles(workDir);
  const numbers = [...new Set([...plan.map((r) => r.unit), ...files.keys()])].sort((a, b) => a - b);
  const units: OutputUnit[] = numbers.map((unit) => {
    const row = plan.find((r) => r.unit === unit);
    const beat = core.beats.find((b) => b.chapter === unit);
    const file = files.get(unit);
    const state = file === undefined ? undefined : episodeState(workDir, unit);
    return {
      unit,
      ...(row?.title !== undefined ? { title: row.title } : beat !== undefined ? { title: beat.title } : {}),
      ...(beat !== undefined && beat.storyDate !== "" ? { storyDate: beat.storyDate } : {}),
      status: radioUnitStatus(file),
      ...(file !== undefined ? { file: `${RADIO_DIR}/${file.slice(file.lastIndexOf("/") + 1)}` } : {}),
      render: state?.render ?? "none",
      openFlags: state?.openFlags ?? 0,
    };
  });
  const undrafted = units.find((u) => u.file === undefined);
  // Once every episode is written, the next is the first episode's next casting stage.
  const due = undrafted === undefined ? numbers.map((n) => episodeState(workDir, n)).find((s) => s.stage !== "publish") : undefined;
  const next = undrafted !== undefined ? stageCommand("script", undrafted.unit) : due !== undefined ? stageCommand(due.stage, due.episode) : undefined;
  const drafted = units.filter((u) => u.file !== undefined).length;
  return { noun: "episode", plural: "episodes", dir: RADIO_DIR, units, drafted, total: units.length, ...(next !== undefined ? { next } : {}) };
}

/** Which stages an episode has done, in order (publish is never "done": it is a target, run again at will). */
function stageRows(state: EpisodeState): { stage: RadioStage; done: boolean }[] {
  const at = RADIO_STAGES.indexOf(state.stage);
  return RADIO_STAGES.map((stage, i) => ({ stage, done: stage !== "publish" && i < at }));
}

/**
 * What an episode still needs before it is published, in stage order: its
 * script (and what the writer needs for it), each unbound role, a render, a
 * mix, its open flags, and the casting side while a casting stage is still
 * ahead (`not provisioned` included: the first casting verb provisions it,
 * and without `uv` it cannot be).
 */
function episodeMissing(workDir: string, state: EpisodeState, casting: CastingReadiness): string[] {
  const n = state.episode;
  if (!state.script) {
    return [`episode ${n} has no script (pablo write --output radio --unit ${n})`, ...radioPreconditions(workDir, n).missing];
  }
  const missing = state.unbound.map((role) => `role ${role} is not cast`);
  if (state.render === "none") missing.push(`episode ${n} has no render (pablo perform --output radio --unit ${n})`);
  else if (state.render.startsWith("performed")) missing.push(`episode ${n} is not mixed (pablo mix --output radio --unit ${n})`);
  if (state.openFlags > 0) missing.push(`episode ${n} has ${state.openFlags} open flag(s) (pablo fix --output radio --unit ${n})`);
  const ahead = missing.length > 0;
  if (ahead && casting.state !== "provisioned") {
    missing.push(casting.missing !== undefined ? `the casting side cannot be provisioned here: ${casting.missing.join(", ")}` : `the casting side is ${casting.state} (the first casting verb provisions it)`);
  }
  return missing;
}

/**
 * `status --for "radio N"`: `{ready, missing}` where `missing` is what the
 * episode still needs before it is published (unbound roles, a missing
 * render or mix, open flags, an unprovisioned Python side) and `ready` means
 * nothing is; plus its next stage and the command for it, each stage's
 * state, the render, the open flags and the casting side.
 */
function radioUnitStatusReport(workDir: string, episode: number): UnitStatusReport {
  const state = episodeState(workDir, episode);
  const casting = castingReadiness();
  const missing = episodeMissing(workDir, state, casting);
  return {
    ready: missing.length === 0,
    missing,
    detail: {
      stage: state.stage,
      next: stageCommand(state.stage, episode),
      stages: stageRows(state),
      unbound: state.unbound,
      render: state.render,
      ...(state.version !== undefined ? { version: state.version } : {}),
      ...(state.audio !== undefined ? { audio: state.audio } : {}),
      openFlags: state.openFlags,
      casting: { state: casting.state, note: casting.note },
    },
    lines: [
      `stage: ${state.stage} (next: ${stageCommand(state.stage, episode)})`,
      ...(state.unbound.length > 0 ? [`unbound roles: ${state.unbound.join(", ")}`] : []),
      `render: ${state.render}${state.openFlags > 0 ? `, ${state.openFlags} open flag(s)` : ""}`,
      `casting side: ${casting.note}`,
    ],
  };
}

export const RADIO: OutputDefinition = {
  id: RADIO_ID,
  noun: "episode",
  plural: "episodes",
  artifactDir: RADIO_DIR,
  rulesTemplate: RADIO_RULES_TEMPLATE,
  tracks: ["fiction", "historical-fiction"],
  stages: RADIO_STAGES,
  plan: radioDefaultPlan,
  preconditions: radioPreconditions,
  pack: buildRadioPack,
  rituals: RADIO_RITUALS,
  publish: { targets: RADIO_PUBLISH_TARGETS, run: publishRadio },
  report: radioReport,
  unitFileName: radioUnitFileName,
  unitOfPath: radioUnitOfPath,
  branch: radioBranch,
  unitOfBranch: radioUnitOfBranch,
  ensure: ensureRadio,
  manuscript: "lines",
  unitStatus: radioUnitStatusReport,
};
