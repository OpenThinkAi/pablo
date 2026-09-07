/**
 * `pablo check` (AGT-1234): provenance and mechanical-tells scanning.
 *
 * Two independent checks over a work's `chapters/*.md`:
 *
 * 1. **Provenance** — a chapter whose frontmatter lacks `model` or
 *    `prompt_hash` is "unprovenanced": prose the model never produced, or
 *    prose written before pablo tracked who wrote it.
 * 2. **Mechanical tells** — lines that trip a fixed rule set: em-dashes,
 *    curly quotes, dash year ranges, foreshadowing phrases, the banned stock
 *    names the style guide lists, and every `Flagged:` line in
 *    `<vault>/style/prose.md`, matched verbatim. See the design doc's
 *    "Voice" section (`~/saltline-digital-vault/projects/ai-terminal/README.md`)
 *    for where these rules come from — the guide's own flagged lines are "the
 *    best document in the vault and the pattern the rest follows."
 *
 * Voice-pattern scoring beyond verbatim flagged lines is P1, out of scope
 * here (AC3). `checkFile` and `checkWork` are pure/read-only and exported for
 * AGT-1237's `write` to call directly and put the hits in its receipt.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { TextSource } from "@openthink/pablo-core";
import { parseFrontmatter } from "./novel/machine";

/** One mechanical-tell or flagged-line match. `detail` disambiguates which stock name matched when `rule` is `"stock-name"`. */
export interface Hit {
  readonly path: string;
  readonly line: number;
  readonly rule: string;
  readonly excerpt: string;
  readonly detail?: string;
}

/** The rules `loadCheckRules` reads out of the vault's style guide. */
export interface CheckRules {
  readonly stockNames: readonly string[];
  readonly flaggedLines: readonly string[];
}

/** The result of scanning a work: always `ok: true` once the file selection resolves — a hit is data, not a failure (AC3). */
export interface CheckSuccess {
  readonly ok: true;
  readonly code: 0;
  readonly hits: readonly Hit[];
  readonly unprovenanced: readonly string[];
}

/** A resolution refusal before any scanning happens — the one case `checkWork`/`runCheck` exit non-zero (a `--file` outside the work). */
export interface CheckRefusal {
  readonly ok: false;
  readonly code: 2;
  readonly message: string;
  readonly tried: readonly string[];
}

export type CheckOutcome = CheckSuccess | CheckRefusal;

const EXCERPT_MAX = 120;
const REQUIRED_PROVENANCE_KEYS = ["model", "prompt_hash"] as const;

const MECHANICAL_RULES: ReadonlyArray<{ readonly rule: string; readonly regex: RegExp }> = [
  { rule: "em-dash", regex: /—/ },
  { rule: "en-dash", regex: /–/ },
  { rule: "curly-quote", regex: /[“”‘’]/ },
  { rule: "dash-year-range", regex: /\b(1[89]|20)\d\d\s*[-–—]\s*(1[89]|20)\d\d\b/ },
  {
    rule: "foreshadow",
    regex:
      /\b(little did (he|she|they)|it would be years before|this was the beginning of|in that moment|a testament to|a reminder that)\b/i,
  },
];

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function stripQuotesAndBackticks(text: string): string {
  return text.trim().replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "").trim();
}

function excerptOf(line: string): string {
  const trimmed = line.trim();
  return trimmed.length <= EXCERPT_MAX ? trimmed : trimmed.slice(0, EXCERPT_MAX);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Names out of a comma-separated list: strips a trailing/embedded
 * parenthetical (e.g. `"Elias (as a default)"` -> `"Elias"`), surrounding
 * quotes/backticks, and a trailing sentence period.
 */
function namesFromList(raw: string): string[] {
  return raw
    .split(",")
    .map((token) =>
      collapseWhitespace(
        token
          .replace(/\([^()]*\)/g, "")
          .replace(/[“”‘’"'`]/g, "")
          .replace(/\.\s*$/, ""),
      ),
    )
    .filter((token) => token !== "");
}

/**
 * The parenthesized comma-list immediately after a "stock" mention — the
 * shape both the real vault and the fixture use for the banned-name list
 * embedded in a sentence (e.g. `"No stock fiction names (Blackwood, Thorne,
 * Vance)."`). Anchored to "stock" (not "any parenthesized comma-list in the
 * section") for two reasons: the `## Names` section also carries prose like
 * "for 1920s Napa that means Italian, Swiss, German ..." describing where to
 * draw names FROM, and the real vault's `## Names` section goes on to a
 * `Flagged:` example whose own explanatory aside
 * ("(both were named Miller, and the text patched it instead of renaming
 * one)") also has a parenthesized comma-list — neither is the ban list.
 */
function stockNameParenListsIn(text: string): string[] {
  const lists: string[] = [];
  const re = /stock[^()]{0,80}\(([^()]*,[^()]*)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match[1] !== undefined) lists.push(match[1]);
  }
  return lists;
}

/** The `## Names` section of `prose.md`: from the heading to the next `## ` heading, or end of file. */
function namesSection(prose: string): string {
  const heading = "## Names";
  const at = prose.indexOf(heading);
  if (at < 0) return "";
  const rest = prose.slice(at + heading.length);
  const next = /\n##\s/.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/**
 * Names out of the `- Stock names: ...` bullet in `anti-tells.md`
 * (case-insensitive label) — everything after the label's colon, comma-split.
 * Unlike `## Names`, this line's whole purpose is the ban list, so no
 * parenthesized-only restriction is needed here.
 */
function stockNamesFromBullet(antiTells: string): string[] {
  for (const line of antiTells.split("\n")) {
    const match = /^\s*-\s*stock names\s*:\s*(.+)$/i.exec(line);
    if (match?.[1] !== undefined) return namesFromList(match[1]);
  }
  return [];
}

/** The first quoted substring on a line, or (when no closing quote is on the same physical line) the whole remainder, quotes/backticks stripped. */
function extractFlaggedText(afterLabel: string): string {
  const quoted = /"([^"]*)"/.exec(afterLabel);
  if (quoted?.[1] !== undefined && quoted[1].trim() !== "") return collapseWhitespace(quoted[1]);
  return collapseWhitespace(stripQuotesAndBackticks(afterLabel));
}

/** Every `Flagged: "..."` line in `prose.md`, label and surrounding quotes/backticks stripped, whitespace-collapsed. */
function flaggedLinesIn(prose: string): string[] {
  const lines: string[] = [];
  for (const rawLine of prose.split("\n")) {
    const match = /^\s*Flagged:\s*(.*)$/.exec(rawLine);
    if (match === null) continue;
    const text = extractFlaggedText(match[1] ?? "");
    if (text !== "") lines.push(text);
  }
  return lines;
}

/**
 * Loads `stockNames` (the `## Names` section of `<vaultRoot>/style/prose.md`
 * plus the `"Stock names"` bullet in `anti-tells.md`, de-duplicated) and
 * `flaggedLines` (every `Flagged:` line in `prose.md`). Missing files read as
 * empty text — a vault without a style guide yet just has no rules, not an
 * error.
 */
export function loadCheckRules(vaultRoot: string): CheckRules {
  const prose = read(join(vaultRoot, "style", "prose.md"));
  const antiTells = read(join(vaultRoot, "style", "anti-tells.md"));

  const names = new Set<string>();
  for (const list of stockNameParenListsIn(namesSection(prose))) {
    for (const name of namesFromList(list)) names.add(name);
  }
  for (const name of stockNamesFromBullet(antiTells)) names.add(name);

  return { stockNames: [...names], flaggedLines: flaggedLinesIn(prose) };
}

/**
 * The same rules, read out of a resolved voice's own text instead of a vault's
 * `style/` directory (AGT-1242): every `Flagged:` line in the voice's rules,
 * plus the stock names its `## Names` section or `Stock names:` bullet lists.
 *
 * One parser, two sources — the `Flagged:`/`## Names`/`Stock names:` grammar
 * above is not duplicated here, so a voice's flagged line and the fiction
 * style guide's are recognised identically. The `fiction` voice needs no
 * special case at all: `readVoice` gives it `style/*.md` as its rules
 * (`readStyle`), so `prose.md`'s flagged lines AND `anti-tells.md`'s stock-name
 * bullet arrive here as ordinary voice rules.
 */
export function checkRulesFromVoice(voice: { readonly rules: readonly TextSource[] }): CheckRules {
  const text = voice.rules.map((rule) => rule.text).join("\n\n");

  const names = new Set<string>();
  for (const list of stockNameParenListsIn(namesSection(text))) {
    for (const name of namesFromList(list)) names.add(name);
  }
  for (const name of stockNamesFromBullet(text)) names.add(name);

  return { stockNames: [...names], flaggedLines: flaggedLinesIn(text) };
}

/** 0-based index of the closing `---` line of a leading frontmatter block, or `-1` if `text` has none. */
function frontmatterEndIndex(lines: readonly string[]): number {
  if ((lines[0] ?? "").trim() !== "---") return -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") return i;
  }
  return -1;
}

/**
 * Scans `text` (a chapter file's full contents, `path` its report label)
 * against `rules`, line by line, skipping the frontmatter block. One hit per
 * `(line, rule)` for the mechanical rules and `flagged-line` — repeated
 * matches on one line count once — but each matching stock name gets its own
 * hit (`rule: "stock-name"`, the name in `detail` and in `excerpt`, since
 * `excerpt` is just the line). Pure: no disk I/O.
 */
export function checkFile(text: string, path: string, rules: CheckRules): Hit[] {
  const lines = text.split("\n");
  const frontmatterEnd = frontmatterEndIndex(lines);
  const hits: Hit[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (i <= frontmatterEnd) continue;
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const lineNumber = i + 1;
    const excerpt = excerptOf(line);

    for (const { rule, regex } of MECHANICAL_RULES) {
      if (regex.test(line)) hits.push({ path, line: lineNumber, rule, excerpt });
    }

    for (const name of rules.stockNames) {
      if (new RegExp(`\\b${escapeRegex(name)}\\b`).test(line)) {
        hits.push({ path, line: lineNumber, rule: "stock-name", excerpt, detail: name });
      }
    }

    const collapsedLine = collapseWhitespace(line);
    for (const flagged of rules.flaggedLines) {
      if (flagged !== "" && collapsedLine.includes(flagged)) {
        hits.push({ path, line: lineNumber, rule: "flagged-line", excerpt });
      }
    }
  }

  return hits;
}

/**
 * `true` when `text`'s frontmatter is missing, has no `model`, or has no
 * `prompt_hash` — the AC1 provenance gate. Reuses `parseFrontmatter` from the
 * novel stage machine rather than a second hand parser.
 */
export function isUnprovenanced(text: string): boolean {
  const fields = parseFrontmatter(text);
  return REQUIRED_PROVENANCE_KEYS.some((key) => (fields[key] ?? "") === "");
}

/**
 * Resolves which file(s) to scan, loads the vault's rules, and runs
 * `checkFile` + `isUnprovenanced` over each. `file`, when given, may be
 * work-relative or absolute — it must resolve inside `workDir`, or this
 * refuses (exit 2) instead of scanning outside the work. With no `file`,
 * every `chapters/*.md` file is scanned, sorted by name.
 *
 * Otherwise always succeeds with exit 0 (AC3): a hit, or an unprovenanced
 * file, is data the scan reports, never a reason to fail. AGT-1237's `write`
 * calls this (or `checkFile` directly) to put a chapter's hits in its
 * receipt.
 */
export function checkWork(vaultRoot: string, workDir: string, file?: string): CheckOutcome {
  let filePaths: string[];

  if (file !== undefined) {
    const resolved = isAbsolute(file) ? resolve(file) : resolve(workDir, file);
    const rel = relative(workDir, resolved);
    if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
      return {
        ok: false,
        code: 2,
        message: `pablo: check --file ${file} resolves outside the work (${workDir})`,
        tried: [resolved],
      };
    }
    if (!existsSync(resolved)) {
      return {
        ok: false,
        code: 2,
        message: `pablo: check --file ${file} does not exist (${resolved})`,
        tried: [resolved],
      };
    }
    filePaths = [resolved];
  } else {
    const chaptersDir = join(workDir, "chapters");
    filePaths = existsSync(chaptersDir)
      ? readdirSync(chaptersDir)
          .filter((name) => name.endsWith(".md"))
          .sort()
          .map((name) => join(chaptersDir, name))
      : [];
  }

  const rules = loadCheckRules(vaultRoot);
  const hits: Hit[] = [];
  const unprovenanced: string[] = [];

  for (const filePath of filePaths) {
    const text = read(filePath);
    const label = relative(workDir, filePath);
    hits.push(...checkFile(text, label, rules));
    if (isUnprovenanced(text)) unprovenanced.push(label);
  }

  return { ok: true, code: 0, hits, unprovenanced };
}

/** `pablo check`'s own argument slice — kept local so `check.ts` does not import `cli.ts` (which imports `check.ts`). */
export interface CheckArgs {
  readonly json: boolean;
  readonly file: string | undefined;
}

/**
 * `pablo check --project <slug> [--file F]`. Prose output is one line per
 * hit (`path:line rule — excerpt`, with `(<detail>)` appended when set) then
 * one `unprovenanced: <path>` line per unprovenanced file, or `no hits` when
 * both are empty. JSON is `{ok: true, hits[], unprovenanced[]}`. Exit 0
 * always, except a resolution refusal before any scanning (exit 2).
 */
export function runCheck(args: CheckArgs, vaultRoot: string, workDir: string): number {
  const outcome = checkWork(vaultRoot, workDir, args.file);

  if (!outcome.ok) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, code: outcome.code, message: outcome.message, tried: outcome.tried }));
    } else {
      console.error(outcome.message);
    }
    return outcome.code;
  }

  if (args.json) {
    console.log(JSON.stringify({ ok: true, hits: outcome.hits, unprovenanced: outcome.unprovenanced }));
  } else if (outcome.hits.length === 0 && outcome.unprovenanced.length === 0) {
    console.log("no hits");
  } else {
    for (const hit of outcome.hits) {
      const detail = hit.detail !== undefined ? ` (${hit.detail})` : "";
      console.log(`${hit.path}:${hit.line} ${hit.rule} — ${hit.excerpt}${detail}`);
    }
    for (const path of outcome.unprovenanced) {
      console.log(`unprovenanced: ${path}`);
    }
  }

  return outcome.code;
}
