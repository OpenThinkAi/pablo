/**
 * `pablo save` (AGT-1233) — the agent's planning output (acts, beats, bible
 * facts) lands in the files the novel stage machine reads (see
 * `packages/cli/src/novel/machine.ts`, `~/saltline-digital-vault/projects/ai-terminal/README.md`).
 *
 * `pablo save --project <slug> --stage acts|beats|premise|bible/<file> [--file <path>]`
 * reads stdin (or `--file`), validates it, and writes the target file for that
 * stage:
 *
 *  - `premise`     replaces `bible/overview.md` whole.
 *  - `acts`        replaces the acts table in `outline/chapters.md`.
 *  - `beats`       replaces the chapter table in `outline/chapters.md`.
 *  - `bible/<file>` replaces `bible/<file>` whole (must stay under `bible/`,
 *    `.md` only).
 *
 * Validation runs before any write — a malformed table is refused (exit 2)
 * naming the row and column, and nothing is written. The touched file is
 * committed by pathspec (never `git add -A`); a git failure is a `notice` on
 * an otherwise-successful result, never a thrown exception — see
 * `gitCommit` in `./init.ts`, reused here rather than duplicated.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { gitCommit } from "./init";

const ACTS_HEADER = "| Act | Years | What it accomplishes |";
const ACTS_SEP = "|---|---|---|";
const ACTS_COLUMNS = 3;

const BEATS_HEADER = "| # | Story date | Title (working) | Beat | POV | Status |";
const BEATS_SEP = "|---|---|---|---|---|---|";
const BEATS_COLUMNS = 6;

/** Exit codes — mirrors `cli.ts`'s contract (0 ok, 2 refused, 1 error). */
export const SAVE_EXIT_OK = 0;
export const SAVE_EXIT_REFUSED = 2;
export const SAVE_EXIT_ERROR = 1;

export interface SaveOptions {
  readonly stage: string | undefined;
  readonly file: string | undefined;
  readonly json: boolean;
}

type StageKind = "premise" | "acts" | "beats" | "bible";

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
export function resolveStageTarget(projectPath: string, stage: string): StageTargetResult {
  if (stage === "premise") {
    return { ok: true, target: { kind: "premise", absPath: join(projectPath, "bible", "overview.md"), relPath: "bible/overview.md" } };
  }
  if (stage === "acts") {
    return { ok: true, target: { kind: "acts", absPath: join(projectPath, "outline", "chapters.md"), relPath: "outline/chapters.md" } };
  }
  if (stage === "beats") {
    return { ok: true, target: { kind: "beats", absPath: join(projectPath, "outline", "chapters.md"), relPath: "outline/chapters.md" } };
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
    message: `pablo: save: --stage expects acts|beats|premise|bible/<file> (got "${stage}")`,
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

/**
 * `pablo save --project <slug> --stage <stage> [--file <path>]`. `projectPath`
 * is already resolved and marker-checked by `cli.ts`'s shared dispatch (the
 * same gate every verb but `init` goes through). Synchronous throughout, per
 * the ticket's constraint — no `await Bun.stdin.text()`.
 */
export function runSave(options: SaveOptions, projectPath: string): number {
  const { stage, file, json } = options;

  if (stage === undefined) {
    return emitRefusal(json, SAVE_EXIT_REFUSED, "pablo: save requires --stage acts|beats|premise|bible/<file>");
  }

  const targetResult = resolveStageTarget(projectPath, stage);
  if (!targetResult.ok) {
    return emitRefusal(json, SAVE_EXIT_REFUSED, targetResult.message);
  }
  const target = targetResult.target;

  const inputResult = readSaveInput(file);
  if (!inputResult.ok) {
    return emitRefusal(json, inputResult.code, inputResult.message);
  }

  const existingText = existsSync(target.absPath) ? readFileSync(target.absPath, "utf8") : "";
  const built = buildContent(target, inputResult.text, existingText);
  if (!built.ok) {
    return emitRefusal(json, SAVE_EXIT_REFUSED, built.message);
  }

  writeFileSync(target.absPath, built.content, "utf8");

  const commitMessage = `${basename(projectPath)}: save ${stage}`;
  const { committed, notice } = gitCommit(projectPath, commitMessage, [target.absPath]);

  emitOk(json, stage, target.relPath, committed, notice);
  return SAVE_EXIT_OK;
}
