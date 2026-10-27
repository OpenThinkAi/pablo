/**
 * The essay output's units on disk and in git (AGT-2134, pm project
 * `pablo-platform`, D-7): every unit is a section of one file.
 *
 *     outputs/essay/essay.md     the essay: one `## <section title>` per unit
 *     draft/essay-NN[-vK]        the branch a drafted section is committed on
 *
 * A path names a file, not a section, so `essay.md` as a whole reads as unit
 * 1 (the section it opens with); a verb that needs one section's text goes
 * through the definition's `shared` and `unitText` (`./sections.ts`).
 *
 * A leaf module, like `../story/units.ts`: no imports from the rest of the cli.
 */

/** The essay output's id in `pablo.json`'s `outputs` and in the registry. */
export const ESSAY_ID = "essay";

/** The essay's artifact directory, work-relative. */
export const ESSAY_DIR = "outputs/essay";

/** The one file every section lives in, inside `ESSAY_DIR`. */
export const ESSAY_FILE = "essay.md";

/** The essay's publish targets, in the order `--target` lists them. */
export const ESSAY_PUBLISH_TARGETS = ["draft", "final"] as const;

/** Every section's file name: always `essay.md`, whatever the section is called. */
export function essayUnitFileName(_unit: number, _title: string): string {
  return ESSAY_FILE;
}

/** 1 for `.../outputs/essay/essay.md` (the file opens with section 1), undefined for any other path. */
export function essayUnitOfPath(path: string): number | undefined {
  return /(?:^|\/)outputs\/essay\/essay\.md$/.test(path) ? 1 : undefined;
}

/** The base draft branch for a section: `draft/essay-NN`. A re-draft adds `-vK` (`write.ts`). */
export function essayBranch(unit: number): string {
  return `draft/essay-${String(unit).padStart(2, "0")}`;
}

/** `draft/essay-03` or `draft/essay-03-v2` -> 3; undefined for any other branch. */
export function essayUnitOfBranch(branch: string): number | undefined {
  const m = /^draft\/essay-(\d+)(?:-v\d+)?$/.exec(branch);
  return m ? Number(m[1]) : undefined;
}
