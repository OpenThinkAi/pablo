/**
 * The wire contract of the review player (AGT-1693, `pm project show pablo-casting`, "The review surface"):
 * what `src/review-host.ts` sends the view `views/review.tsx` and what the view may ask for. Types and a few
 * constants, no IO, so the view (browser bundle) and the host (node) share one definition.
 *
 * The view never reads a file. It calls exactly six mutations: `loadTrack`, `setVersion`, `flag`, `unflag`,
 * `listChapters` and (AGT-1697, a chapter still being performed) `loadSegments`.
 */

/** Why a listener flags a line, in the order the player shows them. `pablo fix` reads the reason. */
export const REASONS = ["clipped", "wrong voice", "flat", "rushed", "other"] as const;
export type Reason = (typeof REASONS)[number];

/** The mutation names the host registers (and ui-leaf declares); anything else is a 404 from ui-leaf. */
export const MUTATIONS = ["loadTrack", "setVersion", "flag", "unflag", "listChapters", "loadSegments"] as const;

/** One gate score on a line; non-numeric, non-boolean entries of a manifest's `gates` are dropped. */
export type GateValue = number | boolean;

export interface ReviewLine {
  readonly i: number;
  readonly speaker: string;
  readonly text: string;
  /** Seconds into this version's audio. */
  readonly start: number;
  readonly end: number;
  /** The line's scores as the performer recorded them (`sim_card`, `utmos`, `wer`, `wps`, ...). */
  readonly gates: Readonly<Record<string, GateValue>>;
  /** The gates the kept take failed (`pace`, `artefacts`, ...); empty for a take that passed. */
  readonly failing: readonly string[];
}

export interface ReviewFlag {
  readonly id: string;
  readonly episode: number;
  readonly line: number;
  /** A human flag's reason is one of `REASONS`; an auto flag's is the performer's sentence. */
  readonly reason: string;
  /** Seconds into the audio the listener flagged at (an auto flag: the line's start). */
  readonly time: number;
  readonly source: "human" | "auto";
  /** An auto flag's failing gates, named; empty for a human flag. */
  readonly failing: readonly string[];
}

export interface VersionInfo {
  readonly version: number;
  readonly duration: number | null;
  readonly created: string | null;
  /** How many lines this version re-recorded (`changed_lines`). */
  readonly changedLines: number;
}

/** A chapter still being performed, streamed in segments (AGT-1697, `pablo perform --stream`). */
export interface StreamInfo {
  readonly state: "streaming" | "finished";
  /** Seconds of the episode cut into segments so far. */
  readonly seconds: number;
  readonly segments: number;
  readonly linesDone: number;
  readonly linesTotal: number;
}

/**
 * One row of the chapter list: an episode with at least one mixed version, or (with `stream`, no versions
 * and `latest` null) one whose streamed performance is playable before its last line has been performed.
 */
export interface ChapterRow {
  readonly episode: number;
  readonly title: string;
  /** Mixed versions only, ascending. */
  readonly versions: readonly VersionInfo[];
  readonly latest: number | null;
  readonly flags: { readonly human: number; readonly auto: number };
  readonly stream?: StreamInfo;
}

/** One cut segment of a streamed chapter: 16-bit WAV, `start` seconds into the episode. */
export interface SegmentPayload {
  readonly n: number;
  readonly start: number;
  readonly seconds: number;
  readonly mime: string;
  readonly b64: string;
}

/** The answer to `loadSegments({episode, from})`: segments `from` on (a few at a time), and the lines timed so far. */
export interface SegmentsPayload {
  readonly episode: number;
  readonly title: string;
  readonly from: number;
  readonly segments: readonly SegmentPayload[];
  /** How many segments exist now; more than `from + segments.length` means ask again at once. */
  readonly available: number;
  /** Every segment is cut: the chapter ends at `seconds`. */
  readonly complete: boolean;
  readonly seconds: number;
  readonly lines: readonly ReviewLine[];
}

/** How many segments one `loadSegments` answer carries at most. */
export const SEGMENTS_PER_CALL = 4;

/** How often the view asks for new segments while it plays a streaming chapter. */
export const STREAM_POLL_MS = 1500;

/** The answer to `loadTrack` and `setVersion`: the audio, its own timings, and the episode's open flags. */
export interface TrackPayload {
  readonly episode: number;
  readonly version: number;
  readonly versions: readonly VersionInfo[];
  readonly title: string;
  readonly mime: string;
  readonly b64: string;
  readonly duration: number;
  readonly lines: readonly ReviewLine[];
  readonly flags: readonly ReviewFlag[];
}

/** What the view is mounted with. */
export interface ReviewData {
  readonly title: string;
  readonly chapters: readonly ChapterRow[];
  /** The episode to open on (`--episode N`), else the first in the list; null while the list is empty. */
  readonly start: number | null;
}

/** How often the view asks `listChapters` while it is open. */
export const CHAPTER_POLL_MS = 4000;
