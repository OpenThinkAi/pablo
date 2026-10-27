/**
 * A work's distilled period facts (AGT-2109, AGT-2110; pm project `pablo-platform`, D-10): `facts/period.md`, a
 * markdown table `| Fact | Source | Story date |`, one fact per row after the header and separator. `pablo research
 * distill` writes it; every fiction drafting pack reads it, keeping the rows whose story date is on or before the
 * unit's (undated rows always). The raw notes under `research/` never reach a pack; these rows are the only form of
 * research the writer sees.
 *
 * Pure and dependency-free: text in, values out.
 */

/** Where the distilled facts live, work-relative. */
export const PERIOD_FACTS_FILE = "facts/period.md";

/** One row of `facts/period.md`. */
export interface PeriodFact {
  readonly fact: string;
  /** A research note id: `research/<source>.md` exists. */
  readonly source: string;
  /** When in the story the fact holds: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
  readonly date?: string;
}

/** The cells of one markdown table row, honouring `\|` inside a cell. */
export function splitTableRow(line: string): string[] {
  const inner = line.replace(/^\|/, "").replace(/\|$/, "");
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

/** The fact rows of a `facts/period.md` table (the header and separator are not facts). */
export function parsePeriodFacts(text: string): PeriodFact[] {
  const lines = text.split("\n");
  const facts: PeriodFact[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("|") || /^\|[\s:|-]*$/.test(line)) continue;
    if (/^\|[\s:|-]*$/.test((lines[i + 1] ?? "").trim())) continue;
    const [fact = "", source = "", date = ""] = splitTableRow(line);
    if (!fact && !source) continue;
    facts.push({ fact, source, ...(date ? { date } : {}) });
  }
  return facts;
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/**
 * A story date as a sortable key: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, as precise as the text allows, or `undefined`
 * when it names no year. Reads ISO forms (`1929-01-09`, `1929-01`) and an English month next to a year (`January
 * 1929`, `9 January 1929`, `January 9, 1929`); anything else with a year in it (`Winter 1931`) is the year alone.
 */
export function storyDateKey(text: string): string | undefined {
  const iso = /(?<!\d)(1[0-9]\d{2}|20\d{2})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?(?!\d)/.exec(text);
  if (iso !== null) return [iso[1], iso[2], iso[3]].filter((p) => p !== undefined).join("-");
  const year = /(?<!\d)(1[0-9]\d{2}|20\d{2})(?!\d)/.exec(text);
  if (year === null) return undefined;
  const lower = text.toLowerCase();
  const month = MONTHS.findIndex((name) => new RegExp(`\\b(${name}|${name.slice(0, 3)})\\b`).test(lower));
  if (month < 0) return year[1];
  const mm = String(month + 1).padStart(2, "0");
  const name = MONTHS[month] as string;
  const day =
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:${name}|${name.slice(0, 3)})\\b`).exec(lower)?.[1] ??
    new RegExp(`\\b(?:${name}|${name.slice(0, 3)})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\d)`).exec(lower)?.[1];
  const dd = day !== undefined && Number(day) >= 1 && Number(day) <= 31 ? `-${day.padStart(2, "0")}` : "";
  return `${year[1]}-${mm}${dd}`;
}

/**
 * Whether a fact dated `factDate` holds by a unit dated `unitDate` (both `storyDateKey` keys). Compared at the
 * coarser of the two precisions, so a fact dated `1929-05` holds in a unit dated only `1929`: the gate fails safe,
 * telling the writer a fact it may not need rather than withholding one it does.
 */
export function factHoldsBy(factDate: string, unitDate: string): boolean {
  const n = Math.min(factDate.length, unitDate.length);
  return factDate.slice(0, n) <= unitDate.slice(0, n);
}

/**
 * The facts a unit may rely on: every undated fact, and every dated one on or before the unit's latest story date
 * (a unit telling several beats spans them all). A unit with no readable date gets every fact, as the story-time
 * gate does. File order is kept.
 */
export function periodFactsAt(facts: readonly PeriodFact[], storyDates: readonly string[]): PeriodFact[] {
  const keys = storyDates.map(storyDateKey).filter((k): k is string => k !== undefined);
  if (keys.length === 0) return [...facts];
  const latest = keys.reduce((a, b) => (latestOf(a, b) === a ? a : b));
  return facts.filter((f) => {
    const key = f.date === undefined ? undefined : storyDateKey(f.date);
    return key === undefined || factHoldsBy(key, latest);
  });
}

/** The later of two keys; at a shared prefix the more precise one is not later (`1929` vs `1929-03` is a tie). */
function latestOf(a: string, b: string): string {
  const n = Math.min(a.length, b.length);
  const x = a.slice(0, n);
  const y = b.slice(0, n);
  if (x === y) return a.length <= b.length ? a : b;
  return x > y ? a : b;
}

/** One fact as the writer sees it: the fact, with its story date when it has one. The source note is never sent. */
export function renderPeriodFactLine(fact: PeriodFact): string {
  return `- ${fact.fact}${fact.date === undefined ? "" : ` (from ${fact.date})`}`;
}
