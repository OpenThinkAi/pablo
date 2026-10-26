/**
 * The core files a new work starts with, per track (AGT-2103, pm project
 * `pablo-platform`, D-6): empty sections and table headers the track's core
 * stages fill, so a work created on a track (`pablo init --track`, `pablo
 * story --track`) has the shape its stage machine reads from the first
 * commit. No file here satisfies a stage on its own: a heading-only period
 * brief or thesis, and a table with only its header, read as missing.
 *
 * - `fiction`: the bible (overview, places, timeline, characters/), the
 *   beats file, `facts.md`, `research/` and `notes/`.
 * - `historical-fiction`: fiction's, plus the period brief
 *   (`bible/period.md`) and the period facts table (`facts/period.md`).
 * - `nonfiction`: no bible, acts or beats; the thesis, the claims table and
 *   the outline table under `core/`, `research/` and `notes/`.
 *
 * Paths are work-relative; `.keep` files hold otherwise-empty directories.
 */

import { CLAIMS_FILE, OUTLINE_FILE, THESIS_FILE } from "../core/nonfiction";
import type { TrackId } from "./registry";

/** `facts.md`'s header: what migration creates, and what the first promotion starts from on a work without one (AGT-1671). */
export const FACTS_TEXT = `# Facts

Facts every output of this work must honour: continuity an output established
that the author (or the harness, with the author) promoted to the story core.
Each fact names where it came from, e.g. \`established-by: novel/ch03\`.
Nothing lands here by itself; promotion is explicit.
`;

/** The fiction core: the bible, the beats file and `facts.md` (the shape `pablo story` has always scaffolded). */
const FICTION_CORE: Readonly<Record<string, string>> = {
  "bible/overview.md": "# Overview\n\n## Logline\n\n## Premise\n\n## Themes\n\n## Tone\n\n## Structure\n",
  "bible/places.md": "# Places\n",
  "bible/timeline.md": "# Timeline\n\n| Year | Real events | In the story |\n|---|---|---|\n",
  "bible/characters/.keep": "",
  "outline/beats.md": "# Outline\n",
  "facts.md": FACTS_TEXT,
  "research/.keep": "",
  "notes/.keep": "",
};

/**
 * What `historical-fiction` adds to the fiction core: the period brief its
 * `period` stage reads and the table `research distill` fills for
 * `period-facts` (D-5, D-10). Paths match `PERIOD_BRIEF_FILE` and
 * `PERIOD_FACTS_FILE` in `core/machine.ts`.
 */
const HISTORICAL_EXTRA: Readonly<Record<string, string>> = {
  "bible/period.md": "# Period\n\n## When and where\n\n## The events\n\n## What the story must be true to\n",
  "facts/period.md": "# Period facts\n\n| Fact | Source | Story date |\n|---|---|---|\n",
};

/** The nonfiction core (AGT-2101): thesis, claims (`| # | Claim | Sources |`) and outline (`| # | Section | What it covers |`). */
const NONFICTION_CORE: Readonly<Record<string, string>> = {
  [THESIS_FILE]: "# Thesis\n",
  [CLAIMS_FILE]: "# Claims\n\n| # | Claim | Sources |\n|---|---|---|\n",
  [OUTLINE_FILE]: "# Outline\n\n| # | Section | What it covers |\n|---|---|---|\n",
  "research/.keep": "",
  "notes/.keep": "",
};

/** Every core file a new work on `track` starts with, work-relative path to content. */
export function trackCoreFiles(track: TrackId): Record<string, string> {
  if (track === "nonfiction") return { ...NONFICTION_CORE };
  if (track === "historical-fiction") return { ...FICTION_CORE, ...HISTORICAL_EXTRA };
  return { ...FICTION_CORE };
}

/**
 * The core files `track` adds over the fiction core: what a fiction-shaped
 * scaffold (the vault's `templates/novel`) needs on top to be a work on
 * `track`. Empty for `fiction`; for `nonfiction` it is the whole nonfiction
 * core (it shares none of fiction's).
 */
export function trackExtraFiles(track: TrackId): Record<string, string> {
  if (track === "historical-fiction") return { ...HISTORICAL_EXTRA };
  if (track === "nonfiction") return { ...NONFICTION_CORE };
  return {};
}
