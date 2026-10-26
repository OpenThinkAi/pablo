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
 *                outputs/<type>/continuity.md     (every other output's own ledger, AGT-1671)
 *     facts      facts.md                         (the core's promoted facts, AGT-1671)
 *     rules      STYLE.md                         (the work's own rules, AGT-2141)
 *                QWEN.md                          (the old name, read as a fallback)
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
/**
 * The story core's promoted facts (pm project `pablo-story-core`, "Per-output
 * continuity"): facts one output established that every output must honour,
 * each naming its source (`established-by: novel/ch03`). Work-relative.
 */
export const FACTS_FILE = "facts.md";

/** The work-relative (forward-slash) path of the work's beats file. */
export function beatsFile(workRoot: string): string {
  return existsSync(join(workRoot, BEATS_FILE)) ? BEATS_FILE : LEGACY_BEATS_FILE;
}

/**
 * The work-relative (forward-slash) path of an output's own continuity ledger
 * (AGT-1671): what that telling established, read only by that output's packs
 * and critic. The novel's resolves through the migration shim
 * (`outputs/novel/continuity.md`, else the unmigrated `continuity.md`); every
 * other type's is `outputs/<type>/continuity.md`, whether or not it exists yet.
 */
export function continuityFile(workRoot: string, output = "novel"): string {
  if (output !== "novel") return outputContinuityFile(output);
  return existsSync(join(workRoot, NOVEL_CONTINUITY_FILE)) ? NOVEL_CONTINUITY_FILE : LEGACY_CONTINUITY_FILE;
}

/** `outputs/<type>/continuity.md`: the ledger's place for an output type, with no shim. Throws on an id that is not one. */
export function outputContinuityFile(output: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(output)) throw new RangeError(`pablo: "${output}" is not an output type id`);
  return `outputs/${output}/continuity.md`;
}

/** The work's own rules file (D-15): model-neutral, scaffolded into every new work. Work-relative. */
export const WORK_RULES_FILE = "STYLE.md";
/** The rules file's old name, still read when a work has no `STYLE.md` (`pablo migrate style` renames it). */
export const LEGACY_WORK_RULES_FILE = "QWEN.md";

/**
 * The work-relative name of the work's rules file: `STYLE.md` when it exists,
 * else `QWEN.md` when that exists, else `STYLE.md` (what a new work gets, and
 * what a message about a missing file should name).
 */
export function workRulesFile(workRoot: string): string {
  if (existsSync(join(workRoot, WORK_RULES_FILE))) return WORK_RULES_FILE;
  return existsSync(join(workRoot, LEGACY_WORK_RULES_FILE)) ? LEGACY_WORK_RULES_FILE : WORK_RULES_FILE;
}
