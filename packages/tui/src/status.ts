// The status area's second line: separate fields, each a dim label and its value, so nothing runs together. Pure, so
// the narrow widths are tested without drawing anything. Copied from prview's status.ts and adapted: pablo's fields
// are the format, the progress (chapters drafted of the total), the branch and the comment counts by kind.
//
// No field is cut to make room for another: when the line is too narrow, whole fields drop, in DROP_ORDER. The
// progress is never dropped (at a width too narrow even for it alone, the line is cut at the edge).

export interface Field { readonly key: "format" | "progress" | "branch" | "comments"; readonly label: string; readonly value: string; readonly color?: string }

/** The order fields leave a narrow line in: the branch first, then the comments, then the format. The progress stays. */
export const DROP_ORDER: readonly Field["key"][] = ["branch", "comments", "format"];
export const GAP = "   ";

/** What a comment is about: a continuity contradiction, a voice tell, a `check` hit. Kinds, not severities. */
export type CommentKind = "continuity" | "tells" | "check";
const KINDS: readonly CommentKind[] = ["continuity", "tells", "check"];

export interface StatusInput {
  readonly format: string;
  /** Chapters drafted of the book's total. */
  readonly drafted: number; readonly total: number;
  /** The git branch the screen is on (`main`, `draft/ch03`). */
  readonly branch: string;
  /** Comment counts by kind; absent or zero kinds are left out. */
  readonly comments: Partial<Record<CommentKind, number>>;
}

export function statusFields(s: StatusInput): Field[] {
  const out: Field[] = [{ key: "format", label: "", value: s.format }];
  out.push({ key: "progress", label: "ch", value: `${s.drafted} of ${s.total} drafted` });
  out.push({ key: "branch", label: "branch", value: s.branch });
  const counts = KINDS.filter((k) => s.comments[k]).map((k) => `${s.comments[k]} ${k}`);
  out.push({ key: "comments", label: "comments", value: counts.length ? `▲ ${counts.join(" · ")}` : "none", color: counts.length ? "yellow" : undefined });
  return out;
}

/** Columns a field takes: its label, a space (when there is a label), its value. */
export const fieldWidth = (f: Field): number => (f.label ? [...f.label].length + 1 : 0) + [...f.value].length;
const lineWidth = (fs: readonly Field[]) => fs.reduce((n, f) => n + fieldWidth(f), 0) + GAP.length * Math.max(0, fs.length - 1);

/** The fields that fit `width`, whole, dropping in DROP_ORDER until they do. */
export function fitFields(fields: readonly Field[], width: number): Field[] {
  let kept = [...fields];
  for (const k of DROP_ORDER) {
    if (lineWidth(kept) <= width) break;
    kept = kept.filter((f) => f.key !== k);
  }
  return kept;
}
