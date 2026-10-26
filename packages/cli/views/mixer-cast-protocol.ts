/**
 * The Cast panel's wire contract (AGT-2157, pm project `pablo-platform`, D-19): what `src/mixer-cast-host.ts`
 * answers and the panel (`views/mixer-cast.tsx`) may ask for. Types and the mutation names only, no IO, so the view
 * and the host share one definition. The host runs the casting verbs' own functions (`voices`, `describe_voice`,
 * `audition`, `cast`, `bind`, and `fix` to re-perform a rebound role's lines); the two reads no verb gives (the
 * episode's roles with their bindings, and a library voice read on one line) are `python -m pablo_casting castpanel`.
 */

export const CAST_MUTATIONS = [
  "castRoles",
  "listVoices",
  "previewVoice",
  "describeVoice",
  "auditionVoices",
  "candidateAudio",
  "castCandidate",
  "bindVoice",
  "reperformRole",
] as const;

export type CastMutation = (typeof CAST_MUTATIONS)[number];

export interface CastLine {
  /** The spoken line's index, as `perform` and the manifest number it. */
  readonly i: number;
  readonly text: string;
}

/** A role's binding in `cast.json`; `state` says whether the pinned card still hashes to the pin. */
export interface RoleVoice {
  readonly slug: string;
  readonly cardHash: string;
  readonly by: string | null;
  readonly at: string | null;
  readonly state: "ok" | "changed" | "missing" | "unknown";
}

export interface CastRole {
  readonly role: string;
  readonly gender: string | null;
  /** The `CAST:` line's description, when the script gives one. */
  readonly description: string | null;
  readonly voice: RoleVoice | null;
  readonly lines: readonly CastLine[];
  /** Lines of the newest performance made in another voice than the one bound now: what a re-perform redoes. */
  readonly stale: readonly number[];
}

/** The answer to `castRoles({episode})`. */
export interface CastRolesPayload {
  readonly episode: number;
  /** Whether the episode has a manifest (has been performed). */
  readonly performed: boolean;
  readonly roles: readonly CastRole[];
}

/** One `pablo voices list` row. */
export interface LibraryVoice {
  readonly slug: string;
  /** False for a voice with auditions and no card yet. */
  readonly cast: boolean;
  readonly hash?: string;
  readonly description?: string | null;
  readonly traits?: Readonly<Record<string, unknown>>;
  readonly retired?: boolean;
  readonly auditions: number;
}

/** The answer to `listVoices()`. */
export interface VoicesPayload {
  readonly voices: readonly LibraryVoice[];
}

/** The answer to `previewVoice({episode, line, voice})`: the line read in that voice, as a base64 16-bit WAV. */
export interface PreviewPayload {
  readonly episode: number;
  readonly line: number;
  readonly role: string;
  readonly text: string;
  readonly voice: string;
  readonly mime: "audio/wav";
  readonly b64: string;
  readonly seconds: number;
}

/** The answer to `describeVoice({describe, gender?, role?})`: `pablo describe_voice`'s body. */
export interface DescribePayload {
  readonly traits: Readonly<Record<string, unknown>>;
  readonly freeText: readonly string[];
  readonly instruct: string;
}

export interface AuditionCandidate {
  readonly candidate: number;
  readonly seconds: number;
  readonly referenceOk: boolean;
  readonly nearDuplicates: readonly number[];
  readonly utmos: number | null;
}

/** The answer to `auditionVoices({role, describe, slug?, n?, designer?})`: `pablo audition`'s candidates. */
export interface AuditionPayload {
  readonly role: string;
  readonly slug: string;
  readonly candidates: readonly AuditionCandidate[];
  readonly message: string;
}

/** The answer to `candidateAudio({slug, candidate})`: one candidate of the panel's last audition of that slug. */
export interface CandidateAudioPayload {
  readonly slug: string;
  readonly candidate: number;
  readonly mime: "audio/wav";
  readonly b64: string;
}

/** The answer to `castCandidate({role, slug, candidate, recast?})`: the card `pablo cast` froze. */
export interface CastCandidatePayload {
  readonly slug: string;
  readonly hash: string;
  readonly message: string;
}

/** The answer to `bindVoice({episode, role, voice})`: `pablo bind`'s body, and the lines a re-perform would redo. */
export interface BindPayload {
  readonly role: string;
  readonly slug: string;
  readonly cardHash: string;
  /** The voice the role was bound to before, if any. */
  readonly replaced: string | null;
  /** The episode's lines of this role performed in another voice: the offer to re-perform them (empty: nothing to offer). */
  readonly reperform: readonly number[];
  readonly roles: CastRolesPayload;
}

/** The answer to `reperformRole({episode, role})`: the role's stale lines flagged and `pablo fix` run on them. */
export interface ReperformPayload {
  readonly episode: number;
  readonly role: string;
  readonly lines: readonly number[];
  /** The manifest version `fix` wrote. */
  readonly version: number | null;
  readonly message: string;
}
