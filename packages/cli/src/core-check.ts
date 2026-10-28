/**
 * The core check (AGT-1671; pm project `pablo-story-core`, "Per-output continuity, and consistency between
 * outputs"): what `pablo check --output <type>` adds to the tells and provenance scan. A unit of any output is held
 * to the story core it tells:
 *
 * - **story-time** (the story-time gate, a hard rule): a line that names a year after the unit's own year, or names
 *   a thing the timeline (`bible/timeline.md`) dates after it. The unit's date is its frontmatter `story_date`, else
 *   the story date of the first beat its plan row maps it to. The gate is core's `gateTimeline`, the same code the
 *   drafting pack and the critic use, so the three cannot disagree about what exists yet.
 * - **unknown-name**: a capitalised name, not at the start of a sentence, that nothing in the core knows: not the
 *   bible, the timeline, the beats, `facts.md`, nor this output's own ledger (names and places, against the bible
 *   and `facts.md`). Another output's ledger is not consulted: a name only the novel established is unknown to the
 *   radio show until it is promoted. Also known (AGT-2197): the work's own title, the period facts
 *   (`facts/period.md`), and on a nonfiction work the research notes. Headings are not scanned, and a word right
 *   after an opening quote (a sign's "Please") is not a name.
 *
 * Pure over the work directory: reads, never writes. The hits use `check`'s `Hit` shape, so `check` prints them
 * like any other.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { FACTS_FILE, PERIOD_FACTS_FILE, beatsFile, continuityFile, gateTimeline, parseBeatRows } from "@openthink/pablo-core";
import type { Hit } from "./check";
import { readMarker, trackOf } from "./marker";
import { parseFrontmatter } from "./novel/machine";
import type { OutputDefinition } from "./outputs/types";

const EXCERPT_MAX = 120;
const MONTHS_AND_DAYS = new Set(
  "January February March April May June July August September October November December Monday Tuesday Wednesday Thursday Friday Saturday Sunday".split(" "),
);
/** Capitalised words that are not names: honorifics and the pronoun. */
const NOT_NAMES = new Set(["I", "Mr", "Mrs", "Ms", "Miss", "Dr", "Doctor", "God", "Sir", "Madam", "Ma", "Pa"]);
const STOP = new Set("the a an and or but of to in on at by for with from as is was are were be been it its this that his her their".split(" "));

function read(path: string): string {
  try {
    return existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function excerptOf(line: string): string {
  const trimmed = line.trim();
  return trimmed.length <= EXCERPT_MAX ? trimmed : trimmed.slice(0, EXCERPT_MAX);
}

const yearIn = (text: string): number | undefined => {
  const match = /(1[6-9]\d{2}|20\d{2})/.exec(text);
  return match === null ? undefined : Number(match[1]);
};

/** Lowercased content words, in order. */
const contentWords = (text: string): string[] => (text.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w));

/** Every `.md` under `dir`, recursively. */
function markdownUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? markdownUnder(full) : name.endsWith(".md") ? [read(full)] : [];
  });
}

/** The words the core (and this output's ledger) already knows, as written: what a name is checked against. */
function knownWords(workDir: string, output: string): Set<string> {
  const texts = [
    ...markdownUnder(join(workDir, "bible")),
    read(join(workDir, beatsFile(workDir))),
    read(join(workDir, FACTS_FILE)),
    // A bullet the continuity ritual marked unconfirmed (AGT-2190) is a model's claim, not the author's: it knows no name.
    read(join(workDir, continuityFile(workDir, output)))
      .split("\n")
      .filter((line) => !/, unconfirmed\]\s*$/.test(line))
      .join("\n"),
    read(join(workDir, PERIOD_FACTS_FILE)),
  ];
  const marker = readMarker(workDir);
  if (marker.ok) {
    texts.push(marker.marker.title);
    if (trackOf(marker.marker) === "nonfiction") texts.push(...markdownUnder(join(workDir, "research")));
  }
  const known = new Set<string>();
  for (const text of texts) for (const word of text.match(/[A-Za-z][A-Za-z'-]*/g) ?? []) known.add(word.replace(/'s$/, ""));
  return known;
}

/** One later timeline row's things, as consecutive content-word pairs a mention of them would carry. */
interface LaterThing {
  readonly year: number;
  readonly item: string;
  readonly pairs: readonly string[];
}

function laterThings(timeline: string, storyDate: string): LaterThing[] {
  return gateTimeline(timeline, storyDate, "bible/timeline.md").later.flatMap((row) => {
    const match = /^- (\d{4}): (.*)$/.exec(row);
    if (match === null) return [];
    return (match[2] as string).split("; ").flatMap((item) => {
      const words = contentWords(item);
      const pairs = words.slice(1).map((w, i) => `${words[i]} ${w}`);
      return pairs.length === 0 ? [] : [{ year: Number(match[1]), item, pairs }];
    });
  });
}

/** The unit's story date: its frontmatter `story_date`, else its plan row's first beat's. */
export function storyDateOf(workDir: string, def: OutputDefinition, unit: number | undefined, text: string): string | undefined {
  const own = parseFrontmatter(text)["story_date"]?.trim().replace(/^["']|["']$/g, "");
  if (own) return own;
  if (unit === undefined) return undefined;
  const beat = def.plan(workDir).find((row) => row.unit === unit)?.beats[0];
  if (beat === undefined) return undefined;
  const rows = parseBeatRows(read(join(workDir, beatsFile(workDir))), beatsFile(workDir));
  return rows.find((row) => row.chapter === beat)?.storyDate || undefined;
}

/** The capitalised names on a line that do not start a sentence. */
function namesOn(line: string): string[] {
  const names: string[] = [];
  const re = /[A-Z][a-z][A-Za-z'-]*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    const raw = line.slice(0, match.index);
    const before = raw.replace(/["'“‘(\s]+$/, "");
    if (before === "" || /[.!?:]$/.test(before)) continue;
    // The strip above handles an opening quote after sentence punctuation; this handles one mid-sentence.
    // Straight after an opening quote (not a mid-word apostrophe): a quoted sign or line, which starts like a sentence.
    if (/(?:^|[\s(])["“‘]$/.test(raw)) continue;
    const word = match[0].replace(/'s$/, "");
    if (MONTHS_AND_DAYS.has(word) || NOT_NAMES.has(word)) continue;
    names.push(word);
  }
  return names;
}

/**
 * The core check over the given unit files of `def` (absolute paths). `label` is how a hit names its file (the
 * work-relative path, as `check` reports).
 */
export function coreCheck(workDir: string, def: OutputDefinition, files: readonly string[]): Hit[] {
  const timeline = read(join(workDir, "bible", "timeline.md"));
  const known = knownWords(workDir, def.id);
  const hits: Hit[] = [];
  for (const file of files) {
    const text = read(file);
    const label = relative(workDir, file).split("\\").join("/");
    const unit = def.unitOfPath(label);
    const date = storyDateOf(workDir, def, unit, text);
    const year = date === undefined ? undefined : yearIn(date);
    const later = date === undefined || timeline === "" ? [] : laterThings(timeline, date);
    const lines = text.split("\n");
    const front = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
    const start = front === null ? 0 : front[0].replace(/\r?\n$/, "").split("\n").length;
    for (let i = start; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.trim() === "" || /^\s*#{1,6}\s/.test(line)) continue;
      const found: Hit[] = [];
      if (year !== undefined) {
        for (const m of line.matchAll(/\b(1[6-9]\d{2}|20\d{2})\b/g)) {
          if (Number(m[1]) > year) found.push({ path: label, line: i + 1, rule: "story-time", excerpt: excerptOf(line), detail: `${m[1]} is after the unit's date (${date})` });
        }
        const words = contentWords(line);
        const linePairs = new Set(words.slice(1).map((w, k) => `${words[k]} ${w}`));
        for (const thing of later) {
          if (thing.pairs.some((p) => linePairs.has(p))) {
            found.push({ path: label, line: i + 1, rule: "story-time", excerpt: excerptOf(line), detail: `${thing.year}: ${thing.item} does not exist yet at ${date}` });
          }
        }
      }
      for (const name of new Set(namesOn(line))) {
        if (!known.has(name)) found.push({ path: label, line: i + 1, rule: "unknown-name", excerpt: excerptOf(line), detail: name });
      }
      hits.push(...found);
    }
  }
  return hits;
}
