/**
 * `pablo save` (AGT-1233) — the agent's planning output (acts, beats, bible
 * facts) lands in the files the novel stage machine reads (see
 * `packages/cli/src/novel/machine.ts`, `pm project show ai-terminal`).
 *
 * `pablo save --project <slug> --stage acts|beats|premise|bible/<file> [--file <path>]`
 * reads stdin (or `--file`), validates it, and writes the target file for that
 * stage:
 *
 *  - `premise`     replaces `bible/overview.md` whole.
 *  - `acts`        replaces the acts table in the beats file.
 *  - `beats`       replaces the chapter table in the beats file.
 *    (The beats file is `outline/beats.md`; an unmigrated work's is still
 *    `outline/chapters.md`, see core's `beatsFile`.)
 *  - `bible/<file>` replaces `bible/<file>` whole (must stay under `bible/`,
 *    `.md` only).
 *
 * A nonfiction work (AGT-2101, `pablo.json` `track: "nonfiction"`) has its
 * own core instead (`core/nonfiction.ts`), and its own stages:
 *
 *  - `thesis`      replaces `core/thesis.md` whole (refused when empty).
 *  - `claims`      replaces the `| # | Claim | Sources |` table in
 *                  `core/claims.md`; every claim cites at least one research
 *                  note id (`research/<id>.md`).
 *  - `outline`     replaces the `| # | Section | What it covers |` table in
 *                  `core/outline.md`.
 *
 * Each track refuses the other's stages, naming the stages it takes.
 *
 * Validation runs before any write — a malformed table is refused (exit 2)
 * naming the row and column, and nothing is written. The touched file is
 * committed by pathspec (never `git add -A`); a git failure is a `notice` on
 * an otherwise-successful result, never a thrown exception — see
 * `gitCommit` in `./init.ts`, reused here rather than duplicated.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { beatsFile } from "@openthink/pablo-core";
import { CLAIMS_FILE, OUTLINE_FILE, parseSources, THESIS_FILE } from "./core/nonfiction";
import { gitCommit } from "./init";
import { readMarker, trackOf } from "./marker";
import type { TrackId } from "./tracks/registry";

const ACTS_HEADER = "| Act | Years | What it accomplishes |";
const ACTS_SEP = "|---|---|---|";
const ACTS_COLUMNS = 3;

const BEATS_HEADER = "| # | Story date | Title (working) | Beat | POV | Status |";
const BEATS_SEP = "|---|---|---|---|---|---|";
const BEATS_COLUMNS = 6;

const CLAIMS_HEADER = "| # | Claim | Sources |";
const CLAIMS_SEP = "|---|---|---|";
const CLAIMS_COLUMNS = 3;

const OUTLINE_HEADER = "| # | Section | What it covers |";
const OUTLINE_SEP = "|---|---|---|";
const OUTLINE_COLUMNS = 3;

/** The `--stage` values each kind of core takes, as usage text. */
const FICTION_STAGES = "acts|beats|premise|bible/<file>";
const NONFICTION_STAGES = "thesis|claims|outline";

/** Exit codes — mirrors `cli.ts`'s contract (0 ok, 2 refused, 1 error). */
export const SAVE_EXIT_OK = 0;
export const SAVE_EXIT_REFUSED = 2;
export const SAVE_EXIT_ERROR = 1;

export interface SaveOptions {
  readonly stage: string | undefined;
  readonly file: string | undefined;
  readonly json: boolean;
}

type StageKind = "premise" | "acts" | "beats" | "bible" | "thesis" | "claims" | "outline";

export interface StageTarget {
  readonly kind: StageKind;
  readonly absPath: string;
  /** Work-relative, forward-slash (e.g. `outline/chapters.md`). */
  readonly relPath: string;
}

type StageTargetResult = { readonly ok: true; readonly target: StageTarget } | { readonly ok: false; readonly message: string };

/**
 * Resolves `--stage` to the file it targets, refusing (with a message, never
 * a throw) an unknown stage or a `bible/<file>` path that isn't `.md`, tries
 * to escape `bible/`, or is absolute.
 */
export function resolveStageTarget(projectPath: string, stage: string, track: TrackId = "fiction"): StageTargetResult {
  if (track === "nonfiction") {
    const rel = stage === "thesis" ? THESIS_FILE : stage === "claims" ? CLAIMS_FILE : stage === "outline" ? OUTLINE_FILE : undefined;
    if (rel === undefined) {
      return { ok: false, message: `pablo: save: a nonfiction work's --stage is ${NONFICTION_STAGES} (got "${stage}")` };
    }
    return { ok: true, target: { kind: stage as StageKind, absPath: join(projectPath, rel), relPath: rel } };
  }
  if (stage === "thesis" || stage === "claims" || stage === "outline") {
    return { ok: false, message: `pablo: save: --stage ${stage} is a nonfiction stage; a ${track} work's --stage is ${FICTION_STAGES}` };
  }
  if (stage === "premise") {
    return { ok: true, target: { kind: "premise", absPath: join(projectPath, "bible", "overview.md"), relPath: "bible/overview.md" } };
  }
  if (stage === "acts" || stage === "beats") {
    // The beats file: `outline/beats.md` on a migrated work, the old name on an unmigrated one.
    const relPath = beatsFile(projectPath);
    return { ok: true, target: { kind: stage, absPath: join(projectPath, relPath), relPath } };
  }

  if (stage.startsWith("bible/")) {
    const rest = stage.slice("bible/".length);
    if (rest === "" || !rest.endsWith(".md")) {
      return { ok: false, message: `pablo: save: invalid --stage "${stage}" (bible/<file> must name a .md file)` };
    }
    if (rest.includes("..") || isAbsolute(rest)) {
      return { ok: false, message: `pablo: save: invalid --stage "${stage}" (must stay under bible/)` };
    }

    const bibleDir = resolve(join(projectPath, "bible"));
    const absPath = join(bibleDir, rest);
    if (resolve(absPath) !== absPath || (resolve(absPath) + sep).indexOf(bibleDir + sep) !== 0) {
      return { ok: false, message: `pablo: save: invalid --stage "${stage}" (resolves outside bible/)` };
    }

    return { ok: true, target: { kind: "bible", absPath, relPath: `bible/${rest}` } };
  }

  return {
    ok: false,
    message: `pablo: save: --stage expects ${FICTION_STAGES} (got "${stage}")`,
  };
}

type SaveInputResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: 1 | 2; readonly message: string };

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reads `--file` if given, else stdin to end. Refuses (exit 2) when stdin is
 * a TTY and no `--file` was given — there is nothing to read and blocking on
 * a terminal would hang. `readFileSync(0, ...)` (not `Bun.stdin.text()`,
 * which is async) is what lets `runSave` stay synchronous.
 */
export function readSaveInput(file: string | undefined): SaveInputResult {
  if (file !== undefined) {
    try {
      return { ok: true, text: readFileSync(file, "utf8") };
    } catch (err) {
      return { ok: false, code: 1, message: `pablo: save: could not read --file ${file}: ${errMessage(err)}` };
    }
  }

  if (process.stdin.isTTY) {
    return {
      ok: false,
      code: 2,
      message: "pablo: save: reading from a terminal — pipe input or pass --file <path>",
    };
  }

  try {
    return { ok: true, text: readFileSync(0, "utf8") };
  } catch (err) {
    return { ok: false, code: 1, message: `pablo: save: could not read stdin: ${errMessage(err)}` };
  }
}

/** `| a | b | c |` (leading/trailing pipes optional) -> `["a", "b", "c"]`, cells trimmed. */
function cellsOf(line: string): string[] {
  let inner = line.trim();
  if (inner.startsWith("|")) inner = inner.slice(1);
  if (inner.endsWith("|")) inner = inner.slice(0, -1);
  return inner.split("|").map((cell) => cell.trim());
}

/** True if every cell is a run of `-` (optionally `:`-anchored) — a table separator row. */
function isSeparatorLine(line: string): boolean {
  const cells = cellsOf(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/**
 * The input's data rows, header/separator stripped if present. The input may
 * be a full table (header + separator + rows) or rows only — detected by the
 * first pipe-line's first cell matching `firstCellExpected` (case-insensitive),
 * which is the header text `save` itself always writes, so this never
 * misfires on a data row (a chapter number, a roman numeral).
 */
export function extractDataRows(text: string, firstCellExpected: string): string[][] {
  const pipeLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));

  if (pipeLines.length === 0) return [];

  let lines = pipeLines;
  const firstCell = (cellsOf(lines[0]!)[0] ?? "").toLowerCase();
  if (firstCell === firstCellExpected.toLowerCase()) {
    lines = lines.slice(1);
    if (lines.length > 0 && isSeparatorLine(lines[0]!)) lines = lines.slice(1);
  }

  return lines.map(cellsOf);
}

type ValidationResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

/** `acts` rows: exactly 3 cells (Act, Years, What it accomplishes). */
export function validateActsRows(rows: readonly string[][]): ValidationResult {
  for (let i = 0; i < rows.length; i++) {
    const n = i + 1;
    const cells = rows[i]!;
    if (cells.length !== ACTS_COLUMNS) {
      return {
        ok: false,
        message: `pablo: save: row ${n}, column ${ACTS_COLUMNS}: expected ${ACTS_COLUMNS} columns, got ${cells.length}`,
      };
    }
  }
  return { ok: true };
}

/**
 * `beats` rows: exactly 6 cells; column 1 (`#`) a positive integer; column 2
 * (story date) contains a four-digit year.
 */
export function validateBeatsRows(rows: readonly string[][]): ValidationResult {
  for (let i = 0; i < rows.length; i++) {
    const n = i + 1;
    const cells = rows[i]!;
    if (cells.length !== BEATS_COLUMNS) {
      return {
        ok: false,
        message: `pablo: save: row ${n}, column ${BEATS_COLUMNS}: expected ${BEATS_COLUMNS} columns, got ${cells.length}`,
      };
    }
    if (!/^\d+$/.test(cells[0]!) || Number(cells[0]) < 1) {
      return {
        ok: false,
        message: `pablo: save: row ${n}, column 1: chapter number must be a positive integer (got "${cells[0]}")`,
      };
    }
    if (!/\d{4}/.test(cells[1]!)) {
      return {
        ok: false,
        message: `pablo: save: row ${n}, column 2: story date must contain a four-digit year (got "${cells[1]}")`,
      };
    }
  }
  return { ok: true };
}

/** `claims` rows: exactly 3 cells; `#` a positive integer; a claim; at least one research note id. */
export function validateClaimsRows(rows: readonly string[][]): ValidationResult {
  if (rows.length === 0) return { ok: false, message: "pablo: save: claims: no claim rows (| # | Claim | Sources |)" };
  for (let i = 0; i < rows.length; i++) {
    const n = i + 1;
    const cells = rows[i]!;
    if (cells.length !== CLAIMS_COLUMNS) {
      return { ok: false, message: `pablo: save: row ${n}, column ${CLAIMS_COLUMNS}: expected ${CLAIMS_COLUMNS} columns, got ${cells.length}` };
    }
    if (!/^\d+$/.test(cells[0]!) || Number(cells[0]) < 1) {
      return { ok: false, message: `pablo: save: row ${n}, column 1: claim number must be a positive integer (got "${cells[0]}")` };
    }
    if (cells[1] === "") return { ok: false, message: `pablo: save: row ${n}, column 2: the claim is empty` };
    if (parseSources(cells[2]!).length === 0) {
      return { ok: false, message: `pablo: save: row ${n}, column 3: a claim must cite at least one research note id (research/<id>.md)` };
    }
  }
  return { ok: true };
}

/** `outline` rows: exactly 3 cells; `#` a positive integer; a section title. */
export function validateOutlineRows(rows: readonly string[][]): ValidationResult {
  if (rows.length === 0) return { ok: false, message: "pablo: save: outline: no section rows (| # | Section | What it covers |)" };
  for (let i = 0; i < rows.length; i++) {
    const n = i + 1;
    const cells = rows[i]!;
    if (cells.length !== OUTLINE_COLUMNS) {
      return { ok: false, message: `pablo: save: row ${n}, column ${OUTLINE_COLUMNS}: expected ${OUTLINE_COLUMNS} columns, got ${cells.length}` };
    }
    if (!/^\d+$/.test(cells[0]!) || Number(cells[0]) < 1) {
      return { ok: false, message: `pablo: save: row ${n}, column 1: section number must be a positive integer (got "${cells[0]}")` };
    }
    if (cells[1] === "") return { ok: false, message: `pablo: save: row ${n}, column 2: the section title is empty` };
  }
  return { ok: true };
}

/** Replaces the first `| # |` table in `text`, else appends a `## <heading>` section holding it (a fresh file gets `# <title>` first). */
function replaceOrAppendNumberedTable(text: string, title: string, heading: string, tableText: string): string {
  const lines = text.split("\n");
  const span = findTable(lines, "#", 0);
  if (span !== undefined) return spliceTable(lines, span, tableText);
  return appendSection(text.trim() === "" ? `# ${title}\n` : text, heading, tableText);
}

function buildTable(header: string, separator: string, rows: readonly string[][]): string {
  const body = rows.map((cells) => `| ${cells.join(" | ")} |`);
  return [header, separator, ...body].join("\n");
}

interface TableSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * The first table in `lines` (from `fromIndex`) whose header row's first cell
 * matches `firstCellExpected` (case-insensitive) and is followed by a
 * separator row. `end` is exclusive — the first line after the contiguous
 * run of `|`-prefixed rows.
 */
function findTable(lines: readonly string[], firstCellExpected: string, fromIndex: number): TableSpan | undefined {
  for (let i = fromIndex; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim().startsWith("|")) continue;
    const firstCell = (cellsOf(line)[0] ?? "").toLowerCase();
    if (firstCell !== firstCellExpected.toLowerCase()) continue;
    const sepLine = lines[i + 1];
    if (sepLine === undefined || !isSeparatorLine(sepLine)) continue;

    let end = i + 2;
    while (end < lines.length && lines[end]!.trim().startsWith("|")) end++;
    return { start: i, end };
  }
  return undefined;
}

/** Splices `tableText` into `lines[span.start, span.end)`, everything else untouched. */
function spliceTable(lines: readonly string[], span: TableSpan, tableText: string): string {
  return [...lines.slice(0, span.start), ...tableText.split("\n"), ...lines.slice(span.end)].join("\n");
}

/** Inserts `tableText` right after `lines[headingIndex]`, everything else untouched. */
function insertAfterHeading(lines: readonly string[], headingIndex: number, tableText: string): string {
  return [...lines.slice(0, headingIndex + 1), "", ...tableText.split("\n"), ...lines.slice(headingIndex + 1)].join("\n");
}

/** Appends a brand-new `## <heading>` section (with `tableText`) to the end of `text`. */
function appendSection(text: string, heading: string, tableText: string): string {
  const trimmed = text.replace(/\s+$/, "");
  const sep = trimmed.length > 0 ? "\n\n" : "";
  return `${trimmed}${sep}${heading}\n\n${tableText}\n`;
}

/**
 * `acts` -> `outline/chapters.md`: replaces the first `| Act | ... |` table
 * found after a heading matching `/^## .*acts/i`. If that heading exists but
 * has no table yet, the table is inserted right after it. If no such heading
 * exists at all, a new `## The acts` section is appended.
 */
export function replaceOrInsertActsTable(outlineText: string, tableText: string): string {
  const lines = outlineText.split("\n");
  const headingIndex = lines.findIndex((line) => /^## .*acts/i.test(line));

  if (headingIndex === -1) {
    return appendSection(outlineText, "## The acts", tableText);
  }

  const span = findTable(lines, "act", headingIndex + 1);
  if (span === undefined) {
    return insertAfterHeading(lines, headingIndex, tableText);
  }
  return spliceTable(lines, span, tableText);
}

/**
 * `beats` -> `outline/chapters.md`: replaces the first table anywhere in the
 * file whose header row starts with `| # |`. If none exists yet, the table is
 * inserted under the first `## Act` heading, or a new `## Act I` section is
 * appended if there is no such heading either.
 */
export function replaceOrInsertBeatsTable(outlineText: string, tableText: string): string {
  const lines = outlineText.split("\n");
  const span = findTable(lines, "#", 0);
  if (span !== undefined) {
    return spliceTable(lines, span, tableText);
  }

  const headingIndex = lines.findIndex((line) => /^##\s*Act\b/i.test(line));
  if (headingIndex === -1) {
    return appendSection(outlineText, "## Act I", tableText);
  }
  return insertAfterHeading(lines, headingIndex, tableText);
}

type BuildContentResult = { readonly ok: true; readonly content: string } | { readonly ok: false; readonly message: string };

/** Whole-file content for `premise`/`bible/<file>`: the input, with exactly one trailing newline. */
function wholeFileContent(rawInput: string): string {
  return rawInput.endsWith("\n") ? rawInput : `${rawInput}\n`;
}

/**
 * Builds the new file content for `target` from `rawInput`, validating table
 * input first — a validation failure is returned, never written.
 * `existingText` is the file's current content (`""` when it doesn't exist
 * yet, e.g. a fresh template) for the `acts`/`beats` table-replace path.
 */
export function buildContent(target: StageTarget, rawInput: string, existingText: string): BuildContentResult {
  if (target.kind === "premise" || target.kind === "bible") {
    return { ok: true, content: wholeFileContent(rawInput) };
  }

  if (target.kind === "thesis") {
    if (rawInput.trim() === "") return { ok: false, message: "pablo: save: thesis: the input is empty" };
    return { ok: true, content: wholeFileContent(rawInput) };
  }

  if (target.kind === "claims" || target.kind === "outline") {
    const claims = target.kind === "claims";
    const rows = extractDataRows(rawInput, "#");
    const validated = claims ? validateClaimsRows(rows) : validateOutlineRows(rows);
    if (!validated.ok) return validated;
    const table = claims ? buildTable(CLAIMS_HEADER, CLAIMS_SEP, rows) : buildTable(OUTLINE_HEADER, OUTLINE_SEP, rows);
    const content = claims
      ? replaceOrAppendNumberedTable(existingText, "Claims", "## Claims", table)
      : replaceOrAppendNumberedTable(existingText, "Outline", "## Sections", table);
    return { ok: true, content };
  }

  if (target.kind === "acts") {
    const rows = extractDataRows(rawInput, "act");
    const validated = validateActsRows(rows);
    if (!validated.ok) return validated;
    const table = buildTable(ACTS_HEADER, ACTS_SEP, rows);
    return { ok: true, content: replaceOrInsertActsTable(existingText, table) };
  }

  // beats
  const rows = extractDataRows(rawInput, "#");
  const validated = validateBeatsRows(rows);
  if (!validated.ok) return validated;
  const table = buildTable(BEATS_HEADER, BEATS_SEP, rows);
  return { ok: true, content: replaceOrInsertBeatsTable(existingText, table) };
}

function emitRefusal(json: boolean, code: number, message: string): number {
  if (json) {
    console.log(JSON.stringify({ ok: false, code, message }));
  } else {
    console.error(message);
  }
  return code;
}

function emitOk(json: boolean, stage: string, path: string, committed: boolean, notice: string | undefined): void {
  if (json) {
    const body: Record<string, unknown> = { ok: true, path, stage, committed };
    if (notice) body["notice"] = notice;
    console.log(JSON.stringify(body));
    return;
  }
  console.log(`saved ${stage} -> ${path}`);
  if (notice) console.log(notice);
}

/** `runSave`'s options minus `json` — the fields `saveCore` needs to do the actual work. */
export interface SaveCoreOptions {
  readonly stage: string | undefined;
  readonly file: string | undefined;
}

/** A refusal body, the exact shape `--json`/MCP print — `{ok:false, code, message}`, no `tried` (save never resolves a project path itself). */
export interface SaveRefusalBody {
  readonly ok: false;
  readonly code: number;
  readonly message: string;
}

/** A success body, the exact shape `--json`/MCP print. */
export interface SaveSuccessBody {
  readonly ok: true;
  readonly path: string;
  readonly stage: string;
  readonly committed: boolean;
  readonly notice?: string;
}

export type SaveBody = SaveRefusalBody | SaveSuccessBody;

export interface SaveOutcome {
  readonly body: SaveBody;
  readonly exitCode: number;
}

/**
 * The pure core of `pablo save`: validates `--stage`, reads the input,
 * validates/builds the target file's content, writes it, and commits it by
 * pathspec — everything `runSave` used to do, minus the printing. Returns the
 * exact `--json` body (never throws), so both `runSave` (CLI, prints prose or
 * JSON from this) and `verbs.ts` (MCP, returns this verbatim) share one
 * implementation — the two cannot drift.
 */
export function saveCore(options: SaveCoreOptions, projectPath: string): SaveOutcome {
  const { stage, file } = options;

  if (stage === undefined) {
    return {
      body: { ok: false, code: SAVE_EXIT_REFUSED, message: `pablo: save requires --stage ${FICTION_STAGES} (nonfiction: ${NONFICTION_STAGES})` },
      exitCode: SAVE_EXIT_REFUSED,
    };
  }

  // The track picks the stages (AGT-2101); a work whose marker cannot be read saves as fiction, as before.
  const marker = readMarker(projectPath);
  const track = marker.ok ? trackOf(marker.marker) : "fiction";
  const targetResult = resolveStageTarget(projectPath, stage, track);
  if (!targetResult.ok) {
    return { body: { ok: false, code: SAVE_EXIT_REFUSED, message: targetResult.message }, exitCode: SAVE_EXIT_REFUSED };
  }
  const target = targetResult.target;

  const inputResult = readSaveInput(file);
  if (!inputResult.ok) {
    return { body: { ok: false, code: inputResult.code, message: inputResult.message }, exitCode: inputResult.code };
  }

  const existingText = existsSync(target.absPath) ? readFileSync(target.absPath, "utf8") : "";
  const built = buildContent(target, inputResult.text, existingText);
  if (!built.ok) {
    return { body: { ok: false, code: SAVE_EXIT_REFUSED, message: built.message }, exitCode: SAVE_EXIT_REFUSED };
  }

  mkdirSync(dirname(target.absPath), { recursive: true });
  writeFileSync(target.absPath, built.content, "utf8");

  const commitMessage = `${basename(projectPath)}: save ${stage}`;
  const { committed, notice } = gitCommit(projectPath, commitMessage, [target.absPath]);

  const body: SaveSuccessBody = { ok: true, path: target.relPath, stage, committed };
  return { body: notice ? { ...body, notice } : body, exitCode: SAVE_EXIT_OK };
}

/**
 * `pablo save --project <slug> --stage <stage> [--file <path>]`. `projectPath`
 * is already resolved and marker-checked by `cli.ts`'s shared dispatch (the
 * same gate every verb but `init` goes through). Synchronous throughout, per
 * the ticket's constraint — no `await Bun.stdin.text()`. Delegates the actual
 * work to `saveCore` (shared with MCP) and only handles prose/JSON printing.
 */
export function runSave(options: SaveOptions, projectPath: string): number {
  const { json, ...core } = options;
  const { body, exitCode } = saveCore(core, projectPath);

  if (!body.ok) {
    return emitRefusal(json, body.code, body.message);
  }

  emitOk(json, body.stage, body.path, body.committed, body.notice);
  return exitCode;
}
