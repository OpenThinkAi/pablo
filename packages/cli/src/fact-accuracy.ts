/**
 * The `fact-accuracy` check (AGT-2112, pm project `pablo-platform`, D-10): a historical-fiction unit's draft held to
 * the work's distilled period facts (`facts/period.md`, AGT-2109/2110), not only to the timeline and bible the same
 * agent wrote. `pablo check --output <type> [--unit N]` runs it on each unit it scans:
 *
 *  - The facts a unit is held to are the ones its drafting pack was given: every undated row and every row dated on
 *    or before the unit's story date (`periodFactsAt`, the unit's date as the core check reads it). A unit with none
 *    left is not sent to the model at all.
 *  - The unit's sentences and those facts go to the model on the `check` intent (the planner role, any provider,
 *    D-12/D-13) as fenced data, and it names each sentence a fact contradicts. A reply naming a sentence or fact that
 *    was not shown is dropped, so a hit always quotes a real draft sentence and a real fact with its source.
 *  - Each hit (`rule: "fact-accuracy"`) quotes the draft sentence (`excerpt`), the contradicted fact (`fact`) and its
 *    source note (`source`, `research/<id>.md`), all three also in `detail` for the one-line printers.
 *  - The run's hits are saved to `<work>/.pablo/fact-accuracy.json` (gitignored machine state, like `critique`'s),
 *    keyed by unit file and the text's hash, so the screen shows them with the other check hits on a unit that has
 *    not changed since, without a model call of its own.
 *
 * The model is a seam: `ask` is passed in (tests a fake; real runs `factAccuracyAsk`). Never auto-rewrites.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { CHECK_INTENT, PERIOD_FACTS_FILE, createPlanner, loadConfig, parsePeriodFacts, periodFactsAt } from "@openthink/pablo-core";
import type { PeriodFact } from "@openthink/pablo-core";
import type { Hit } from "./check";
import { sentencesOf } from "./claim-support";
import { storyDateOf } from "./core-check";
import { DATA_RULE, adapterAsk, fence, jsonIn } from "./critique";
import type { Ask } from "./critique";
import { readMarker, trackOf } from "./marker";
import type { OutputDefinition } from "./outputs/types";

export const FACT_ACCURACY_RULE = "fact-accuracy";

/** One fact-accuracy hit: `check`'s `Hit` plus the contradicted fact and its source, so it lands in `hits[]` unchanged. */
export interface FactHit extends Hit {
  readonly rule: typeof FACT_ACCURACY_RULE;
  /** The draft sentence. */
  readonly excerpt: string;
  /** The period fact the sentence contradicts, as `facts/period.md` states it. */
  readonly fact: string;
  /** The fact's source note, `research/<id>.md`. */
  readonly source: string;
  /** The model's one-line reason. */
  readonly why: string;
  /** `contradicts "<fact>" (research/<id>.md): <why>`. */
  readonly detail: string;
}

/** What a run came to: the hits, how many units were sent, and why it stopped short (a model that failed or could not be built). */
export interface FactAccuracyRun {
  readonly hits: readonly FactHit[];
  /** Units sent to the model (a unit with no relevant facts is not). */
  readonly checked: number;
  readonly notice?: string;
}

/** The test-only injection point: set `ask` and every `check` uses it instead of building the planner. No test calls a real model. */
export const factAccuracyModel: { ask?: Ask } = {};

/** One draft sentence and the 1-based file line it is on. */
interface Sentence {
  readonly line: number;
  readonly text: string;
}

/** Whether `workDir` is a historical-fiction work: the one track fact accuracy runs on (nonfiction gets claim support). */
export function factAccuracyApplies(workDir: string): boolean {
  const marker = readMarker(workDir);
  return marker.ok && trackOf(marker.marker) === "historical-fiction";
}

/** The rows of the work's `facts/period.md`, or `undefined` when it has none (nothing distilled yet). */
export function readPeriodFacts(workDir: string): PeriodFact[] | undefined {
  const path = join(workDir, PERIOD_FACTS_FILE);
  return existsSync(path) ? parsePeriodFacts(readFileSync(path, "utf8")) : undefined;
}

/** The draft's sentences with their lines: frontmatter, headings, fenced blocks and blank lines skipped. */
export function draftSentences(text: string): Sentence[] {
  const lines = text.split("\n");
  let start = 0;
  if ((lines[0] ?? "").trim() === "---") {
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
    if (close > 0) start = close + 1;
  }
  const out: Sentence[] = [];
  let fenced = false;
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
    for (const sentence of sentencesOf(raw)) out.push({ line: i + 1, text: sentence });
  }
  return out;
}

/** The prompt for one unit: numbered facts and numbered sentences, each fenced as data. */
export function factAccuracyPrompt(label: string, sentences: readonly Sentence[], facts: readonly PeriodFact[]): string {
  const factList = facts.map((f, i) => `F${i + 1}. ${f.fact}${f.date === undefined ? "" : ` (from ${f.date})`}`).join("\n");
  const sentenceList = sentences.map((s, i) => `S${i + 1}. ${s.text}`).join("\n");
  return [
    "You check a historical novel's draft against sourced period facts. Report each draft sentence that a fact shows to be wrong: it states or plainly implies something the fact contradicts (a date, a number, a name, a place, how a thing worked).",
    "A sentence the facts agree with, or that no fact speaks to, is not reported. Invented characters and their private doings are not contradictions. Report only clear contradictions, never a matter of taste.",
    DATA_RULE,
    fence("period facts", factList),
    fence(`draft ${label}`, sentenceList),
    'Reply with JSON only: {"contradictions": [{"sentence": <S number>, "fact": <F number>, "why": "<one short line>"}]}. An empty list when nothing contradicts.',
  ].join("\n\n");
}

/** The contradictions a reply names, keeping only ones that point at a shown sentence and a shown fact. */
export function parseContradictions(reply: string, sentences: number, facts: number): Array<{ sentence: number; fact: number; why: string }> {
  let value: { contradictions?: unknown } | undefined;
  try {
    value = jsonIn(reply) as { contradictions?: unknown } | undefined;
  } catch {
    value = undefined;
  }
  const list = typeof value === "object" && value !== null && Array.isArray(value.contradictions) ? value.contradictions : undefined;
  if (list === undefined) throw new Error("the model's reply was not the contradictions JSON");
  const out: Array<{ sentence: number; fact: number; why: string }> = [];
  const seen = new Set<string>();
  for (const item of list as unknown[]) {
    if (item === null || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const s = Number(String(raw["sentence"] ?? "").replace(/^S/i, ""));
    const f = Number(String(raw["fact"] ?? "").replace(/^F/i, ""));
    if (!Number.isInteger(s) || !Number.isInteger(f) || s < 1 || s > sentences || f < 1 || f > facts) continue;
    const key = `${s}:${f}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // `why` is the one free model text that reaches a terminal: control characters (escape sequences) are stripped.
    const why = typeof raw["why"] === "string" ? raw["why"].replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim() : "";
    out.push({ sentence: s, fact: f, why });
  }
  return out;
}

/** A fact's source as a work-relative note path. */
const sourcePath = (fact: PeriodFact): string => (fact.source.startsWith("research/") ? fact.source : `research/${fact.source.replace(/\.md$/, "")}.md`);

/**
 * One unit's fact-accuracy hits (`text` its contents, `path` its report label) against `facts`, the facts it is
 * held to. No facts or no sentences: no model call, no hits. Throws when the model fails or its reply is unreadable.
 */
export async function checkFactAccuracy(text: string, path: string, facts: readonly PeriodFact[], ask: Ask): Promise<FactHit[]> {
  if (facts.length === 0) return [];
  const sentences = draftSentences(text);
  if (sentences.length === 0) return [];
  const reply = await ask(factAccuracyPrompt(path, sentences, facts));
  return parseContradictions(reply, sentences.length, facts.length)
    .map(({ sentence, fact, why }) => {
      const s = sentences[sentence - 1] as Sentence;
      const f = facts[fact - 1] as PeriodFact;
      const source = sourcePath(f);
      return {
        path,
        line: s.line,
        rule: FACT_ACCURACY_RULE,
        excerpt: s.text,
        fact: f.fact,
        source,
        why,
        detail: `contradicts "${f.fact}" (${source})${why === "" ? "" : `: ${why}`}`,
      } satisfies FactHit;
    })
    .sort((a, b) => a.line - b.line);
}

/** The check model: the planner role under the `check` intent (or the test injection). A message when it cannot be built. */
export function factAccuracyAsk(env: NodeJS.ProcessEnv, projectDir: string): Ask | string {
  if (factAccuracyModel.ask !== undefined) return factAccuracyModel.ask;
  try {
    return adapterAsk(createPlanner(loadConfig({ env, projectDir }), { keys: { env }, intent: CHECK_INTENT }).adapter);
  } catch (error) {
    return (error as Error).message.replace(/^pablo: /, "");
  }
}

export interface FactAccuracyOptions {
  readonly workDir: string;
  readonly def: OutputDefinition;
  /** The unit files `check` scanned, absolute. */
  readonly files: readonly string[];
  /** The model seam, built only when a unit needs it: an `Ask`, or a message saying why there is none (the run reports it and sends nothing). */
  readonly ask: () => Ask | string;
  /** Told before each model call, so a long run on a local endpoint is never a silent wait (the CLI's prose mode prints it). */
  readonly progress?: (line: string) => void;
}

/**
 * Fact accuracy over the scanned units of one output of a historical-fiction work: `undefined` when it does not
 * apply (another track, or no `facts/period.md`). Each unit with relevant facts is one model call; the first failing
 * call stops the run with a notice (the hits so far are kept). The hits are saved for the screen.
 */
export async function runFactAccuracy(opts: FactAccuracyOptions): Promise<FactAccuracyRun | undefined> {
  if (!factAccuracyApplies(opts.workDir)) return undefined;
  const facts = readPeriodFacts(opts.workDir);
  if (facts === undefined) return undefined;

  const units = opts.files
    .filter((file) => file.endsWith(".md") || file.endsWith(".fountain"))
    .map((file) => {
      const text = readFileSync(file, "utf8");
      const label = relative(opts.workDir, file).split("\\").join("/");
      const date = storyDateOf(opts.workDir, opts.def, opts.def.unitOfPath(label), text);
      return { label, text, facts: periodFactsAt(facts, date === undefined ? [] : [date]) };
    });

  const hits: FactHit[] = [];
  const saved: Record<string, readonly FactHit[]> = {};
  let checked = 0;
  let notice: string | undefined;
  let ask: Ask | string | undefined;
  const sent = units.filter((u) => u.facts.length > 0 && draftSentences(u.text).length > 0).length;
  for (const unit of units) {
    if (unit.facts.length === 0 || draftSentences(unit.text).length === 0) {
      saved[unit.label] = [];
      continue;
    }
    ask ??= opts.ask();
    if (typeof ask === "string") {
      notice = `fact-accuracy not run: ${ask}`;
      break;
    }
    opts.progress?.(`fact-accuracy: ${unit.label} (${checked + 1}/${sent}), ${unit.facts.length} period fact${unit.facts.length === 1 ? "" : "s"}, asking the check model…`);
    try {
      const found = await checkFactAccuracy(unit.text, unit.label, unit.facts, ask);
      checked++;
      hits.push(...found);
      saved[unit.label] = found;
    } catch (error) {
      notice = `fact-accuracy stopped at ${unit.label}: ${(error as Error).message}`;
      break;
    }
  }
  saveFactHits(opts.workDir, units.filter((u) => saved[u.label] !== undefined).map((u) => ({ label: u.label, text: u.text, hits: saved[u.label] as FactHit[] })));
  return { hits, checked, ...(notice !== undefined ? { notice } : {}) };
}

// ---------------------------------------------------------------- saved hits, for the screen

/** `<work>/.pablo/fact-accuracy.json`: the last run's hits per unit file, keyed to the text they were found in. */
export function factHitsPath(workDir: string): string {
  return join(workDir, ".pablo", "fact-accuracy.json");
}

const hashOf = (text: string): string => createHash("sha256").update(text).digest("hex");

type SavedUnits = Record<string, { readonly hash: string; readonly hits: readonly FactHit[] }>;

function loadSaved(workDir: string): SavedUnits {
  try {
    const value = JSON.parse(readFileSync(factHitsPath(workDir), "utf8")) as { units?: unknown };
    return value.units !== null && typeof value.units === "object" ? (value.units as SavedUnits) : {};
  } catch {
    return {};
  }
}

/** Records each unit's hits against its text's hash, keeping other units' earlier results. Best effort: a failed write loses only the screen's copy. */
export function saveFactHits(workDir: string, units: ReadonlyArray<{ label: string; text: string; hits: readonly FactHit[] }>): void {
  if (units.length === 0) return;
  const all = loadSaved(workDir);
  for (const unit of units) all[unit.label] = { hash: hashOf(unit.text), hits: unit.hits };
  const path = factHitsPath(workDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify({ units: all }, null, 2)}\n`);
    renameSync(`${path}.tmp`, path);
  } catch {
    // The CLI already printed the hits; the screen just will not show them until the next run.
  }
}

/** The saved fact-accuracy hits for `file` (work-relative) when `text` is what they were found in; none once it changed. */
export function savedFactHits(workDir: string, file: string, text: string): FactHit[] {
  const entry = loadSaved(workDir)[file.split("\\").join("/")];
  return entry !== undefined && entry.hash === hashOf(text) && Array.isArray(entry.hits) ? [...entry.hits] : [];
}
