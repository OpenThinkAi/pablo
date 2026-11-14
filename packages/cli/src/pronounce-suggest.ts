/**
 * `pablo pronounce --suggest` (AGT-2303, pm project `pablo-platform`): the long tail the spoken-form rules cannot
 * decide — unusual names, abbreviations no rule knows, and heteronyms whose sound depends on the sense — goes to the
 * model the `plan` intent routes to, which proposes a respelling and a one-line reason for each.
 *
 * pablo, not the model, decides what lands. The Python side (`pronounce.py`) says which tokens the rules and the
 * lexicon left undecided, each with its speaker and sentence; a word the lexicon already decides is never sent. A
 * proposal must name a token that was sent, carry a single-line respelling in the lexicon's own `word -> respelling`
 * form, and is dropped otherwise. Nothing is applied: the accepted proposals are appended to the output's
 * `pronounce.md` on a new `plan/` branch for the author to review and `pablo merge`. A respelling is a guess about a
 * speech engine, and hand-written ones have made it worse before, so every one is to be heard before it is kept.
 *
 * The lexicon has no per-line scope, only per-speaker (`SPEAKER: word -> respelling`). A heteronym suggestion is
 * therefore always speaker-scoped, and its comment names the unit and line it was judged on.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_RULE, fence, jsonIn } from "./critique";

/** One token pronounce flagged, with where it stands, as the model is asked about it. */
export interface SuggestItem {
  readonly id: number;
  /** The lexicon key: the token without a trailing full stop. */
  readonly word: string;
  readonly kind: "caps" | "capitalised" | "abbreviation" | "unit" | "heteronym";
  readonly speaker: string;
  readonly unit: number;
  readonly line: number;
  readonly sentence: string;
}

/** A proposal pablo accepted: ready to be a lexicon entry. */
export interface Suggestion {
  readonly word: string;
  readonly respelling: string;
  /** The line's speaker when the entry is scoped to it, else every speaker. */
  readonly speaker?: string;
  readonly reason: string;
  readonly unit: number;
  readonly line: number;
  readonly kind: SuggestItem["kind"];
}

/** A proposal pablo did not keep, with why. */
export interface RejectedSuggestion {
  readonly word: string;
  readonly reason: string;
}

interface PronounceUnresolved {
  readonly token?: unknown;
  readonly kind?: unknown;
  readonly first?: { readonly unit?: unknown; readonly line?: unknown };
  readonly speaker?: unknown;
  readonly sentence?: unknown;
}

interface PronounceHeteronym {
  readonly word?: unknown;
  readonly unit?: unknown;
  readonly line?: unknown;
  readonly speaker?: unknown;
  readonly sentence?: unknown;
}

const KINDS = new Set(["caps", "capitalised", "abbreviation", "unit"]);
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const int = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) ? v : 0);

/**
 * What `pronounce`'s JSON asks the model about: every undecided token (links excepted: a respelling only ever
 * matches a word, and a link is rewritten by hand) and every heteronym, in the order `pronounce` listed them.
 */
export function suggestItems(body: Record<string, unknown>): SuggestItem[] {
  const items: Omit<SuggestItem, "id">[] = [];
  for (const raw of (Array.isArray(body["unresolved"]) ? body["unresolved"] : []) as PronounceUnresolved[]) {
    const kind = text(raw.kind);
    const word = text(raw.token).replace(/\.$/, "");
    if (!KINDS.has(kind) || word === "") continue;
    items.push({ word, kind: kind as SuggestItem["kind"], speaker: text(raw.speaker), unit: int(raw.first?.unit), line: int(raw.first?.line), sentence: text(raw.sentence) });
  }
  for (const raw of (Array.isArray(body["heteronyms"]) ? body["heteronyms"] : []) as PronounceHeteronym[]) {
    const word = text(raw.word);
    if (word === "") continue;
    items.push({ word, kind: "heteronym", speaker: text(raw.speaker), unit: int(raw.unit), line: int(raw.line), sentence: text(raw.sentence) });
  }
  return items.map((item, i) => ({ ...item, id: i + 1 }));
}

/** The prompt the planner answers. Pure. */
export function suggestPrompt(items: readonly SuggestItem[]): string {
  const rows = items.map((i) => `${i.id}. [${i.kind}] ${i.word} (speaker ${i.speaker || "?"}, unit ${i.unit} line ${i.line}): ${i.sentence}`).join("\n");
  return [
    "You help a writer fix how a text-to-speech engine says words. The engine reads English from plain spelling. It cannot be told phonemes: a respelling is just different spelling it then reads, so it must be a plain-letter spelling, with the stressed syllable in CAPITALS and syllables joined by hyphens (`Zinfandel -> zin-fan-DELL`).",
    "Below are tokens the rules could not decide: unusual names, abbreviations, and heteronyms (words spelled alike but sounded by sense, such as read, lead, live, close, tear, wind), each with the sentence it stands in.",
    "For each, decide whether the engine's default reading is wrong or doubtful and, only then, propose a respelling and a one-line reason. For a name or abbreviation, give its usual spoken form. For a heteronym, propose a respelling only when the sentence means the reading the engine is unlikely to choose by default (the more common sound of the word); when the default fits the sentence, leave it out. Leave out any token you are not sure how to say.",
    "A respelling replaces the whole word wherever it appears, so a name or abbreviation has one spoken form. A heteronym's respelling applies to everything its speaker says, so propose one only when the sentence's sense is the one that speaker's lines mostly use; say in the reason if it is not.",
    DATA_RULE,
    fence("tokens", rows),
    'Reply with JSON only: {"suggestions": [{"id": <number>, "word": "<the token exactly as listed>", "respelling": "<plain-letter respelling>", "reason": "<one short line>"}]}. An empty list when none needs one.',
  ].join("\n\n");
}

const clean = (v: unknown): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim() : "");

/**
 * The proposals worth keeping, checked by pablo: each names a token that was sent (by id, with the same word) and has
 * a respelling that is one line, differs from the word and holds no arrow. A token proposed twice keeps its first
 * proposal; a heteronym or a token the speaker's name cannot scope is never written unscoped. Throws when the reply
 * is not the JSON asked for.
 */
export function parseSuggestions(reply: string, items: readonly SuggestItem[]): { suggestions: Suggestion[]; rejected: RejectedSuggestion[] } {
  let value: unknown;
  try {
    value = jsonIn(reply);
  } catch {
    value = undefined;
  }
  const list = Array.isArray(value) ? value : (value as { suggestions?: unknown } | null)?.suggestions;
  if (!Array.isArray(list)) throw new Error("the model's reply was not the suggestions JSON");
  const byId = new Map(items.map((i) => [i.id, i]));
  const suggestions: Suggestion[] = [];
  const rejected: RejectedSuggestion[] = [];
  const seen = new Set<string>();
  for (const raw of list as unknown[]) {
    if (raw === null || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const item = byId.get(Number(r["id"]));
    const word = clean(r["word"]);
    const drop = (why: string) => void rejected.push({ word: word || String(r["id"] ?? ""), reason: why });
    if (item === undefined) {
      drop("not a token that was sent");
      continue;
    }
    if (word.replace(/\.$/, "").toLowerCase() !== item.word.toLowerCase()) {
      drop(`id ${item.id} is "${item.word}", not "${word}"`);
      continue;
    }
    const respelling = clean(r["respelling"]);
    if (respelling === "" || /->|→/.test(respelling) || respelling.toLowerCase() === item.word.toLowerCase()) {
      drop("no usable respelling (empty, the word itself, or it holds an arrow)");
      continue;
    }
    const speaker = item.speaker.toUpperCase();
    const scopable = /^[A-Z][A-Z0-9_ ]*$/.test(speaker);
    if (item.kind === "heteronym" && !scopable) {
      drop(`the line's speaker "${item.speaker}" cannot be a lexicon scope, and a heteronym is never written for every speaker`);
      continue;
    }
    const key = `${item.kind === "heteronym" ? speaker : ""}|${item.word.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({
      word: item.word,
      respelling,
      ...(item.kind === "heteronym" ? { speaker } : {}),
      reason: clean(r["reason"]),
      unit: item.unit,
      line: item.line,
      kind: item.kind,
    });
  }
  return { suggestions, rejected };
}

/** `word -> respelling`, or `SPEAKER: word -> respelling`: the lexicon's own form (`lexicon.py`). */
export function entryLine(s: Suggestion): string {
  return `${s.speaker === undefined ? "" : `${s.speaker}: `}${s.word} -> ${s.respelling}`;
}

/** `current` with the suggestions appended after a comment block saying where they came from; `#` lines are ignored by the lexicon parser. */
export function appendSuggestions(current: string, suggestions: readonly Suggestion[], by: { date: string; model: string }): string {
  const body = current === "" || current.endsWith("\n") ? current : `${current}\n`;
  const lines = [
    ...(body === "" ? [] : [""]),
    `# Suggested by pablo pronounce --suggest, ${by.date} (${by.model}). Proposals, not decisions: hear each before keeping it, and delete any that sounds worse.`,
  ];
  for (const s of suggestions) {
    lines.push(`# unit ${s.unit} line ${s.line}${s.reason === "" ? "" : `: ${s.reason}`}${s.speaker === undefined ? "" : " (a heteronym: scoped to this speaker, so it applies to all their lines)"}`);
    lines.push(entryLine(s));
  }
  return `${body}${lines.join("\n")}\n`;
}

/** The work's current lexicon text, `""` when it has none. */
export function readLexicon(workDir: string, relPath: string): string {
  const path = join(workDir, relPath);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
