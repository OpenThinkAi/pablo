/**
 * The review player's host (AGT-1693, pm project `pablo-casting`, "The review surface"): `pablo review
 * [--episode N]` mounts the ui-leaf view `views/review.tsx` on a radio work's rendered episodes and answers
 * its six mutations. This file is the only thing that touches the casting directory; the view is dumb.
 *
 * What it reads, all under `<work>/outputs/radio/casting/` (written by `pablo perform`, `pablo mix`, `pablo
 * fix`, none of which this file changes):
 *  - `renders/epNN/v<k>.json` — one manifest per version (per-line `start`/`end`, `gates`, `failing`, `audio`);
 *  - `renders/epNN/epNN.v<k>.m4a` — that version's audio (a version without audio is not yet mixed: not listed);
 *  - `flags.json` — `{"flags": [...]}`, the open flags. The performer appends `by: "auto"` entries for
 *    `best_of_failed` takes; this file appends and removes the listener's.
 *
 * Mutations (names in `views/review-protocol.ts`), each reading the disk afresh so a version or chapter
 * written while the window is open shows up on the next call:
 *  - `listChapters()` — the chapter list; the view polls it, so a chapter published while open appears;
 *  - `loadTrack({episode, version?})` — the audio (base64: ui-leaf serves no files), its own timings and the
 *    episode's flags; the newest mixed version when `version` is omitted;
 *  - `setVersion({episode, version})` — `loadTrack` for a chosen version, refused when it is not mixed;
 *  - `flag({episode, line, reason?, time?, version?})` — writes the flag to `flags.json`;
 *  - `unflag({episode, line, id?})` — removes one flag by id, else every open flag on that line;
 *  - `loadSegments({episode, from?})` (AGT-1697) — a chapter still being performed (`pablo perform --stream`):
 *    its cut segments from `from` on, a few at a time, as base64 WAV, and its lines timed so far. Such a
 *    chapter is in `listChapters` (with `stream`, no versions) once its stream is playable, read from the
 *    listening directory `<work>/.pablo/out/stream/epNN/stream.json` (`radio-stream.ts`), until it is mixed.
 *
 * A failure is a thrown plain-words `Error`; ui-leaf hands it to the view, which toasts it. The window itself
 * is `deps.mount` (ui-leaf's `mount`), so tests drive the host against a temp work and a fake mount.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mount } from "@openthink/ui-leaf";
import type { MountOptions, MutationHandler, View } from "@openthink/ui-leaf";
import { MUTATIONS, REASONS, SEGMENTS_PER_CALL } from "../views/review-protocol";
import type { ChapterRow, GateValue, ReviewData, ReviewFlag, ReviewLine, SegmentsPayload, TrackPayload, VersionInfo } from "../views/review-protocol";
import { radioScriptDir } from "./radio";
import { readLiveStream, readSegment, renderedEpisodes, streamedEpisodes } from "./radio-stream";
import type { LiveStream } from "./radio-stream";
import { VIEWS_ROOT, findChrome, resolveUiLeafBinary } from "./reader-host";

type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// Reading the casting directory
// ---------------------------------------------------------------------------

const MIME: Readonly<Record<string, string>> = { ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".ogg": "audio/ogg" };
/** A manifest's `audio` is a bare `epNN.v<k>.<ext>` beside it; anything else is never opened. */
const AUDIO_NAME = /^ep\d+\.v\d+\.[a-z0-9]+$/;

export function castingDir(work: string): string {
  return join(work, "outputs", "radio", "casting");
}

function episodeDir(work: string, episode: number): string {
  return join(castingDir(work), "renders", `ep${String(episode).padStart(2, "0")}`);
}

export function flagsFile(work: string): string {
  return join(castingDir(work), "flags.json");
}

interface Manifest {
  readonly version: number;
  readonly audio: string | null;
  readonly duration: number | null;
  readonly created: string | null;
  readonly changed: number;
  readonly lines: readonly ReviewLine[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

function reviewLine(raw: unknown): ReviewLine | undefined {
  if (!isRecord(raw) || typeof raw["i"] !== "number") return undefined;
  const gates: Record<string, GateValue> = {};
  if (isRecord(raw["gates"])) for (const [name, value] of Object.entries(raw["gates"])) if (typeof value === "number" || typeof value === "boolean") gates[name] = value;
  return {
    i: raw["i"],
    speaker: typeof raw["speaker"] === "string" ? raw["speaker"] : "",
    text: typeof raw["text"] === "string" ? raw["text"] : "",
    start: num(raw["start"], 0),
    end: num(raw["end"], 0),
    gates,
    failing: Array.isArray(raw["failing"]) ? raw["failing"].filter((g): g is string => typeof g === "string") : [],
  };
}

/** `renders/epNN/v<k>.json`, or undefined when it is missing or not a manifest (never trusted, never thrown). */
function readManifest(work: string, episode: number, version: number): Manifest | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(episodeDir(work, episode), `v${version}.json`), "utf8"));
    if (!isRecord(raw) || !Array.isArray(raw["lines"])) return undefined;
    return {
      version,
      audio: typeof raw["audio"] === "string" ? raw["audio"] : null,
      duration: typeof raw["duration"] === "number" ? raw["duration"] : null,
      created: typeof raw["created"] === "string" ? raw["created"] : null,
      changed: Array.isArray(raw["changed_lines"]) ? raw["changed_lines"].length : 0,
      lines: raw["lines"].map(reviewLine).filter((l): l is ReviewLine => l !== undefined),
    };
  } catch {
    return undefined;
  }
}

function versionNumbers(work: string, episode: number): number[] {
  try {
    return readdirSync(episodeDir(work, episode))
      .map((name) => /^v(\d+)\.json$/.exec(name)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** The versions of an episode that have mixed audio on disk, ascending, with their manifests. */
function mixedVersions(work: string, episode: number): Manifest[] {
  const dir = episodeDir(work, episode);
  const out: Manifest[] = [];
  for (const version of versionNumbers(work, episode)) {
    const manifest = readManifest(work, episode, version);
    if (manifest?.audio != null && AUDIO_NAME.test(manifest.audio) && existsSync(join(dir, manifest.audio))) out.push(manifest);
  }
  return out;
}

/**
 * The episode's streamed performance (`pablo perform --stream`) once a listener can start it: playable, with
 * segments, still streaming or finished (and, for `loadSegments` only, already mixed). A failed stream is never one.
 */
function playableStream(work: string, episode: number, mixedToo = false): LiveStream | undefined {
  const live = readLiveStream(work, episode);
  if (live === undefined || !live.playable || live.segments.length === 0) return undefined;
  if (live.state === "streaming" || live.state === "finished" || (mixedToo && live.state === "mixed")) return live;
  return undefined;
}

function liveLines(live: LiveStream): ReviewLine[] {
  return live.lines.map(reviewLine).filter((l): l is ReviewLine => l !== undefined);
}

const versionInfo = (m: Manifest): VersionInfo => ({ version: m.version, duration: m.duration, created: m.created, changedLines: m.changed });

/** The episode's title from its script (`title:` in the frontmatter, else the first `# ` heading), else "Episode N". */
export function episodeTitle(work: string, episode: number): string {
  const fallback = `Episode ${episode}`;
  try {
    const dir = radioScriptDir(work);
    const name = readdirSync(dir)
      .sort()
      .find((file) => /^\d+-.*\.md$/.test(file) && Number(/^(\d+)-/.exec(file)?.[1]) === episode);
    if (name === undefined) return fallback;
    const lines = readFileSync(join(dir, name), "utf8").replace(/^﻿/, "").split(/\r?\n/);
    if (lines[0]?.trim() === "---") {
      for (let i = 1; i < lines.length && lines[i]?.trim() !== "---"; i++) {
        const match = /^title:\s*(.*?)\s*$/.exec(lines[i] as string);
        if (match?.[1]) return match[1].replace(/^(["'])(.*)\1$/, "$2");
      }
    }
    const heading = lines.find((l) => /^#\s+\S/.test(l));
    return heading === undefined ? fallback : heading.replace(/^#\s+/, "").trim() || fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// flags.json
// ---------------------------------------------------------------------------

interface FlagsFile {
  readonly raw: Record<string, unknown>;
  readonly flags: Record<string, unknown>[];
}

/** `flags.json` as written, or an empty file when it does not exist. A file that is not JSON is never touched. */
function readFlagsFile(work: string): FlagsFile {
  const path = flagsFile(work);
  if (!existsSync(path)) return { raw: {}, flags: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`flags.json is not valid JSON (${path}); nothing was changed. Fix or move it, then try again.`);
  }
  if (!isRecord(parsed) || (parsed["flags"] !== undefined && !Array.isArray(parsed["flags"]))) {
    throw new Error(`flags.json must hold {"flags": [...]} (${path}); nothing was changed.`);
  }
  return { raw: parsed, flags: ((parsed["flags"] as unknown[] | undefined) ?? []).filter(isRecord) };
}

function writeFlagsFile(work: string, file: FlagsFile, flags: Record<string, unknown>[]): void {
  const path = flagsFile(work);
  mkdirSync(castingDir(work), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ ...file.raw, flags }, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/** Failing gate names out of the performer's sentence: `best of 4 failed: artefacts, pace; needed stretch ...`. */
export function failingFromReason(reason: string): string[] {
  const match = /failed:\s*([^;]*)/.exec(reason);
  return match?.[1] === undefined ? [] : match[1].split(",").map((g) => g.trim()).filter((g) => g !== "");
}

/**
 * The open flags of an episode as the view draws them. An auto flag (`by: "auto"`, written by `pablo perform`)
 * names its failing gates, from the shown version's line when that line is the flagged take, else from the
 * performer's sentence; its time is that line's start.
 */
function flagRows(file: FlagsFile, episode: number, lines: readonly ReviewLine[]): ReviewFlag[] {
  const rows: ReviewFlag[] = [];
  for (const f of file.flags) {
    if (f["episode"] !== episode || typeof f["line"] !== "number") continue;
    const line = lines.find((l) => l.i === f["line"]);
    const reason = typeof f["reason"] === "string" ? f["reason"] : "";
    const auto = f["source"] === "auto" || (f["source"] === undefined && f["by"] === "auto");
    const failing = auto ? (failingFromReason(reason).length > 0 ? failingFromReason(reason) : (line?.failing ?? [])) : [];
    rows.push({
      id: typeof f["id"] === "string" ? f["id"] : `line-${String(f["line"])}`,
      episode,
      line: f["line"],
      reason,
      time: num(f["time"], line?.start ?? 0),
      source: auto ? "auto" : "human",
      failing,
    });
  }
  return rows.sort((a, b) => a.line - b.line || Number(b.source === "auto") - Number(a.source === "auto"));
}

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

export interface ReviewHostOptions {
  /** The work's directory (`<vault>/<kind>/<slug>`). */
  readonly work: string;
  /** Shown as the window's title; the work's title. */
  readonly title: string;
  readonly now?: () => Date;
}

export interface ReviewHost {
  /** What the view is mounted with; `episode` is `--episode N`. Read fresh each call. */
  data(episode?: number): ReviewData;
  listChapters(): ChapterRow[];
  loadTrack(args: unknown): TrackPayload;
  setVersion(args: unknown): TrackPayload;
  flag(args: unknown): ReviewFlag[];
  unflag(args: unknown): ReviewFlag[];
  loadSegments(args: unknown): SegmentsPayload;
}

function positiveInt(args: unknown, key: string, required: true): number;
function positiveInt(args: unknown, key: string, required: false): number | undefined;
function positiveInt(args: unknown, key: string, required: boolean): number | undefined {
  const value = isRecord(args) ? args[key] : undefined;
  if (value === undefined && !required) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${key} must be a whole number of 1 or more`);
  return value;
}

function lineId(args: unknown): number {
  const value = isRecord(args) ? args["line"] : undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error("line must be a whole number of 0 or more");
  return value;
}

export function createReviewHost(options: ReviewHostOptions): ReviewHost {
  const { work } = options;
  const now = options.now ?? (() => new Date());

  const chapterRows = (): ChapterRow[] => {
    const file = (() => {
      try {
        return readFlagsFile(work);
      } catch {
        return { raw: {}, flags: [] } as FlagsFile; // a broken flags.json must not hide the chapters
      }
    })();
    const rows: ChapterRow[] = [];
    const counts = (flags: readonly ReviewFlag[]): ChapterRow["flags"] => ({
      human: flags.filter((f) => f.source === "human").length,
      auto: flags.filter((f) => f.source === "auto").length,
    });
    const episodes = [...new Set([...renderedEpisodes(work), ...streamedEpisodes(work)])].sort((a, b) => a - b);
    for (const episode of episodes) {
      const mixed = mixedVersions(work, episode);
      const newest = mixed[mixed.length - 1];
      if (newest !== undefined) {
        rows.push({ episode, title: episodeTitle(work, episode), versions: mixed.map(versionInfo), latest: newest.version, flags: counts(flagRows(file, episode, newest.lines)) });
        continue;
      }
      // Not mixed yet: listed once its streamed performance is playable (AGT-1697), with no version to switch.
      const live = playableStream(work, episode);
      if (live === undefined) continue;
      rows.push({
        episode,
        title: episodeTitle(work, episode),
        versions: [],
        latest: null,
        flags: counts(flagRows(file, episode, liveLines(live))),
        stream: { state: live.state === "streaming" ? "streaming" : "finished", seconds: live.seconds, segments: live.segments.length, linesDone: live.linesDone, linesTotal: live.linesTotal },
      });
    }
    return rows;
  };

  function segments(episode: number, from: number): SegmentsPayload {
    // A chapter that finished mixing while it played keeps its segments: the listener plays on to its end.
    const live = playableStream(work, episode, true);
    if (live === undefined) throw new Error(`episode ${episode} is not streaming (it has no playable performance in progress); choose it again from the chapter list, or start one with pablo perform --stream`);
    return {
      episode,
      title: episodeTitle(work, episode),
      from,
      segments: live.segments.slice(from, from + SEGMENTS_PER_CALL).map((s) => ({
        n: s.n,
        start: s.start,
        seconds: s.seconds,
        mime: "audio/wav",
        b64: readSegment(work, episode, s).toString("base64"),
      })),
      available: live.segments.length,
      complete: live.state !== "streaming",
      seconds: live.seconds,
      lines: liveLines(live),
    };
  }

  function track(episode: number, version: number | undefined): TrackPayload {
    const mixed = mixedVersions(work, episode);
    if (mixed.length === 0) throw new Error(`episode ${episode} has no mixed audio yet (run pablo perform, then pablo mix)`);
    const chosen = version === undefined ? mixed[mixed.length - 1] : mixed.find((m) => m.version === version);
    if (chosen === undefined) throw new Error(`episode ${episode} has no mixed version ${String(version)} (it has ${mixed.map((m) => `v${m.version}`).join(", ")})`);
    const audio = resolve(episodeDir(work, episode), chosen.audio as string);
    const extension = /\.[a-z0-9]+$/.exec(audio)?.[0] ?? "";
    const lastEnd = chosen.lines.reduce((m, l) => Math.max(m, l.end), 0);
    return {
      episode,
      version: chosen.version,
      versions: mixed.map(versionInfo),
      title: episodeTitle(work, episode),
      mime: MIME[extension] ?? "application/octet-stream",
      b64: readFileSync(audio).toString("base64"),
      duration: chosen.duration ?? lastEnd,
      lines: chosen.lines,
      flags: flagRows(readFlagsFile(work), episode, chosen.lines),
    };
  }

  /** The flags of `episode` as the view shows them against the line timings of `version` (default newest). */
  function flagsFor(episode: number, version: number | undefined): ReviewFlag[] {
    const mixed = mixedVersions(work, episode);
    const shown = (version === undefined ? mixed[mixed.length - 1] : mixed.find((m) => m.version === version)) ?? mixed[mixed.length - 1];
    return flagRows(readFlagsFile(work), episode, shown?.lines ?? []);
  }

  return {
    data(episode) {
      const chapters = chapterRows();
      return { title: options.title, chapters, start: episode ?? chapters[0]?.episode ?? null };
    },

    listChapters: chapterRows,

    loadTrack(args) {
      return track(positiveInt(args, "episode", true), positiveInt(args, "version", false));
    },

    setVersion(args) {
      return track(positiveInt(args, "episode", true), positiveInt(args, "version", true));
    },

    flag(args) {
      const episode = positiveInt(args, "episode", true);
      const line = lineId(args);
      const reasonArg = isRecord(args) ? args["reason"] : undefined;
      const reason = reasonArg === undefined ? "clipped" : reasonArg;
      if (typeof reason !== "string" || !(REASONS as readonly string[]).includes(reason)) {
        throw new Error(`reason must be one of: ${REASONS.join(", ")}`);
      }
      const version = positiveInt(args, "version", false);
      const mixed = mixedVersions(work, episode);
      const shown = (version === undefined ? mixed[mixed.length - 1] : mixed.find((m) => m.version === version)) ?? mixed[mixed.length - 1];
      if (shown === undefined) throw new Error(`episode ${episode} has no mixed audio yet; there is nothing to flag`);
      const target = shown.lines.find((l) => l.i === line);
      if (target === undefined) throw new Error(`episode ${episode} has no line ${line}`);
      const timeArg = isRecord(args) ? args["time"] : undefined;
      if (timeArg !== undefined && (typeof timeArg !== "number" || !Number.isFinite(timeArg) || timeArg < 0)) throw new Error("time must be a number of seconds, 0 or more");
      const time = Math.round((timeArg ?? target.start) * 100) / 100;

      const file = readFlagsFile(work);
      const stamp = now().toISOString();
      const id = `f-${stamp.replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-")}-ep${String(episode).padStart(2, "0")}-${line}`;
      const isHumanHere = (f: Record<string, unknown>): boolean => f["episode"] === episode && f["line"] === line && f["source"] !== "auto" && f["by"] !== "auto";
      // One listener flag per line: flagging it again updates the reason and time. The performer's stays.
      const kept = file.flags.filter((f) => !isHumanHere(f));
      kept.push({ id, episode, line, reason, time, source: "human", by: "human", at: stamp });
      writeFlagsFile(work, file, kept);
      return flagsFor(episode, version);
    },

    unflag(args) {
      const episode = positiveInt(args, "episode", true);
      const idArg = isRecord(args) ? args["id"] : undefined;
      const file = readFlagsFile(work);
      let kept: Record<string, unknown>[];
      if (idArg !== undefined) {
        if (typeof idArg !== "string") throw new Error("id must be text");
        kept = file.flags.filter((f) => !(f["episode"] === episode && f["id"] === idArg));
      } else {
        const line = lineId(args);
        kept = file.flags.filter((f) => !(f["episode"] === episode && f["line"] === line));
      }
      if (kept.length !== file.flags.length) writeFlagsFile(work, file, kept);
      return flagsFor(episode, undefined);
    },

    loadSegments(args) {
      const fromArg = isRecord(args) ? args["from"] : undefined;
      if (fromArg !== undefined && (typeof fromArg !== "number" || !Number.isInteger(fromArg) || fromArg < 0)) throw new Error("from must be a whole number of 0 or more");
      return segments(positiveInt(args, "episode", true), fromArg ?? 0);
    },
  };
}

/** The mutations the window may call, and nothing else: ui-leaf answers 404 for any other name. */
export function reviewMutations(host: ReviewHost): Record<string, MutationHandler> {
  const handlers: Record<(typeof MUTATIONS)[number], MutationHandler> = {
    listChapters: async () => host.listChapters(),
    loadTrack: async (args) => host.loadTrack(args),
    setVersion: async (args) => host.setVersion(args),
    flag: async (args) => host.flag(args),
    unflag: async (args) => host.unflag(args),
    loadSegments: async (args) => host.loadSegments(args),
  };
  return handlers;
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

export const NO_CHROME_MESSAGE =
  "pablo: the review player opens in Google Chrome, and I could not find it on this Mac. Install Chrome (https://www.google.com/chrome) and run this again; nothing was changed.";

/** ui-leaf's strict preset, plus media from data:/blob: so <audio> can play the episode it is handed as base64. */
export const REVIEW_CSP =
  "default-src 'self'; connect-src 'self'; form-action 'self'; img-src 'self' data: https:; font-src 'self' https: data:; " +
  "style-src 'self' 'unsafe-inline' https:; script-src 'self' 'unsafe-inline'; media-src 'self' data: blob:";

/** After the window disconnects and does not come back, close its server. */
const DISCONNECT_CLOSE_DELAY_MS = 5000;

export interface OpenReviewDeps {
  readonly env: Env;
  readonly mount: (options: MountOptions) => Promise<View>;
  readonly existsExecutable?: (path: string) => boolean;
  readonly binaryPath: () => string | undefined;
  readonly now?: () => Date;
}

export type OpenReviewOutcome =
  | { readonly ok: true; readonly view: View; readonly closed: Promise<void>; readonly host: ReviewHost }
  | { readonly ok: false; readonly code: 1 | 2; readonly message: string };

/**
 * Mounts the review player on a work. Refuses (exit 2) when `--episode N` has no mixed audio, and (unless
 * `UI_LEAF_NO_OPEN` is set, which headless runs and smoke tests use) when Google Chrome is missing.
 * An empty work opens an empty list that fills as chapters are published.
 */
export async function openReview(
  work: string,
  title: string,
  episode: number | undefined,
  signal?: AbortSignal,
  overrides: Partial<OpenReviewDeps> = {},
): Promise<OpenReviewOutcome> {
  const deps: OpenReviewDeps = { env: process.env, mount, binaryPath: resolveUiLeafBinary, ...overrides };
  const headless = deps.env["UI_LEAF_NO_OPEN"] !== undefined && deps.env["UI_LEAF_NO_OPEN"] !== "0";
  if (!headless && findChrome(deps.existsExecutable) === undefined) return { ok: false, code: 2, message: NO_CHROME_MESSAGE };

  const host = createReviewHost({ work, title, ...(deps.now === undefined ? {} : { now: deps.now }) });
  if (episode !== undefined && !host.listChapters().some((c) => c.episode === episode)) {
    return { ok: false, code: 2, message: `pablo: review: episode ${episode} has no mixed audio yet (run pablo perform, then pablo mix); nothing was opened` };
  }

  // ui-leaf reads this from its inherited environment and, on its own, suppresses the window under ssh;
  // this is a window meant to open. An explicit UI_LEAF_NO_OPEN is still honoured.
  if (process.env["UI_LEAF_NO_OPEN"] === undefined) process.env["UI_LEAF_NO_OPEN"] = "0";

  const binaryPath = deps.binaryPath();
  let view: View;
  try {
    view = await deps.mount({
      view: "review",
      viewsRoot: VIEWS_ROOT,
      data: host.data(episode),
      title: `${title} — pablo review`,
      mutations: reviewMutations(host),
      shell: "app",
      windowSize: { width: 620, height: 900 },
      port: 0,
      silent: true,
      csp: REVIEW_CSP,
      // A listening window is one you leave while you do something else.
      heartbeatTimeoutMs: 90_000,
      ...(binaryPath === undefined ? {} : { binaryPath }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    return { ok: false, code: 1, message: `pablo: review: could not open the review player (${(error as Error).message})` };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  view.onDisconnect(() => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void view.close(), DISCONNECT_CLOSE_DELAY_MS);
  });
  view.onReconnect(() => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  });
  const closed = view.closed.then(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  return { ok: true, view, closed, host };
}
