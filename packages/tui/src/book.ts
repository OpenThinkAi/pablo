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
  /** The output this row belongs to (`novel`, `radio`): its group row and each of its units. Absent on a core stage. */
  readonly output?: string;
  /** A unit row's number within its output (`radio › 3` is `output: "radio", unit: 3`). */
  readonly unit?: number;
  /** A drafted unit row's file (work-relative) and how it is stored (`sentences` joins lines into paragraphs; `lines` keeps them line for line). */
  readonly file?: string;
  readonly storage?: Storage;
}

/** How a unit's text is stored: one sentence per line (read as paragraphs), or line for line (a radio script). */
export type Storage = "sentences" | "lines" | "screenplay";

/** The file behind a unit row and its storage mode, from the rail. */
export interface UnitRef { readonly file: string; readonly storage: Storage }

/** The output unit `a w` writes: what `write --output <output> --unit <unit>` takes. */
export interface WriteTarget { readonly output: string; readonly unit: number }

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
  /** The output a row belongs to (its group row or one of its units), by row id; core stages have none. */
  readonly outputOf: Readonly<Record<string, string>>;
  /** The unit each unit row writes, by row id. A `chapter:N` row with no output named is the novel's chapter N. */
  readonly targets: Readonly<Record<string, WriteTarget>>;
  /** The file and storage mode of each drafted unit row, by row id. */
  readonly units: Readonly<Record<string, UnitRef>>;
  /** Units drafted of the total, per output: the status line's progress while the cursor is in that output. */
  readonly counts: Readonly<Record<string, { readonly drafted: number; readonly total: number }>>;
}

export function bookRail(stages: readonly BookStage[]): BookRail {
  const labels: Record<string, string> = {};
  const missing: Record<string, readonly string[]> = {};
  const waiting: Record<string, string> = {};
  const outputOf: Record<string, string> = {};
  const targets: Record<string, WriteTarget> = {};
  const units: Record<string, UnitRef> = {};
  for (const s of stages) {
    if (s.file !== undefined) units[s.id] = { file: s.file, storage: s.storage ?? "sentences" };
    const legacy = /^chapter:(\d+)$/.exec(s.id)?.[1];
    if (s.output !== undefined) outputOf[s.id] = s.output;
    if (s.unit !== undefined && s.output !== undefined) targets[s.id] = { output: s.output, unit: s.unit };
    else if (legacy !== undefined) targets[s.id] = { output: s.output ?? "novel", unit: Number(legacy) };
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
    outputOf,
    targets,
    units,
    counts: Object.fromEntries([...new Set(Object.values(outputOf))].map((o) => [o, bookCounts(stages, o)])),
  };
}

/** What `a w` on row `rowId` writes, or undefined when the row is a core stage or an output's group row. Pure. */
export const writeRequest = (book: BookRail, rowId: string | undefined): WriteTarget | undefined => (rowId === undefined ? undefined : book.targets[rowId]);

/** The `pablo write` arguments that request means: `write --output radio --unit 3`. */
export const writeArgv = (t: WriteTarget): string[] => ["write", "--output", t.output, "--unit", String(t.unit)];

/** The status area's progress: units drafted of the total (every unit row), of one output when `output` is given. */
export const bookCounts = (stages: readonly BookStage[], output?: string): { drafted: number; total: number } => {
  const units = stages.filter((s) => s.depth > 0 && (output === undefined || s.output === output));
  return { drafted: units.filter((s) => s.status === "drafted").length, total: units.length };
};

/** What the content area shows for a stage that is not ready. */
export const missingContent = (name: string, reasons: readonly string[]) =>
  ({ kind: "missing", title: `Not ready: ${name}`, body: reasons.map((r) => `- ${r}`).join("\n") });

/** What the main pane says for a chapter row (`chapter:3`) whose draft is waiting on `branch`, in place of the missing-file notice. */
export const waitingDoc = (id: string, branch: string): MainDoc => {
  const n = id.replace(/^chapter:/, "");
  return { title: `chapter ${n}`, text: `The draft of chapter ${n} is waiting for review on ${branch}.\n\nPress Enter on this row to open its review.` };
};
