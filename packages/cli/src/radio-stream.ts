/**
 * The listening directory (AGT-1697, pm project `pablo-casting`, "On demand: speed and the progressive
 * render"): where a radio work's episodes are published as they finish, and where a streamed episode's
 * segments land before its last line is performed. `<work>/.pablo/out/stream/`, machine state beside the
 * other publish targets' `.pablo/out/` (gitignored, never committed):
 *
 *     index.json                  the published chapters (this file writes it)
 *     epNN/manifest.json          the published version's manifest (this file)
 *     epNN/epNN.m4a               the published version's audio (this file)
 *     epNN/stream.json            a streamed performance's live index (`pablo perform --stream`,
 *     epNN/playlist.m3u8            packages/casting/src/pablo_casting/stream.py, the only writer of these)
 *     epNN/segments/seg-NNNNN.wav
 *
 * `publishStream` is `pablo publish --output radio --target stream`: it copies each episode's newest mixed
 * version (manifest and audio, from `outputs/radio/casting/renders/epNN/`) into the directory and records
 * it, with the version's time to first audio, in `index.json`. `perform --stream` calls it the moment an
 * episode's file exists, so a listener's chapter list fills in while later episodes still render. Nothing
 * here writes under `outputs/`: a published chapter is a copy, and renders, takes and manifests are the
 * casting side's.
 *
 * `readLiveStream` and `readSegment` are what the review player (`review-host.ts`) reads of a stream.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Work-relative. */
export const STREAM_DIR = join(".pablo", "out", "stream");

const AUDIO_NAME = /^ep\d+\.v\d+\.([a-z0-9]+)$/;
const SEGMENT_FILE = /^segments\/seg-\d{5}\.wav$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const pad = (episode: number): string => String(episode).padStart(2, "0");

export function streamRoot(work: string): string {
  return join(work, STREAM_DIR);
}

export function streamEpisodeDir(work: string, episode: number): string {
  return join(streamRoot(work), `ep${pad(episode)}`);
}

function rendersDir(work: string): string {
  return join(work, "outputs", "radio", "casting", "renders");
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Writes through a temporary name in the same directory, so a reader never sees half a file. */
function writeAtomic(path: string, write: (tmp: string) => void): void {
  const tmp = `${path}.tmp-${process.pid}`;
  write(tmp);
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Rendered episodes (read-only)
// ---------------------------------------------------------------------------

export interface MixedVersion {
  readonly episode: number;
  readonly version: number;
  /** Absolute paths. */
  readonly manifest: string;
  readonly audio: string;
  readonly extension: string;
  readonly duration: number | null;
  readonly ttfa: Record<string, unknown> | null;
}

/** The episode numbers with a `renders/epNN/` directory, ascending. */
export function renderedEpisodes(work: string): number[] {
  try {
    return readdirSync(rendersDir(work))
      .map((name) => /^ep(\d+)$/.exec(name)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** Whether `episode` has been performed: any `renders/epNN/v<k>.json` (mixed or not). */
export function isPerformed(work: string, episode: number): boolean {
  try {
    return readdirSync(join(rendersDir(work), `ep${pad(episode)}`)).some((name) => /^v\d+\.json$/.test(name));
  } catch {
    return false;
  }
}

/** The newest version of `episode` whose audio is on disk, or undefined when none is mixed yet. */
export function newestMixed(work: string, episode: number): MixedVersion | undefined {
  const dir = join(rendersDir(work), `ep${pad(episode)}`);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const numbers = names
    .map((name) => /^v(\d+)\.json$/.exec(name)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => b - a);
  for (const version of numbers) {
    const manifest = join(dir, `v${version}.json`);
    const raw = readJson(manifest);
    if (!isRecord(raw) || typeof raw["audio"] !== "string") continue;
    const match = AUDIO_NAME.exec(raw["audio"]);
    if (match === null || !existsSync(join(dir, raw["audio"]))) continue;
    return {
      episode,
      version,
      manifest,
      audio: join(dir, raw["audio"]),
      extension: match[1] as string,
      duration: typeof raw["duration"] === "number" ? raw["duration"] : null,
      ttfa: isRecord(raw["ttfa"]) ? raw["ttfa"] : null,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// publish --target stream
// ---------------------------------------------------------------------------

export interface PublishedChapter {
  readonly episode: number;
  readonly version: number;
  /** Relative to the listening directory. */
  readonly audio: string;
  readonly manifest: string;
  readonly duration: number | null;
  readonly ttfa: Record<string, unknown> | null;
  readonly published: string;
}

export type PublishStreamOutcome =
  | {
      readonly ok: true;
      readonly code: 0;
      readonly target: "stream";
      /** The listening directory, absolute. */
      readonly where: string;
      /** Chapters copied by this call (a chapter whose published version is current is left alone). */
      readonly published: readonly PublishedChapter[];
      readonly unchanged: readonly number[];
      /** Every chapter the directory now holds. */
      readonly chapters: readonly PublishedChapter[];
    }
  | { readonly ok: false; readonly code: 2; readonly message: string; readonly tried: readonly string[] };

function readIndex(work: string): PublishedChapter[] {
  const raw = readJson(join(streamRoot(work), "index.json"));
  if (!isRecord(raw) || !Array.isArray(raw["chapters"])) return [];
  return raw["chapters"].filter(
    (c): c is PublishedChapter => isRecord(c) && typeof c["episode"] === "number" && typeof c["version"] === "number" && typeof c["audio"] === "string",
  );
}

/**
 * Publishes every mixed episode (or only `episode`) to the listening directory. Refuses (exit 2, nothing
 * written) when there is nothing mixed to publish.
 */
export function publishStream(work: string, options: { readonly episode?: number; readonly now?: () => Date } = {}): PublishStreamOutcome {
  const now = options.now ?? (() => new Date());
  const episodes = options.episode === undefined ? renderedEpisodes(work) : [options.episode];
  const mixed = episodes.map((e) => newestMixed(work, e)).filter((m): m is MixedVersion => m !== undefined);
  if (mixed.length === 0) {
    const what = options.episode === undefined ? "no radio episode has" : `episode ${options.episode} has no`;
    return {
      ok: false,
      code: 2,
      message: `pablo: publish --target stream: ${what} mixed audio yet (pablo perform --stream, or pablo perform then pablo mix); nothing was published`,
      tried: [rendersDir(work)],
    };
  }

  const root = streamRoot(work);
  mkdirSync(root, { recursive: true });
  const index = new Map(readIndex(work).map((c) => [c.episode, c]));
  const published: PublishedChapter[] = [];
  const unchanged: number[] = [];
  for (const m of mixed) {
    const dir = streamEpisodeDir(work, m.episode);
    const audioName = `ep${pad(m.episode)}.${m.extension}`;
    const current = index.get(m.episode);
    if (current !== undefined && current.version === m.version && existsSync(join(root, current.audio)) && existsSync(join(root, current.manifest))) {
      unchanged.push(m.episode);
      continue;
    }
    mkdirSync(dir, { recursive: true });
    // The audio first, then its manifest: a reader that finds the manifest finds the file it names.
    writeAtomic(join(dir, audioName), (tmp) => copyFileSync(m.audio, tmp));
    writeAtomic(join(dir, "manifest.json"), (tmp) => copyFileSync(m.manifest, tmp));
    const row: PublishedChapter = {
      episode: m.episode,
      version: m.version,
      audio: `ep${pad(m.episode)}/${audioName}`,
      manifest: `ep${pad(m.episode)}/manifest.json`,
      duration: m.duration,
      ttfa: m.ttfa,
      published: now().toISOString(),
    };
    index.set(m.episode, row);
    published.push(row);
  }
  const chapters = [...index.values()].sort((a, b) => a.episode - b.episode);
  if (published.length > 0) {
    writeAtomic(join(root, "index.json"), (tmp) => writeFileSync(tmp, `${JSON.stringify({ chapters, updated: now().toISOString() }, null, 2)}\n`, "utf8"));
  }
  return { ok: true, code: 0, target: "stream", where: root, published, unchanged, chapters };
}

// ---------------------------------------------------------------------------
// A streamed performance, as the review player reads it
// ---------------------------------------------------------------------------

export interface LiveSegment {
  readonly n: number;
  /** Relative to the episode's directory: `segments/seg-NNNNN.wav`. */
  readonly file: string;
  /** Seconds into the episode. */
  readonly start: number;
  readonly seconds: number;
}

export interface LiveLine {
  readonly i: number;
  readonly speaker: string;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly gates: Record<string, unknown>;
  readonly failing: readonly string[];
}

export interface LiveStream {
  readonly episode: number;
  readonly state: "streaming" | "finished" | "mixed" | "failed";
  readonly playable: boolean;
  readonly seconds: number;
  readonly linesDone: number;
  readonly linesTotal: number;
  readonly segments: readonly LiveSegment[];
  readonly lines: readonly LiveLine[];
  readonly ttfa: Record<string, unknown> | null;
}

const STATES = new Set(["streaming", "finished", "mixed", "failed"]);
const num = (value: unknown, fallback = 0): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** `epNN/stream.json`, or undefined when the episode was never streamed (or the file is not one). Never throws. */
export function readLiveStream(work: string, episode: number): LiveStream | undefined {
  const raw = readJson(join(streamEpisodeDir(work, episode), "stream.json"));
  if (!isRecord(raw) || typeof raw["state"] !== "string" || !STATES.has(raw["state"])) return undefined;
  const segments = (Array.isArray(raw["segments"]) ? raw["segments"] : [])
    .filter(isRecord)
    .filter((s) => typeof s["file"] === "string" && SEGMENT_FILE.test(s["file"]))
    .map((s) => ({ n: num(s["n"]), file: s["file"] as string, start: num(s["start"]), seconds: num(s["seconds"]) }));
  const lines = (Array.isArray(raw["lines"]) ? raw["lines"] : []).filter(isRecord).map((l) => ({
    i: num(l["i"]),
    speaker: typeof l["speaker"] === "string" ? l["speaker"] : "",
    text: typeof l["text"] === "string" ? l["text"] : "",
    start: num(l["start"]),
    end: num(l["end"]),
    gates: isRecord(l["gates"]) ? l["gates"] : {},
    failing: Array.isArray(l["failing"]) ? l["failing"].filter((g): g is string => typeof g === "string") : [],
  }));
  return {
    episode,
    state: raw["state"] as LiveStream["state"],
    playable: raw["playable"] === true,
    seconds: num(raw["seconds"]),
    linesDone: num(raw["lines_done"]),
    linesTotal: num(raw["lines_total"]),
    segments,
    lines,
    ttfa: isRecord(raw["ttfa"]) ? raw["ttfa"] : null,
  };
}

/** The episodes with a stream index in the listening directory, ascending. */
export function streamedEpisodes(work: string): number[] {
  try {
    return readdirSync(streamRoot(work))
      .map((name) => /^ep(\d+)$/.exec(name)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .filter((e) => existsSync(join(streamEpisodeDir(work, e), "stream.json")))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** One segment's bytes; `file` must be a name the stream index lists (never a path a caller made up). */
export function readSegment(work: string, episode: number, segment: LiveSegment): Buffer {
  if (!SEGMENT_FILE.test(segment.file)) throw new Error(`not a segment: ${segment.file}`);
  return readFileSync(join(streamEpisodeDir(work, episode), segment.file));
}
