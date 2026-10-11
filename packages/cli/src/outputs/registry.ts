/**
 * `OUTPUTS` (AGT-1668, pm project `pablo-story-core`, "The registry"): every
 * output type pablo knows, one row each, the single source the way `VERBS`
 * is for verbs. `pablo.json`'s `outputs` keys are checked against it
 * (`marker.ts`), `status` and `resume` report each declared output through
 * its `report`, and `write`, `check`, `publish`, `share`, `merge` and the
 * rituals ask the work's output for its paths, preconditions, pack, branch
 * names, rituals and publish targets instead of naming the novel's.
 *
 * Adding a type: a directory under `outputs/<type>/` exporting an
 * `OutputDefinition` (`./types.ts`), a row here, and nothing else; the
 * conformance test (`test/outputs.test.ts`, over `./conformance.ts`) runs
 * every row end to end, so a half-wired type cannot land.
 *
 * Only top-level `OUTPUTS` is evaluated at import; everything else is a
 * function, so the marker (which validates against this table and is read
 * by `outputForWork`) can import it back without an initialisation cycle.
 */

import type { Outputs } from "../marker";
import { readMarker } from "../marker";
import { NOVEL } from "./novel";
import type { OutputDefinition } from "./types";

export const OUTPUTS = {
  novel: NOVEL,
} as const satisfies Readonly<Record<string, OutputDefinition>>;

/** An output type's id: a key of `OUTPUTS`. */
export type OutputId = keyof typeof OUTPUTS;

/** Every registered type's id, in registry order. */
export function outputIds(): OutputId[] {
  return Object.keys(OUTPUTS) as OutputId[];
}

export function isOutputId(id: string): id is OutputId {
  return Object.hasOwn(OUTPUTS, id);
}

/**
 * The output a verb acts on for a work whose marker declares `declared`:
 * the declared type when there is one, and the novel for a work that declares
 * none (every verb treated a work as a novel before outputs existed; a core
 * with nothing derived yet still drafts, checks and publishes as one until
 * `--output` addressing, pablo-story-core S5, makes the choice explicit).
 */
export function workOutput(declared: Outputs): OutputDefinition {
  for (const id of Object.keys(declared)) {
    if (isOutputId(id)) return OUTPUTS[id];
  }
  return OUTPUTS.novel;
}

/** `workOutput` for a work directory, reading its marker; an unreadable marker falls back to the novel, as `workOutput({})` does. */
export function outputForWork(workDir: string): OutputDefinition {
  const marker = readMarker(workDir);
  return workOutput(marker.ok ? marker.marker.outputs : {});
}
