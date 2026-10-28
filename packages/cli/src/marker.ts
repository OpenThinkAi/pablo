/**
 * `pablo.json` — the project marker. Its presence (and shape) is what tells
 * an agent a directory is a pablo project and which outputs its story core
 * has; every verb but `init` refuses when it is missing or malformed. See the
 * `pablo-story-core` design doc (`pm project show pablo-story-core`, "The
 * work") for the canonical shape this mirrors.
 *
 * MARKER_SCHEMA — `pablo.json` fields:
 *
 * | key         | required | default                          |
 * |-------------|----------|----------------------------------|
 * | `title`     | yes      | —                                |
 * | `slug`      | yes      | —                                |
 * | `outputs`   | no       | `{}` (a core with nothing derived yet) |
 * | `author`    | no       | `"author"` (init writes git user.name) |
 * | `voice`     | no       | `["../../style", "STYLE.md"]`     |
 * | `neverSend` | no       | `["research/", "notes/"]`        |
 * | `publish`   | no       | `{}`                              |
 * | `policy`    | no       | —  (the harness's minimal default judgement policy) |
 * | `track`     | no       | `"fiction"` (`fiction`, `historical-fiction`, `nonfiction`) |
 * | `realNames` | no       | `true` (`false` keeps research names out of distilled facts) |
 * | `think`     | no       | `true` (`false` skips the `think sync` after a merge) |
 * | `providers` | no       | —  (the global config's; merged over it by `loadConfig({ projectDir })`) |
 * | `intents`   | no       | —  (the global config's; merged over it the same way) |
 * | `format`    | deprecated | —  (`"novel"` only; read as `outputs.novel`) |
 *
 * `outputs` maps an output type to its entry: `{ dir?, added, ...more }`.
 * `added` (YYYY-MM-DD) is required; `dir` is where the type's units land
 * (the novel's is fixed at its artifact directory); any other key is the
 * type's own and kept as written. The known types are the output registry's
 * rows (`OUTPUTS`, `outputs/registry.ts`, AGT-1668); any other is refused by
 * name.
 *
 * `format` (AGT-1666): the one-format-per-work key `outputs` replaced
 * (decided 2026-10-10). For one release `format: "novel"` is read as
 * migrated in memory, `outputs: { novel: { dir: NOVEL_DIR } }`, with a
 * deprecation notice on stderr naming `pablo migrate outputs`; any other
 * `format` value is refused by name, and a marker carrying both `format` and
 * `outputs` is refused naming both keys.
 *
 * `policy` names a judgement policy pablo ships under `packages/cli/policies/`
 * (e.g. `"historical-fiction"`); the harness loads it into its system prompt
 * (AGT-1553). A value that is not a plain name (lowercase letters, digits and
 * hyphens) is refused here; a well-formed name pablo does not ship is refused
 * when the harness loads it.
 *
 * `track` (AGT-2099, pm project `pablo-platform`, D-4..D-6) is the kind of
 * work: a key of the track registry (`TRACKS`, `tracks/registry.ts`). A
 * marker without one reads as `fiction` (`trackOf`), and `Marker.track` stays
 * absent so a rewritten marker is byte-for-byte what it was; an unknown
 * value is refused naming the allowed ids.
 *
 * `realNames` (AGT-2107, D-10) is whether distilled period facts may name the
 * real people and places in `research/`. Absent reads as `true` (`realNamesOf`),
 * and `Marker.realNames` stays absent so a rewritten marker is unchanged; a
 * work that keeps research names out sets `false`. A non-boolean value is
 * refused. `resume` reports it; `distill_facts` (AGT-2109) acts on it.
 *
 * `providers` and `intents` (AGT-2129, D-13) route this work's model calls
 * over the global config; core's `loadConfig({ projectDir })` reads and
 * validates them. One check is made here too, so every verb refuses it: a
 * provider entry that sets `key` at all (AGT-2228, D-4: keys are bound only in
 * the global config, since this file is committed; core's `refuseWorkKey`).
 *
 * A missing required key is refused by name (`message` names the exact key).
 * A directory with no `pablo.json` at all is refused with a pointer at
 * `pablo init --adopt --project <slug>`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { refuseWorkKey } from "@openthink/pablo-core";
import { NOVEL_DIR } from "./outputs/novel/units";
import type { OutputId } from "./outputs/registry";
import { isOutputId, outputIds } from "./outputs/registry";
import type { Refusal } from "./project";
import type { TrackId } from "./tracks/registry";
import { DEFAULT_TRACK, isTrackId, trackIds } from "./tracks/registry";

/** An output type's id: a key of the output registry (`OUTPUTS`, `outputs/registry.ts`). */
export type OutputType = OutputId;

/** The novel output's artifact directory (the registry's `OUTPUTS.novel.artifactDir`), kept here for the marker's own checks. */
export { NOVEL_DIR };

/** The only value the deprecated `format` key may hold. */
const LEGACY_FORMATS = ["novel"] as const;

export const DEFAULT_AUTHOR = "author";
export const DEFAULT_VOICE: readonly string[] = ["../../style", "STYLE.md"];
export const DEFAULT_NEVER_SEND: readonly string[] = ["research/", "notes/"];
export const DEFAULT_PUBLISH: Readonly<Record<string, unknown>> = {};

/** What a `policy` value may look like: a file name under `policies/`, never a path. */
export const POLICY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** One `outputs` entry. `added` is absent only on an entry the `format` shim made in memory. */
export interface OutputEntry {
  readonly dir?: string;
  readonly added?: string;
  readonly [key: string]: unknown;
}

export type Outputs = Readonly<Record<string, OutputEntry>>;

/** The typed shape of `pablo.json`. */
export interface Marker {
  readonly title: string;
  readonly slug: string;
  readonly author: string;
  readonly voice: readonly string[];
  readonly neverSend: readonly string[];
  readonly publish: Readonly<Record<string, unknown>>;
  /** The judgement policy's name; absent means the harness's minimal default. */
  readonly policy?: string;
  /** The work's track, as written; absent reads as `fiction` (use `trackOf`). */
  readonly track?: TrackId;
  /** Whether distilled facts may carry real names, as written; absent reads as `true` (use `realNamesOf`). */
  readonly realNames?: boolean;
  /** `false` skips the after-merge `think sync` (AGT-2190); absent reads as on. */
  readonly think?: boolean;
  /** The outputs derived from the work's story core; `{}` is a core with nothing derived yet. */
  readonly outputs: Outputs;
}

export interface MarkerFound {
  readonly ok: true;
  readonly marker: Marker;
  /**
   * Set when the marker was read through the `format` shim: the deprecation
   * notice (also written to stderr, once per marker per process).
   */
  readonly deprecated?: string;
}

export type MarkerResult = MarkerFound | Refusal;

function refuse(message: string, tried: readonly string[]): Refusal {
  return { ok: false, code: 2, message, tried };
}

export function markerPath(workDir: string): string {
  return join(workDir, "pablo.json");
}

/** The notice an unmigrated marker carries; names the migration that rewrites it. */
export function formatDeprecation(path: string, slug: string): string {
  return `pablo: ${path} uses the deprecated "format" key, read as outputs.novel for this release; run \`pablo migrate outputs --project ${slug}\` to rewrite it`;
}

const warned = new Set<string>();

/** A short name for the work's outputs, for prompts and the status line: `"novel"`, `"novel, radio"`, or `"core"` with none. */
export function outputsLabel(marker: Marker): string {
  const types = Object.keys(marker.outputs);
  return types.length === 0 ? "core" : types.join(", ");
}

/** The work's track: the marker's `track`, else `fiction` (D-6). */
export function trackOf(marker: Marker): TrackId {
  return marker.track ?? DEFAULT_TRACK;
}

/** Whether the work lets real names from `research/` into distilled facts: the marker's `realNames`, else `true` (D-10). */
export function realNamesOf(marker: Marker): boolean {
  return marker.realNames ?? true;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the `outputs` value, refusing by the exact key (`outputs`, `outputs.<type>`, `outputs.<type>.<field>`). */
function readOutputs(value: unknown, path: string): { ok: true; outputs: Outputs } | Refusal {
  if (!isObject(value)) {
    return refuse(`pablo: ${path} has an invalid "outputs" (${JSON.stringify(value)}); it maps an output type to its entry, e.g. {"novel": {"dir": "${NOVEL_DIR}", "added": "2026-10-10"}}`, [path]);
  }
  const outputs: Record<string, OutputEntry> = {};
  for (const [type, entry] of Object.entries(value)) {
    const key = `outputs.${type}`;
    if (!isOutputId(type)) {
      return refuse(`pablo: ${path} has unknown output type "${type}" at "${key}" (known: ${outputIds().join(", ")})`, [path]);
    }
    if (!isObject(entry)) {
      return refuse(`pablo: ${path} has an invalid "${key}" (${JSON.stringify(entry)}); an output entry is an object with "added"`, [path]);
    }
    const dir = entry["dir"];
    if (dir !== undefined && (typeof dir !== "string" || dir === "")) {
      return refuse(`pablo: ${path} has an invalid "${key}.dir" (${JSON.stringify(dir)})`, [path]);
    }
    if (type === "novel" && dir !== undefined && dir !== NOVEL_DIR) {
      return refuse(`pablo: ${path} has "${key}.dir" ${JSON.stringify(dir)}; the novel's chapters live in "${NOVEL_DIR}"`, [path]);
    }
    const added = entry["added"];
    if (typeof added !== "string" || !DATE.test(added)) {
      return refuse(
        added === undefined
          ? `pablo: ${path} is missing required key "${key}.added" (the date the output was added, YYYY-MM-DD)`
          : `pablo: ${path} has an invalid "${key}.added" (${JSON.stringify(added)}); expected YYYY-MM-DD`,
        [path],
      );
    }
    outputs[type] = entry as OutputEntry;
  }
  return { ok: true, outputs };
}

/**
 * Reads and validates `<workDir>/pablo.json`. A missing file, invalid JSON,
 * a missing required key, an unknown output type, both `format` and
 * `outputs`, or an unsupported `format` are all refusals (exit code 2
 * everywhere in the CLI) rather than thrown errors, so callers can relay
 * `message` directly. A `format: "novel"` marker reads as migrated (see the
 * header) and writes its deprecation notice to stderr once per process.
 */
export function readMarker(workDir: string): MarkerResult {
  const path = markerPath(workDir);

  if (!existsSync(path)) {
    return refuse(
      `pablo: ${workDir} is not a pablo project (no pablo.json); run \`pablo init --adopt --project <slug>\``,
      [path],
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return refuse(`pablo: ${path} is not valid JSON (${(err as Error).message})`, [path]);
  }

  if (!isObject(raw)) {
    return refuse(`pablo: ${path} must contain a JSON object`, [path]);
  }
  const data = raw;

  for (const key of ["title", "slug"] as const) {
    if (typeof data[key] !== "string" || data[key] === "") {
      return refuse(`pablo: ${path} is missing required key "${key}"`, [path]);
    }
  }
  const slug = data["slug"] as string;

  const hasFormat = data["format"] !== undefined;
  const hasOutputs = data["outputs"] !== undefined;
  if (hasFormat && hasOutputs) {
    return refuse(
      `pablo: ${path} has both "format" and "outputs"; "outputs" replaces "format" — remove "format" (or run \`pablo migrate outputs --project ${slug}\` on a marker with only "format")`,
      [path],
    );
  }

  let outputs: Outputs = {};
  let deprecated: string | undefined;
  if (hasFormat) {
    const format = data["format"];
    if (typeof format !== "string" || !(LEGACY_FORMATS as readonly string[]).includes(format)) {
      return refuse(
        `pablo: ${path} has unknown format ${JSON.stringify(format)} at "format" (supported: ${LEGACY_FORMATS.join(", ")}; "format" is deprecated, use "outputs")`,
        [path],
      );
    }
    outputs = { novel: { dir: NOVEL_DIR } };
    deprecated = formatDeprecation(path, slug);
  } else if (hasOutputs) {
    const read = readOutputs(data["outputs"], path);
    if (!read.ok) return read;
    outputs = read.outputs;
  }

  const policy = data["policy"];
  if (policy !== undefined && (typeof policy !== "string" || !POLICY_NAME.test(policy))) {
    return refuse(
      `pablo: ${path} has an invalid "policy" (${JSON.stringify(policy)}); it names a policy pablo ships, e.g. "historical-fiction"`,
      [path],
    );
  }

  const track = data["track"];
  if (track !== undefined && !isTrackId(track)) {
    return refuse(`pablo: ${path} has unknown track ${JSON.stringify(track)} at "track" (allowed: ${trackIds().join(", ")})`, [path]);
  }
  const realNames = data["realNames"];
  if (realNames !== undefined && typeof realNames !== "boolean") {
    return refuse(`pablo: ${path} has an invalid "realNames" (${JSON.stringify(realNames)}); it is true or false`, [path]);
  }
  const think = data["think"];
  if (think !== undefined && typeof think !== "boolean") {
    return refuse(`pablo: ${path} has an invalid "think" (${JSON.stringify(think)}); it is true or false`, [path]);
  }
  const workKey = workKeyRefusal(data["providers"], path);
  if (workKey !== undefined) return workKey;

  const marker: Marker = {
    title: data["title"] as string,
    slug,
    author: typeof data["author"] === "string" ? (data["author"] as string) : DEFAULT_AUTHOR,
    voice: Array.isArray(data["voice"]) ? (data["voice"] as string[]) : DEFAULT_VOICE,
    neverSend: Array.isArray(data["neverSend"]) ? (data["neverSend"] as string[]) : DEFAULT_NEVER_SEND,
    publish: isObject(data["publish"]) ? data["publish"] : DEFAULT_PUBLISH,
    ...(policy === undefined ? {} : { policy }),
    ...(track === undefined ? {} : { track }),
    ...(realNames === undefined ? {} : { realNames }),
    ...(think === undefined ? {} : { think }),
    outputs,
  };

  if (deprecated !== undefined) {
    const key = resolve(path);
    if (!warned.has(key)) {
      warned.add(key);
      process.stderr.write(`${deprecated}\n`);
    }
    return { ok: true, marker, deprecated };
  }
  return { ok: true, marker };
}

/** A provider entry that sets `key` (any value, a reference included), as a refusal; the rest of `providers` is core's to validate. */
function workKeyRefusal(providers: unknown, path: string): Refusal | undefined {
  if (!isObject(providers)) return undefined;
  for (const [id, entry] of Object.entries(providers)) {
    try {
      refuseWorkKey(id, entry, path);
    } catch (error) {
      return refuse((error as Error).message, [path]);
    }
  }
  return undefined;
}

/** Writes `marker` as `<workDir>/pablo.json`, pretty-printed with a trailing newline. */
export function writeMarker(workDir: string, marker: Marker): void {
  writeFileSync(markerPath(workDir), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}
