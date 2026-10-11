/**
 * The novel output's units on disk and in git (AGT-1668, pm project
 * `pablo-story-core`): the one place outside the vault templates that names
 * the novel's artifact directory, `chapters/` at the work root (decided
 * 2026-10-10: nothing in an existing novel moves).
 *
 *     chapters/NN-<slug>.md     one unit (a chapter), NN zero-padded to two or more digits
 *     draft/chNN[-vK]           the branch a drafted chapter is committed on
 *
 * A leaf module: no imports from the rest of the cli, so the registry, the
 * marker, the machine and every verb can read it without an import cycle.
 * Everything else reaches these through `OUTPUTS.novel` (`../registry.ts`);
 * `test/outputs.test.ts` holds the rest of `packages/cli/src` to never
 * spelling `chapters/` itself.
 */

import { join } from "node:path";

/** The novel output's id in `pablo.json`'s `outputs` and in the registry. */
export const NOVEL_ID = "novel";

/** The novel output's units live in `chapters/` at the work root, always (decided 2026-10-10). */
export const NOVEL_DIR = "chapters";

/** The novel's publish targets, in the order `--target` lists them. Only `draft` is built so far. */
export const NOVEL_PUBLISH_TARGETS = ["draft", "review", "final"] as const;

/** A chapter file's name, `NN-*.md` (NN = 2+ digits); group 1 is the number. */
export const NOVEL_UNIT_FILE = /^(\d{2,})-.*\.md$/;

/**
 * A chapter file's path anywhere in a vault (`novels/<slug>/chapters/03-x.md`):
 * the only files that ever reach a reading repo (`share`, `read`, `notes pull`).
 * Every segment is a plain name, so the pattern itself refuses `..`.
 */
export const NOVEL_UNIT_PATH = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*chapters\/[^/]+\.md$/;

/** The absolute directory the novel's units live in. */
export function novelUnitDir(workDir: string): string {
  return join(workDir, NOVEL_DIR);
}

/** lowercase, non-alphanumerics collapsed to one `-`, leading/trailing `-` trimmed. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `NN-<slug>.md`, `NN` zero-padded to at least two digits: the name `NOVEL_UNIT_FILE` matches. */
export function novelUnitFileName(chapter: number, beatTitle: string): string {
  return `${String(chapter).padStart(2, "0")}-${slugify(beatTitle)}.md`;
}

/** The chapter number a (repo- or work-relative) path names (`.../chapters/03-the-well.md` is 3), or undefined. */
export function novelUnitOfPath(path: string): number | undefined {
  const m = path.match(/(?:^|\/)chapters\/(\d+)-[^/]*\.md$/);
  return m ? Number(m[1]) : undefined;
}

/** The base draft branch for a chapter: `draft/chNN`. A re-draft adds `-vK` (`write.ts`). */
export function novelBranch(chapter: number): string {
  return `draft/ch${String(chapter).padStart(2, "0")}`;
}

/** `draft/ch05` or `draft/ch05-v2` -> 5; undefined for any other branch. */
export function novelUnitOfBranch(branch: string): number | undefined {
  const m = branch.match(/^draft\/ch(\d+)(?:-v\d+)?$/);
  return m ? Number(m[1]) : undefined;
}

/** How a draft branch is spelled in messages and usage lines. */
export const NOVEL_BRANCH_PATTERN = "draft/chNN";
