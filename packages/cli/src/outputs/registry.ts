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
 * Addressing (AGT-1669, "Addressing an output"): a verb that acts on one
 * output takes `--output <type>` and resolves it with `resolveOutput`, which
 * applies the default-output rule: a work with one output needs no flag; a
 * work with several refuses a verb that names none, listing them
 * (`missing: ["--output: novel | radio"]`).
 *
 * Only top-level `OUTPUTS` is evaluated at import; everything else is a
 * function, so the marker (which validates against this table and is read
 * by `outputForWork`) can import it back without an initialisation cycle.
 */

import type { Outputs } from "../marker";
import { readMarker } from "../marker";
import { NOVEL } from "./novel";
import { RADIO } from "./radio";
import { SCREENPLAY } from "./screenplay";
import { STORY } from "./story";
import type { OutputDefinition } from "./types";

export const OUTPUTS = {
  novel: NOVEL,
  story: STORY,
  screenplay: SCREENPLAY,
  radio: RADIO,
} as const satisfies Readonly<Record<string, OutputDefinition>>;

/** An output type's id: a key of `OUTPUTS` (or of a type a test registered). */
export type OutputId = string;

/**
 * Types registered at run time by `registerOutput`: tests only (a fixture
 * type such as a `blog`, to exercise a type pablo does not ship). Production
 * types are rows of `OUTPUTS` (`novel`, `story`, `screenplay`, `radio`), never registered.
 */
const registered = new Map<string, OutputDefinition>();

/**
 * Tests only: makes `def` a known output type until the returned function is
 * called. Throws on an id `OUTPUTS` or an earlier registration already holds.
 */
export function registerOutput(def: OutputDefinition): () => void {
  if (Object.hasOwn(OUTPUTS, def.id) || registered.has(def.id)) throw new Error(`pablo: output type "${def.id}" is already registered`);
  registered.set(def.id, def);
  return () => {
    if (registered.get(def.id) === def) registered.delete(def.id);
  };
}

/** Every known type's id, `OUTPUTS` order first. */
export function outputIds(): OutputId[] {
  return [...Object.keys(OUTPUTS), ...registered.keys()];
}

export function isOutputId(id: string): boolean {
  return Object.hasOwn(OUTPUTS, id) || registered.has(id);
}

/** The definition for `id`, or undefined for a type pablo does not know. */
export function outputDefinition(id: string): OutputDefinition | undefined {
  if (Object.hasOwn(OUTPUTS, id)) return OUTPUTS[id as keyof typeof OUTPUTS];
  return registered.get(id);
}

/**
 * The output a verb acts on for a work whose marker declares `declared`, when
 * the verb is not addressed to one: the first declared type, and the novel
 * for a work that declares none (every verb treated a work as a novel before
 * outputs existed). A verb addressed to one output uses `resolveOutput`.
 */
export function workOutput(declared: Outputs): OutputDefinition {
  for (const id of Object.keys(declared)) {
    const def = outputDefinition(id);
    if (def !== undefined) return def;
  }
  return OUTPUTS.novel;
}

/** `workOutput` for a work directory, reading its marker; an unreadable marker falls back to the novel, as `workOutput({})` does. */
export function outputForWork(workDir: string): OutputDefinition {
  const marker = readMarker(workDir);
  return workOutput(marker.ok ? marker.marker.outputs : {});
}

/**
 * The output a draft branch belongs to on a work (AGT-1690): the declared
 * type whose `unitOfBranch` reads it, so `draft/story` merges as the story's
 * on a work that also has a novel. A work that declares none is read as the
 * novel, as `outputForWork` reads it. Undefined for a branch no declared type
 * drafts.
 */
export function outputForBranch(workDir: string, branch: string): { readonly output: OutputDefinition; readonly unit: number } | undefined {
  const marker = readMarker(workDir);
  const declared = marker.ok ? Object.keys(marker.marker.outputs) : [];
  const defs = declared.length === 0 ? [OUTPUTS.novel] : declared.map(outputDefinition).filter((d): d is OutputDefinition => d !== undefined);
  for (const output of defs) {
    const unit = output.unitOfBranch(branch);
    if (unit !== undefined) return { output, unit };
  }
  return undefined;
}

/** `resolveOutput`'s refusal: exit 2, naming what is missing. */
export interface OutputRefusal {
  readonly ok: false;
  readonly code: 2;
  readonly message: string;
  readonly missing: readonly string[];
}

export type ResolvedOutput = { readonly ok: true; readonly output: OutputDefinition } | OutputRefusal;

/** The item a multi-output work's refusal names: `--output: novel | radio`. */
export function outputChoice(declared: Outputs): string {
  return `--output: ${Object.keys(declared).join(" | ")}`;
}

/**
 * The default-output rule (pablo-story-core, "Addressing an output"). With
 * `requested`: it must be a known type the work declares (a work that
 * declares none may still name the novel, which it is read as). Without:
 * the one declared output, the novel for a work that declares none, and a
 * refusal naming every declared type when there are several. `verb` names
 * the verb in the message.
 */
export function resolveOutput(declared: Outputs, requested: string | undefined, verb: string): ResolvedOutput {
  const types = Object.keys(declared);
  if (requested !== undefined) {
    const def = outputDefinition(requested);
    if (def === undefined) {
      return {
        ok: false,
        code: 2,
        message: `pablo: ${verb}: unknown output type "${requested}" (known: ${outputIds().join(", ")})`,
        missing: [`--output: ${outputIds().join(" | ")}`],
      };
    }
    if (types.includes(requested) || (types.length === 0 && def === OUTPUTS.novel)) return { ok: true, output: def };
    return {
      ok: false,
      code: 2,
      message: `pablo: ${verb}: the work has no ${requested} output (it has: ${types.length === 0 ? "none" : types.join(", ")}); add it with \`pablo output add ${requested}\``,
      missing: [`output ${requested} (pablo output add ${requested})`],
    };
  }
  if (types.length > 1) {
    return {
      ok: false,
      code: 2,
      message: `pablo: ${verb}: the work has ${types.length} outputs (${types.join(", ")}); name one with --output`,
      missing: [outputChoice(declared)],
    };
  }
  return { ok: true, output: workOutput(declared) };
}
