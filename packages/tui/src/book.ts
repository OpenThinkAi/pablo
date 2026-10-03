// Book mode's table of contents: the novel stage machine as rail rows. The stages themselves (what is ready, missing
// or drafted, and why) come from pablo's CLI package, which owns the machine (`readNovelState`, `chapterPreconditions`);
// this package cannot import it (the CLI imports this one), so it takes the result as plain data and only lays it out.

import type { MainDoc } from "./document";

export type StageStatus = "ready" | "missing" | "drafted" | "waiting";

/** One stage of the book: premise, bible, acts, beats, the chapters group, each chapter. `missing` is `status`'s reasons. */
export interface BookStage {
  readonly id: string;
  readonly name: string;
  readonly depth: number;
  readonly group?: boolean;
  readonly status: StageStatus;
  readonly missing: readonly string[];
  /** A `waiting` stage: the change branch holding its draft (no file on `main` yet); Enter on its row opens that branch in review. */
  readonly branch?: string;
}

export const MARKS: Readonly<Record<StageStatus, string>> = { ready: "✓", missing: "✗", drafted: "●", waiting: "◆" };

export interface BookRail {
  readonly rows: readonly { readonly id: string; readonly depth: number; readonly group?: boolean; /** The branch Enter opens in review (a chapter whose draft is waiting on it). */ readonly opens?: string }[];
  readonly labels: Readonly<Record<string, string>>;
  /** The reasons a stage that is not ready cannot be started, by row id; the content area shows them when the cursor lands on it. */
  readonly missing: Readonly<Record<string, readonly string[]>>;
  /** The branch waiting for review behind a `waiting` stage, by row id; the main pane says so instead of "no draft yet". */
  readonly waiting: Readonly<Record<string, string>>;
  /** Groups that start folded: the chapters, until → opens them. */
  readonly folded: readonly string[];
}

export function bookRail(stages: readonly BookStage[]): BookRail {
  const labels: Record<string, string> = {};
  const missing: Record<string, readonly string[]> = {};
  const waiting: Record<string, string> = {};
  for (const s of stages) {
    labels[s.id] = `${MARKS[s.status]} ${s.name}${s.status === "waiting" ? " · draft waiting for review" : ""}`;
    if (s.status === "waiting" && s.branch !== undefined) waiting[s.id] = s.branch;
    if (s.status === "missing" && s.missing.length > 0) missing[s.id] = s.missing;
  }
  return {
    rows: stages.map((s) => ({ id: s.id, depth: s.depth, ...(s.group ? { group: true } : {}), ...(s.status === "waiting" && s.branch !== undefined ? { opens: s.branch } : {}) })),
    labels,
    missing,
    waiting,
    folded: stages.filter((s) => s.group).map((s) => s.id),
  };
}

/** What the content area shows for a stage that is not ready. */
export const missingContent = (name: string, reasons: readonly string[]) =>
  ({ kind: "missing", title: `Not ready: ${name}`, body: reasons.map((r) => `- ${r}`).join("\n") });

/** What the main pane says for a chapter row (`chapter:3`) whose draft is waiting on `branch`, in place of the missing-file notice. */
export const waitingDoc = (id: string, branch: string): MainDoc => {
  const n = id.replace(/^chapter:/, "");
  return { title: `chapter ${n}`, text: `The draft of chapter ${n} is waiting for review on ${branch}.\n\nPress Enter on this row to open its review.` };
};
