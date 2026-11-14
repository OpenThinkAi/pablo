/**
 * Change-branch names are per work (AGT-2292): `draft/<slug>/story`, `plan/<slug>/<date>-<id>`,
 * `edit/<slug>/<id>`, `revise/<slug>/<id>`. A vault is one git repository holding several works, so the work slug
 * keeps one work's branches (and their `-vK` numbering) from colliding with another's. Branches made before
 * AGT-2292 carry no slug (`draft/story`, `plan/<date>-<id>`); they are still read, never renamed.
 *
 * Pure string helpers with no imports, so output types and the branch layer can both use them.
 */

/** `<kind>/<slug>/<rest>`: the name a new change branch gets. `rest` is the part after the kind (`story`, `ch03`, `2026-11-14-ab12cd`). */
export function scopedBranch(kind: string, slug: string, rest: string): string {
  return `${kind}/${slug}/${rest}`;
}

/** `draft/story` + slug `crowns` -> `draft/crowns/story`: scopes an output's unscoped base branch (`OutputDefinition.branch`) to the work. */
export function scopeBase(base: string, slug: string): string {
  const i = base.indexOf("/");
  return i < 0 ? base : scopedBranch(base.slice(0, i), slug, base.slice(i + 1));
}

/** The work slug a branch is scoped to (`draft/crowns/story` -> `crowns`), or undefined for a pre-AGT-2292 branch (`draft/story`). */
export function branchWork(branch: string): string | undefined {
  const parts = branch.split("/");
  return parts.length >= 3 ? parts[1] : undefined;
}

/** The branch without its work segment (`draft/crowns/story-v2` -> `draft/story-v2`); an unscoped name is returned as is. */
export function unscopedBranch(branch: string): string {
  const parts = branch.split("/");
  return parts.length >= 3 ? [parts[0], ...parts.slice(2)].join("/") : branch;
}

/** True when `branch` may be listed for the work `slug`: it is scoped to that work, or is an unscoped (older) name. */
export function branchBelongsTo(branch: string, slug: string): boolean {
  const work = branchWork(branch);
  return work === undefined || work === slug;
}
