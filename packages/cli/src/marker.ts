/**
 * `pablo.json` — the project marker. Its presence (and shape) is what tells
 * an agent a directory is a pablo project and which format it follows; every
 * verb but `init` refuses when it is missing or malformed. See the design
 * doc's "The project" section (`~/saltline-digital-vault/projects/ai-terminal/README.md`)
 * for the canonical shape this mirrors.
 *
 * MARKER_SCHEMA — `pablo.json` fields:
 *
 * | key         | required | default                          |
 * |-------------|----------|----------------------------------|
 * | `format`    | yes      | —  ("novel" for P0; any other value is refused, naming it) |
 * | `title`     | yes      | —                                |
 * | `slug`      | yes      | —                                |
 * | `author`    | no       | `"matt"`                         |
 * | `voice`     | no       | `["../../style", "QWEN.md"]`     |
 * | `neverSend` | no       | `["research/", "notes/"]`        |
 * | `publish`   | no       | `{}`                              |
 *
 * A missing required key is refused by name (`message` names the exact key);
 * an unknown `format` is refused by name too. A directory with no `pablo.json`
 * at all is refused with a pointer at `pablo init --adopt --project <slug>`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Refusal } from "./project";

/** Formats pablo's stage machine understands. Only "novel" ships in P0. */
const SUPPORTED_FORMATS = ["novel"] as const;
export type Format = (typeof SUPPORTED_FORMATS)[number];

export const DEFAULT_AUTHOR = "matt";
export const DEFAULT_VOICE: readonly string[] = ["../../style", "QWEN.md"];
export const DEFAULT_NEVER_SEND: readonly string[] = ["research/", "notes/"];
export const DEFAULT_PUBLISH: Readonly<Record<string, unknown>> = {};

/** The typed shape of `pablo.json`. */
export interface Marker {
  readonly format: Format;
  readonly title: string;
  readonly slug: string;
  readonly author: string;
  readonly voice: readonly string[];
  readonly neverSend: readonly string[];
  readonly publish: Readonly<Record<string, unknown>>;
}

export interface MarkerFound {
  readonly ok: true;
  readonly marker: Marker;
}

export type MarkerResult = MarkerFound | Refusal;

function refuse(message: string, tried: readonly string[]): Refusal {
  return { ok: false, code: 2, message, tried };
}

export function markerPath(workDir: string): string {
  return join(workDir, "pablo.json");
}

/**
 * Reads and validates `<workDir>/pablo.json`. A missing file, invalid JSON,
 * a missing required key, or an unsupported `format` are all refusals (exit
 * code 2 everywhere in the CLI) rather than thrown errors, so callers can
 * relay `message` directly.
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

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return refuse(`pablo: ${path} must contain a JSON object`, [path]);
  }
  const data = raw as Record<string, unknown>;

  for (const key of ["format", "title", "slug"] as const) {
    if (typeof data[key] !== "string" || data[key] === "") {
      return refuse(`pablo: ${path} is missing required key "${key}"`, [path]);
    }
  }

  const format = data["format"] as string;
  if (!(SUPPORTED_FORMATS as readonly string[]).includes(format)) {
    return refuse(
      `pablo: ${path} has unknown format "${format}" (supported: ${SUPPORTED_FORMATS.join(", ")})`,
      [path],
    );
  }

  const marker: Marker = {
    format: format as Format,
    title: data["title"] as string,
    slug: data["slug"] as string,
    author: typeof data["author"] === "string" ? (data["author"] as string) : DEFAULT_AUTHOR,
    voice: Array.isArray(data["voice"]) ? (data["voice"] as string[]) : DEFAULT_VOICE,
    neverSend: Array.isArray(data["neverSend"]) ? (data["neverSend"] as string[]) : DEFAULT_NEVER_SEND,
    publish:
      typeof data["publish"] === "object" && data["publish"] !== null && !Array.isArray(data["publish"])
        ? (data["publish"] as Record<string, unknown>)
        : DEFAULT_PUBLISH,
  };

  return { ok: true, marker };
}

/** Writes `marker` as `<workDir>/pablo.json`, pretty-printed with a trailing newline. */
export function writeMarker(workDir: string, marker: Marker): void {
  writeFileSync(markerPath(workDir), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}
