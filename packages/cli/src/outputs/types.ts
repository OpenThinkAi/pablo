/**
 * The shape of one output type (AGT-1668, pm project `pablo-story-core`,
 * "The output layer"): everything a verb needs to know about how a work's
 * story core is told in one form. `OUTPUTS` (`./registry.ts`) holds one
 * `OutputDefinition` per type; `write`, `check`, `publish`, `share`, `merge`,
 * the rituals and `status`/`resume` ask it instead of naming a type's paths.
 *
 * A type is added by adding a directory under `outputs/` and a row in
 * `OUTPUTS`; `./conformance.ts` is the test every row must pass (every field
 * present, and plan, preconditions, pack, rituals and publish working end to
 * end on a four-beat fixture with a fake writer).
 */

import type { DraftingInputs, Pack } from "@openthink/pablo-core";
import type { CoreState } from "../core/machine";
import type { Marker } from "../marker";
import type { Ritual, RitualOptions } from "../novel/rituals";

/** One unit as `status` and `resume` report it: a beat row, a unit file, or both. */
export interface OutputUnit {
  readonly unit: number;
  readonly title?: string;
  readonly storyDate?: string;
  /** The unit file's frontmatter `status` (`"unknown"` when it has none), or `"beat"` when only the beat exists. */
  readonly status: string;
  /** The unit file, work-relative, when it is drafted. */
  readonly file?: string;
}

/** One output's state as reported: its units and the next one to draft. */
export interface OutputReport {
  readonly noun: string;
  readonly plural: string;
  /** Where the output's units land, work-relative. */
  readonly dir: string;
  readonly units: readonly OutputUnit[];
  /** Units with a file on disk. */
  readonly drafted: number;
  readonly total: number;
  /** The output's next action, absent when every unit is drafted. */
  readonly next?: string;
}

/** One row of an output's plan: a unit mapped onto the core beats it tells. */
export interface PlanRow {
  readonly unit: number;
  readonly title: string;
  /** The core beat numbers the unit tells. */
  readonly beats: readonly number[];
  /** The unit file's status when it exists, else `"beat"`. */
  readonly status: string;
}

/** What a unit needs beyond the core, and what is missing. */
export interface UnitPreconditions {
  readonly ready: boolean;
  readonly missing: readonly string[];
}

export interface UnitPackOptions {
  readonly words?: number | undefined;
  readonly scenes?: number | undefined;
  /** The work's `pablo.json`, for `neverSend`. */
  readonly marker: Marker;
  /** A steer for this unit beyond its beat: its own `direction` slice. */
  readonly direction?: string | undefined;
  /**
   * The output the unit belongs to (AGT-1671): the pack carries that output's
   * own continuity ledger plus `facts.md`, never another output's ledger.
   * Callers pass the definition's `id`; absent means the novel.
   */
  readonly output?: string | undefined;
}

/** The writer's pack for one unit, or a refusal (a `neverSend` violation). */
export type UnitPackOutcome =
  | { readonly ok: true; readonly pack: Pack; readonly inputs: DraftingInputs }
  | { readonly ok: false; readonly code: 2; readonly message: string };

/** The after-write steps for a unit. Neither ever throws: a failure is a `Ritual` with status `failed`. */
export interface OutputRituals {
  /** After a drafted unit is merged to `main`: `unitPath` is the merged unit file, absolute. */
  readonly afterMerge: (workDir: string, unit: number, unitPath: string, opts: RitualOptions) => Promise<Ritual[]>;
  /** After a non-draft branch (revise/, edit/, reader/) that changed or commented on the unit is merged. */
  readonly afterRevision: (
    workDir: string,
    unit: number,
    opts: Pick<RitualOptions, "slug" | "authorNotes" | "now" | "env" | "thinkTimeoutMs"> & { readonly branch: string },
  ) => Ritual[] | Promise<Ritual[]>;
}

export type PublishOutcome =
  | {
      readonly ok: true;
      readonly code: 0;
      readonly target: string;
      /** Absolute path of the file written. */
      readonly where: string;
      /** Units compiled. */
      readonly chapters: number;
      readonly words: number;
    }
  | { readonly ok: false; readonly code: 2; readonly message: string; readonly tried: readonly string[] };

export interface OutputPublish {
  /** Every `--target` the type names, built or not. */
  readonly targets: readonly string[];
  /** Publishes the work's units to `target`; an unknown or unbuilt target is a refusal. */
  readonly run: (workDir: string, slug: string, title: string, target: string | undefined) => PublishOutcome;
}

/** `ensure()`'s answer (AGT-1690): the type can run on this machine, or what it is missing. */
export type EnsureOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly missing?: readonly string[] };

export interface OutputDefinition {
  /** The key in `pablo.json`'s `outputs` and in `OUTPUTS`. */
  readonly id: string;
  /** What one unit is called (`chapter`), and many (`chapters`). */
  readonly noun: string;
  readonly plural: string;
  /** Where units land, work-relative, no trailing slash. */
  readonly artifactDir: string;
  /** The `outputs/<id>/RULES.md` scaffold: the type's own rules, layered after the work's voice. */
  readonly rulesTemplate: string;
  /** For an output with exactly one unit (the story), its number: `write` needs no `--unit`. Absent for multi-unit outputs. */
  readonly soleUnit?: number;
  /** The output's stage machine after the core, in order. */
  readonly stages: readonly string[];
  /** The default plan: how units map onto the core's beats. Pure over the work directory. */
  readonly plan: (workDir: string) => readonly PlanRow[];
  /** What `unit` needs beyond the core (and the core's own per-unit gates). Pure over the work directory. */
  readonly preconditions: (workDir: string, unit: number) => UnitPreconditions;
  /** The writer's pack for `unit`. Pure over the vault and work directory. */
  readonly pack: (vaultRoot: string, workDir: string, unit: number, options: UnitPackOptions) => UnitPackOutcome;
  readonly rituals: OutputRituals;
  readonly publish: OutputPublish;
  /** The output's state over an already-read core, for `status` and `resume`. Pure over the work directory. */
  readonly report: (workDir: string, core: CoreState) => OutputReport;
  /** A unit's file name inside `artifactDir`, from its number and its beat's title. */
  readonly unitFileName: (unit: number, title: string) => string;
  /** The unit a repo- or work-relative path names, or undefined for a file that is not one of this type's units. */
  readonly unitOfPath: (path: string) => number | undefined;
  /** The base branch a drafted unit is committed on. */
  readonly branch: (unit: number) => string;
  /** The unit a draft branch of this type drafts, or undefined for any other branch. */
  readonly unitOfBranch: (branch: string) => number | undefined;
  /**
   * For a type with dependencies beyond pablo itself (the radio output's
   * casting side, provisioned lazily): makes the type runnable, or says by
   * name what is missing (AGT-1690). Called only when a run names the type
   * (`pablo story --output radio`), never by a run that does not, so a
   * written-only run never loads what it does not use. Absent: the type
   * needs nothing beyond pablo.
   */
  readonly ensure?: () => EnsureOutcome | Promise<EnsureOutcome>;
}
