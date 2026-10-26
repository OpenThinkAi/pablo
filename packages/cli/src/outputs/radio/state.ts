/**
 * Where a radio output's episodes stand after their script (AGT-1686, pm
 * project `pablo-casting`, "The radio output's stage machine"), read from
 * disk without the Python side:
 *
 *     script N    outputs/radio/episodes/NN-*.md with a CAST: line
 *     cast        every role the script needs bound in cast.json
 *     perform     renders/epNN/v<k>.json (a manifest)
 *     mix         the newest manifest's audio on disk (epNN.v<k>.m4a)
 *     fix         open flags for the episode in flags.json
 *     publish     the mixed episodes, by target
 *
 * `radioStageCheck` is the one place a casting verb asks whether its stage
 * may run for an episode (`perform` with an unbound role is refused, naming
 * the role, before anything is provisioned or rendered); `episodeState` is
 * what `status --for "radio N"` and `resume` report. Everything here only
 * reads; the files are the Python side's (`binding.py`, `manifest.py`,
 * `perform.py`) and the review player's (`flags.json`).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { radioScriptDir } from "../../radio";
import { audioCastingDir, unitNoun } from "../audio";
import type { AudioOutput } from "../audio";
import { NARRATED_DIR } from "../narrated/units";
import { hasCastLine, scriptRoles } from "./script";
import { RADIO_CASTING_DIR, RADIO_UNIT_FILE, episodeTag } from "./units";

/** The radio output's stage machine after the core, in order. */
export const RADIO_STAGES = ["script", "cast", "perform", "mix", "fix", "publish"] as const;
export type RadioStage = (typeof RADIO_STAGES)[number];

/** A stage a casting verb runs: `review` (the player) needs what `fix`'s flags come from, a mixed version. */
export type RadioVerbStage = Exclude<RadioStage, "script" | "publish"> | "review";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Where an output's scripts are read from (`binding.py`'s `script_dir`): radio's episodes (else the novel's directory), narrated's readings. */
export function audioScriptDir(work: string, output: AudioOutput = "radio"): string {
  return output === "radio" ? radioScriptDir(work) : join(work, NARRATED_DIR);
}

/** The episode's script, absolute, when one carries a `CAST:` line (`binding.py`'s `episode_files`). */
export function episodeScript(work: string, episode: number, output: AudioOutput = "radio"): string | undefined {
  const dir = audioScriptDir(work, output);
  if (!existsSync(dir)) return undefined;
  for (const name of readdirSync(dir).sort()) {
    const m = RADIO_UNIT_FILE.exec(name);
    if (m === null || Number(m[1]) !== episode) continue;
    const path = join(dir, name);
    try {
      if (hasCastLine(readFileSync(path, "utf8"))) return path;
    } catch {
      // An unreadable file is no script.
    }
  }
  return undefined;
}

/** `cast.json`, where `binding.py`'s `casting_dir` finds it: the radio output's, else a pre-output work's top-level `casting/`. */
export function castFile(work: string, output: AudioOutput = "radio"): string {
  // Any other output keeps its own `cast.json`, with no legacy fallback (AGT-2158).
  if (output !== "radio") return join(audioCastingDir(work, output), "cast.json");
  const radio = join(work, RADIO_CASTING_DIR, "cast.json");
  const legacy = join(work, "casting", "cast.json");
  return !existsSync(radio) && existsSync(legacy) ? legacy : radio;
}

/** The roles `cast.json` binds; an absent or unreadable file binds none (the Python side reports a broken one). */
export function boundRoles(work: string, output: AudioOutput = "radio"): Set<string> {
  const body = readJson(castFile(work, output));
  const roles = isRecord(body) && isRecord(body["roles"]) ? Object.keys(body["roles"]) : [];
  return new Set(roles);
}

/** The roles of episode N's script that `cast.json` does not bind, in script order; `undefined` without a script. */
export function unboundRoles(work: string, episode: number, output: AudioOutput = "radio"): string[] | undefined {
  const script = episodeScript(work, episode, output);
  if (script === undefined) return undefined;
  const bound = boundRoles(work, output);
  return scriptRoles(readFileSync(script, "utf8")).filter((role) => !bound.has(role));
}

/** `renders/epNN/` for an episode, absolute. */
export function renderDir(work: string, episode: number, output: AudioOutput = "radio"): string {
  return join(audioCastingDir(work, output), "renders", episodeTag(episode));
}

/** A manifest's audio is a bare `epNN.v<k>.<ext>` beside it; anything else is never opened. */
const AUDIO_NAME = /^ep\d+\.v\d+\.[a-z0-9]+$/;

/** One manifest version of an episode, as the stage machine needs it. */
export interface RenderVersion {
  readonly version: number;
  /** The manifest, absolute. */
  readonly manifest: string;
  /** The mixed audio, absolute, when the version is mixed and the file is on disk. */
  readonly audio?: string;
}

/** Every manifest version of an episode, ascending. */
export function renderVersions(work: string, episode: number, output: AudioOutput = "radio"): RenderVersion[] {
  const dir = renderDir(work, episode, output);
  if (!existsSync(dir)) return [];
  const versions: RenderVersion[] = [];
  for (const name of readdirSync(dir)) {
    const m = /^v(\d+)\.json$/.exec(name);
    if (m === null) continue;
    const manifest = join(dir, name);
    const body = readJson(manifest);
    const audio = isRecord(body) && typeof body["audio"] === "string" && AUDIO_NAME.test(body["audio"]) ? join(dir, body["audio"]) : undefined;
    versions.push({ version: Number(m[1]), manifest, ...(audio !== undefined && existsSync(audio) ? { audio } : {}) });
  }
  return versions.sort((a, b) => a.version - b.version);
}

/** The episode's open flags in `flags.json` (the player's and the performer's automatic ones). */
export function openFlags(work: string, episode: number, output: AudioOutput = "radio"): number {
  const body = readJson(join(audioCastingDir(work, output), "flags.json"));
  if (!isRecord(body) || !Array.isArray(body["flags"])) return 0;
  return body["flags"].filter((f) => isRecord(f) && f["episode"] === episode).length;
}

/** The newest receipt `perform` (or `fix`) left for the episode in `<work>/.pablo/casting/receipts.jsonl`, or undefined. */
export function lastReceipt(work: string, episode: number, intents: readonly string[] = ["perform", "fix"], output: AudioOutput = "radio"): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(join(work, ".pablo", "casting", "receipts.jsonl"), "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n").reverse()) {
    if (line.trim() === "") continue;
    try {
      const receipt = JSON.parse(line) as unknown;
      if (!isRecord(receipt)) continue;
      // A receipt with no `output` is radio's; any other output's says so (`receipts.py`, AGT-2158).
      const of = typeof receipt["output"] === "string" ? receipt["output"] : "radio";
      if (of === output && intents.includes(String(receipt["intent"])) && receipt["episode"] === episode) return receipt;
    } catch {
      // A torn line is skipped.
    }
  }
  return undefined;
}

/** What a stage needs for one episode, and what is missing. */
export interface StageCheck {
  readonly ready: boolean;
  readonly missing: readonly string[];
}

const scriptMissing = (episode: number, output: AudioOutput): string => `${unitNoun(output)} ${episode} has no script (pablo write --output ${output} --unit ${episode})`;

/**
 * Whether `stage` may run for `episode`, and what is missing when it may
 * not. Pure over the work directory, and it never runs the Python side:
 *
 *   cast      the episode's script (with its `CAST:` line)
 *   perform   the script, every role bound, and no render yet (a performed episode is fixed, not performed again)
 *   mix       a performed version
 *   fix       a performed version and at least one open flag
 *   review    a mixed version
 */
export function radioStageCheck(work: string, stage: RadioVerbStage, episode: number, output: AudioOutput = "radio"): StageCheck {
  const done = (missing: string[]): StageCheck => ({ ready: missing.length === 0, missing });
  const unbound = unboundRoles(work, episode, output);
  if (unbound === undefined) return done([scriptMissing(episode, output)]);
  if (stage === "cast") return done([]);
  const versions = renderVersions(work, episode, output);
  const latest = versions.at(-1);
  const noun = unitNoun(output);
  const unperformed = `${noun} ${episode} is not performed (pablo perform --output ${output} --unit ${episode})`;
  switch (stage) {
    case "perform":
      return done([
        ...unbound.map((role) => `role ${role} is not cast`),
        ...(latest === undefined ? [] : [`${noun} ${episode} is already performed (v${latest.version}); re-record flagged lines with pablo fix`]),
      ]);
    case "mix":
      return done(latest === undefined ? [unperformed] : []);
    case "fix":
      if (latest === undefined) return done([unperformed]);
      return done(openFlags(work, episode, output) === 0 ? [`${noun} ${episode} has no open flags (flag lines in ${output === "radio" ? "pablo review" : "pablo mixer"})`] : []);
    case "review":
      return done(versions.some((v) => v.audio !== undefined) ? [] : [`${noun} ${episode} has no mixed audio yet (pablo perform, then pablo mix)`]);
  }
}

/** One episode's state through the stages after its script, as `status` and `resume` report it. */
export interface EpisodeState {
  readonly episode: number;
  readonly script: boolean;
  /** Roles the script needs that `cast.json` does not bind (empty without a script). */
  readonly unbound: readonly string[];
  /** `none`, `performed vK` (a manifest, not mixed) or `mixed vK` (the newest version with audio). */
  readonly render: string;
  readonly version?: number;
  /** The newest mixed audio, absolute. */
  readonly audio?: string;
  readonly openFlags: number;
  /** The next stage to run, or `publish` when the episode is mixed with nothing open. */
  readonly stage: RadioStage;
}

/** Reads one episode's state. Pure over the work directory. */
export function episodeState(work: string, episode: number, output: AudioOutput = "radio"): EpisodeState {
  const unbound = unboundRoles(work, episode, output);
  const versions = renderVersions(work, episode, output);
  const latest = versions.at(-1);
  const mixed = [...versions].reverse().find((v) => v.audio !== undefined);
  const flags = openFlags(work, episode, output);
  const render = latest === undefined ? "none" : latest.audio !== undefined ? `mixed v${latest.version}` : `performed v${latest.version}`;
  const stage: RadioStage =
    unbound === undefined ? "script" : unbound.length > 0 ? "cast" : latest === undefined ? "perform" : latest.audio === undefined ? "mix" : flags > 0 ? "fix" : "publish";
  return {
    episode,
    script: unbound !== undefined,
    unbound: unbound ?? [],
    render,
    ...(latest !== undefined ? { version: latest.version } : {}),
    ...(mixed?.audio !== undefined ? { audio: mixed.audio } : {}),
    openFlags: flags,
    stage,
  };
}
