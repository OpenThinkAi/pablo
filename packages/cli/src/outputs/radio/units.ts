/**
 * The radio output's units on disk and in git (AGT-1686, pm project
 * `pablo-casting`): one episode per unit, a script in the output's own
 * directory, its casting state beside it.
 *
 *     outputs/radio/episodes/NN-<slug>.md      one unit (an episode's script)
 *     outputs/radio/casting/                   cast.json, flags.json, renders/epNN/, takes/ (pablo-casting)
 *     draft/radio-epNN[-vK]                    the branch a drafted episode is committed on
 *
 * A leaf module, like `../novel/units.ts`: no imports from the rest of the
 * cli, so the registry and every reader of the casting state can use it
 * without an import cycle.
 */

/** The radio output's id in `pablo.json`'s `outputs` and in the registry. */
export const RADIO_ID = "radio";

/** Where the episode scripts land, work-relative. */
export const RADIO_DIR = "outputs/radio/episodes";

/** The work's casting state for its radio output, work-relative (`binding.py`'s `casting_dir`). */
export const RADIO_CASTING_DIR = "outputs/radio/casting";

/**
 * The radio output's publish targets, in the order `--target` lists them.
 * `bundle` (the episodes' scripts, mixed audio and manifests in one
 * directory) is built; `player` is the review player (`pablo review`), and
 * `stream` is the progressive render (AGT-1697): mixed episodes to the listening directory.
 */
export const RADIO_PUBLISH_TARGETS = ["bundle", "player", "stream"] as const;

/** An episode script's name, `NN-*.md`; group 1 is the number. */
export const RADIO_UNIT_FILE = /^(\d{2,})-.*\.md$/;

/** lowercase, non-alphanumerics collapsed to one `-`, leading/trailing `-` trimmed. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `NN-<slug>.md`, `NN` zero-padded to at least two digits. */
export function radioUnitFileName(episode: number, title: string): string {
  const slug = slugify(title);
  return `${String(episode).padStart(2, "0")}-${slug === "" ? "episode" : slug}.md`;
}

/** The episode a (repo- or work-relative) path names (`.../outputs/radio/episodes/03-x.md` is 3), or undefined. */
export function radioUnitOfPath(path: string): number | undefined {
  const m = /(?:^|\/)outputs\/radio\/episodes\/(\d+)-[^/]*\.md$/.exec(path);
  return m ? Number(m[1]) : undefined;
}

/** `epNN`, the episode's tag in branch names, render directories and the ledger. */
export function episodeTag(episode: number): string {
  return `ep${String(episode).padStart(2, "0")}`;
}

/** The base draft branch for an episode: `draft/radio-epNN`. A re-draft adds `-vK` (`write.ts`). */
export function radioBranch(episode: number): string {
  return `draft/radio-${episodeTag(episode)}`;
}

/** `draft/radio-ep05` or `draft/radio-ep05-v2` -> 5; undefined for any other branch. */
export function radioUnitOfBranch(branch: string): number | undefined {
  const m = /^draft\/radio-ep(\d+)(?:-v\d+)?$/.exec(branch);
  return m ? Number(m[1]) : undefined;
}
