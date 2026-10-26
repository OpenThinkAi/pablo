/**
 * The research checklist (AGT-2111, pm project `pablo-platform`, D-9): what a factual work still has to research,
 * derived from its period brief (historical-fiction) or its thesis (nonfiction) by `pablo research plan`, kept in
 * `research/checklist.md`. Research is guided: the research stage's gate passes only once every item is sourced or
 * waived, and `status`/`resume` list the items still open.
 *
 * The file is a markdown table, one item per row:
 *
 *     | # | Category | Item | Status | Sources | Waived |
 *     | 1 | people   | Who ran the Knickerbocker ice houses | sourced | knickerbocker | |
 *     | 2 | language | Ice-trade slang of the 1880s | waived | | the cutters never speak on the page |
 *
 * An item's status is worked out from its cells, never trusted from the Status cell (pablo writes that cell so the
 * file reads well, and refreshes it on every write):
 *
 *     waived    the Waived cell has a reason
 *     sourced   the Sources cell names at least one research note that exists and has a `## Sources` entry
 *     open      neither
 *
 * A note is named by its id, its path under `research/` without `.md` (the slug `pablo research save` gives it), as a
 * nonfiction claim cites it. This module is pure (no I/O): `machine.ts` reads the file and the notes.
 */

import { researchNoteId } from "./nonfiction";

/** The checklist, work-relative. It lives under `research/`, so it never reaches a drafting pack; it is not a note. */
export const CHECKLIST_FILE = "research/checklist.md";

/** The categories a period brief's checklist covers (historical-fiction), in the order they are listed. */
export const PERIOD_CATEGORIES = ["people", "places", "technology", "language", "daily-life", "politics", "dates"] as const;

/** A thesis's checklist (nonfiction) has one category: each item is a claim the work has to support. */
export const THESIS_CATEGORIES = ["claim"] as const;

export type ItemStatus = "open" | "sourced" | "waived";

/** One row of the checklist as written. */
export interface ChecklistRow {
  readonly number: number;
  readonly category: string;
  readonly item: string;
  /** Research note ids, normalised (no `research/`, no `.md`). */
  readonly sources: readonly string[];
  /** Why the item needs no research; set only on a waived item. */
  readonly waived?: string;
}

/** One row with its status worked out against the notes that exist. */
export interface ChecklistItem extends ChecklistRow {
  readonly status: ItemStatus;
}

/** A category as a model or an author may write it (`Daily life`, `daily_life`) -> its id (`daily-life`). */
export function categoryId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

/** The cells of one table row, honouring `\|` inside a cell. */
function cellsOf(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] as string;
    if (ch === "\\" && inner[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cell);
      cell = "";
    } else cell += ch;
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

function isSeparator(line: string): boolean {
  const cells = cellsOf(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** A Sources cell -> the note ids it names (comma, semicolon or space separated). */
function parseSourceIds(cell: string): string[] {
  return cell
    .split(/[,;\s]+/)
    .map(researchNoteId)
    .filter((id) => id !== "");
}

/**
 * The rows of the first table in `text` whose header's first cell is `#`. Columns are found by header name, so a
 * hand-edited file with its columns moved still reads; a row whose `#` is not a positive whole number is skipped.
 */
export function parseChecklist(text: string): ChecklistRow[] {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((line, i) => line.trim().startsWith("|") && cellsOf(line)[0] === "#" && isSeparator(lines[i + 1] ?? ""));
  if (header === -1) return [];
  const names = cellsOf(lines[header] ?? "").map((c) => c.toLowerCase());
  const col = (name: string, fallback: number): number => {
    const at = names.indexOf(name);
    return at >= 0 ? at : fallback;
  };
  const category = col("category", 1);
  const item = col("item", 2);
  const sources = col("sources", 4);
  const waived = col("waived", 5);
  const rows: ChecklistRow[] = [];
  for (let i = header + 2; i < lines.length && (lines[i] ?? "").trim().startsWith("|"); i++) {
    const cells = cellsOf(lines[i] ?? "");
    if (!/^\d+$/.test(cells[0] ?? "") || Number(cells[0]) <= 0) continue;
    const text = cells[item] ?? "";
    if (text === "") continue;
    const reason = cells[waived] ?? "";
    rows.push({
      number: Number(cells[0]),
      category: categoryId(cells[category] ?? ""),
      item: text,
      sources: parseSourceIds(cells[sources] ?? ""),
      ...(reason !== "" ? { waived: reason } : {}),
    });
  }
  return rows;
}

/** One row's status: waived (with a reason), sourced (names a sourced note in `sourcedNotes`), else open. Pure. */
export function itemStatus(row: ChecklistRow, sourcedNotes: ReadonlySet<string>): ItemStatus {
  if (row.waived !== undefined && row.waived.trim() !== "") return "waived";
  if (row.sources.some((id) => sourcedNotes.has(id))) return "sourced";
  return "open";
}

/** Every row with its status. */
export function checklistItems(rows: readonly ChecklistRow[], sourcedNotes: ReadonlySet<string>): ChecklistItem[] {
  return rows.map((row) => ({ ...row, status: itemStatus(row, sourcedNotes) }));
}

/** `#3 people: Who ran the ice houses`: how an item is named in status, resume and refusals. */
export function itemLabel(row: ChecklistRow): string {
  return `#${row.number} ${row.category}: ${row.item}`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

/** Where the checklist was derived from, for its header line. */
export type ChecklistOrigin = "period" | "thesis";

/** `research/checklist.md`'s content: a heading, what it is and how an item closes, then the table. Pure. */
export function renderChecklist(items: readonly ChecklistItem[], origin: ChecklistOrigin): string {
  const from = origin === "thesis" ? "the thesis (core/thesis.md): the claims the work has to support" : "the period brief (bible/period.md)";
  const rows = items.map(
    (i) => `| ${i.number} | ${escapeCell(i.category)} | ${escapeCell(i.item)} | ${i.status} | ${i.sources.map(escapeCell).join(", ")} | ${escapeCell(i.waived ?? "")} |`,
  );
  return [
    "# Research checklist",
    "",
    `Derived from ${from} by \`pablo research plan\`.`,
    "An item is sourced once Sources names a research note (its id: the path under research/ without .md) that has a ## Sources entry, " +
      "and waived once Waived gives a reason (`pablo research waive <#> \"<reason>\"`). pablo works the Status out from those two cells.",
    "",
    "| # | Category | Item | Status | Sources | Waived |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** A proposed item (from the research agent) before it is numbered. */
export interface ProposedItem {
  readonly category: string;
  readonly item: string;
}

/** A proposed item pablo did not keep, with why. */
export interface RejectedItem {
  readonly category: string;
  readonly item: string;
  readonly reason: string;
}

/** An item longer than this is a paragraph, not a checklist line. */
export const MAX_ITEM_CHARS = 200;

function key(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** The placeholder a category the agent left empty gets, so the author still decides it: source it or waive it. */
export function placeholderItem(category: string): string {
  return `${category}: nothing derived from the brief yet; research it or waive it`;
}

/**
 * The next checklist: every existing row kept as it is (number, sources, waiver: research already done is never
 * dropped), then each new proposed item appended with the next number. A proposal is rejected when its category is
 * not one of `categories`, it is empty or too long, or it repeats an item already listed. Each category in
 * `categories` that ends up with no item gets a placeholder, so nothing in the brief's scope is skipped silently.
 * Pure.
 */
export function mergeChecklist(
  existing: readonly ChecklistRow[],
  proposed: readonly ProposedItem[],
  categories: readonly string[],
): { rows: ChecklistRow[]; added: number; rejected: RejectedItem[] } {
  const rows: ChecklistRow[] = [...existing];
  const seen = new Set(existing.map((r) => key(r.item)));
  const rejected: RejectedItem[] = [];
  let next = existing.reduce((n, r) => Math.max(n, r.number), 0) + 1;
  let added = 0;
  const push = (category: string, item: string): void => {
    rows.push({ number: next++, category, item, sources: [] });
    seen.add(key(item));
    added++;
  };
  for (const p of proposed) {
    const category = categoryId(p.category);
    const item = p.item.replace(/\s+/g, " ").trim();
    const reject = (reason: string) => void rejected.push({ category: p.category, item, reason });
    if (!categories.includes(category)) {
      reject(`"${p.category}" is not a checklist category (${categories.join(", ")})`);
      continue;
    }
    if (item === "") {
      reject("the item is empty");
      continue;
    }
    if (item.length > MAX_ITEM_CHARS) {
      reject(`the item is longer than ${MAX_ITEM_CHARS} characters`);
      continue;
    }
    if (seen.has(key(item))) {
      reject("already on the checklist");
      continue;
    }
    push(category, item);
  }
  for (const category of categories) {
    if (!rows.some((r) => r.category === category)) push(category, placeholderItem(category));
  }
  return { rows, added, rejected };
}
