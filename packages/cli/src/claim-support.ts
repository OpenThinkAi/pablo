/**
 * The `claim-support` check for nonfiction (AGT-2114, pm project `pablo-platform`, D-5 and D-10): nonfiction gets
 * claim support where historical fiction gets fact accuracy. A unit of a nonfiction work is read a sentence at a
 * time; each sentence that makes a factual claim is traced to the work's sources, the rows of `core/claims.md`
 * (`| # | Claim | Sources |`) and the notes under `research/`.
 *
 *  - `claim-unsupported`: a claim that traces to no claims row and no research note, and cites nothing that
 *    resolves. `detail` names the nearest candidate source when one shares enough words to be worth a look.
 *  - `claim-uncited`: a claim that does trace to a claims row or note, but carries no citation in the text.
 *    `detail` names the source it traces to and the citation to add.
 *
 * A citation in the text is a bracket of `@<note id>` (a research note, `research/<id>.md`) and/or `#<n>` (row n of
 * `core/claims.md`), separated by `;` or `,`: `[@ice-harvest]`, `[#2]`, `[@ice-harvest; #3]`. A sentence whose
 * citation resolves to a note or row is sourced by the author and never a hit; one whose citation resolves to
 * nothing is checked as if uncited, and the dangling target is named in its hit.
 *
 * Tracing is lexical: the share of a sentence's content words (stopwords dropped, a plural `s` folded) found in a
 * claims row or a note's body. Which sentences are claims at all is a seam (`ClaimSupportSeam.isClaim`) so tests
 * drive it with a fake and a model-assisted judge can replace the default heuristic (`looksFactual`) later. Pure
 * apart from `readClaimSources`, which reads the work's files.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAIMS_FILE, parseClaims, researchNoteId } from "./core/nonfiction";
import type { ClaimRow } from "./core/nonfiction";
import { readResearchNotes } from "./distill";

/** One claim-support hit; the same shape as `check.ts`'s `Hit`, so it lands in `hits[]` unchanged. */
export interface ClaimHit {
  readonly path: string;
  readonly line: number;
  readonly rule: "claim-unsupported" | "claim-uncited";
  /** The claim sentence. */
  readonly excerpt: string;
  readonly detail: string;
}

/** What a unit's claims are traced against. */
export interface ClaimSources {
  readonly claims: readonly ClaimRow[];
  readonly notes: ReadonlyArray<{ readonly id: string; readonly text: string }>;
}

/** Decides which sentences make a factual claim. The default is `looksFactual`; tests inject a fake. */
export interface ClaimSupportSeam {
  readonly isClaim: (sentence: string) => boolean;
}

/** At least this share of a claim's content words must appear in a source for the claim to trace to it. */
export const SUPPORT_THRESHOLD = 0.5;
/** Below the threshold, a source sharing at least this share is still named as the nearest candidate. */
export const NEAREST_THRESHOLD = 0.2;

const EXCERPT_MAX = 120;

const STOPWORDS = new Set(
  (
    "a about after all also an and any are around as at be because been before being between both but by can could " +
    "did do does each even every for from had has have he her here him his how i if in into is it its just like made " +
    "make many may more most much must my no nor not of off on once one only or other our out over own same she " +
    "should so some such than that the their them then there these they this those through to too under until up upon " +
    "us very was we were what when where which while who whom why will with would yet you your"
  ).split(" "),
);

/** Phrases that mark a sentence as reporting fact even without a number or a name. */
const FACT_CUES =
  /\b(according to|records show|research shows|studies show|historians|census|percent|per cent|was founded|were founded|was built|were built|was invented|was established|first|largest|oldest|only)\b/i;

/**
 * The default claim detector: a sentence states a fact when it carries a number (a year, a count, a price), a name
 * past its first word, or a reporting cue (`according to`, `was founded`, `the first`). A question is never a claim.
 */
export function looksFactual(sentence: string): boolean {
  const text = stripCitations(sentence).trim();
  if (text === "" || text.endsWith("?")) return false;
  if (/\d/.test(text)) return true;
  if (FACT_CUES.test(text)) return true;
  const words = text.split(/\s+/).slice(1);
  return words.some((word) => /^["“'(]?[A-Z][a-z]/.test(word) && !/^["“'(]?I\b/.test(word));
}

/** One citation target: a research note id or a claims row number. */
type Target = { readonly kind: "note"; readonly id: string } | { readonly kind: "row"; readonly number: number };

const BRACKET = /\[([^\]]*)\]/g;

/** The targets of every citation bracket in `sentence`; a bracket that is not wholly `@id`/`#n` tokens is not a citation. */
export function citationsIn(sentence: string): Target[] {
  const targets: Target[] = [];
  for (const match of sentence.matchAll(BRACKET)) {
    const tokens = (match[1] ?? "").split(/[;,]/).map((token) => token.trim());
    if (tokens.length === 0 || tokens.some((token) => !/^(@[\w./-]+|#\d+)$/.test(token))) continue;
    for (const token of tokens) {
      targets.push(token.startsWith("@") ? { kind: "note", id: researchNoteId(token.slice(1)) } : { kind: "row", number: Number(token.slice(1)) });
    }
  }
  return targets;
}

function stripCitations(sentence: string): string {
  return sentence.replace(BRACKET, (whole, inner: string) =>
    inner.split(/[;,]/).every((token) => /^(@[\w./-]+|#\d+)$/.test(token.trim())) ? "" : whole,
  );
}

/** The content words of `text`: lowercased, stopwords and one- or two-letter words dropped, a plural `s` folded. */
export function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const raw of text.toLowerCase().replace(/[’']/g, "").match(/[a-z0-9]+/g) ?? []) {
    if (STOPWORDS.has(raw) || (raw.length < 3 && !/\d/.test(raw))) continue;
    words.add(raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return words;
}

/** The share of `claim`'s words found in `source` (0 when the claim has none). */
function overlap(claim: ReadonlySet<string>, source: ReadonlySet<string>): number {
  if (claim.size === 0) return 0;
  let shared = 0;
  for (const word of claim) if (source.has(word)) shared++;
  return shared / claim.size;
}

/** A note's body for tracing: its `Retrieved:` line and `## Sources` section (URLs, not facts) left out. */
function noteBody(text: string): string {
  const sources = /^##\s+Sources\b/im.exec(text);
  const body = sources ? text.slice(0, sources.index) : text;
  return body
    .split("\n")
    .filter((line) => !/^\s*Retrieved:/i.test(line))
    .join("\n");
}

interface Candidate {
  readonly label: string;
  readonly cite: readonly string[];
  readonly words: ReadonlySet<string>;
}

function candidatesOf(sources: ClaimSources): Candidate[] {
  const rows = sources.claims.map((row) => ({
    label: `${CLAIMS_FILE} #${row.number} "${row.claim}"`,
    cite: [`[#${row.number}]`, ...row.sources.map((id) => `[@${id}]`)],
    words: contentWords(row.claim),
  }));
  const notes = sources.notes.map((note) => ({ label: `research/${note.id}.md`, cite: [`[@${note.id}]`], words: contentWords(noteBody(note.text)) }));
  // Claims rows first, so a tie goes to the row (it names the note too).
  return [...rows, ...notes];
}

function nearest(claim: ReadonlySet<string>, candidates: readonly Candidate[]): { candidate: Candidate; score: number } | undefined {
  let best: { candidate: Candidate; score: number } | undefined;
  for (const candidate of candidates) {
    const score = overlap(claim, candidate.words);
    if (score > 0 && (best === undefined || score > best.score)) best = { candidate, score };
  }
  return best;
}

/** 0-based index of the closing `---` of a leading frontmatter block, or `-1`. */
function frontmatterEnd(lines: readonly string[]): number {
  if ((lines[0] ?? "").trim() !== "---") return -1;
  for (let i = 1; i < lines.length; i++) if ((lines[i] ?? "").trim() === "---") return i;
  return -1;
}

/** The sentences on one line: split after `.`, `!` or `?` (and any closing quote or citation) before a capital. */
export function sentencesOf(line: string): string[] {
  return line
    .split(/(?<=[.!?]["”')\]]*)\s+(?=["“(]?[A-Z])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

function excerptOf(sentence: string): string {
  return sentence.length <= EXCERPT_MAX ? sentence : sentence.slice(0, EXCERPT_MAX);
}

/**
 * Every claim-support hit in one unit (`text` its full contents, `path` its report label). Frontmatter, headings,
 * fenced code and blank lines are skipped; each remaining line is split into sentences, and a sentence is checked
 * when it carries a citation or `seam.isClaim` says it makes a claim. Pure: no disk I/O.
 */
export function checkClaimSupport(text: string, path: string, sources: ClaimSources, seam: ClaimSupportSeam = { isClaim: looksFactual }): ClaimHit[] {
  const lines = text.split("\n");
  const end = frontmatterEnd(lines);
  const candidates = candidatesOf(sources);
  const noteIds = new Set(sources.notes.map((note) => note.id));
  const rowNumbers = new Set(sources.claims.map((row) => row.number));
  const hits: ClaimHit[] = [];
  let fenced = false;

  for (let i = end + 1; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || raw.trim() === "" || raw.trimStart().startsWith("#")) continue;

    for (const sentence of sentencesOf(raw)) {
      const targets = citationsIn(sentence);
      if (targets.length === 0 && !seam.isClaim(sentence)) continue;

      const resolves = (t: Target): boolean => (t.kind === "note" ? noteIds.has(t.id) : rowNumbers.has(t.number));
      if (targets.some(resolves)) continue;
      const dangling = targets.map((t) => (t.kind === "note" ? `[@${t.id}]` : `[#${t.number}]`));
      const danglingNote = dangling.length > 0 ? `; cites ${dangling.join(", ")}, which is no research note or claims row` : "";

      const best = nearest(contentWords(stripCitations(sentence)), candidates);
      const base = { path, line: i + 1, excerpt: excerptOf(sentence) };
      if (best !== undefined && best.score >= SUPPORT_THRESHOLD) {
        hits.push({ ...base, rule: "claim-uncited", detail: `traces to ${best.candidate.label}; cite ${best.candidate.cite.join(" or ")}${danglingNote}` });
      } else {
        const near = best !== undefined && best.score >= NEAREST_THRESHOLD ? `nearest source: ${best.candidate.label}` : "no candidate source";
        hits.push({ ...base, rule: "claim-unsupported", detail: `${near}${danglingNote}` });
      }
    }
  }
  return hits;
}

/** A work's claims rows (`core/claims.md`, absent reads as none) and research notes. */
export function readClaimSources(workDir: string): ClaimSources {
  const claimsPath = join(workDir, CLAIMS_FILE);
  return {
    claims: existsSync(claimsPath) ? parseClaims(readFileSync(claimsPath, "utf8")) : [],
    notes: readResearchNotes(workDir),
  };
}
