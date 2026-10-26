/**
 * The nonfiction core's files and parsers (AGT-2101, pm project `pablo-platform`,
 * D-5): a nonfiction work has no bible, acts or beats. Its core is
 *
 *     thesis     core/thesis.md has text
 *     research   a sourced note under research/ (required, as on historical-fiction)
 *     claims     core/claims.md has claim rows, each citing at least one
 *                research note id that resolves to a file under research/
 *     outline    core/outline.md has at least one section row
 *
 * A research note's id is its path under `research/` without `.md`
 * (`research/printing-press.md` is `printing-press`), the slug
 * `pablo research save` names it by.
 *
 * This module holds the nonfiction core's files and table parsers, pure and
 * with no I/O; the stages themselves are `machine.ts`'s (`coreStageIds` picks
 * `NONFICTION_CORE_STAGE_IDS` for the track, `coreStages` evaluates them and
 * `trackGate` gates `write` on them).
 */

/** The nonfiction core's files, work-relative. */
export const THESIS_FILE = "core/thesis.md";
export const CLAIMS_FILE = "core/claims.md";
export const OUTLINE_FILE = "core/outline.md";

/** One row of the claims table: `| # | Claim | Sources |`. */
export interface ClaimRow {
  readonly number: number;
  readonly claim: string;
  /** The research note ids the claim cites, normalised (no `research/`, no `.md`). */
  readonly sources: readonly string[];
}

/** One row of the outline table: `| # | Section | What it covers |`. */
export interface SectionRow {
  readonly number: number;
  readonly section: string;
  readonly summary: string;
}

/** `| a | b | c |` (leading/trailing pipes optional) -> `["a", "b", "c"]`, cells trimmed. */
function cellsOf(line: string): string[] {
  let inner = line.trim();
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);
  return inner.split("|").map((cell) => cell.trim());
}

function isSeparator(line: string): boolean {
  const cells = cellsOf(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** The data rows of the first table in `text` whose header's first cell is `#`. */
function numberedRows(text: string): string[][] {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((line, i) => line.trim().startsWith("|") && cellsOf(line)[0] === "#" && isSeparator(lines[i + 1] ?? ""));
  if (header === -1) return [];
  const rows: string[][] = [];
  for (let i = header + 2; i < lines.length && (lines[i] ?? "").trim().startsWith("|"); i++) {
    const cells = cellsOf(lines[i] ?? "");
    if (/^\d+$/.test(cells[0] ?? "") && Number(cells[0]) > 0) rows.push(cells);
  }
  return rows;
}

/** A cited source as a research note id: backticks, a `research/` prefix and a `.md` suffix are dropped. */
export function researchNoteId(raw: string): string {
  return raw
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/^research\//, "")
    .replace(/\.md$/, "");
}

/** A claim row's sources cell -> the ids it cites (comma, semicolon or space separated). */
export function parseSources(cell: string): string[] {
  return cell
    .split(/[,;\s]+/)
    .map(researchNoteId)
    .filter((id) => id !== "");
}

/** The claim rows of `text` (`core/claims.md`). */
export function parseClaims(text: string): ClaimRow[] {
  return numberedRows(text).map((cells) => ({ number: Number(cells[0]), claim: cells[1] ?? "", sources: parseSources(cells[2] ?? "") }));
}

/** The section rows of `text` (`core/outline.md`). */
export function parseSections(text: string): SectionRow[] {
  return numberedRows(text)
    .filter((cells) => (cells[1] ?? "") !== "")
    .map((cells) => ({ number: Number(cells[0]), section: cells[1] ?? "", summary: cells[2] ?? "" }));
}

/** True if `text` has a line of prose (anything that is not blank and not a `#` heading). */
export function hasProse(text: string): boolean {
  return text.split("\n").some((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
}
