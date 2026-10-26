/**
 * The screenplay output's units on disk and in git (AGT-2132, pm project
 * `pablo-platform`, D-7): a screenplay stored as Fountain, one scene per
 * unit, planned from the core beats.
 *
 *     outputs/screenplay/scenes/NN-<slug>.fountain   one unit (a scene, Fountain, with pablo's frontmatter)
 *     draft/screenplay-scNN[-vK]                     the branch a drafted scene is committed on
 *
 * A leaf module, like `../radio/units.ts`: no imports from the rest of the
 * cli, so the registry and the check can use it without an import cycle.
 */

/** The screenplay output's id in `pablo.json`'s `outputs` and in the registry. */
export const SCREENPLAY_ID = "screenplay";

/** Where the scenes land, work-relative. */
export const SCREENPLAY_DIR = "outputs/screenplay/scenes";

/** A unit file's extension: Fountain, the plain-text screenplay format. */
export const FOUNTAIN_EXT = ".fountain";

/** The screenplay's publish targets: `fountain`, every scene in order as one Fountain file with a title page. */
export const SCREENPLAY_PUBLISH_TARGETS = ["fountain"] as const;

/** A scene file's name, `NN-*.fountain`; group 1 is the number. */
export const SCREENPLAY_UNIT_FILE = /^(\d{2,})-.*\.fountain$/;

/** lowercase, non-alphanumerics collapsed to one `-`, leading/trailing `-` trimmed. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `NN-<slug>.fountain`, `NN` zero-padded to at least two digits. */
export function screenplayUnitFileName(scene: number, title: string): string {
  const slug = slugify(title);
  return `${String(scene).padStart(2, "0")}-${slug === "" ? "scene" : slug}${FOUNTAIN_EXT}`;
}

/** The scene a (repo- or work-relative) path names (`.../outputs/screenplay/scenes/03-x.fountain` is 3), or undefined. */
export function screenplayUnitOfPath(path: string): number | undefined {
  const m = /(?:^|\/)outputs\/screenplay\/scenes\/(\d+)-[^/]*\.fountain$/.exec(path);
  return m ? Number(m[1]) : undefined;
}

/** `scNN`, the scene's tag in branch names and notes. */
export function sceneTag(scene: number): string {
  return `sc${String(scene).padStart(2, "0")}`;
}

/** The base draft branch for a scene: `draft/screenplay-scNN`. A re-draft adds `-vK` (`write.ts`). */
export function screenplayBranch(scene: number): string {
  return `draft/screenplay-${sceneTag(scene)}`;
}

/** `draft/screenplay-sc05` or `draft/screenplay-sc05-v2` -> 5; undefined for any other branch. */
export function screenplayUnitOfBranch(branch: string): number | undefined {
  const m = /^draft\/screenplay-sc(\d+)(?:-v\d+)?$/.exec(branch);
  return m ? Number(m[1]) : undefined;
}
