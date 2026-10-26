/**
 * `pablo migrate track` (AGT-2104, pm project `pablo-platform`, D-6): writes
 * `track` into an existing work's `pablo.json` and commits exactly that file
 * on the vault's current branch, with a `Pablo-Migrate` trailer. A work with no
 * `track` reads as `fiction`; this is the one-step way to set the right one.
 *
 * Moving to a track whose core has stages the work's current track lacks
 * (fiction to `historical-fiction` adds `period` and `period-facts`) reports
 * those stages as `missingStages`: the work has not produced them yet.
 * Idempotent: a work already on `<track>` (explicitly) changes nothing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { gitCommit } from "./init";
import { markerPath, readMarker, trackOf } from "./marker";
import { dirtyPaths } from "./migrate";
import { isTrackId, TRACKS, trackIds, type TrackId } from "./tracks/registry";

export const MIGRATE_TRACK_COMMIT_TRAILER = "Pablo-Migrate: track";

export type MigrateTrackResult =
  | {
      readonly ok: true;
      readonly dryRun: boolean;
      /** The track the work read as before (`fiction` when `pablo.json` had none). */
      readonly from: TrackId;
      readonly track: TrackId;
      readonly changes: readonly { readonly op: "rewrite"; readonly path: string }[];
      readonly paths: readonly string[];
      readonly committed: boolean;
      /** Core stages of `track` that the previous track's core does not have, and the work has not produced. */
      readonly missingStages: readonly string[];
      readonly notice?: string;
    }
  | { readonly ok: false; readonly code: 2; readonly message: string };

function refuse(message: string): MigrateTrackResult {
  return { ok: false, code: 2, message: `pablo: migrate track: ${message}` };
}

/** `pablo.json` with `track` set, in place when already present, else appended; every other key as written. */
function rewrittenMarker(raw: Record<string, unknown>, track: TrackId): string {
  return `${JSON.stringify({ ...raw, track }, null, 2)}\n`;
}

export function migrateTrack(vaultRoot: string, projectPath: string, opts: { track: string | undefined; dryRun: boolean }): MigrateTrackResult {
  if (opts.track === undefined || opts.track === "") return refuse(`--track is required (one of: ${trackIds().join(", ")})`);
  if (!isTrackId(opts.track)) return refuse(`unknown track ${JSON.stringify(opts.track)} (allowed: ${trackIds().join(", ")})`);
  const track = opts.track;

  const found = readMarker(projectPath);
  if (!found.ok) return { ok: false, code: 2, message: found.message };
  const from = trackOf(found.marker);

  const path = markerPath(projectPath);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const fromCore = new Set<string>(TRACKS[from].coreStages);
  const missingStages = TRACKS[track].coreStages.filter((s) => !fromCore.has(s));

  const rel = relative(vaultRoot, path);
  const changed = raw["track"] !== track;
  const changes = changed ? [{ op: "rewrite" as const, path: "pablo.json" }] : [];
  const base = { ok: true as const, from, track, changes, paths: changes.map((c) => c.path), missingStages };
  if (opts.dryRun || !changed) return { ...base, dryRun: opts.dryRun, committed: false };

  const dirty = dirtyPaths(vaultRoot, [rel]);
  if (dirty.length > 0) {
    return refuse(`uncommitted changes in ${dirty.join(", ")}; commit or discard them first so the migration commit holds only the track`);
  }

  writeFileSync(path, rewrittenMarker(raw, track), "utf8");
  const { committed, notice } = gitCommit(vaultRoot, `migrate: track ${track}\n\n${MIGRATE_TRACK_COMMIT_TRAILER}=${track}`, [path]);
  return { ...base, dryRun: false, committed, ...(notice ? { notice } : {}) };
}
