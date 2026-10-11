/**
 * `radio.ts` (AGT-1680, pm project `pablo-casting`) — the radio-script side of
 * `check`, `status --for "episode N"` and `bind`.
 *
 * The script reader, the direction grammar, the described `CAST:` line and
 * `cast.json` live in the Python side (`packages/casting`), so there is one
 * parser, tested once. This file only decides *whether* a work has radio
 * scripts, asks the Python side (through the lazy runner in `casting.ts`) and
 * hands its body back as pablo's own. A writing-only work has no `CAST:` line,
 * so none of this runs for it: no `uv`, no venv, no provisioning.
 *
 * Where scripts live matches `packages/casting/src/pablo_casting/binding.py`:
 * `outputs/radio/episodes/` when the work has one, else the novel's chapter directory (the
 * sandbox drama, whose episode scripts are chapter files).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { castingState, ensureProvisioned, realCastingDeps, runPython, UV_INSTALL } from "./casting";
import { OUTPUTS } from "./outputs/registry";
import type { CastingContext, CastingDeps } from "./casting";
import type { VerbResult } from "./verbs";

/**
 * The one way the rest of the cli gets the real runner and its types: through here, so only a radio work reaches it.
 * The radio output type (`outputs/radio/casting-side.ts`, AGT-1686) reads the venv's state through `castingState`,
 * which only reads a stamp file.
 */
export { castingState, realCastingDeps, UV_INSTALL };
export type { CastingDeps };

const EPISODE_FILE = /^\d+-.*\.md$/;

/** The directory a work's episode scripts are read from. */
export function radioScriptDir(work: string): string {
  const episodes = join(work, "outputs", "radio", "episodes");
  return existsSync(episodes) ? episodes : join(work, OUTPUTS.novel.artifactDir);
}

/** Whether any `NN-*.md` in the script directory carries a `CAST:` line, i.e. the work has radio scripts. */
export function hasRadioScripts(work: string): boolean {
  const dir = radioScriptDir(work);
  if (!existsSync(dir)) return false;
  return readdirSync(dir)
    .filter((name) => EPISODE_FILE.test(name))
    .some((name) => /^\s*\**CAST:/im.test(readFileSync(join(dir, name), "utf8")));
}

/**
 * Parses `status --for`'s value into an episode number: `episode N`,
 * `episode-N`, `ep N`. A bare number is a chapter (`parseForChapter`), never
 * an episode.
 */
export function parseForEpisode(raw: string): number | undefined {
  const match = /^(?:episode|ep)[\s-]+(\d+)$/i.exec(raw.trim());
  return match === null ? undefined : Number(match[1]);
}

/** The vault's voice library, as the Python side wants it named: it appends `casting/voices` itself. */
function vaultArgs(vaultRoot: string): string[] {
  return ["--vault", vaultRoot];
}

/** Runs one Python command against a work, provisioning the side first when needed. */
function python(ctx: CastingContext, deps: CastingDeps, work: string, args: readonly string[]): VerbResult {
  const ready = ensureProvisioned(ctx, deps, work);
  if (!ready.ok) return ready.result;
  return runPython(ready.layout, deps, ctx, [...args, "--work", work]);
}

/**
 * The radio half of `pablo check`: unknown directions with line numbers and
 * the roles with no voice, per episode. `undefined` when the work has no
 * radio scripts (nothing to check, nothing provisioned).
 */
export function radioCheck(ctx: CastingContext, deps: CastingDeps, work: string): VerbResult | undefined {
  if (!hasRadioScripts(work)) return undefined;
  return python(ctx, deps, work, ["check"]);
}

/** `status --for "episode N"`: `{ready, missing}`, exit 2 while any role is unbound. */
export function radioStatus(ctx: CastingContext, deps: CastingDeps, work: string, episode: number): VerbResult {
  // No radio scripts at all: say so without provisioning the Python side.
  if (!hasRadioScripts(work)) {
    return { body: { ready: false, missing: [`episode ${episode} has no script (this work has no radio scripts)`], episode }, exitCode: 2 };
  }
  return python(ctx, deps, work, ["status", "--episode", String(episode)]);
}

/** `bind --role R --voice slug`: pin a role to a library voice (refuses an absent or retired one). */
export function radioBind(
  ctx: CastingContext,
  deps: CastingDeps,
  vaultRoot: string,
  work: string,
  args: { readonly role: string; readonly voice: string },
): VerbResult {
  return python(ctx, deps, work, ["bind", "--role", args.role, "--voice", args.voice, ...vaultArgs(vaultRoot)]);
}

/** Plain-text lines for the radio part of a `check` body. */
export function radioCheckLines(body: unknown): string[] {
  const {
    unknownDirections = [],
    offVocabulary = [],
    multipleDirections = [],
    undescribedRoles = [],
    unboundRoles = [],
  } = body as {
    unknownDirections?: { file: string; line: number; text: string; speaker: string; unknown: string[] }[];
    offVocabulary?: { file: string; line: number; text: string; speaker: string; mapped: Record<string, string>; ignored: string[] }[];
    multipleDirections?: { file: string; line: number; speaker: string; directions: string[] }[];
    undescribedRoles?: { file: string; episode: number; role: string }[];
    unboundRoles?: { file: string; episode: number; role: string }[];
  };
  return [
    ...unknownDirections.map((d) => `${d.file}:${d.line} unknown direction ${d.text} (${d.speaker}: ${d.unknown.join(", ")})`),
    ...offVocabulary.map((d) => {
      const fix = Object.entries(d.mapped).map(([from, to]) => `${from} -> ${to}`);
      return `${d.file}:${d.line} direction outside the vocabulary ${d.text} (${d.speaker}: ${[...fix, ...d.ignored.map((w) => `${w} is a sound, not a direction`)].join(", ")})`;
    }),
    ...multipleDirections.map((d) => `${d.file}:${d.line} more than one direction ${d.directions.join(" ")} (${d.speaker})`),
    ...undescribedRoles.map((r) => `${r.file} undescribed role: ${r.role} (add a description on the CAST: line)`),
    ...unboundRoles.map((r) => `${r.file} unbound role: ${r.role}`),
  ];
}
