/**
 * The story output's one unit on disk and in git (AGT-1689, pm project
 * `pablo-story-core`): the whole story is a single unit, number 1, in a file
 * of its own inside the output's directory.
 *
 *     outputs/story/story.md    the unit
 *     draft/story[-vK]          the branch a drafted story is committed on
 *
 * A leaf module, like `../novel/units.ts`: no imports from the rest of the cli.
 */

/** The story output's id in `pablo.json`'s `outputs` and in the registry. */
export const STORY_ID = "story";

/** The story's artifact directory, work-relative. */
export const STORY_DIR = "outputs/story";

/** The one unit's file name inside `STORY_DIR`. */
export const STORY_FILE = "story.md";

/** The story is one unit; this is its number. */
export const STORY_UNIT = 1;

/** The story's publish targets, in the order `--target` lists them. Only `draft` is built so far. */
export const STORY_PUBLISH_TARGETS = ["draft", "review", "final"] as const;

/** The unit's file name: always `story.md`, whatever the beat is called. */
export function storyUnitFileName(_unit: number, _title: string): string {
  return STORY_FILE;
}

/** 1 for `.../outputs/story/story.md`, undefined for any other path. */
export function storyUnitOfPath(path: string): number | undefined {
  return /(?:^|\/)outputs\/story\/story\.md$/.test(path) ? STORY_UNIT : undefined;
}

/** The base draft branch: `draft/story`. A re-draft adds `-vK` (`write.ts`). */
export function storyBranch(_unit: number): string {
  return "draft/story";
}

/** `draft/story` or `draft/story-v2` -> 1; undefined for any other branch. */
export function storyUnitOfBranch(branch: string): number | undefined {
  return /^draft\/story(?:-v\d+)?$/.test(branch) ? STORY_UNIT : undefined;
}
