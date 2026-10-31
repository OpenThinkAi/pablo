/**
 * `pablo check` (AGT-1234): provenance and mechanical-tells scanning.
 *
 * Two independent checks over the `*.md` units of a work's output (the
 * novel's chapters; the registry's `artifactDir`; a screenplay's scenes are
 * `*.fountain` and also get the Fountain lint, AGT-2132):
 *
 * 1. **Provenance** — a chapter whose frontmatter lacks `model` or
 *    `prompt_hash` is "unprovenanced": prose the model never produced, or
 *    prose written before pablo tracked who wrote it.
 * 2. **Mechanical tells** — lines that trip a fixed rule set: em-dashes,
 *    curly quotes, dash year ranges, foreshadowing phrases, the banned stock
 *    names the style guide lists, and every `Flagged:` line in
 *    `<vault>/style/prose.md`, matched verbatim. See the design doc's
 *    "Voice" section (`pm project show ai-terminal`)
 *    for where these rules come from — the guide's own flagged lines are "the
 *    best document in the vault and the pattern the rest follows."
 *
 * A nonfiction work's `*.md` units also get the claim-support check (AGT-2114, `claim-support.ts`):
 * `claim-unsupported` and `claim-uncited` hits in `hits[]`. A historical-fiction work's units get the
 * `anachronism` check (AGT-2113, `anachronism.ts`) and, with `--output`, the `fact-accuracy` check against the
 * distilled period facts (AGT-2112, `fact-accuracy.ts`). Both ask a model, so `runCheck` and the verb run them after
 * `checkWork` over `scanned`, through one pipeline (`runModelChecks`).
 *
 * Voice-pattern scoring beyond verbatim flagged lines is P1, out of scope
 * here (AC3). `checkFile` and `checkWork` are pure/read-only and exported for
 * AGT-1237's `write` to call directly and put the hits in its receipt.
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { branchExists, ensureWorktree, repoRoot, waitingBranches } from "./branch";
import type { TextSource } from "@openthink/pablo-core";
import { joinSentences } from "@openthink/pablo-core";
import { parseFrontmatter } from "./novel/machine";
import { readMarker, trackOf } from "./marker";
import { checkClaimSupport, readClaimSources } from "./claim-support";
import { anachronismBody, checkAnachronisms } from "./anachronism";
import { coreCheck } from "./core-check";
import type { Ask } from "./critique";
import { factAccuracyAsk, runFactAccuracy, savedFactHits } from "./fact-accuracy";
import { narratedDrift } from "./outputs/narrated";
import { outputDefinition, resolveOutput } from "./outputs/registry";
import type { OutputDefinition } from "./outputs/types";
import { radioCheck, radioCheckLines, realCastingDeps } from "./radio";
import type { CastingDeps } from "./radio";
import { lintFountain } from "./outputs/screenplay/fountain";
import { FOUNTAIN_EXT } from "./outputs/screenplay/units";

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
  /**
   * `check --output <type>` (AGT-1671): the core check's hits (`core-check.ts`: `story-time`, `unknown-name`) over
   * that output's units. Run on the resolved output (named, or the work's one output), so `write` and `check` agree; absent for a bare `--file`.
   */
  readonly core?: readonly Hit[];
  /** The absolute paths scanned, for the model-backed checks that run after (`anachronism`, AGT-2113; `fact-accuracy`, AGT-2112). */
  readonly scanned: readonly string[];
  /** The output whose units a whole-work scan read (AGT-2188: "nothing to check" names it); absent for a `--file` scan. */
  readonly scannedOutput?: OutputDefinition;
  /** The pending draft branch these units were read from (AGT-2188), when the scan ran on a branch rather than on main. */
  readonly branch?: string;
}

/** A resolution refusal before any scanning happens — the one case `checkWork`/`runCheck` exit non-zero (a `--file` outside the work). */
export interface CheckRefusal {
  readonly ok: false;
  readonly code: 2;
  readonly message: string;
  readonly tried: readonly string[];
  /** `--output` was needed (a work with several outputs) or names one the work lacks (AGT-1669). */
  readonly missing?: readonly string[];
  /** `--unit N` named a unit this output's files on the scanned tree do not have (AGT-2188: it may be a pending draft). */
  readonly unitMissing?: { readonly output: OutputDefinition; readonly unit: number };
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

/** A paragraph of a chapter body: its lines joined into one string, and where each line starts in it. */
interface Paragraph {
  readonly text: string;
  /** `starts[i]` is the offset in `text` where the paragraph's i-th line begins; `lines[i]` is that line's 1-based number and raw text. */
  readonly starts: readonly number[];
  readonly lines: ReadonlyArray<{ readonly number: number; readonly raw: string }>;
}

/**
 * Groups the body lines (frontmatter skipped) into paragraphs, each a run of
 * non-blank lines joined with `joinSentences`. Chapters are stored one
 * sentence per line (AGT-1532), so a rule that spans a sentence break — a
 * flagged line, a foreshadowing phrase — only matches in the joined text.
 */
function paragraphsOf(lines: readonly string[], frontmatterEnd: number): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  let run: Array<{ number: number; raw: string }> = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const starts: number[] = [];
    let offset = 0;
    const pieces = run.map((line) => joinSentences([line.raw]));
    for (const piece of pieces) {
      starts.push(offset);
      offset += piece.length + 1;
    }
    paragraphs.push({ text: joinSentences(pieces), starts, lines: run });
    run = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (i <= frontmatterEnd || raw.trim() === "") flush();
    else run.push({ number: i + 1, raw });
  }
  flush();
  return paragraphs;
}

/** Every start offset at which `regex` (made global) matches `text`. */
function matchOffsets(regex: RegExp, text: string): number[] {
  const global = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
  return [...text.matchAll(global)].map((match) => match.index ?? 0);
}

/** Every offset at which `needle` occurs in `text`. */
function indexesOf(text: string, needle: string): number[] {
  const offsets: number[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) offsets.push(at);
  return offsets;
}

/**
 * Scans `text` (a chapter file's full contents, `path` its report label)
 * against `rules`, a paragraph at a time, skipping the frontmatter block.
 * Sentence lines are joined into their paragraph first, so a match may span
 * lines; it is reported on the line where it starts, with that line as the
 * excerpt. One hit per `(line, rule)` for the mechanical rules — repeated
 * matches on one line count once — and per `(line, flagged line)` for
 * `flagged-line`, but each matching stock name gets its own hit
 * (`rule: "stock-name"`, the name in `detail`). Pure: no disk I/O.
 */
export function checkFile(text: string, path: string, rules: CheckRules): Hit[] {
  const lines = text.split("\n");
  const frontmatterEnd = frontmatterEndIndex(lines);
  const hits: Hit[] = [];

  for (const paragraph of paragraphsOf(lines, frontmatterEnd)) {
    /** The physical line a joined-text offset falls on. */
    const lineAt = (offset: number): { number: number; raw: string } => {
      let index = 0;
      for (let i = 0; i < paragraph.starts.length; i++) {
        if ((paragraph.starts[i] as number) <= offset) index = i;
      }
      return paragraph.lines[index] as { number: number; raw: string };
    };
    /** Distinct physical lines the offsets fall on, in order. */
    const linesOf = (offsets: readonly number[]): Array<{ number: number; raw: string }> => {
      const seen = new Map<number, { number: number; raw: string }>();
      for (const offset of offsets) {
        const line = lineAt(offset);
        if (!seen.has(line.number)) seen.set(line.number, line);
      }
      return [...seen.values()];
    };

    const found: Hit[] = [];
    for (const { rule, regex } of MECHANICAL_RULES) {
      for (const line of linesOf(matchOffsets(regex, paragraph.text))) {
        found.push({ path, line: line.number, rule, excerpt: excerptOf(line.raw) });
      }
    }

    for (const name of rules.stockNames) {
      for (const line of linesOf(matchOffsets(new RegExp(`\\b${escapeRegex(name)}\\b`), paragraph.text))) {
        found.push({ path, line: line.number, rule: "stock-name", excerpt: excerptOf(line.raw), detail: name });
      }
    }

    for (const flagged of rules.flaggedLines) {
      if (flagged === "") continue;
      for (const line of linesOf(indexesOf(paragraph.text, flagged))) {
        found.push({ path, line: line.number, rule: "flagged-line", excerpt: excerptOf(line.raw) });
      }
    }

    // Line order, rules in declaration order within a line (Array.sort is stable).
    hits.push(...found.sort((a, b) => a.line - b.line));
  }

  // A screenplay scene (AGT-2132) is also linted as Fountain: a malformed heading, cue or parenthetical is a hit.
  if (path.endsWith(FOUNTAIN_EXT)) hits.push(...lintFountain(text, path));
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
 * every `*.md` (or `*.fountain`, a screenplay scene) unit file in the work's output directory (`artifactDir`; a file its `unitOfPath` reads as a unit, so never its `RULES.md` or `plan.md`) is
 * scanned, sorted by name.
 *
 * Otherwise always succeeds with exit 0 (AC3): a hit, or an unprovenanced
 * file, is data the scan reports, never a reason to fail. AGT-1237's `write`
 * calls this (or `checkFile` directly) to put a chapter's hits in its
 * receipt.
 */
export function checkWork(vaultRoot: string, workDir: string, file?: string, output?: string, unit?: number): CheckOutcome {
  let filePaths: string[];
  if (unit !== undefined && file !== undefined) {
    return { ok: false, code: 2, message: "pablo: check --unit picks a unit of the output; it cannot be combined with --file", tried: [] };
  }

  // Which output's units a whole-work scan reads (AGT-1669): `--output`, else the work's one output;
  // several outputs and none named is a refusal naming them.
  let artifactDir: string | undefined;
  let scanned: OutputDefinition | undefined;
  if (file === undefined || output !== undefined) {
    const marker = readMarker(workDir);
    const resolved = resolveOutput(marker.ok ? marker.marker.outputs : {}, output, "check", marker.ok ? trackOf(marker.marker) : undefined);
    if (!resolved.ok) return { ok: false, code: 2, message: resolved.message, tried: [], missing: resolved.missing };
    artifactDir = resolved.output.artifactDir;
    scanned = resolved.output;
  }

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
    const chaptersDir = join(workDir, artifactDir as string);
    filePaths = existsSync(chaptersDir)
      ? readdirSync(chaptersDir)
          .filter((name) => name.endsWith(".md") || name.endsWith(FOUNTAIN_EXT))
          // Only the output's units: an output whose units sit beside its RULES.md and plan.md (story, essay) scans neither.
          .filter((name) => scanned?.unitOfPath(`${artifactDir as string}/${name}`) !== undefined)
          .sort()
          .map((name) => join(chaptersDir, name))
      : [];
    // `--unit N` (AGT-2112): just that unit of the output.
    if (unit !== undefined && scanned !== undefined) {
      const def = scanned;
      // Only a shared-file output (the essay) reads each file for the unit: a section of it (AGT-2188) is in the file when the file has its text, whatever number the file reads as.
      const shared = def.shared;
      filePaths =
        shared !== undefined
          ? filePaths.filter((path) => def.unitOfPath(relative(workDir, path).split("\\").join("/")) !== undefined && shared.has(workDir, read(path), unit))
          : filePaths.filter((path) => def.unitOfPath(relative(workDir, path).split("\\").join("/")) === unit);
      if (filePaths.length === 0) {
        return { ok: false, code: 2, message: `pablo: check --unit ${unit}: ${def.id} has no unit ${unit} under ${def.artifactDir}/`, tried: [chaptersDir], unitMissing: { output: def, unit } };
      }
    }
  }

  const rules = loadCheckRules(vaultRoot);
  const hits: Hit[] = [];
  const unprovenanced: string[] = [];

  // A nonfiction work's prose units also get claim support (AGT-2114, `claim-support.ts`).
  const workMarker = readMarker(workDir);
  const claimSources = workMarker.ok && trackOf(workMarker.marker) === "nonfiction" ? readClaimSources(workDir) : undefined;

  for (const filePath of filePaths) {
    const text = read(filePath);
    const label = relative(workDir, filePath);
    hits.push(...checkFile(text, label, rules));
    if (claimSources !== undefined && filePath.endsWith(".md")) hits.push(...checkClaimSupport(text, label, claimSources));
    if (isUnprovenanced(text)) unprovenanced.push(label);
    // A narrated reading (AGT-2137) is the source unit's prose word for word: flag the first place it is not.
    const drift = narratedDrift(workDir, filePath);
    if (drift !== undefined) hits.push({ path: label, line: drift.line, rule: "narration-drift", excerpt: excerptOf(drift.excerpt), detail: drift.detail });
  }

  // The resolved output (named, or the work's one output) adds the core check (AGT-1671, AGT-2197): the units against the bible, the timeline and facts.md.
  return { ok: true, code: 0, hits, unprovenanced, scanned: filePaths, ...(file === undefined && scanned !== undefined ? { scannedOutput: scanned } : {}), ...(scanned !== undefined ? { core: coreCheck(workDir, scanned, filePaths) } : {}) };
}

/** `draft/essay-03-v2` -> 2, `draft/essay-03` -> 1: a re-draft's version, so the newest draft of a unit sorts last. */
function draftVersion(branch: string): number {
  const m = /-v(\d+)$/.exec(branch);
  return m ? Number(m[1]) : 1;
}

/** The scan a pending draft's branch gets (AGT-2188): where it is checked out, and which branch it is. */
interface PendingDraft {
  readonly ok: true;
  readonly branch: string;
  /** The work as the branch has it: the branch's worktree plus the work's path inside the repo. */
  readonly workDir: string;
}

/**
 * The checkout a unit's pending draft can be checked in (AGT-2188): `branch`, else the newest draft branch of
 * `unit` that has commits `main` lacks. `check --unit N` falls back to it when the unit is not on `main` yet, so a
 * draft is linted and fact-checked before it is accepted. The branch's worktree is added when it has none. A failure
 * is a message, never a throw.
 */
function pendingDraft(workDir: string, def: OutputDefinition | undefined, unit: number | undefined, branch: string | undefined, env: NodeJS.ProcessEnv = process.env): PendingDraft | { ok: false; message: string } {
  const repo = repoRoot(workDir);
  const marker = readMarker(workDir);
  if (repo === undefined || !marker.ok) return { ok: false, message: `pablo: check: ${workDir} is not a work in a git repository, so it has no pending drafts` };
  let name = branch;
  if (name !== undefined) {
    if (!branchExists(repo, name)) return { ok: false, message: `pablo: check --branch ${name}: no such branch` };
  } else {
    if (def === undefined || unit === undefined) return { ok: false, message: "pablo: check: a pending draft needs a unit" };
    const waiting = waitingBranches(repo, workDir);
    if (!waiting.ok) return { ok: false, message: waiting.notice };
    const drafts = waiting.branches.filter((b) => def.unitOfBranch(b) === unit).sort((a, b) => draftVersion(a) - draftVersion(b));
    name = drafts[drafts.length - 1];
    if (name === undefined) return { ok: false, message: `pablo: check --unit ${unit}: ${def.id} has no unit ${unit} under ${def.artifactDir}/ and no pending draft of it` };
  }
  const tree = ensureWorktree(repo, marker.marker.slug, name, env);
  if (!tree.ok) return { ok: false, message: tree.notice };
  if (tree.path === undefined) return { ok: false, message: `pablo: check: ${name} has no worktree` };
  return { ok: true, branch: name, workDir: join(tree.path, relative(realpathSync(repo), realpathSync(workDir))) };
}

/**
 * `checkWork`, then, for `--unit N` that `main` lacks (or any `--branch <b>`), the same scan on that pending draft's
 * branch (AGT-2188). `workDir` in the result is the tree the scan read, which the model-backed checks must use too.
 */
export function checkWorkOrPending(
  vaultRoot: string,
  workDir: string,
  file: string | undefined,
  output: string | undefined,
  unit: number | undefined,
  branch?: string,
  env: NodeJS.ProcessEnv = process.env,
): { outcome: CheckOutcome; workDir: string } {
  if (branch !== undefined && file !== undefined) {
    return { outcome: { ok: false, code: 2, message: "pablo: check --branch checks a draft branch's units; it cannot be combined with --file", tried: [] }, workDir };
  }
  if (branch !== undefined) {
    const pending = pendingDraft(workDir, undefined, undefined, branch, env);
    if (!pending.ok) return { outcome: { ok: false, code: 2, message: pending.message, tried: [] }, workDir };
    const outcome = checkWork(vaultRoot, pending.workDir, undefined, output, unit);
    return { outcome: outcome.ok ? { ...outcome, branch: pending.branch } : outcome, workDir: pending.workDir };
  }
  const outcome = checkWork(vaultRoot, workDir, file, output, unit);
  if (outcome.ok || outcome.unitMissing === undefined) return { outcome, workDir };
  const pending = pendingDraft(workDir, outcome.unitMissing.output, outcome.unitMissing.unit, undefined, env);
  if (!pending.ok) return { outcome, workDir };
  const onBranch = checkWork(vaultRoot, pending.workDir, undefined, output, unit);
  if (!onBranch.ok) return { outcome, workDir };
  return { outcome: { ...onBranch, branch: pending.branch }, workDir: pending.workDir };
}

/**
 * The scanner the screen runs when a chapter opens (AGT-1528): `checkFile` with the vault's rules, loaded once on
 * the first chapter. Takes the file's raw text, so a hit's line is a line of the file and the screen can put its
 * box under the sentence it is about.
 */
export function screenChecks(vaultRoot: string, workDir?: string): (file: string, text: string) => Hit[] {
  let rules: CheckRules | undefined;
  return (file, text) => {
    const hits = checkFile(text, file, (rules ??= loadCheckRules(vaultRoot)));
    // The last `check --output` run's fact-accuracy hits on this unit, while its text is unchanged (AGT-2112).
    return workDir === undefined ? hits : [...hits, ...savedFactHits(workDir, file, text)].sort((a, b) => a.line - b.line);
  };
}

/** What `check --output` adds for a historical-fiction work (AGT-2112): its fact-accuracy run's count and any notice. */
export interface FactAccuracySummary {
  readonly checked: number;
  readonly notice?: string;
}

/**
 * The fact-accuracy step (AGT-2112, `fact-accuracy.ts`): with `--output` named on a historical-fiction work that has
 * `facts/period.md`, each scanned unit goes to the `check` intent's model and its hits join `hits`. Anything else
 * leaves the outcome as it was. `ask` builds the model seam lazily (tests inject a fake).
 */
export async function withFactAccuracy(
  outcome: CheckSuccess,
  workDir: string,
  output: string | undefined,
  ask: () => Ask | string,
  progress?: (line: string) => void,
): Promise<{ outcome: CheckSuccess; factAccuracy?: FactAccuracySummary }> {
  const def = output === undefined ? undefined : outputDefinition(output);
  if (def === undefined) return { outcome };
  const run = await runFactAccuracy({ workDir, def, files: outcome.scanned, ask, ...(progress ? { progress } : {}) });
  if (run === undefined) return { outcome };
  return {
    outcome: { ...outcome, hits: [...outcome.hits, ...run.hits] },
    factAccuracy: { checked: run.checked, ...(run.notice !== undefined ? { notice: run.notice } : {}) },
  };
}

/** What the model-backed checks added to a scan: every hit (the scan's first), their JSON blocks, and the notices to print. */
export interface ModelChecked {
  readonly hits: readonly Hit[];
  readonly anachronism?: { asked: number; notice?: string; failed?: true };
  readonly factAccuracy?: FactAccuracySummary;
  /** Each check's notice when it stopped short, for the prose form's stderr. */
  readonly notices: readonly string[];
}

/**
 * The one pipeline after `checkWork` that `runCheck` and the `check` verb share: the anachronism check (AGT-2113)
 * then fact accuracy (AGT-2112), both on the `check` intent's model, both a no-op off the historical-fiction track.
 * `factAsk` is the fact-accuracy model seam (default: `factAccuracyModel.ask`, else the planner).
 */
export async function runModelChecks(
  outcome: CheckSuccess,
  workDir: string,
  output: string | undefined,
  options: { readonly env: NodeJS.ProcessEnv; readonly progress?: (line: string) => void; readonly factAsk?: () => Ask | string },
): Promise<ModelChecked> {
  const progress = options.progress;
  const anachronism = await checkAnachronisms(workDir, outcome.scanned, { env: options.env, ...(progress ? { progress } : {}) });
  const fact = await withFactAccuracy(outcome, workDir, output, options.factAsk ?? (() => factAccuracyAsk(options.env, workDir)), progress);
  // An anachronism run that left terms unjudged is a check error, never a silent pass (AGT-2187).
  const anachronismNotice = anachronism?.notice === undefined ? undefined : anachronism.failed ? `pablo: check error: ${anachronism.notice}` : anachronism.notice;
  const notices = [anachronismNotice, fact.factAccuracy?.notice].filter((n): n is string => n !== undefined);
  return {
    hits: [...fact.outcome.hits, ...(anachronism?.hits ?? [])],
    notices,
    ...(anachronism !== undefined ? { anachronism: anachronismBody(anachronism) } : {}),
    ...(fact.factAccuracy !== undefined ? { factAccuracy: fact.factAccuracy } : {}),
  };
}

/** What the track's checks found on one freshly drafted unit (AGT-2115): the hits, and a notice for each check that could not run. */
export interface DraftChecked {
  readonly hits: readonly Hit[];
  readonly notices: readonly string[];
}

/**
 * The checks after a draft (AGT-2115, D-10): `checkWork` narrowed to the one unit (the mechanical tells, the core
 * check, claim support on a nonfiction work) then `runModelChecks` (anachronism and fact accuracy on a
 * historical-fiction work). Read-only on the draft: a hit is reported and the text is never rewritten. A check that
 * cannot run (no model, a model error, a refusal) is a notice, never a throw, so it can never fail the draft.
 * `workDir` is the work as the draft sits in it (the draft branch's worktree).
 */
export async function checkDraft(
  vaultRoot: string,
  workDir: string,
  output: string,
  unit: number,
  options: { readonly env: NodeJS.ProcessEnv; readonly progress?: (line: string) => void; readonly factAsk?: () => Ask | string },
): Promise<DraftChecked> {
  try {
    const outcome = checkWork(vaultRoot, workDir, undefined, output, unit);
    if (!outcome.ok) return { hits: [], notices: [`pablo: check skipped: ${outcome.message}`] };
    const model = await runModelChecks(outcome, workDir, output, { env: options.env, ...(options.progress ? { progress: options.progress } : {}), ...(options.factAsk ? { factAsk: options.factAsk } : {}) });
    return { hits: [...model.hits, ...(outcome.core ?? [])], notices: model.notices };
  } catch (error) {
    return { hits: [], notices: [`pablo: check failed: ${(error as Error).message}`] };
  }
}

/** `pablo check`'s own argument slice — kept local so `check.ts` does not import `cli.ts` (which imports `check.ts`). */
export interface CheckArgs {
  readonly json: boolean;
  readonly file: string | undefined;
  /** `check --output <type>` (AGT-1669): scan that output's units. */
  readonly output?: string | undefined;
  /** `check --unit N` (AGT-2112): only unit N of the output; validated here. */
  readonly unit?: string | undefined;
  /** `check --branch <b>` (AGT-2188): check the units on that pending draft branch instead of `main`. */
  readonly branch?: string | undefined;
  /** `check --strict` (AGT-2188): exit 1 when any hit is reported. */
  readonly strict?: boolean | undefined;
}

/** The line `check` prints when there is nothing drafted to scan (AGT-2188). */
export function nothingToCheck(def: OutputDefinition): string {
  return `nothing to check: no drafted ${def.plural} in ${def.artifactDir}/ (${def.id} output)`;
}

/** Whether a check also reads radio scripts: not for a single `--file`, nor when `--output` names another output. */
export function radioScriptsChecked(file: string | undefined, output: string | undefined): boolean {
  return file === undefined && (output === undefined || output === "radio");
}

/**
 * `pablo check --project <slug> [--file F]`. Prose output is one line per
 * hit (`path:line rule — excerpt`, with `(<detail>)` appended when set) then
 * one `unprovenanced: <path>` line per unprovenanced file, or `no hits` when
 * both are empty. JSON is `{ok: true, hits[], unprovenanced[], radio?}`. Exit
 * 0, except a resolution refusal before any scanning (exit 2) and an anachronism
 * run that left terms unjudged (exit 1, `anachronism.failed`, AGT-2187).
 *
 * A work with radio scripts (a `CAST:` line, AGT-1680) also gets them read by
 * the Python side: `radio` holds each episode's counts, the directions outside
 * the vocabulary (with line numbers) and the roles with no voice; prose adds
 * one `file:line unknown direction` / `unbound role` line each. A `--file`
 * scan skips it. `casting` is injectable so tests never reach `uv`.
 */
export async function runCheck(args: CheckArgs, vaultRoot: string, workDir: string, casting?: CastingDeps, factAsk?: () => Ask | string): Promise<number> {
  const badUnit =
    args.unit === undefined ? undefined
    : !/^[1-9]\d*$/.test(args.unit) ? `pablo: check --unit must be a positive whole number (got "${args.unit}")`
    : args.file !== undefined ? "pablo: check --unit picks a unit of the output; it cannot be combined with --file"
    : undefined;
  if (badUnit !== undefined) {
    if (args.json) console.log(JSON.stringify({ ok: false, code: 2, message: badUnit }));
    else console.error(badUnit);
    return 2;
  }
  const picked = checkWorkOrPending(vaultRoot, workDir, args.file, args.output, args.unit === undefined ? undefined : Number(args.unit), args.branch);
  const outcome = picked.outcome;
  // A pending draft is read from its branch's worktree (AGT-2188); the model-backed checks read it there too.
  const scanDir = picked.workDir;

  if (!outcome.ok) {
    if (args.json) {
      console.log(JSON.stringify({ ok: false, code: outcome.code, message: outcome.message, tried: outcome.tried, ...(outcome.missing ? { missing: outcome.missing } : {}) }));
    } else {
      console.error(outcome.message);
      for (const item of outcome.missing ?? []) console.error(`  ${item}`);
    }
    return outcome.code;
  }

  // A historical-fiction work also gets the model-backed checks: anachronism (AGT-2113) and fact accuracy (AGT-2112).
  const model = await runModelChecks(outcome, scanDir, args.output, { env: process.env, progress: (line) => process.stderr.write(`${line}\n`), ...(factAsk ? { factAsk } : {}) });
  const hits = model.hits;
  if (!args.json) for (const notice of model.notices) console.error(notice);
  if (!args.json && outcome.branch !== undefined) console.error(`pablo: checked the pending draft on ${outcome.branch}`);
  const nothing = outcome.scanned.length === 0 && outcome.scannedOutput !== undefined ? nothingToCheck(outcome.scannedOutput) : undefined;

  const radio =
    radioScriptsChecked(args.file, args.output) ? radioCheck({ env: process.env, stderr: process.stderr }, casting ?? realCastingDeps(process.env), scanDir) : undefined;
  if (radio !== undefined && radio.exitCode !== 0) {
    const failure = radio.body as { message?: string };
    if (args.json) console.log(JSON.stringify(radio.body));
    else console.error(failure.message ?? "pablo: reading the radio scripts failed");
    return radio.exitCode;
  }
  const { ok: _ok, ...radioBody } = (radio?.body ?? {}) as Record<string, unknown>;
  const hasRadio = radio !== undefined;
  const radioLines = hasRadio ? radioCheckLines(radioBody) : [];

  if (args.json) {
    console.log(JSON.stringify({ ok: true, hits, unprovenanced: outcome.unprovenanced, ...(outcome.core ? { core: outcome.core } : {}), ...(hasRadio ? { radio: radioBody } : {}), ...(model.anachronism !== undefined ? { anachronism: model.anachronism } : {}), ...(model.factAccuracy !== undefined ? { factAccuracy: model.factAccuracy } : {}), ...(outcome.branch !== undefined ? { branch: outcome.branch } : {}), ...(nothing !== undefined && !hasRadio ? { notice: nothing } : {}) }));
  } else if (hits.length === 0 && outcome.unprovenanced.length === 0 && (outcome.core ?? []).length === 0 && radioLines.length === 0) {
    console.log(nothing ?? "no hits");
  } else {
    for (const hit of hits) {
      const detail = hit.detail !== undefined ? ` (${hit.detail})` : "";
      console.log(`${hit.path}:${hit.line} ${hit.rule} — ${hit.excerpt}${detail}`);
    }
    for (const hit of outcome.core ?? []) {
      console.log(`${hit.path}:${hit.line} ${hit.rule} — ${hit.excerpt}${hit.detail !== undefined ? ` (${hit.detail})` : ""}`);
    }
    for (const path of outcome.unprovenanced) {
      console.log(`unprovenanced: ${path}`);
    }
    for (const line of radioLines) console.log(line);
  }

  // Terms the anachronism check could not judge fail the check (exit 1, AGT-2187); the hits it did find are reported above.
  if (model.anachronism?.failed) return 1;
  return args.strict === true && strictFails(hits, outcome.core) ? 1 : outcome.code;
}

/** `check --strict` (AGT-2188): any reported hit (the scan's, the model checks' or the core check's) fails the run. */
export function strictFails(hits: readonly Hit[], core: readonly Hit[] | undefined): boolean {
  return hits.length > 0 || (core ?? []).length > 0;
}
