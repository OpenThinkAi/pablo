/**
 * `distill_facts` (AGT-2109, pm project `pablo-platform`, D-9 and D-10): a work's raw research notes become short,
 * sourced period facts in `facts/period.md`, the only form of research the drafting model ever sees.
 *
 * The research agent reads the notes (on whatever model the `research` intent routes to; D-10 lets it read raw
 * notes on any model) and answers with one fact per row. pablo, not the model, decides what lands:
 *
 *  - every row cites a research note that exists (`research/<id>.md`); a row with no source, or a source that is not
 *    a note, is rejected and reported, never written;
 *  - on a work with `realNames: false`, every name the model lists as a research name, and every mapped name found in
 *    a fact, is swapped for its bible counterpart (mapped in `research/names.md`); a listed research name with no
 *    counterpart refuses the whole run, naming each one to map. pablo cannot tell a real name the model failed to
 *    list from an ordinary word, so that case is caught only by the author reviewing the `plan/` branch. The map lives under `research/` because that directory never reaches a drafting pack; a map in `bible/`
 *    would carry the real names straight to the writer.
 *
 * `facts/period.md` is a markdown table, `| Fact | Source | Story date |`, one fact per row after the header and
 * separator. That is the shape `core/machine.ts`'s `countFactRows` counts (AGT-2100); `parsePeriodFacts` reads it
 * back exactly.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Adapter, Intent } from "@openthink/pablo-core";
import { CHECKLIST_FILE } from "./core/checklist";

/** The intent distillation routes under: a planning-kind call, so an unmapped config sends it to the cloud planner when one exists. */
export const RESEARCH_INTENT: Intent = { name: "research", kind: "planning" };

/** Where the distilled facts live, work-relative. */
export const PERIOD_FACTS_FILE = "facts/period.md";

/** The research-name to bible-name map a `realNames: false` work keeps, work-relative. Never a source note. */
export const NAMES_FILE = "research/names.md";

/** A fact longer than this is not short: it is rejected so the author distils it again. */
export const MAX_FACT_CHARS = 280;

/** One row of `facts/period.md`. */
export interface PeriodFact {
  readonly fact: string;
  /** A research note id: `research/<source>.md` exists. */
  readonly source: string;
  /** When in the story the fact holds: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. */
  readonly date?: string;
}

/** A row the model proposed that pablo did not write, with why. */
export interface RejectedFact {
  readonly fact: string;
  readonly source: string;
  readonly reason: string;
}

/** One research note the agent may cite. */
export interface ResearchNote {
  /** Path under `research/` without `.md`, e.g. `ice-prices-1929` or `trade/ice-prices`. */
  readonly id: string;
  readonly text: string;
}

const DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/** Every `.md` research note under `<work>/research/`, recursively, sorted by id; the names map and the checklist are not notes. */
export function readResearchNotes(workDir: string): ResearchNote[] {
  const root = join(workDir, "research");
  const notes: ResearchNote[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const rel = relative(root, abs).split("\\").join("/");
        // Neither the names map nor the research checklist (AGT-2111) is a source note.
        if (`research/${rel}` === NAMES_FILE || `research/${rel}` === CHECKLIST_FILE) continue;
        notes.push({ id: rel.slice(0, -".md".length), text: readFileSync(abs, "utf8") });
      }
    }
  };
  walk(root);
  return notes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * `research/names.md`: research name to bible name. A table (`| Research name | Bible name |`, header and separator
 * skipped) or bullets (`- Real Name -> Invented Name`, `→` too). Later rows win.
 */
export function parseNameMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line.startsWith("|")) {
      if (/^\|[\s:|-]*$/.test(line)) continue;
      if (/^\|[\s:|-]*$/.test((lines[i + 1] ?? "").trim())) continue;
      const cells = splitRow(line);
      const from = cells[0]?.trim();
      const to = cells[1]?.trim();
      if (from && to) map.set(from, to);
      continue;
    }
    const bullet = /^[-*]\s+(.+?)\s*(?:->|→)\s*(.+)$/.exec(line);
    if (bullet) map.set((bullet[1] as string).trim(), (bullet[2] as string).trim());
  }
  return map;
}

/** The cells of one table row, honouring `\|` inside a cell. */
function splitRow(line: string): string[] {
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

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** `facts/period.md`'s content: a heading, one line saying what it is, then the table. */
export function renderPeriodFacts(facts: readonly PeriodFact[]): string {
  const rows = facts.map((f) => `| ${escapeCell(f.fact)} | ${escapeCell(f.source)} | ${f.date ?? ""} |`);
  return [
    "# Period facts",
    "",
    "Distilled from research/ by `pablo research distill`. One fact per row; the source is a research note (research/<source>.md).",
    "",
    "| Fact | Source | Story date |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** The fact rows of a `facts/period.md` table (the header and separator are not facts). */
export function parsePeriodFacts(text: string): PeriodFact[] {
  const lines = text.split("\n");
  const facts: PeriodFact[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("|") || /^\|[\s:|-]*$/.test(line)) continue;
    if (/^\|[\s:|-]*$/.test((lines[i + 1] ?? "").trim())) continue;
    const [fact = "", source = "", date = ""] = splitRow(line);
    if (!fact && !source) continue;
    facts.push({ fact, source, ...(date ? { date } : {}) });
  }
  return facts;
}

/** The prompt the research agent answers. Pure. */
export function distillPrompt(notes: readonly ResearchNote[], opts: { realNames: boolean; brief?: string }): string {
  const names = opts.realNames
    ? ""
    : '\nThis work keeps real names out of what the writer sees. In "names", list every proper name of a real person, place, business, ship or organisation that your fact takes from the research, exactly as you wrote it in the fact. pablo swaps each for the book\'s invented name.\n';
  return [
    "You are distilling a novel's research notes into short period facts for the writer.",
    "Each fact is one plain sentence a scene could rely on: a price, a date, how a trade or tool worked, what a word meant then, the weather of a season. No commentary, no hedging, nothing the notes do not support.",
    "Every fact cites the one research note it came from by its id (shown after `## Note` below). A fact you cannot source to a note is not a fact; leave it out.",
    `Keep each fact under ${MAX_FACT_CHARS} characters. When a fact holds at a particular time in the story, give that as "date" (YYYY, YYYY-MM or YYYY-MM-DD); otherwise omit it.`,
    names,
    'Answer with JSON only, no prose and no code fence: {"facts": [{"fact": "...", "source": "<note id>", "date": "1929-01", "names": ["..."]}]}',
    ...(opts.brief ? ["", "## Period brief", "", opts.brief.trim()] : []),
    ...notes.flatMap((n) => ["", `## Note ${n.id}`, "", n.text.trim()]),
    "",
  ].join("\n");
}

/** One fact as the model proposed it, before pablo has checked anything. */
export interface ProposedFact {
  readonly fact: string;
  readonly source: string;
  readonly date?: string;
  readonly names: readonly string[];
}

/** The model's answer as proposed facts; `undefined` when it is not the JSON asked for. Tolerates a code fence and a bare array. */
export function parseDistillAnswer(text: string): ProposedFact[] | undefined {
  const stripped = text.replace(/```(?:json)?/g, "").trim();
  const start = stripped.search(/[[{]/);
  if (start < 0) return undefined;
  const close = stripped[start] === "[" ? "]" : "}";
  const end = stripped.lastIndexOf(close);
  if (end < start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { facts?: unknown } | null)?.facts;
  if (!Array.isArray(list)) return undefined;
  const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
  return list.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const date = str(r["date"]).trim();
    const names = Array.isArray(r["names"]) ? r["names"].map(str).map((n) => n.trim()).filter(Boolean) : [];
    return { fact: str(r["fact"]).replace(/\s+/g, " ").trim(), source: str(r["source"]).trim(), ...(date ? { date } : {}), names };
  });
}

/** A source as the model may write it (`research/x.md`, `x.md`, `x`) reduced to a note id. */
function noteId(source: string): string {
  return source.replace(/^research\//, "").replace(/\.md$/, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `text` with each `from` replaced by its `to`, whole words only, longest name first. */
export function swapNames(text: string, map: ReadonlyMap<string, string>): string {
  let out = text;
  for (const from of [...map.keys()].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(from)}(?![\\p{L}\\p{N}])`, "gu"), map.get(from) as string);
  }
  return out;
}

function mentions(haystack: string, name: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "u").test(haystack);
}

export type CheckedFacts =
  | { ok: true; facts: PeriodFact[]; rejected: RejectedFact[]; swapped: { from: string; to: string }[] }
  | { ok: false; names: string[] };

/**
 * pablo's half of distillation, pure: every proposed fact is checked against the notes that exist, and with
 * `realNames: false` its research names are swapped for their bible counterparts. A name the model listed that is
 * neither mapped (to a name the bible uses) nor already a bible name refuses the whole set.
 */
export function checkFacts(
  proposed: readonly ProposedFact[],
  opts: { noteIds: ReadonlySet<string>; realNames: boolean; nameMap: ReadonlyMap<string, string>; bibleText: string },
): CheckedFacts {
  const rejected: RejectedFact[] = [];
  const kept: PeriodFact[] = [];
  // Only a mapping to a name the bible actually uses is a counterpart.
  const counterparts = new Map([...opts.nameMap].filter(([, to]) => mentions(opts.bibleText, to)));
  const unmapped = new Set<string>();
  const swapped = new Map<string, string>();

  for (const p of proposed) {
    const reject = (reason: string) => void rejected.push({ fact: p.fact, source: p.source, reason });
    if (!p.fact) {
      reject("the fact is empty");
      continue;
    }
    if (!p.source) {
      reject("a fact needs a source: the research note it came from");
      continue;
    }
    const source = noteId(p.source);
    if (!opts.noteIds.has(source)) {
      reject(`research/${source}.md does not exist`);
      continue;
    }
    if (p.fact.length > MAX_FACT_CHARS) {
      reject(`the fact is longer than ${MAX_FACT_CHARS} characters`);
      continue;
    }
    if (p.date !== undefined && !DATE.test(p.date)) {
      reject(`"${p.date}" is not a story date (YYYY, YYYY-MM or YYYY-MM-DD)`);
      continue;
    }
    let fact = p.fact;
    if (!opts.realNames) {
      for (const name of p.names) {
        if (counterparts.has(name) || mentions(opts.bibleText, name)) continue;
        unmapped.add(name);
      }
      for (const [from, to] of counterparts) if (mentions(fact, from)) swapped.set(from, to);
      fact = swapNames(fact, counterparts);
    }
    kept.push({ fact, source, ...(p.date !== undefined ? { date: p.date } : {}) });
  }

  if (unmapped.size > 0) return { ok: false, names: [...unmapped].sort() };
  return { ok: true, facts: kept, rejected, swapped: [...swapped].map(([from, to]) => ({ from, to })) };
}

/** Every `.md` under `<work>/bible/`, joined: what "a name the bible uses" is checked against. */
export function readBibleText(workDir: string): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith(".md")) parts.push(readFileSync(abs, "utf8"));
    }
  };
  walk(join(workDir, "bible"));
  return parts.join("\n");
}

/** Streams one completion to its full text. */
export async function completeText(adapter: Adapter, prompt: string): Promise<string> {
  let text = "";
  // Room for a few hundred short JSON rows; a run that needs more is research to split, not one answer.
  for await (const ev of adapter.complete({ prompt, maxTokens: 8000 })) {
    if (ev.type === "token") text += ev.text;
  }
  return text;
}
