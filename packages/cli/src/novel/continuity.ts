/**
 * `runContinuity` (AGT-1232): the ritual `continuity.md` needed since AGT-1231
 * shipped and deliberately left it out — extraction was "a ritual no model ran
 * on its own." After a chapter lands, this asks the routed extraction adapter
 * for `extract_facts` with anchors (core's `Adapter.extractFactsWithAnchors`),
 * matches each anchor into the chapter body whitespace-insensitively, and
 * files the fact under the matching heading of `continuity.md` — or, when the
 * anchor can't be found, under `## Check`, never dropped.
 *
 * `applyFacts` is the pure core: text in, text out, no I/O, so the heading
 * routing and anchor matching are unit-testable without a model or a
 * filesystem. `runContinuity` is the ritual wrapper: reads/writes
 * `continuity.md`, calls the adapter with a 120s ceiling (`Promise.race`,
 * injectable), and writes a receipt — the extraction call is receipted like
 * any other model call, even though `withReceipts` (core's `pack/receipts.ts`)
 * only wraps `complete`, `proposeEdit` and `extractFacts`, not the optional
 * `extractFactsWithAnchors`. Rather than extend core's receipt wrapper for one
 * caller, this builds the same `Receipt` shape by hand and sends it to the
 * same `fileReceiptSink` — see the doc comment on `writeContinuityReceipt`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Adapter, ExtractedFact, Receipt } from "@openthink/pablo-core";
import { estimateTokens, fileReceiptSink, hashPrompt } from "@openthink/pablo-core";
import type { Ritual } from "./rituals";

export interface ApplyFactsResult {
  readonly text: string;
  /** Facts appended under one of the four real headings (anchor found). */
  readonly placed: number;
  /** Facts appended under `## Check` (anchor not found in the chapter body). */
  readonly unanchored: number;
}

export interface ContinuityOptions {
  /** The adapter to extract with; `undefined` means no extraction adapter was configured/injected. */
  readonly adapter: Adapter | undefined;
  /** Overrides the 120s ceiling the whole extraction+apply is raced against. */
  readonly timeoutMs?: number | undefined;
}

const DEFAULT_CONTINUITY_TIMEOUT_MS = 120_000;

/** The instruction sent with every extraction request — the ticket's exact wording. */
const EXTRACT_INSTRUCTION =
  "Extract every concrete fact the text establishes: names, ages, dates, objects, places, and who knows what. Quote the sentence that establishes each as its anchor.";

const NAMES_AGES_HEADING = "## Names and ages";
const DATES_HEADING = "## Dates";
const WHO_KNOWS_HEADING = "## Who knows what";
const OBJECTS_PLACES_HEADING = "## Objects and places";
const CHECK_HEADING = "## Check";

/** A number that reads as an age (1-3 digits), tested against an entity or the fact text. */
const AGE_LIKE_NUMBER = /\b\d{1,3}\b/;
const BORN_WORD = /\bborn\b/i;
const FOUR_DIGIT_YEAR = /\b\d{4}\b/;
const WHO_KNOWS_PATTERN = /knows|learns|tells|told|hears/i;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line ?? text.trim();
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Whether `anchor` (a substring the model claims establishes the fact) can be
 * found in `chapterBody`, both normalized with `s.replace(/\s+/g, " ").trim()`
 * first — the bench found a hard line wrap in the chapter is the only
 * legitimate reason a verbatim anchor otherwise fails to match.
 */
function anchorFound(chapterBody: string, anchor: string | undefined): boolean {
  if (anchor === undefined) return false;
  const normalizedAnchor = normalizeWhitespace(anchor);
  if (normalizedAnchor === "") return false;
  return normalizeWhitespace(chapterBody).includes(normalizedAnchor);
}

/**
 * Which heading an anchored fact files under. Checked in this fixed order,
 * first match wins: an entity or the fact text carrying an age-like number or
 * the word "born" is a name/age fact; a set `storyTime` or a four-digit year
 * in the fact text is a date; a fact describing what someone knows, learns,
 * tells, is told, or hears is a "who knows what" fact; everything else is an
 * object/place.
 */
function headingFor(fact: ExtractedFact): string {
  const namesAges =
    fact.entities.some((entity) => AGE_LIKE_NUMBER.test(entity) || BORN_WORD.test(entity)) || BORN_WORD.test(fact.fact);
  if (namesAges) return NAMES_AGES_HEADING;

  const isDate = (fact.storyTime !== undefined && fact.storyTime.trim() !== "") || FOUR_DIGIT_YEAR.test(fact.fact);
  if (isDate) return DATES_HEADING;

  if (WHO_KNOWS_PATTERN.test(fact.fact)) return WHO_KNOWS_HEADING;

  return OBJECTS_PLACES_HEADING;
}

/**
 * Finds `heading`'s section in `lines` (its line to the next `## ` heading or
 * EOF) and inserts `bulletLine` as the section's last line, preserving
 * everything else byte-for-byte. A missing heading is appended at EOF as
 * `heading`, a blank line, then `bulletLine` — matching the fixture's own
 * "heading, blank line, first bullet" shape.
 */
function insertUnderHeading(lines: readonly string[], heading: string, bulletLine: string): string[] {
  const headingIndex = lines.findIndex((line) => line.trim() === heading);

  if (headingIndex === -1) {
    const result = [...lines];
    while (result.length > 0 && (result[result.length - 1] ?? "") === "") result.pop();
    if (result.length > 0) result.push("");
    result.push(heading, "", bulletLine);
    return result;
  }

  let sectionEnd = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i] ?? "")) {
      sectionEnd = i;
      break;
    }
  }

  let insertAt = sectionEnd;
  for (let i = sectionEnd - 1; i > headingIndex; i--) {
    if ((lines[i] ?? "").trim() !== "") {
      insertAt = i + 1;
      break;
    }
  }

  const result = [...lines];
  result.splice(insertAt, 0, bulletLine);
  return result;
}

/**
 * The pure core of the ritual (AC2): places every fact in `facts` into
 * `continuityText` under the heading `headingFor` picks (anchored facts) or
 * `## Check` (unanchored — never dropped, AC2), as `- <fact> [chNN]` or
 * `- <fact> [chNN, anchor not found]`. A bullet that already exists verbatim
 * anywhere in the file is not duplicated (idempotent re-run on the same
 * chapter/facts). Everything else in the file is unchanged, byte-for-byte.
 */
export function applyFacts(
  continuityText: string,
  facts: readonly ExtractedFact[],
  chapterBody: string,
  chapter: number,
): ApplyFactsResult {
  const chapterTag = String(chapter).padStart(2, "0");
  let lines = continuityText.split("\n");
  let placed = 0;
  let unanchored = 0;

  for (const fact of facts) {
    const anchored = anchorFound(chapterBody, fact.anchor);
    const heading = anchored ? headingFor(fact) : CHECK_HEADING;
    const bulletLine = anchored ? `- ${fact.fact} [ch${chapterTag}]` : `- ${fact.fact} [ch${chapterTag}, anchor not found]`;

    if (lines.includes(bulletLine)) continue;

    lines = insertUnderHeading(lines, heading, bulletLine);
    if (anchored) placed += 1;
    else unanchored += 1;
  }

  return { text: lines.join("\n"), placed, unanchored };
}

/**
 * Writes the same `Receipt` shape `withReceipts` would (core's
 * `pack/receipts.ts`), by hand, straight to `fileReceiptSink(workDir)`.
 * `withReceipts` only wraps `complete`, `proposeEdit` and `extractFacts` —
 * `extractFactsWithAnchors` is optional on `Adapter` and core has no wrapper
 * for it. Extending `withReceipts` for a single caller would mean a new
 * method-shaped branch in a dependency-free package for one CLI ritual, so
 * this instead builds the receipt at the call site: same fields, same sink,
 * `measurement: "wall"` (nothing here streams), `pack_kind: null` and
 * `slices: []` (no `Pack` — the request is the raw chapter body, not an
 * assembled pack).
 */
function writeContinuityReceipt(
  workDir: string,
  adapter: Adapter,
  chapterBody: string,
  startedAt: number,
  error: string | null,
  factsText: string | undefined,
): void {
  const receipt: Receipt = {
    at: new Date().toISOString(),
    intent: "continuity",
    pack_kind: null,
    prompt_hash: hashPrompt(`${EXTRACT_INSTRUCTION}\n\n${chapterBody}`),
    slices: [],
    provider: adapter.id,
    model: adapter.model,
    params: {},
    tokens_read: estimateTokens(chapterBody) + estimateTokens(EXTRACT_INSTRUCTION),
    tokens_written: factsText === undefined ? null : estimateTokens(factsText),
    ttft_ms: null,
    gen_tok_s: null,
    wall_ms: Date.now() - startedAt,
    measurement: "wall",
    proposal: null,
    error,
  };
  fileReceiptSink(workDir)(receipt);
}

/** `[fact (entities) anchor]` joined per fact — what `writeContinuityReceipt`'s `tokens_written` estimates over. */
function factsSummaryText(facts: readonly ExtractedFact[]): string {
  return facts.map((f) => f.fact).join("\n");
}

/**
 * Runs the extraction ritual: no adapter, or one with no
 * `extractFactsWithAnchors`, is `"skipped"` (AC not applicable to that
 * provider) and never calls anything or writes a receipt. A missing
 * `continuity.md` is also `"skipped"` — nowhere to file a fact. Otherwise the
 * extraction call is raced against `timeoutMs` (default 120s); a throw or a
 * timeout is `"failed"` with a notice (AC3) and still writes an error
 * receipt, same as any other failed model call — the chapter write and the
 * other rituals stand regardless (this never throws out of `runRituals`).
 * A successful call that places nothing new (no facts, or every fact already
 * present) is `"skipped"`; otherwise `"ran"`, `continuity.md` updated,
 * receipted with `intent: "continuity"`.
 */
export async function runContinuity(
  workDir: string,
  chapter: number,
  chapterBody: string,
  opts: ContinuityOptions,
): Promise<Ritual> {
  if (opts.adapter === undefined) {
    return { name: "continuity", status: "skipped", detail: "no extraction adapter" };
  }
  if (opts.adapter.extractFactsWithAnchors === undefined) {
    return { name: "continuity", status: "skipped", detail: "provider has no anchored extraction" };
  }
  // Re-bound to concrete (non-optional) types once, so the nested closure
  // below doesn't rely on narrowing carrying across a function boundary —
  // TS doesn't do that for a plain `function` declaration.
  const adapter: Adapter = opts.adapter;
  const extract: NonNullable<Adapter["extractFactsWithAnchors"]> = opts.adapter.extractFactsWithAnchors;

  const path = join(workDir, "continuity.md");
  if (!existsSync(path)) {
    return { name: "continuity", status: "skipped", detail: "continuity.md not found" };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONTINUITY_TIMEOUT_MS;
  const startedAt = Date.now();

  async function attemptExtraction(): Promise<Ritual> {
    try {
      const facts = await extract({ text: chapterBody, instruction: EXTRACT_INSTRUCTION });
      writeContinuityReceipt(workDir, adapter, chapterBody, startedAt, null, factsSummaryText(facts));

      const existing = readFileSync(path, "utf8");
      const result = applyFacts(existing, facts, chapterBody, chapter);
      if (result.text === existing) {
        return { name: "continuity", status: "skipped", detail: "no new facts" };
      }

      writeFileSync(path, result.text, "utf8");
      return { name: "continuity", status: "ran", detail: `placed ${result.placed}, ${result.unanchored} to Check` };
    } catch (err) {
      const message = firstLine(errMessage(err));
      writeContinuityReceipt(workDir, adapter, chapterBody, startedAt, message, undefined);
      return { name: "continuity", status: "failed", detail: message };
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Ritual>((resolve) => {
    timer = setTimeout(() => {
      const detail = `timed out after ${Math.round(timeoutMs / 1000)}s`;
      writeContinuityReceipt(workDir, adapter, chapterBody, startedAt, detail, undefined);
      resolve({ name: "continuity", status: "failed", detail });
    }, timeoutMs);
  });

  const result = await Promise.race([attemptExtraction(), timedOut]);
  if (timer !== undefined) clearTimeout(timer);
  return result;
}
