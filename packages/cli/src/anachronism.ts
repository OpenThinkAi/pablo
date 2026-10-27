/**
 * The `anachronism` check for historical fiction (AGT-2113, pm project `pablo-platform`, D-10): words, objects and
 * idioms in a unit that are out of the work's period. Each hit names the term, why it is out of period and the
 * period it belongs to.
 *
 * The period is the work's period brief (`bible/period.md`): its "When and where" section, else its first
 * paragraph. Verdicts come from the model the `check` intent routes to (the `plan` mapping when `check` is
 * unmapped), asked in batches about the unit's distinct words, never its prose. Every verdict, in period or not,
 * is cached per (period, term) in the work's `facts/lexicon.json`, so a re-check asks only about terms it has not
 * seen, and a fully cached re-check makes no model call at all (and needs no model configured).
 *
 * The lexicon is a document in the work, not machine state (AC2 of AGT-2113 names `facts/lexicon.json`): the author
 * may read it, commit it with the other facts and overrule a verdict by editing it; a hand-edited verdict is used as
 * is. A lexicon that does not parse is never overwritten: the check reports the cached-nothing result with a notice.
 * The cache key is the period text, so rewriting the brief's "When and where" section starts a fresh set of verdicts.
 *
 * `anachronismModel.ask` is the test seam: tests inject a fake there, so no test calls a real model.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { CHECK_INTENT, createPlanner, loadConfig } from "@openthink/pablo-core";
import type { Hit } from "./check";
import { adapterAsk } from "./critique";
import type { Ask } from "./critique";
import { PERIOD_BRIEF_FILE } from "./core/machine";
import { readMarker, trackOf } from "./marker";

/** Where the cached verdicts live, work-relative. */
export const LEXICON_FILE = "facts/lexicon.json";

/** How many terms one model call judges. */
export const TERMS_PER_ASK = 200;

/** The model the check asks; a test-only injection point, so no test reaches a real model. */
export const anachronismModel: { ask?: Ask } = {};

/** One cached verdict on a term. `why` and `belongs` are set when the term is out of period. */
export interface LexiconEntry {
  readonly inPeriod: boolean;
  readonly why?: string;
  readonly belongs?: string;
}

/** `facts/lexicon.json`: period text to lower-cased term to verdict. */
export interface Lexicon {
  readonly periods: Record<string, Record<string, LexiconEntry>>;
}

/** An `anachronism` hit: the shared hit shape plus the term, the reason and the period it belongs to. */
export interface AnachronismHit extends Hit {
  readonly rule: "anachronism";
  readonly term: string;
  readonly why: string;
  readonly belongs: string;
}

export interface AnachronismResult {
  readonly hits: AnachronismHit[];
  /** How many model calls the run made (0 on a fully cached re-check). */
  readonly asked: number;
  /** Set when some terms could not be judged (no period brief, no model, a failed call): the check is incomplete. */
  readonly notice?: string;
}

const EXCERPT_MAX = 120;
/** A model's `why` and `belongs` are capped so a bad reply cannot bloat the lexicon. */
const VERDICT_TEXT_MAX = 200;

function capped(text: unknown, fallback: string): string {
  const trimmed = typeof text === "string" ? text.trim() : "";
  return trimmed === "" ? fallback : trimmed.slice(0, VERDICT_TEXT_MAX);
}

/** Function words never worth a verdict: no period owns them. */
const STOPWORDS = new Set(
  (
    "the and but for nor yet not was were are has had have his her hers him she they them their theirs its our ours " +
    "you your yours who whom whose which what when where why how this that these those then than there here with " +
    "from into onto upon over under about after before again all any both each few more most other some such only " +
    "own same too very can could would should will shall may might must did does done doing been being one two " +
    "out off down just now also back still even ever never once while until because though although if so as at " +
    "by of on in to up an or no is be do it he we me my us am let get got say said"
  ).split(" "),
);

/** The period a work is set in: the brief's "When and where" section, else its first paragraph; `undefined` without one. */
export function periodOf(brief: string): string | undefined {
  const body = brief.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const section = /^##\s+When and where\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(body)?.[1];
  const source = section !== undefined && section.trim() !== "" ? section : body.replace(/^#[^\n]*$/gm, "");
  const paragraph = source.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).find((p) => p !== "");
  return paragraph === undefined || paragraph === "" ? undefined : paragraph;
}

/** The lower-cased term a token is cached under: curly apostrophes straightened, a possessive dropped. */
export function termOf(token: string): string {
  return token.toLowerCase().replace(/’/g, "'").replace(/'s$/, "");
}

/** The tokens of one line: words, keeping inner apostrophes and hyphens (`teenager`, `drive-in`, `ain't`). */
function tokensOf(line: string): string[] {
  return line.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) ?? [];
}

function worthJudging(term: string): boolean {
  return term.length >= 3 && !STOPWORDS.has(term);
}

/** Each judgeable term on each body line of `text` (frontmatter skipped), with its 1-based line number. */
export function termsByLine(text: string): Array<{ readonly line: number; readonly raw: string; readonly terms: string[] }> {
  const lines = text.split("\n");
  let start = 0;
  if ((lines[0] ?? "").trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) start = end + 1;
  }
  const out: Array<{ line: number; raw: string; terms: string[] }> = [];
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const terms = [...new Set(tokensOf(raw).map(termOf).filter(worthJudging))];
    if (terms.length > 0) out.push({ line: i + 1, raw, terms });
  }
  return out;
}

/** The work's lexicon; a missing file is an empty one, a file that does not parse as one is `undefined`. */
export function readLexicon(workDir: string): Lexicon | undefined {
  const path = join(workDir, LEXICON_FILE);
  if (!existsSync(path)) return { periods: {} };
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { periods?: unknown };
    const periods = data.periods;
    return periods !== null && typeof periods === "object" && !Array.isArray(periods) ? { periods: periods as Lexicon["periods"] } : undefined;
  } catch {
    return undefined;
  }
}

/** Writes the lexicon, terms sorted so the file diffs cleanly; atomic (temp file then rename). */
export function writeLexicon(workDir: string, lexicon: Lexicon): void {
  const path = join(workDir, LEXICON_FILE);
  mkdirSync(dirname(path), { recursive: true });
  const periods: Record<string, Record<string, LexiconEntry>> = {};
  for (const period of Object.keys(lexicon.periods).sort()) {
    periods[period] = Object.fromEntries(Object.entries(lexicon.periods[period] ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ periods }, null, 2)}\n`);
  renameSync(temp, path);
}

/** The prompt that asks for verdicts on `terms`: the period and the bare terms, never a sentence of the draft. */
export function lexiconPrompt(period: string, terms: readonly string[]): string {
  return [
    `You judge anachronisms for a historical story set in: ${period}`,
    "",
    "For each term below, decide whether a person of that time and place could plausibly use it: the word itself, the object or idea it names, or the idiom it belongs to. A word that existed but meant something else then counts as in period. Names of people and places count as in period unless they did not exist yet.",
    "",
    'Reply with only a JSON array, one object per term: {"term": "<the term exactly as given>", "inPeriod": true or false, "why": "<one short sentence; only when false>", "belongs": "<the period the term belongs to, e.g. \\"the 1950s\\"; only when false>"}.',
    "",
    "Terms:",
    ...terms.map((term) => `- ${term}`),
  ].join("\n");
}

/** The verdicts in a reply, keyed by term; only terms that were asked count, and anything malformed is skipped. */
export function parseVerdicts(reply: string, asked: readonly string[]): Map<string, LexiconEntry> {
  const verdicts = new Map<string, LexiconEntry>();
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start < 0 || end <= start) return verdicts;
  let data: unknown;
  try {
    data = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return verdicts;
  }
  if (!Array.isArray(data)) return verdicts;
  const wanted = new Set(asked);
  for (const item of data) {
    if (item === null || typeof item !== "object") continue;
    const { term, inPeriod, why, belongs } = item as Record<string, unknown>;
    if (typeof term !== "string" || typeof inPeriod !== "boolean") continue;
    const key = termOf(term.trim());
    if (!wanted.has(key)) continue;
    verdicts.set(
      key,
      inPeriod
        ? { inPeriod: true }
        : {
            inPeriod: false,
            why: capped(why, "no reason given"),
            belongs: capped(belongs, "a later period"),
          },
    );
  }
  return verdicts;
}

/** The real model: the planner role under the `check` intent. Throws when no provider can be built. */
function realAsk(env: NodeJS.ProcessEnv, workDir: string): Ask {
  return adapterAsk(createPlanner(loadConfig({ env, projectDir: workDir }), { keys: { env }, intent: CHECK_INTENT }).adapter);
}

export interface AnachronismOptions {
  /** The model seam; defaults to `anachronismModel.ask`, else the `check` intent's planner (built only when needed). */
  readonly ask?: Ask;
  readonly env?: NodeJS.ProcessEnv;
  /** Where the progress lines go (the CLI's stderr), so a first run's model calls are a visible wait. */
  readonly progress?: (line: string) => void;
}

/**
 * Runs the check over `files` (absolute paths inside `workDir`): judges the terms the lexicon lacks for the work's
 * period, caches every verdict, then reports one hit per (line, out-of-period term). Returns `undefined` when the
 * work is not on the `historical-fiction` track (the check does not apply).
 */
export async function checkAnachronisms(workDir: string, files: readonly string[], options: AnachronismOptions = {}): Promise<AnachronismResult | undefined> {
  const marker = readMarker(workDir);
  if (!marker.ok || trackOf(marker.marker) !== "historical-fiction") return undefined;

  const briefPath = join(workDir, PERIOD_BRIEF_FILE);
  const period = periodOf(existsSync(briefPath) ? readFileSync(briefPath, "utf8") : "");
  if (period === undefined) return { hits: [], asked: 0, notice: `anachronism: skipped; ${PERIOD_BRIEF_FILE} has no period brief yet` };

  const units = files.map((file) => ({ label: relative(workDir, file), lines: termsByLine(existsSync(file) ? readFileSync(file, "utf8") : "") }));
  const read = readLexicon(workDir);
  const lexicon = read ?? { periods: {} };
  const known = (lexicon.periods[period] ??= {});
  if (read === undefined) {
    return { hits: [], asked: 0, notice: `anachronism: skipped; ${LEXICON_FILE} is not a lexicon (fix or delete it; it is never overwritten)` };
  }

  const unknown = [...new Set(units.flatMap((u) => u.lines.flatMap((l) => l.terms)))].filter((term) => known[term] === undefined).sort();
  let asked = 0;
  let notice: string | undefined;
  if (unknown.length > 0) {
    let ask: Ask | undefined = options.ask ?? anachronismModel.ask;
    const batches = Math.ceil(unknown.length / TERMS_PER_ASK);
    try {
      ask ??= realAsk(options.env ?? process.env, workDir);
      options.progress?.(`anachronism: asking the check model about ${unknown.length} new word(s) in ${batches} batch(es); known verdicts come from ${LEXICON_FILE}`);
      for (let i = 0; i < unknown.length; i += TERMS_PER_ASK) {
        const batch = unknown.slice(i, i + TERMS_PER_ASK);
        asked++;
        options.progress?.(`anachronism: batch ${asked}/${batches}`);
        const verdicts = parseVerdicts(await ask(lexiconPrompt(period, batch)), batch);
        for (const [term, entry] of verdicts) known[term] = entry;
        // Saved after every batch, so a run that fails part way keeps what it learned.
        if (verdicts.size > 0) writeLexicon(workDir, lexicon);
      }
    } catch (error) {
      const message = (error as Error).message;
      // pablo's own config refusal already names its next step; any other failure is the provider's, so point at it.
      const next = message.startsWith("pablo:")
        ? ""
        : " Check the provider the `check` intent routes to (`pablo config test`; `pablo init --config` if none is set).";
      notice = `anachronism: incomplete; ${unknown.filter((t) => known[t] === undefined).length} new word(s) not judged, cached verdicts still reported: ${message}.${next}`;
    }
    const unjudged = unknown.filter((term) => known[term] === undefined).length;
    if (notice === undefined && unjudged > 0) notice = `anachronism: ${unjudged} term(s) got no verdict and will be asked again`;
  }

  const hits: AnachronismHit[] = [];
  for (const unit of units) {
    for (const line of unit.lines) {
      for (const term of line.terms) {
        const entry = known[term];
        if (entry === undefined || entry.inPeriod) continue;
        const why = entry.why ?? "no reason given";
        const belongs = entry.belongs ?? "a later period";
        const trimmed = line.raw.trim();
        hits.push({
          path: unit.label,
          line: line.line,
          rule: "anachronism",
          excerpt: trimmed.length <= EXCERPT_MAX ? trimmed : trimmed.slice(0, EXCERPT_MAX),
          detail: `"${term}": ${why}; belongs to ${belongs}`,
          term,
          why,
          belongs,
        });
      }
    }
  }
  return { hits, asked, ...(notice !== undefined ? { notice } : {}) };
}

/** The `anachronism` block of `check`'s JSON body: how many model calls the run made, and the notice when it is incomplete. */
export function anachronismBody(result: AnachronismResult): { asked: number; notice?: string } {
  return { asked: result.asked, ...(result.notice !== undefined ? { notice: result.notice } : {}) };
}
