/**
 * The narrated output's units on disk and in git (AGT-2137, pm project
 * `pablo-platform`, D-7): one reading per unit of the source output it is
 * derived from, a `lines` script in the output's own directory.
 *
 *     outputs/narrated/readings/NN-<slug>.md   one unit (a reading's script)
 *     draft/narrated-NN[-vK]                   the branch a narrated unit is committed on
 *
 * A leaf module, like `../radio/units.ts`: no imports from the rest of the cli.
 */

/** The narrated output's id in `pablo.json`'s `outputs` and in the registry. */
export const NARRATED_ID = "narrated";

/** Where the readings land, work-relative. */
export const NARRATED_DIR = "outputs/narrated/readings";

/** The narrated output's publish targets. `script` compiles every reading's script into one file; the audio targets come with the mixer (W8). */
export const NARRATED_PUBLISH_TARGETS = ["script"] as const;

/** What `--voices` takes: one narrator for everything (the default), or speaker lines for quoted dialogue too. */
export const NARRATED_VOICES = ["narrator", "characters"] as const;
export type NarratedVoices = (typeof NARRATED_VOICES)[number];

export function isNarratedVoices(value: string): value is NarratedVoices {
  return (NARRATED_VOICES as readonly string[]).includes(value);
}

/** lowercase, non-alphanumerics collapsed to one `-`, leading/trailing `-` trimmed. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `NN-<slug>.md`, `NN` zero-padded to at least two digits. */
export function narratedUnitFileName(unit: number, title: string): string {
  const slug = slugify(title);
  return `${String(unit).padStart(2, "0")}-${slug === "" ? "reading" : slug}.md`;
}

/** The unit a (repo- or work-relative) path names (`.../outputs/narrated/readings/03-x.md` is 3), or undefined. */
export function narratedUnitOfPath(path: string): number | undefined {
  const m = /(?:^|\/)outputs\/narrated\/readings\/(\d+)-[^/]*\.md$/.exec(path);
  return m ? Number(m[1]) : undefined;
}

/** The base draft branch for a reading: `draft/narrated-NN`. A re-draft adds `-vK` (`write.ts`). */
export function narratedBranch(unit: number): string {
  return `draft/narrated-${String(unit).padStart(2, "0")}`;
}

/** `draft/narrated-05` or `draft/narrated-05-v2` -> 5; undefined for any other branch. */
export function narratedUnitOfBranch(branch: string): number | undefined {
  const m = /^draft\/narrated-(\d+)(?:-v\d+)?$/.exec(branch);
  return m ? Number(m[1]) : undefined;
}
