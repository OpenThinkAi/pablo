/**
 * The shape of one output type (AGT-1668, pm project `pablo-story-core`,
 * "The output layer"): everything a verb needs to know about how a work's
 * story core is told in one form. `OUTPUTS` (`./registry.ts`) holds one
 * `OutputDefinition` per type; `write`, `check`, `publish`, `merge`,
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
import type { TrackId } from "../tracks/registry";

/** One unit as `status` and `resume` report it: a beat row, a unit file, or both. */
export interface OutputUnit {
  readonly unit: number;
  readonly title?: string;
  readonly storyDate?: string;
  /** The unit file's frontmatter `status` (`"unknown"` when it has none), or `"beat"` when only the beat exists. */
  readonly status: string;
  /** The unit file, work-relative, when it is drafted. */
  readonly file?: string;
  /**
   * For an output that is performed after it is written (the radio output,
   * AGT-1686): `none`, `performed vK` or `mixed vK`. Absent for written-only types.
   */
  readonly render?: string;
  /** Open flags on the unit's render (the radio output's `flags.json`). Absent for written-only types. */
  readonly openFlags?: number;
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
  /** For the global voices directory the layered voice reads (`$XDG_CONFIG_HOME`); defaults to `process.env`. */
  readonly env?: Record<string, string | undefined> | undefined;
  /** `write --voices narrator|characters` (AGT-2137): who reads a derived output's unit. Only a type with `derive` reads it. */
  readonly voices?: string | undefined;
}

/** `derive()`'s answer (AGT-2137): the unit's text, made from another output's unit with no model, or a refusal. */
export type DeriveOutcome =
  | {
      readonly ok: true;
      /** The unit's body, as `write` stores it (no frontmatter). */
      readonly text: string;
      /** The unit file it was made from, work-relative. */
      readonly source: string;
    }
  | { readonly ok: false; readonly code: 2; readonly message: string };

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
      /** For a target that writes a directory (the radio bundle): the files written, relative to `where`. */
      readonly files?: readonly string[];
      /** What the target left out and why (an episode with no mixed audio yet). */
      readonly notes?: readonly string[];
    }
  | { readonly ok: false; readonly code: 2; readonly message: string; readonly tried: readonly string[] };

export interface OutputPublish {
  /** Every `--target` the type names, built or not. */
  readonly targets: readonly string[];
  /** Publishes the work's units to `target`; an unknown or unbuilt target is a refusal. */
  readonly run: (workDir: string, slug: string, title: string, target: string | undefined) => PublishOutcome;
}

/**
 * `status --for "<type> N"` for a type whose units go through stages after
 * they are written (the radio output, AGT-1686): the next stage's
 * `{ready, missing}` plus whatever the type reports about the unit.
 */
export interface UnitStatusReport {
  readonly ready: boolean;
  readonly missing: readonly string[];
  /** Fields the type adds to the body (stage, stages, render, open flags, the casting side). */
  readonly detail?: Readonly<Record<string, unknown>>;
  /** Extra prose lines for the CLI, after the ready line and the missing items. */
  readonly lines?: readonly string[];
}

/** `ensure()`'s answer (AGT-1690): the type can run on this machine, or what it is missing. */
export type EnsureOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly missing?: readonly string[] };

/**
 * For an output whose units are sections of one file (the essay, AGT-2134): how `write` puts a unit into the file
 * and tells whether it is already there. `unitFileName` names the file for every unit.
 */
export interface SharedUnitFile {
  /** Whether `content` (the file's text) already has text for `unit`. Pure over the work directory. */
  readonly has: (workDir: string, content: string, unit: number) => boolean;
  /**
   * `content` (undefined: no file yet) with `unit` set to `body` (replacing its text, or inserted in its place), and
   * `frontmatter` (the write's provenance block) replacing the file's. Pure over the work directory.
   */
  readonly put: (workDir: string, content: string | undefined, unit: number, body: string, frontmatter: string) => string;
}

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
  /** The tracks this output may be added to (AGT-2105, D-7); `pablo output add` refuses a work on any other. At least one. */
  readonly tracks: readonly TrackId[];
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
  /**
   * How `write` stores a unit's text: `sentences` (the default: one sentence
   * per line, AGT-1531) or `lines` (as the writer laid it out, line for line:
   * a radio script, where a line is a speaker, a cue or the `CAST:` line and
   * joining or splitting them would change the script) or `screenplay`
   * (Fountain, AGT-2132: stored line for line like `lines`, blank lines
   * between elements included; readers lay it out as Fountain, never as
   * sentences).
   */
  readonly manuscript?: "sentences" | "lines" | "screenplay";
  /**
   * `status --for "<type> N"` for a type whose units have stages after the
   * write (the radio output): where the unit stands. Absent: the unit's
   * `preconditions` are its status. Pure over the work directory.
   */
  readonly unitStatus?: (workDir: string, unit: number) => UnitStatusReport;
  /**
   * For an output derived from another output's units (`narrated`,
   * AGT-2137): makes unit N's text from the source with no model, so its
   * words are the source's. `write` stores this instead of a model's
   * answer, and `output add` takes `--from <output>` for such a type.
   * Absent: units are drafted by the writer from the pack. Pure over the
   * work directory.
   */
  readonly derive?: (workDir: string, unit: number, options: Pick<UnitPackOptions, "voices">) => DeriveOutcome;
  /**
   * What the plan's rows map onto, for `plan.md`'s header and the guide (the essay: the outline's sections). Absent:
   * the core beats.
   */
  readonly planNote?: string;
  /** Units that are sections of one shared file (the essay, AGT-2134). Absent: one file per unit. */
  readonly shared?: SharedUnitFile;
  /**
   * Unit N's prose as a listener hears it, when a unit's file holds more than that unit or carries what is not
   * read aloud (the essay: its section, citations removed, AGT-2134). The narrated output reads a source unit
   * through it. Absent: the unit's file, frontmatter stripped. Pure over the work directory.
   */
  readonly unitText?: (workDir: string, unit: number) => string | undefined;
  /**
   * The output's own files `output add` writes beside `plan.md` and `RULES.md`, before the plan is read (the essay
   * on a fiction track, AGT-2135: its thesis and outline), or a refusal naming what is missing (the thesis). Each
   * file is written only when the work does not have it. Absent: none. Pure over the work directory.
   */
  readonly scaffold?: (workDir: string, options: ScaffoldOptions) => ScaffoldOutcome;
}

/** What `output add` passes an output's `scaffold`. */
export interface ScaffoldOptions {
  /** `output add essay --thesis "<text>"` (AGT-2135). */
  readonly thesis?: string | undefined;
}

/** An output's scaffold files (work-relative path and text), or a refusal with what is missing. */
export type ScaffoldOutcome =
  | { readonly ok: true; readonly files: readonly { readonly rel: string; readonly content: string }[] }
  | {
      readonly ok: false;
      readonly message: string;
      readonly missing: readonly string[];
      /** The one value the author can supply to get past the refusal (`--thesis`), so a front end can ask for it. */
      readonly ask?: "thesis";
    };
