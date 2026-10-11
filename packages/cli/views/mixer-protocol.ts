/**
 * The wire contract of the mixer (AGT-1766, `pm project show pablo-mixer`, "The mixer view"): what
 * `src/mixer-host.ts` answers and what the mixer view may ask for. Types and a few constants, no IO, so the
 * view (browser bundle) and the host (node) share one definition.
 *
 * The view never reads a file. It calls exactly four mutations: `loadMix`, `peaks`, `clipAudio` and `saveMix`
 * (the in-mixer pablo actions, `retake`, `regenerateCue` and `flag`, come with their own tickets).
 */

/** The mutation names the host registers (and ui-leaf declares); anything else is a 404 from ui-leaf. */
export const MUTATIONS = ["loadMix", "peaks", "clipAudio", "saveMix", "listNotes", "saveNote", "deleteNote", "exportNotes", "notesToFlags"] as const;

export type TrackName = "dialogue" | "sfx" | "beds" | "music";
export type FadeCurve = "linear" | "scurve" | "log" | "exp";

/** A clip's source: content-addressed, never copied. Only a take carries a `stretch` (its pace, applied before the timeline). */
export interface MixSource {
  readonly kind: "take" | "cue";
  /** The take key or cue key: 64 hex characters. */
  readonly key: string;
  readonly stretch?: number;
}

export type MixAnchor = { readonly line: number; readonly edge: "start" | "end"; readonly offset: number } | { readonly at: number };

export interface MixFade {
  readonly len: number;
  readonly curve?: FadeCurve;
}

export interface MixClip {
  readonly id: string;
  readonly source: MixSource;
  readonly lines?: readonly number[];
  readonly cue?: number;
  readonly in: number;
  readonly out: number;
  readonly anchor: MixAnchor;
  readonly gain?: number;
  readonly fade_in?: MixFade;
  readonly fade_out?: MixFade;
}

export interface MixPoint {
  readonly anchor: MixAnchor;
  readonly db: number;
  readonly curve?: FadeCurve;
}

export interface MixTrack {
  readonly lanes: Readonly<Record<string, { readonly clips: readonly MixClip[] }>>;
  readonly volume?: number;
  readonly mute?: boolean;
  readonly solo?: boolean;
  readonly automation?: readonly MixPoint[];
}

/** `renders/epNN/mix.v<m>.json` as `packages/casting/.../mixdoc.py` defines it. */
export interface MixDocument {
  readonly schema: number;
  readonly episode: number;
  readonly version: number;
  readonly manifest_version: number;
  readonly parent: number | null;
  readonly by: "auto" | "human";
  readonly created: string;
  readonly summary?: string;
  readonly tracks: Readonly<Record<TrackName, MixTrack>>;
  readonly master: { readonly gain: number; readonly peak_db: number | null; readonly target_lufs: null };
}

/** What a human edit proposes: `saveMix` sets schema, episode, version, parent, by and created itself. */
export interface MixProposal {
  readonly manifest_version: number;
  readonly tracks: Readonly<Record<TrackName, MixTrack>>;
  readonly master: MixDocument["master"];
}

/** One mix version in the history list. */
export interface MixVersionInfo {
  readonly version: number;
  readonly by: "auto" | "human";
  readonly created: string;
  readonly parent: number | null;
  readonly manifest_version: number;
  /** A human version's diff summary against its parent; absent on an auto version. */
  readonly summary?: string;
}

export interface ManifestLine {
  readonly i: number;
  readonly speaker: string;
  readonly text: string;
  readonly take: string;
  readonly stretch: number | null;
  /** Seconds into the mixed episode, null until the manifest is mixed. */
  readonly start: number | null;
  readonly end: number | null;
}

export interface ManifestCue {
  /** The cue's index in the manifest: a clip's `cue` field points at it. */
  readonly index: number;
  readonly kind: "SFX" | "BED" | "MUSIC";
  readonly desc: string;
  /** The cue-library key (what a cue clip's `source.key` is). */
  readonly key: string | null;
  readonly after: number | null;
  readonly line: number | null;
  readonly start: number | null;
  readonly end: number | null;
}

export interface TrackLayout {
  readonly track: TrackName;
  readonly lanes: readonly { readonly name: string; readonly clips: number }[];
  readonly volume: number;
  readonly mute: boolean;
  readonly solo: boolean;
  /** How many automation breakpoints the track has. */
  readonly automation: number;
}

/** The answer to `loadMix({episode, version?})`. */
export interface MixPayload {
  readonly episode: number;
  readonly title: string;
  /** The mix version shown (the newest unless one was asked for). */
  readonly version: number;
  readonly newest: number;
  readonly versions: readonly MixVersionInfo[];
  readonly document: MixDocument;
  /** The manifest the shown document was made against: its lines and cues. */
  readonly manifest: {
    readonly version: number;
    readonly duration: number | null;
    readonly lines: readonly ManifestLine[];
    readonly cues: readonly ManifestCue[];
  };
  /** The newest manifest version; above `manifest.version` the mix is behind a `fix` (rebasing is a later ticket). */
  readonly latestManifest: number;
  readonly layout: readonly TrackLayout[];
}

/** The answer to `peaks({source})`. */
export interface PeaksPayload {
  readonly source: MixSource;
  readonly seconds: number;
  /** Windows per second: `peaks[k]` is the largest absolute sample (0 to 1) in `[k / perSecond, (k + 1) / perSecond)`. */
  readonly perSecond: number;
  readonly peaks: readonly number[];
  /** True when the peaks were read from the cache (computed on an earlier ask), false when this ask computed them. */
  readonly cached: boolean;
}

/** The answer to `clipAudio({source})`: a take already paced by its stretch, or a cue, as a base64 16-bit WAV. */
export interface ClipAudioPayload {
  readonly source: MixSource;
  readonly mime: "audio/wav";
  readonly b64: string;
  readonly sampleRate: number;
  readonly seconds: number;
}

/** What a save changed from the base version. */
export interface MixDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly tracks: readonly TrackName[];
  readonly master: boolean;
  readonly text: string;
}

/** The answer to `saveMix({episode, base, document})`: the version it wrote. */
export interface SavedMixPayload {
  readonly episode: number;
  readonly version: number;
  readonly parent: number;
  readonly by: "human";
  readonly summary: MixDiff;
  readonly document: MixDocument;
  readonly versions: readonly MixVersionInfo[];
}

// ---------------------------------------------------------------------------
// Markers (AGT-1792): `renders/epNN/notes.json`, never inside the mix document
// ---------------------------------------------------------------------------

/** The answer to `listNotes`, `saveNote` and `deleteNote`: the episode's markers, in time order. */
export interface NotesPayload {
  readonly episode: number;
  readonly notes: readonly import("./mixer-notes").Marker[];
}

/** The answer to `exportNotes({episode})`: the punch list, also written next to `notes.json`. */
export interface ExportPayload {
  readonly episode: number;
  readonly count: number;
  readonly path: string;
  readonly markdown: string;
}

/** The answer to `notesToFlags({episode, ids?})`: dialogue markers written to `flags.json`; the rest skipped by id. */
export interface ToFlagsPayload {
  readonly episode: number;
  readonly written: readonly string[];
  readonly skipped: readonly string[];
  readonly path: string;
}
