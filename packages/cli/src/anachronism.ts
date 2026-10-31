/**
 * The `anachronism` check for historical fiction (AGT-2113, pm project `pablo-platform`, D-10): words, objects and
 * idioms in a unit that are out of the work's period. Each hit names the term, why it is out of period and the
 * period it belongs to.
 *
 * The period is the work's period brief (`bible/period.md`): its "When and where" section, else its first
 * paragraph. Verdicts come from the model the `check` intent routes to (the `plan` mapping when `check` is
 * unmapped), asked in batches about the unit's distinct words, never its prose. Function words and the names the
 * bible, `facts.md` and the continuity ledgers already know are never sent (AGT-2187): no period owns them.
 *
 * The reply format is a plain-text line protocol, not JSON (AGT-2187, D-12): the model lists only the terms that are
 * out of period, one `term | why | belongs` line each, then a line `END`. That reply is short whatever the batch
 * size, so a local model (Gemma 4 on mlx_lm, whose server caps an answer at 512 tokens unless told otherwise) is not
 * cut off part way through a JSON array, and `END` is how a complete reply is told from a truncated one: only after
 * `END` does an unlisted term count as in period. A JSON array of verdicts is still read, for a model that answers in
 * the old shape. Terms a reply leaves without a verdict make the check fail loudly (`failed`), never a silent pass.
 *
 * Every verdict, in period or not, is cached per (period, term) in `<work>/.pablo/lexicon.json` of the work's main
 * checkout (AGT-2187): a check run in a draft branch's worktree writes there too, so nothing untracked is left in
 * the worktree, the cache survives the merge that removes it, and a re-check asks only about terms it has not seen
 * (a fully cached re-check makes no model call and needs no model configured). The author may overrule a verdict by
 * editing the file; a hand-edited verdict is used as is. A lexicon that does not parse is never overwritten: the
 * check fails with a notice. A legacy `facts/lexicon.json` (AGT-2113 kept it in the work) seeds a missing cache. The
 * cache key is the period text, so rewriting the brief's "When and where" section starts a fresh set of verdicts.
 *
 * Each cached verdict records the model that gave it, `<provider>/<model>` (AGT-2288, D-13: the `check` intent can be
 * moved to another model, a `claude-code` one included). A check on one model reuses only the verdicts that model
 * gave: another model's are asked again and replaced. A verdict with no `model` (a lexicon from before AGT-2288) is
 * from an unknown model, so a known model does not reuse it either; it is re-asked, and the answer is stored with the
 * model. A hand-edited verdict that every model should obey carries `"model": "*"`. `check --fresh` clears the period's
 * verdicts first. A run prints how many verdicts came from the cache and from which model.
 *
 * `anachronismModel.ask` is the test seam: tests inject a fake there, so no test calls a real model.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { CHECK_INTENT, FACTS_FILE, continuityFile, createPlanner, loadConfig } from "@openthink/pablo-core";
import type { Hit } from "./check";
import { adapterAsk } from "./critique";
import type { Ask } from "./critique";
import { PERIOD_BRIEF_FILE } from "./core/machine";
import { readMarker, trackOf } from "./marker";

/** Where the cached verdicts live, relative to the work in its main checkout (gitignored machine state). */
export const LEXICON_FILE = ".pablo/lexicon.json";

/** Where AGT-2113 kept the verdicts, in the work itself; read once to seed a missing cache, never written. */
export const LEGACY_LEXICON_FILE = "facts/lexicon.json";

/** How many terms one model call judges. */
export const TERMS_PER_ASK = 100;

/** The answer budget one call is given: a reply lists only the out-of-period terms, so this is generous. */
export const ASK_MAX_TOKENS = 4096;

/** The line that closes a complete reply. */
export const END_MARKER = "END";

/** The shape of one reply line, as the prompt states it (an echo of it is not a verdict). */
const LINE_FORMAT = "term | what is out of period, in one short sentence | when it arrived, a year or decade, e.g. the 1950s";

/** The model the check asks; a test-only injection point, so no test reaches a real model. */
export const anachronismModel: { ask?: Ask; model?: string } = {};

/** A verdict that every model obeys: the mark for one the author wrote by hand (AGT-2288). */
export const ANY_MODEL = "*";

/** The identity of a check model that cannot be built (no config) or whose verdicts predate model tracking. */
export const UNKNOWN_MODEL = "unknown";

/** One cached verdict on a term. `why` and `belongs` are set when the term is out of period. */
export interface LexiconEntry {
  readonly inPeriod: boolean;
  readonly why?: string;
  readonly belongs?: string;
  /** `<provider>/<model>` that gave this verdict (AGT-2288); absent on a legacy entry, `*` on a hand-written one. */
  readonly model?: string;
}

/** `.pablo/lexicon.json`: period text to lower-cased term to verdict. */
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
  /** The check model's identity, `<provider>/<model>` (`unknown` when it could not be built). */
  readonly model?: string;
  /** How many distinct words were judged from the lexicon without a model call, for `model`. */
  readonly cached?: number;
  /** How many distinct words were not in the lexicon for `model` and so were asked. */
  readonly new?: number;
  /** Set when some terms could not be judged (no period brief, no model, a failed call): the check is incomplete. */
  readonly notice?: string;
  /** Set when the check could not judge every term (a failed call, a reply missing verdicts, a broken lexicon): a check error, never a pass. */
  readonly failed?: true;
}

const EXCERPT_MAX = 120;
/** A model's `why` and `belongs` are capped so a bad reply cannot bloat the lexicon. */
const VERDICT_TEXT_MAX = 200;

/** A `belongs` that names a time: a year, a decade or a century. "N/A" and "a later period" do not. */
const DATED = /\b\d{3,4}s?\b|\bcentur(?:y|ies)\b/i;

/** A `why` that is about spelling, style or word history rather than a thing out of period (AGT-2284). */
const NOT_A_THING = /\b(?:spelling|spelled|spelt|variant|hyphen\w*|capitali[sz]\w*|punctuation|etymolog\w*|word origin|stylistic)\b/i;

/**
 * An out-of-period verdict is reported only when it names what is out of period and when it arrived (AGT-2284): no
 * date, a contradiction (`belongs to N/A`) or a spelling/etymology reason makes it noise, and it is read as in period.
 */
function reportableVerdict(why: unknown, belongs: unknown): { why: string; belongs: string } | undefined {
  const w = typeof why === "string" ? why.trim() : "";
  const b = typeof belongs === "string" ? belongs.trim() : "";
  if (w === "" || b === "" || !DATED.test(b) || NOT_A_THING.test(w)) return undefined;
  return { why: w.slice(0, VERDICT_TEXT_MAX), belongs: b.slice(0, VERDICT_TEXT_MAX) };
}

/** Function words never worth a verdict: no period owns them. Lower-case, apostrophes straight. */
const STOPWORDS = new Set(
  (
    "the and but for nor yet not was were are has had have his her hers him she they them their theirs its our ours " +
    "you your yours who whom whose which what when where why how this that these those then than there here with " +
    "from into onto upon over under about after before again all any both each few more most other some such only " +
    "own same too very can could would should will shall may might must did does done doing been being one two " +
    "out off down just now also back still even ever never once while until because though although if so as at " +
    "by of on in to up an or no is be do it he we me my us am let get got say said " +
    "myself yourself yourselves himself herself itself ourselves themselves whoever whatever whichever whenever " +
    "wherever however therefore thus hence else otherwise either neither whether across along among amongst around " +
    "behind below beneath beside besides between beyond despite during except inside near outside past since through " +
    "throughout toward towards underneath unlike unto within without against above via per " +
    "having has hadn't hasn't haven't isn't aren't wasn't weren't don't doesn't didn't won't wouldn't can't cannot " +
    "couldn't shouldn't mustn't shan't mightn't needn't i'm i've i'll i'd you're you've you'll you'd he's he'll he'd " +
    "she's she'll she'd it's it'll we're we've we'll we'd they're they've they'll they'd that's there's here's what's " +
    "who's where's when's why's how's let's " +
    "three four five six seven eight nine ten first second third another every many much less least few fewer " +
    "several enough whole half none nothing something anything everything someone anyone everyone nobody somebody " +
    "anybody everybody somewhere anywhere everywhere nowhere sometimes always often already almost quite rather " +
    "really perhaps maybe soon later yes yet away again ago instead indeed yesterday today tomorrow tonight " +
    "says saying went go goes going gone come comes came coming make makes made making take takes took taken taking " +
    "see sees saw seen know knows knew known think thought look looked looks give gave given tell told put puts " +
    "like just upon " +
    "january february march april june july august september october november december " +
    "monday tuesday wednesday thursday friday saturday sunday"
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

/** Every `.md` under `dir`, recursively. */
function markdownUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? markdownUnder(full) : name.endsWith(".md") ? [full] : [];
  });
}

function readText(path: string): string {
  try {
    return existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

/**
 * The names the work already knows, as written: each capitalised word in the bible, `facts.md` and every output's
 * continuity ledger that does not start a sentence (so a sentence's ordinary first word is not taken for a name).
 * A draft word spelt with a capital that is one of these is a name the core settled, so no model is asked about it.
 */
export function knownNamesOf(workDir: string, coreDir: string = workDir): Set<string> {
  const outputs = join(workDir, "outputs");
  const ledgers = existsSync(outputs) ? readdirSync(outputs).map((type) => join(outputs, type, "continuity.md")) : [];
  const files = [...markdownUnder(join(coreDir, "bible")), join(coreDir, FACTS_FILE), join(workDir, continuityFile(workDir)), ...ledgers];
  const names = new Set<string>();
  for (const file of files) {
    for (const line of readText(file).split("\n")) {
      for (const match of line.matchAll(/[A-Z][a-z][A-Za-z'’-]*/g)) {
        const before = line.slice(0, match.index).replace(/["'“‘(\s]+$/, "");
        if (before === "" || /[.!?:#]$/.test(before)) continue;
        names.add(match[0].replace(/’/g, "'").replace(/'s$/, ""));
      }
    }
  }
  return names;
}

/**
 * Each judgeable term on each body line of `text` (frontmatter skipped), with its 1-based line number. A term is
 * judgeable when it is three letters or more, not a function word, and not a capitalised name in `names`.
 */
export function termsByLine(text: string, names: ReadonlySet<string> = new Set()): Array<{ readonly line: number; readonly raw: string; readonly terms: string[] }> {
  const lines = text.split("\n");
  let start = 0;
  if ((lines[0] ?? "").trim() === "---") {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (end > 0) start = end + 1;
  }
  const out: Array<{ line: number; raw: string; terms: string[] }> = [];
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const tokens = tokensOf(raw).filter((token) => !(/^[A-Z]/.test(token) && names.has(token.replace(/’/g, "'").replace(/'s$/, ""))));
    const terms = [...new Set(tokens.map(termOf).filter(worthJudging))];
    if (terms.length > 0) out.push({ line: i + 1, raw, terms });
  }
  return out;
}

/**
 * The work directory whose `.pablo/` holds the lexicon: the same work in the repository's main checkout when
 * `workDir` sits in a linked worktree (a draft branch's), else `workDir` itself. The cache then outlives the
 * worktree, and the worktree is left clean for the merge that removes it.
 */
export function lexiconHome(workDir: string): string {
  const run = spawnSync("git", ["-C", workDir, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], { encoding: "utf8" });
  if (run.status !== 0) return workDir;
  const [common, top] = run.stdout.trim().split("\n");
  if (common === undefined || top === undefined || basename(common) !== ".git") return workDir;
  try {
    const main = realpathSync(dirname(common));
    const here = realpathSync(top);
    if (main === here) return workDir;
    const home = join(main, relative(here, realpathSync(workDir)));
    return existsSync(home) ? home : workDir;
  } catch {
    return workDir;
  }
}

/**
 * The lexicon under `homeDir` (see `lexiconHome`); a missing file is an empty one (seeded from `legacyDir`'s
 * `facts/lexicon.json` when that parses), a file that does not parse as one is `undefined`.
 */
export function readLexicon(homeDir: string, legacyDir?: string): Lexicon | undefined {
  const path = join(homeDir, LEXICON_FILE);
  if (!existsSync(path)) {
    const legacy = legacyDir === undefined ? undefined : join(legacyDir, LEGACY_LEXICON_FILE);
    return (legacy !== undefined && existsSync(legacy) ? parseLexicon(legacy) : undefined) ?? { periods: {} };
  }
  return parseLexicon(path);
}

function parseLexicon(path: string): Lexicon | undefined {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { periods?: unknown };
    const periods = data.periods;
    return periods !== null && typeof periods === "object" && !Array.isArray(periods) ? { periods: periods as Lexicon["periods"] } : undefined;
  } catch {
    return undefined;
  }
}

/** Writes the lexicon, terms sorted so the file diffs cleanly; atomic (temp file then rename). */
export function writeLexicon(homeDir: string, lexicon: Lexicon): void {
  const path = join(homeDir, LEXICON_FILE);
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
    "For each term below, decide whether the THING, PRACTICE or IDIOM it names existed in that time and place: an object, a custom, an institution, a way of speaking. Judge what the term refers to, not the word's etymology, first recorded date or spelling. A word that existed but meant something else then counts as in period. A spelling or style variant (labor/labour, a hyphenated date, a capitalisation) is never out of period. Names of people and places count as in period unless they did not exist yet.",
    "Report a term only when you can name what is out of period and the year or decade it arrived. If you cannot give a date, the term is in period: do not list it.",
    "",
    "List only the terms that are OUT of period, one per line, in exactly this form:",
    LINE_FORMAT,
    "Use each term exactly as given. Do not list terms that are in period and write nothing else: no heading, no numbering, no JSON.",
    `When you have gone through every term, end with a line that says only ${END_MARKER}. If every term is in period, reply with only ${END_MARKER}.`,
    "",
    "Terms:",
    ...terms.map((term) => `- ${term}`),
  ].join("\n");
}

/** A reply's own text: a thinking block dropped (a reply cut off mid-thought has none), code fences removed. */
function replyText(reply: string): string {
  const open = reply.search(/<think(?:ing)?>/i);
  let text = reply.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
  if (open >= 0 && text.search(/<think(?:ing)?>/i) >= 0) text = text.slice(0, text.search(/<think(?:ing)?>/i));
  return text.replace(/^\s*```[\w-]*\s*$/gm, "");
}

/** A cell's term: markdown emphasis, code ticks and quotes around it dropped. */
function cellTerm(cell: string): string {
  return termOf(cell.trim().replace(/^[*_`"“'‘]+|[*_`"”'’:]+$/g, "").trim());
}

const IN_PERIOD_CELL = /^(?:in[- ]period|yes|true|fine|ok)\b/i;

/** A JSON array of `{term, inPeriod, why?, belongs?}` verdicts (the shape AGT-2113 asked for), when the reply is one. */
function jsonVerdicts(text: string, wanted: ReadonlySet<string>): Map<string, LexiconEntry> | undefined {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!Array.isArray(data)) return undefined;
  const verdicts = new Map<string, LexiconEntry>();
  for (const item of data) {
    if (item === null || typeof item !== "object") continue;
    const { term, inPeriod, why, belongs } = item as Record<string, unknown>;
    if (typeof term !== "string" || typeof inPeriod !== "boolean") continue;
    const key = termOf(term.trim());
    if (!wanted.has(key)) continue;
    verdicts.set(key, outOfPeriod(inPeriod, why, belongs));
  }
  return verdicts;
}

/**
 * The verdicts in a reply, keyed by term; only terms that were asked count, and anything malformed is skipped.
 *
 * The line protocol: each `term | why | belongs` line (a bullet, a markdown table row, `**bold**` or backticks around
 * the term are tolerated, as is `term: why`) is an out-of-period verdict; a line `END` closes the reply, and only a
 * closed reply makes every unlisted asked term in period. A reply with no `END` (cut off, or in another shape) gives
 * verdicts for the terms it lists and nothing else, so the rest are asked again rather than passed. A reply that is a
 * JSON array of verdicts is read as one.
 */
export function parseVerdicts(reply: string, asked: readonly string[]): Map<string, LexiconEntry> {
  const wanted = new Set(asked);
  const text = replyText(reply);
  const verdicts = new Map<string, LexiconEntry>();
  let closed = false;
  const lines = text.split("\n");
  // A reply cut off mid-line (no trailing newline, no END) may hold a half-written verdict: that last line is not read.
  const partial = !/\n\s*$/.test(text) ? lines.length - 1 : -1;
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim().replace(/^(?:[-*•+]|\d+[.)])\s+/, "");
    if (line === "" || line === LINE_FORMAT) continue;
    if (/^[*_`#\s]*END[*_`.!\s]*$/i.test(line)) {
      closed = true;
      continue;
    }
    const cells = line.includes("|") ? line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim()) : undefined;
    const colon = cells === undefined ? /^([^:—–]+?)\s*(?::|\s[—–-]\s)\s*(.+)$/.exec(line) : null;
    const term = cells !== undefined ? cellTerm(cells[0] ?? "") : colon !== null ? cellTerm(colon[1] as string) : undefined;
    if (term === undefined || !wanted.has(term) || index === partial) continue;
    const why = cells !== undefined ? cells[1] : (colon?.[2] as string);
    if (typeof why === "string" && IN_PERIOD_CELL.test(why.trim())) {
      verdicts.set(term, { inPeriod: true });
      continue;
    }
    verdicts.set(term, outOfPeriod(false, why, cells?.[2]));
  }
  if (closed) {
    for (const term of asked) if (!verdicts.has(term)) verdicts.set(term, { inPeriod: true });
    return verdicts;
  }
  if (verdicts.size === 0) return jsonVerdicts(text, wanted) ?? verdicts;
  return verdicts;
}

/** The cached verdict for a model's answer on a term: out of period only when `reportableVerdict` accepts it. */
function outOfPeriod(inPeriod: boolean, why: unknown, belongs: unknown): LexiconEntry {
  if (inPeriod) return { inPeriod: true };
  const verdict = reportableVerdict(why, belongs);
  return verdict === undefined ? { inPeriod: true } : { inPeriod: false, ...verdict };
}

/** The real model: the planner role under the `check` intent, with its `<provider>/<model>` identity. Throws when no provider can be built. */
function realAsk(env: NodeJS.ProcessEnv, workDir: string): { ask: Ask; model: string } {
  const adapter = createPlanner(loadConfig({ env, projectDir: workDir }), { keys: { env }, intent: CHECK_INTENT }).adapter;
  return { ask: adapterAsk(adapter, undefined, ASK_MAX_TOKENS), model: `${adapter.id}/${adapter.model}` };
}

/** Whether `entry` may be reused by the check model `model`: it gave it, or the author wrote it for every model. */
function usable(entry: LexiconEntry | undefined, model: string): entry is LexiconEntry {
  return entry !== undefined && (entry.model === ANY_MODEL || (model !== UNKNOWN_MODEL && entry.model === model) || (model === UNKNOWN_MODEL && entry.model === undefined));
}

export interface AnachronismOptions {
  /** The model seam; defaults to `anachronismModel.ask`, else the `check` intent's planner (built only when needed). */
  readonly ask?: Ask;
  /** The injected `ask`'s identity (`<provider>/<model>`); default `anachronismModel.model`, else `injected`. */
  readonly model?: string;
  /** `check --fresh` (AGT-2288): drop this period's cached verdicts before judging. */
  readonly fresh?: boolean;
  /**
   * The work whose core (period brief, bible, `facts.md`) is read when it is not `workDir` itself: main's, for a draft
   * branch's worktree (AGT-2288). The lexicon and the units stay where they are.
   */
  readonly coreDir?: string;
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

  const coreDir = options.coreDir ?? workDir;
  const briefPath = join(coreDir, PERIOD_BRIEF_FILE);
  const period = periodOf(existsSync(briefPath) ? readFileSync(briefPath, "utf8") : "");
  if (period === undefined) return { hits: [], asked: 0, notice: `anachronism: skipped; ${PERIOD_BRIEF_FILE} has no period brief yet` };

  const names = knownNamesOf(workDir, coreDir);
  const units = files.map((file) => ({ label: relative(workDir, file), lines: termsByLine(existsSync(file) ? readFileSync(file, "utf8") : "", names) }));
  const home = lexiconHome(workDir);
  const read = readLexicon(home, workDir);
  const lexicon = read ?? { periods: {} };
  if (read === undefined) {
    return { hits: [], asked: 0, failed: true, notice: `anachronism: not run; ${LEXICON_FILE} is not a lexicon (fix or delete it; it is never overwritten)` };
  }
  if (options.fresh === true && lexicon.periods[period] !== undefined) {
    lexicon.periods[period] = {};
    writeLexicon(home, lexicon);
  }
  const known = (lexicon.periods[period] ??= {});

  // Who judges: the injected seam, else the `check` intent's model. One that cannot be built is `unknown`; the error
  // is reported only when a word needs asking (a lexicon of hand-written verdicts still works without a model).
  let ask: Ask | undefined = options.ask ?? anachronismModel.ask;
  let model = ask === undefined ? UNKNOWN_MODEL : (options.model ?? anachronismModel.model ?? "injected");
  let buildError: Error | undefined;
  if (ask === undefined) {
    try {
      ({ ask, model } = realAsk(options.env ?? process.env, workDir));
    } catch (error) {
      buildError = error as Error;
    }
  }
  const allTerms = [...new Set(units.flatMap((u) => u.lines.flatMap((l) => l.terms)))];
  // A verdict another model gave (or a legacy one with no model) is not this model's: it is asked again and replaced.
  const unknown = allTerms.filter((term) => !usable(known[term], model)).sort();
  const cached = allTerms.length - unknown.length;
  options.progress?.(`anachronism: ${cached} of ${allTerms.length} word verdict(s) from the cache (${model}), ${unknown.length} to ask`);
  let asked = 0;
  let notice: string | undefined;
  if (unknown.length > 0) {
    const batches = Math.ceil(unknown.length / TERMS_PER_ASK);
    try {
      if (ask === undefined) throw buildError ?? new Error("no check model");
      options.progress?.(`anachronism: asking ${model} about ${unknown.length} word(s) in ${batches} batch(es); known verdicts come from ${LEXICON_FILE}`);
      for (let i = 0; i < unknown.length; i += TERMS_PER_ASK) {
        const batch = unknown.slice(i, i + TERMS_PER_ASK);
        asked++;
        options.progress?.(`anachronism: batch ${asked}/${batches}`);
        const verdicts = parseVerdicts(await ask(lexiconPrompt(period, batch)), batch);
        for (const [term, entry] of verdicts) known[term] = { ...entry, model };
        // Saved after every batch, so a run that fails part way keeps what it learned.
        if (verdicts.size > 0) writeLexicon(home, lexicon);
      }
    } catch (error) {
      const message = (error as Error).message;
      // pablo's own config refusal already names its next step; any other failure is the provider's, so point at it.
      const next = message.startsWith("pablo:")
        ? ""
        : " Check the provider the `check` intent routes to (`pablo config test`; `pablo init --config` if none is set).";
      notice = `anachronism: incomplete; ${unknown.filter((t) => !usable(known[t], model)).length} new word(s) not judged, cached verdicts still reported: ${message.replace(/\.$/, "")}.${next}`;
    }
    const unjudged = unknown.filter((term) => !usable(known[term], model)).length;
    if (notice === undefined && unjudged > 0) {
      notice = `anachronism: incomplete; ${unjudged} term(s) got no verdict (the check model's reply was cut short or not in the asked \`term | why | belongs\` lines ending in ${END_MARKER}); cached verdicts still reported, and they will be asked again`;
    }
  }
  const failed = notice !== undefined;

  const hits: AnachronismHit[] = [];
  for (const unit of units) {
    for (const line of unit.lines) {
      for (const term of line.terms) {
        const entry = known[term];
        if (!usable(entry, model) || entry.inPeriod) continue;
        // A verdict cached before AGT-2284 (no date, `N/A`, a spelling reason) is dropped here too, never re-asked.
        const verdict = reportableVerdict(entry.why, entry.belongs);
        if (verdict === undefined) continue;
        const { why, belongs } = verdict;
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
  return { hits, asked, model, cached, new: unknown.length, ...(notice !== undefined ? { notice } : {}), ...(failed ? { failed: true as const } : {}) };
}

/**
 * The `anachronism` block of `check`'s JSON body: how many model calls the run made, the notice when it is
 * incomplete, and `failed` when terms went unjudged (`check` then exits non-zero).
 */
export function anachronismBody(result: AnachronismResult): { asked: number; model?: string; cached?: number; new?: number; notice?: string; failed?: true } {
  return { asked: result.asked, ...(result.model !== undefined ? { model: result.model } : {}), ...(result.cached !== undefined ? { cached: result.cached } : {}), ...(result.new !== undefined ? { new: result.new } : {}), ...(result.notice !== undefined ? { notice: result.notice } : {}), ...(result.failed ? { failed: true as const } : {}) };
}
