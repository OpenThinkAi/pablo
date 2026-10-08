// Book mode's Reviews group (AGT-1640): the work's reading rounds that are still with a reader or have a review in,
// as rail rows, and what the main pane says for each. Pure over the rounds the layer above polls; a round that has been
// pulled is a `reader/` branch by then and is listed with the other branches instead.

import type { MainDoc } from "./document";
import { ROUND_ROW, type RailRow, type Round } from "./state";

/** The Reviews group's own row id. */
export const REVIEWS_GROUP = "reviews";

/** "ch 3", "ch 3, 4": the round's chapters as the rail names them. */
const chaptersOf = (r: Round) => (r.chapters.length === 0 ? "chapters" : `ch ${r.chapters.join(", ")}`);

/** The Reviews group and one row per round, or nothing when the work has no round out. */
export function roundRows(rounds: readonly Round[]): { rows: RailRow[]; labels: Record<string, string> } {
  if (rounds.length === 0) return { rows: [], labels: {} };
  const waiting = reviewsIn(rounds);
  const labels: Record<string, string> = { [REVIEWS_GROUP]: `reviews (${rounds.length})${waiting > 0 ? ` · ${waiting} in` : ""}` };
  const rows: RailRow[] = [{ id: REVIEWS_GROUP, depth: 0, group: true }];
  for (const r of rounds) {
    rows.push({ id: `${ROUND_ROW}${r.id}`, depth: 1 });
    labels[`${ROUND_ROW}${r.id}`] = `${r.status === "submitted" ? "● " : ""}${r.reader} · ${chaptersOf(r)} · ${r.status === "submitted" ? "review in" : "reading"}`;
  }
  return { rows, labels };
}

/** How many rounds have a review in, waiting to be pulled: the status area's count. */
export const reviewsIn = (rounds: readonly Round[]): number => rounds.filter((r) => r.status === "submitted").length;

/** The round a rail row id names, if it is a round row and the round is still listed. */
export const roundOf = (rounds: readonly Round[], id: string | undefined): Round | undefined =>
  id?.startsWith(ROUND_ROW) ? rounds.find((r) => `${ROUND_ROW}${r.id}` === id) : undefined;

/** What the main pane says for a round row: where the round stands and what Enter does. */
export function roundDoc(r: Round): MainDoc {
  const what = chaptersOf(r).replace(/^ch /, "chapter ");
  const text = r.status === "submitted"
    ? `${r.reader}'s review of ${what} is in.\n\nPress Enter to pull it and open the review: each suggestion is a change to accept or reject, and each comment sits on its line.`
    : `${what[0]!.toUpperCase()}${what.slice(1)} is with ${r.reader}.\n\nThis row changes when their review comes in; pablo checks GitHub every minute.`;
  return { title: `review · ${r.reader} · ${chaptersOf(r)}`, text };
}
