/**
 * Where a work keeps the files whose names changed with the story-core
 * migration (`pablo migrate outputs`, AGT-1666; pm project
 * `pablo-story-core`). Every reader resolves through here, so a migrated
 * work and an unmigrated one both read correctly:
 *
 *     beats      outline/beats.md                 (migrated)
 *                outline/chapters.md              (unmigrated: the old name, shimmed)
 *     continuity outputs/novel/continuity.md      (migrated: the novel output's ledger)
 *                continuity.md                    (unmigrated)
 *
 * The new name wins whenever it exists; otherwise the old name is returned
 * whether or not it exists, so a message about a missing file names the file
 * an unmigrated work (the vault templates' shape) would have.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** The beats file after migration, work-relative. */
export const BEATS_FILE = "outline/beats.md";
/** The beats file's old name, still read on an unmigrated work. */
export const LEGACY_BEATS_FILE = "outline/chapters.md";
/** The novel output's continuity ledger after migration, work-relative. */
export const NOVEL_CONTINUITY_FILE = "outputs/novel/continuity.md";
/** The continuity ledger's old place at the work root. */
export const LEGACY_CONTINUITY_FILE = "continuity.md";

/** The work-relative (forward-slash) path of the work's beats file. */
export function beatsFile(workRoot: string): string {
  return existsSync(join(workRoot, BEATS_FILE)) ? BEATS_FILE : LEGACY_BEATS_FILE;
}

/** The work-relative (forward-slash) path of the novel's continuity ledger. */
export function continuityFile(workRoot: string): string {
  return existsSync(join(workRoot, NOVEL_CONTINUITY_FILE)) ? NOVEL_CONTINUITY_FILE : LEGACY_CONTINUITY_FILE;
}
