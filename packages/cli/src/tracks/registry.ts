/**
 * `TRACKS` (AGT-2099, pm project `pablo-platform`, D-4..D-6): the kind of
 * work a project is, one row per track, the single source the way `OUTPUTS`
 * is for output types and `VERBS` is for verbs. A work has one track
 * (`pablo.json` `track`, read by `marker.ts`; a marker without one is
 * `fiction`) and any number of outputs.
 *
 * A track owns what the output layer does not:
 *
 * - `coreStages`: the core stage machine, in order (what has to exist before
 *   any output is written). Fiction's is today's `CORE_STAGE_IDS`.
 * - `policy`: the judgement policy's file name under `packages/cli/policies/`
 *   (`<policy>.md`). `loadPromptWork` loads it for the work's track
 *   (AGT-2102); an explicit `pablo.json` `policy` still overrides.
 * - `checks`: the checks run on every unit (AGT-2112..2115 add the new ones).
 * - `outputs`: the output types the track allows (D-7), each a row of
 *   `OUTPUTS` whose own `tracks` agree (AGT-2105; `essay` on every track,
 *   AGT-2134).
 *
 * Plain data, no imports from the output registry or the marker, so the
 * marker can validate against it without an initialisation cycle.
 */

import { CORE_STAGE_IDS, HISTORICAL_CORE_STAGE_IDS, NONFICTION_CORE_STAGE_IDS } from "../core/machine";

/** A track's id: a key of `TRACKS`. */
export type TrackId = "fiction" | "historical-fiction" | "nonfiction";

export interface TrackDefinition {
  readonly id: TrackId;
  /** The core stage machine's stage ids, in order. */
  readonly coreStages: readonly string[];
  /** The judgement policy's file name under `policies/`, without `.md`. */
  readonly policy: string;
  /** The checks run on every unit of the work. */
  readonly checks: readonly string[];
  /** The output types a work on this track may derive (D-7). */
  readonly outputs: readonly string[];
}

/** The checks every fiction track runs today (`critique.ts` continuity, `core-check.ts` story-time and unknown-name). */
const FICTION_CHECKS = ["continuity", "story-time", "unknown-name"] as const;

/** The outputs the fiction tracks allow (D-7). */
const FICTION_OUTPUTS = ["novel", "story", "screenplay", "radio", "narrated", "essay"] as const;

export const TRACKS = {
  fiction: {
    id: "fiction",
    coreStages: CORE_STAGE_IDS,
    policy: "fiction",
    checks: FICTION_CHECKS,
    outputs: FICTION_OUTPUTS,
  },
  "historical-fiction": {
    id: "historical-fiction",
    coreStages: HISTORICAL_CORE_STAGE_IDS,
    policy: "historical-fiction",
    checks: [...FICTION_CHECKS, "fact-accuracy", "anachronism"],
    outputs: FICTION_OUTPUTS,
  },
  nonfiction: {
    id: "nonfiction",
    coreStages: NONFICTION_CORE_STAGE_IDS,
    policy: "nonfiction",
    checks: ["claim-support", "citations"],
    outputs: ["narrated", "essay"],
  },
} as const satisfies Readonly<Record<TrackId, TrackDefinition>>;

/** The track a `pablo.json` without `track` reads as (D-6). */
export const DEFAULT_TRACK: TrackId = "fiction";

/** Every track's id, in `TRACKS` order. */
export function trackIds(): TrackId[] {
  return Object.keys(TRACKS) as TrackId[];
}

export function isTrackId(id: unknown): id is TrackId {
  return typeof id === "string" && Object.hasOwn(TRACKS, id);
}

/** The definition for `id`. */
export function trackDefinition(id: TrackId): TrackDefinition {
  return TRACKS[id];
}
