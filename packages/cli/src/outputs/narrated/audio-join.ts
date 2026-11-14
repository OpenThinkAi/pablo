/**
 * Joining a narrated work's readings into one episode file (AGT-2306, pm
 * project `pablo-platform`): `pablo publish --output narrated --target audio`.
 *
 * Each reading's newest mix (`outputs/narrated/casting/renders/epNN/`) is
 * decoded to one common format, a gap of silence is padded after every reading
 * but the last, and the lot is concatenated and encoded as AAC in an m4a with
 * ffmpeg. With chapters, each reading is a chapter named for its title,
 * written as an ffmetadata file ffmpeg maps into the m4a. ffmpeg and ffprobe
 * are found on PATH, like the casting side's encoder fallback; nothing here
 * loads a model.
 *
 * `joinArgs` and `chapterMetadata` are pure; `joinReadings` runs the tools.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The silence between readings, in seconds, when `--gap` is not given. */
export const DEFAULT_GAP_SECONDS = 1.4;

/** Output sample rate and AAC bitrate of the joined file. */
const SAMPLE_RATE = 44100;
const AAC_BITRATE = "96k";

/** One reading to join: its newest mixed audio and, for a chapter marker, its title. */
export interface JoinReading {
  readonly unit: number;
  readonly title: string;
  readonly audio: string;
}

/** ffmetadata text with one `[CHAPTER]` per reading; `durations` are in seconds, one per reading. */
export function chapterMetadata(readings: readonly JoinReading[], durations: readonly number[], gap: number): string {
  const lines = [";FFMETADATA1"];
  let start = 0;
  readings.forEach((reading, i) => {
    const end = start + (durations[i] ?? 0);
    lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${Math.round(start * 1000)}`, `END=${Math.round(end * 1000)}`, `title=${escapeMeta(reading.title)}`);
    start = end + gap;
  });
  return `${lines.join("\n")}\n`;
}

/** ffmetadata escapes `=`, `;`, `#`, `\` and newlines with a backslash. */
function escapeMeta(value: string): string {
  return value.replace(/[=;#\\]/g, (c) => `\\${c}`).replace(/\n/g, "\\\n");
}

/** The ffmpeg argv that joins `readings` (in order) into `output`; `metadata` is an ffmetadata file for the chapters. */
export function joinArgs(readings: readonly JoinReading[], output: string, gap: number, metadata?: string): string[] {
  const args = ["-y", "-loglevel", "error"];
  for (const r of readings) args.push("-i", r.audio);
  if (metadata !== undefined) args.push("-i", metadata);
  const last = readings.length - 1;
  const chains = readings.map((_r, i) => `[${i}:a]aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo${i < last && gap > 0 ? `,apad=pad_dur=${gap}` : ""}[a${i}]`);
  const inputs = readings.map((_r, i) => `[a${i}]`).join("");
  args.push("-filter_complex", `${chains.join(";")};${inputs}concat=n=${readings.length}:v=0:a=1[out]`, "-map", "[out]");
  if (metadata !== undefined) args.push("-map_metadata", String(readings.length), "-map_chapters", String(readings.length));
  args.push("-c:a", "aac", "-b:a", AAC_BITRATE, output);
  return args;
}

export type JoinResult = { readonly ok: true; readonly chapters: boolean } | { readonly ok: false; readonly message: string };

function durationOf(file: string): number | undefined {
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file], { encoding: "utf8", env: process.env });
  if (probe.error !== undefined || probe.status !== 0) return undefined;
  const seconds = Number(probe.stdout.trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Joins the readings into `output` with ffmpeg; a missing tool or a failed run is a message, never a throw. */
export function joinReadings(readings: readonly JoinReading[], output: string, gap: number, chapters: boolean): JoinResult {
  const scratch = mkdtempSync(join(tmpdir(), "pablo-narrated-join-"));
  try {
    let metadata: string | undefined;
    if (chapters) {
      const durations: number[] = [];
      for (const r of readings) {
        const seconds = durationOf(r.audio);
        if (seconds === undefined) return { ok: false, message: `pablo: publish: could not read the length of reading ${r.unit}'s audio (${r.audio}); is ffprobe installed (brew install ffmpeg)?` };
        durations.push(seconds);
      }
      metadata = join(scratch, "chapters.ffmetadata");
      writeFileSync(metadata, chapterMetadata(readings, durations, gap), "utf8");
    }
    // Encode beside the destination and rename on success, so a failed run never replaces the last good file.
    const partial = `${output}.partial.m4a`;
    const run = spawnSync("ffmpeg", joinArgs(readings, partial, gap, metadata), { encoding: "utf8", env: process.env });
    if (run.error !== undefined || run.status !== 0) rmSync(partial, { force: true });
    if (run.error !== undefined) return { ok: false, message: "pablo: publish: ffmpeg is needed to join the readings (brew install ffmpeg)" };
    if (run.status !== 0) return { ok: false, message: `pablo: publish: ffmpeg failed joining the readings: ${(run.stderr ?? "").trim().split("\n").slice(-3).join(" ")}` };
    renameSync(partial, output);
    return { ok: true, chapters: metadata !== undefined };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
