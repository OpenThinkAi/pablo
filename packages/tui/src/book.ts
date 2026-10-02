// Book mode's table of contents: the novel stage machine as rail rows. The stages themselves (what is ready, missing
// or drafted, and why) come from pablo's CLI package, which owns the machine (`readNovelState`, `chapterPreconditions`);
// this package cannot import it (the CLI imports this one), so it takes the result as plain data and only lays it out.

export type StageStatus = "ready" | "missing" | "drafted";

/** One stage of the book: premise, bible, acts, beats, the chapters group, each chapter. `missing` is `status`'s reasons. */
export interface BookStage {
  readonly id: string;
  readonly name: string;
  readonly depth: number;
  readonly group?: boolean;
  readonly status: StageStatus;
  readonly missing: readonly string[];
}

export const MARKS: Readonly<Record<StageStatus, string>> = { ready: "✓", missing: "✗", drafted: "●" };

export interface BookRail {
  readonly rows: readonly { readonly id: string; readonly depth: number; readonly group?: boolean }[];
  readonly labels: Readonly<Record<string, string>>;
  /** The reasons a stage that is not ready cannot be started, by row id; the content area shows them when the cursor lands on it. */
  readonly missing: Readonly<Record<string, readonly string[]>>;
  /** Groups that start folded: the chapters, until → opens them. */
  readonly folded: readonly string[];
}

export function bookRail(stages: readonly BookStage[]): BookRail {
  const labels: Record<string, string> = {};
  const missing: Record<string, readonly string[]> = {};
  for (const s of stages) {
    labels[s.id] = `${MARKS[s.status]} ${s.name}`;
    if (s.status === "missing" && s.missing.length > 0) missing[s.id] = s.missing;
  }
  return {
    rows: stages.map((s) => ({ id: s.id, depth: s.depth, ...(s.group ? { group: true } : {}) })),
    labels,
    missing,
    folded: stages.filter((s) => s.group).map((s) => s.id),
  };
}

/** What the content area shows for a stage that is not ready. */
export const missingContent = (name: string, reasons: readonly string[]) =>
  ({ kind: "missing", title: `Not ready: ${name}`, body: reasons.map((r) => `- ${r}`).join("\n") });
