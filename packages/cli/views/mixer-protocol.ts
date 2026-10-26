/**
 * The wire contract of the mixer (AGT-1766, `pm project show pablo-mixer`, "The mixer view"): what
 * `src/mixer-host.ts` answers and what the mixer view may ask for. Types and a few constants, no IO, so the
 * view (browser bundle) and the host (node) share one definition.
 *
 * The view never reads a file. It calls `loadMix`, `peaks`, `clipAudio`, `saveMix` and `renderMix` (AGT-2152: the
 * Render button), plus the markers' mutations and the punch list's (AGT-2155: `listFlags`, `flag`, `unflag`,
 * `retake`, `lineTakes`, `chooseTake`) and the cue regeneration's (AGT-2156: `cueOptions`, `regenerateCue`).
 */

/** The punch list's mutations (AGT-2155): open flags, flag/unflag a line, re-take it, compare its takes and choose one. */
export const PUNCH_MUTATIONS = ["listFlags", "flag", "unflag", "retake", "lineTakes", "chooseTake"] as const;

/** The mutation names the host registers (and ui-leaf declares); anything else is a 404 from ui-leaf. */
export const MUTATIONS = ["loadMix", "peaks", "clipAudio", "saveMix", "renderMix", "listNotes", "saveNote", "deleteNote", "exportNotes", "notesToFlags", "cueOptions", "regenerateCue", ...PUNCH_MUTATIONS] as const;

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

/** One thing `mix.rebase` could not carry over mechanically (AGT-2153): the mixer lists it; the author's next save resolves it. */
export interface RebaseReviewItem {
  /** The clip concerned, or null for a track's automation point. */
  readonly clip: string | null;
  /** The field in the human document it came from (`tracks.sfx.lanes.main.clips[0].anchor`). */
  readonly field: string;
  readonly problem: string;
  /** The clip or point as it was in the human document; a set-aside clip lives on only here. */
  readonly was: MixClip | MixPoint | null;
}

/** On a human document `pablo mix` rebased onto a new manifest after `fix`: where it came from and what needs a look. */
export interface MixRebase {
  readonly from: number;
  readonly manifest_from: number;
  readonly retaken: readonly number[];
  readonly review: readonly RebaseReviewItem[];
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
  readonly rebase?: MixRebase;
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
  /** The newest manifest version; above `manifest.version` the mix is behind a `fix` (the next `pablo mix` rebases a human mix onto it). */
  readonly latestManifest: number;
  readonly layout: readonly TrackLayout[];
  /** The newest episode audio on disk: its manifest version and the mix version it was rendered from (null: none). */
  readonly rendered: RenderedFrom;
}

/** Which mix version the newest episode audio was rendered from (AGT-2152); `mix` is null with no audio, or audio older than mix documents. */
export interface RenderedFrom {
  readonly manifest: number | null;
  readonly mix: number | null;
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

/** The answer to `renderMix({episode, base})` (AGT-2152): `pablo mix` ran on mix version `base`. */
export interface RenderedMixPayload {
  readonly episode: number;
  /** The mix version rendered (the `base` asked for). */
  readonly mixVersion: number;
  /** The manifest version that now holds the audio. */
  readonly manifestVersion: number;
  /** The episode file written. */
  readonly audio: string | null;
  readonly duration: number;
  readonly rendered: RenderedFrom;
  readonly message: string;
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

// ---------------------------------------------------------------------------
// Regenerate a cue (AGT-2156, D-19)
// ---------------------------------------------------------------------------

/** One asset a cue clip could play: a recording from the sound library, or the generator's. */
export interface CueOption {
  /** The sound-library id, or null for the generator's asset. */
  readonly id: string | null;
  readonly label: string;
  readonly generated: boolean;
  readonly score: number | null;
  readonly words: readonly string[];
  readonly key: string;
  /** True when the asset is already in the cue library (picking it makes nothing). */
  readonly made: boolean;
  /** True when the clip already plays it. */
  readonly current: boolean;
}

/** The answer to `cueOptions({episode, clip, describe?})`. */
export interface CueOptionsPayload {
  readonly episode: number;
  readonly version: number;
  readonly clip: string;
  readonly kind: "SFX" | "BED" | "MUSIC";
  readonly desc: string;
  readonly key: string;
  readonly options: readonly CueOption[];
}

/**
 * The answer to `regenerateCue({episode, base, clip, describe?, sound?, generated?})`: the next mix version, whose clip
 * differs from `base`'s only in its source (and an `in`/`out` pulled back to fit a shorter asset).
 */
export interface RegeneratedCuePayload {
  readonly episode: number;
  readonly version: number;
  readonly parent: number;
  readonly by: "human";
  readonly clip: string;
  readonly desc: string;
  readonly key: string;
  readonly made: boolean;
  readonly trimmed: boolean;
  readonly summary: MixDiff;
  readonly document: MixDocument;
  readonly versions: readonly MixVersionInfo[];
  readonly message: string;
}

// ---------------------------------------------------------------------------
// The punch list (AGT-2155): flags in `pablo review`'s format, re-take, compare and choose takes
// ---------------------------------------------------------------------------

/** An open flag exactly as the review player lists it (`flags.json`, human and auto). */
export type PunchFlag = import("./review-protocol").ReviewFlag;

/** The answer to `listFlags({episode})`, `flag({episode, line, reason?, time?})` and `unflag({episode, line?, id?})`. */
export interface FlagsPayload {
  readonly episode: number;
  readonly flags: readonly PunchFlag[];
}

/** One take a line has had (`pablo takes line`), oldest first. */
export interface LineTake {
  /** The take key (64 hex): play it with `clipAudio({source: {kind: "take", key, stretch}})`. */
  readonly key: string;
  /** The manifest versions that used it. */
  readonly versions: readonly number[];
  readonly status: string | null;
  readonly attempt: number | null;
  readonly seconds: number | null;
  readonly stretch: number | null;
  readonly gates: Readonly<Record<string, number | boolean | null>>;
  readonly failing: readonly string[];
  /** The flag reasons the `fix` that made it applied; empty for the performance's own take. */
  readonly reasons: readonly string[];
  readonly temperature: number | null;
  /** It was put back on the line by `takes choose` (in a version after the one that made it). */
  readonly chosen: boolean;
  /** False once `takes gc` archived it: it can no longer be played or chosen. */
  readonly stored: boolean;
  readonly created: string | null;
  /** The newest manifest version uses it. */
  readonly current: boolean;
}

/** The answer to `lineTakes({episode, line})`: every take the line has had. */
export interface LineTakesPayload {
  readonly episode: number;
  readonly line: number;
  readonly speaker: string;
  readonly text: string;
  /** The newest manifest version. */
  readonly version: number;
  readonly current: string;
  readonly takes: readonly LineTake[];
}

/** The answer to `retake({episode, line, reason?})`: `pablo fix --line` ran (the reason, when given, flagged the line first). */
export interface RetakePayload {
  readonly episode: number;
  readonly line: number;
  /** The manifest version written. */
  readonly version: number;
  readonly fromVersion: number;
  readonly changedLines: readonly number[];
  /** Remixed (a mixer-saved mix rebased onto the new take); false when the remix failed after the version was written. */
  readonly mixed: boolean;
  readonly message: string;
  readonly flags: readonly PunchFlag[];
  readonly takes: LineTakesPayload;
}

/** The answer to `chooseTake({episode, line, take})`: `pablo takes choose` put that take back and remixed. */
export interface ChosenTakePayload {
  readonly episode: number;
  readonly line: number;
  readonly take: string;
  readonly version: number;
  readonly mixed: boolean;
  readonly message: string;
  readonly takes: LineTakesPayload;
}
