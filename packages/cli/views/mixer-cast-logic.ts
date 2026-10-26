/**
 * The Cast panel's pure helpers (AGT-2157): which library voices a role may be given, and what the panel offers after
 * a rebind. No React, no IO; `mixer-cast.tsx` draws them and `test/mixer-cast.test.tsx` holds them.
 */

import type { BindPayload, CastRole, LibraryVoice } from "./mixer-cast-protocol";

/** The voices a role can be auditioned on and bound to: cast cards that are not retired, by slug. */
export function bindableVoices(voices: readonly LibraryVoice[]): LibraryVoice[] {
  return voices.filter((v) => v.cast && v.retired !== true).sort((a, b) => a.slug.localeCompare(b.slug));
}

/** The voice the role's pickers start on: its bound voice when that is bindable, else the first bindable one. */
export function initialVoice(role: CastRole, voices: readonly LibraryVoice[]): string | undefined {
  const bound = role.voice?.slug;
  if (bound !== undefined && voices.some((v) => v.slug === bound)) return bound;
  return voices[0]?.slug;
}

/** A role's default slug for a newly designed voice: the role lowercased, as `pablo audition` makes it. */
export function defaultSlug(role: string): string {
  return role.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "voice";
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** What the panel offers once a role's lines were performed in another voice than its binding: null for nothing. */
export function reperformOffer(role: CastRole): string | null {
  if (role.voice === null || role.stale.length === 0) return null;
  return `${plural(role.stale.length, "line")} of ${role.role} ${role.stale.length === 1 ? "was" : "were"} performed in another voice than ${role.voice.slug}. Re-perform ${role.stale.length === 1 ? "it" : "them"}?`;
}

/** The status line after a bind. */
export function bindMessage(bound: BindPayload): string {
  const was = bound.replaced !== null && bound.replaced !== bound.slug ? ` (was ${bound.replaced})` : "";
  return `${bound.role} is bound to ${bound.slug}${was} in every episode.`;
}

/** A line's label in the line picker: its number and the start of its words. */
export function lineLabel(i: number, text: string, width = 48): string {
  const words = text.length > width ? `${text.slice(0, width - 1).trimEnd()}…` : text;
  return `${i + 1}. ${words}`;
}

/** A traits block as one short phrase (`f, 40s, warm`). */
export function traitsPhrase(traits: Readonly<Record<string, unknown>>): string {
  return Object.entries(traits)
    .filter(([, v]) => typeof v === "string" || typeof v === "number")
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(", ");
}
