/**
 * Where a work stands, in both layers (AGT-1667, pm project
 * `pablo-story-core`): the story core's stages, then each output the marker
 * names with its units. `pablo status` (no `--for`) and `pablo resume` both
 * report this; `next` names the layer that is short:
 *
 *     core: <action>        the core is not at beats yet (premise, bible, acts, beats)
 *     add an output         the core is ready but the work derives nothing from it yet
 *     <type>: <action>      the first output with a unit still to draft
 *     all outputs drafted   nothing is short
 *
 * Each output's state comes from its row in the output registry
 * (`OUTPUTS[type].report`, AGT-1668), so a type added there is reported here
 * with no change to this file.
 */

import { coreNext, coreStages, readCoreState } from "./core/machine";
import type { CoreStage, CoreState } from "./core/machine";
import { waitingForReview } from "./branch";
import type { Outputs } from "./marker";
import { readMarker } from "./marker";
import { outputDefinition } from "./outputs/registry";
import type { OutputReport } from "./outputs/types";

export type { OutputReport };

/** The core's state with its stages evaluated, as reported. */
export interface CoreReport extends CoreState {
  readonly stages: readonly CoreStage[];
}

export interface WorkReport {
  readonly core: CoreReport;
  readonly outputs: Readonly<Record<string, OutputReport>>;
  readonly next: string;
}

/** The work-level next action over an evaluated core and its outputs. Pure. */
export function workNext(core: CoreState, outputs: Readonly<Record<string, OutputReport>>): string {
  const short = coreNext(core);
  if (short !== undefined) return `core: ${short}`;
  const types = Object.keys(outputs);
  if (types.length === 0) return "add an output";
  for (const type of types) {
    const next = outputs[type]?.next;
    if (next !== undefined) return `${type}: ${next}`;
  }
  return "all outputs drafted";
}

/** Reads `workDir`'s core and every output in `declared` (the marker's `outputs`) into one report. */
export function readWorkReport(workDir: string, declared: Outputs): WorkReport {
  const core = readCoreState(workDir);
  const outputs: Record<string, OutputReport> = {};
  for (const type of Object.keys(declared)) {
    const def = outputDefinition(type);
    if (def !== undefined) outputs[type] = def.report(workDir, core);
  }
  return { core: { ...core, stages: coreStages(core) }, outputs, next: workNext(core, outputs) };
}

/** The core block of the prose forms: a `core` heading, then one indented line per stage. */
export function coreLines(core: CoreReport): string[] {
  return ["core:", ...core.stages.map((stage) => `  ${stage.id}: ${stage.summary}`)];
}

/** One output's line: `novel: 2 of 24 chapters drafted`, with the drafted units' statuses when `detail` is set. */
export function outputLine(type: string, output: OutputReport, detail = false): string {
  const line = `${type}: ${output.drafted} of ${output.total} ${output.total === 1 ? output.noun : output.plural} drafted`;
  if (!detail) return line;
  const counts = new Map<string, number>();
  for (const unit of output.units) {
    if (unit.file === undefined) continue;
    counts.set(unit.status, (counts.get(unit.status) ?? 0) + 1);
  }
  const shown = [...counts.entries()].map(([status, n]) => `${status}: ${n}`).join(", ");
  return shown === "" ? line : `${line} (${shown})`;
}

/** Every output's line, or `outputs: none` for a core with nothing derived yet. */
export function outputLines(outputs: Readonly<Record<string, OutputReport>>, detail = false): string[] {
  const types = Object.keys(outputs);
  if (types.length === 0) return ["outputs: none"];
  return types.map((type) => outputLine(type, outputs[type] as OutputReport, detail));
}

/** `pablo status`'s whole-work body (no `--for`): the report plus the branches waiting for review. */
export interface WorkStatus extends WorkReport {
  readonly waiting: readonly string[];
}

/**
 * `pablo status` with no `--for`, for the CLI and the `status` verb alike:
 * the core's stages, then each output the marker names, the branches waiting
 * for review, and `next`. `workDir` is a resolved, marker-valid project.
 */
export function readWorkStatus(workDir: string): WorkStatus {
  const marker = readMarker(workDir);
  const report = readWorkReport(workDir, marker.ok ? marker.marker.outputs : {});
  return { core: report.core, outputs: report.outputs, waiting: waitingForReview(workDir), next: report.next };
}

/**
 * `status`'s prose: the core's stages, then one line per output with its
 * drafted units' statuses, the branches waiting for review, and `next`.
 */
export function formatStatusProse(status: WorkStatus): string {
  const { waiting } = status;
  return [
    ...coreLines(status.core),
    ...outputLines(status.outputs, true),
    waiting.length === 0 ? "waiting for review: none" : `waiting for review: ${waiting.length} (${waiting.join(", ")})`,
    `next: ${status.next}`,
  ].join("\n");
}
