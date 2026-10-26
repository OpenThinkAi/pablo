/**
 * `pablo resume` (AGT-1229): the structured summary an agent picks a project
 * up from, so it does not have to read ten files to know where the work is
 * and what comes next. See the design doc's "The session, from the agent's
 * side" (`pm project show ai-terminal`).
 *
 * All resume logic lives in this file by design (three sibling tickets — the
 * pack/write path, `save`, `check` — are landing on other branches at the
 * same time; keeping this self-contained keeps those merges clean). `cli.ts`
 * only wires the verb to `runResumeVerb`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { beatsFile } from "@openthink/pablo-core";
import { outputsLabel, readMarker, realNamesOf, trackOf } from "./marker";
import { DEFAULT_TRACK } from "./tracks/registry";
import type { TrackId } from "./tracks/registry";
import { waitingForReview } from "./branch";
import type { CoreState } from "./core/machine";
import { coreLines, outputLines, readWorkReport } from "./work-state";
import type { CoreReport, OutputReport } from "./work-state";

/** The newest dated file in `notes/`, summarized by its first `# ` heading. */
export interface NoteSummary {
  readonly file: string;
  readonly date: string;
  readonly summary: string;
}

/** `git -C <workDir> log -1 -- .`, parsed. Omitted (never thrown) on any git failure. */
export interface CommitSummary {
  readonly sha: string;
  readonly date: string;
  readonly subject: string;
}

/** One `[pick]` row or one "Decisions"/"Open questions" bullet. */
export interface OpenItem {
  readonly source: string;
  readonly text: string;
}

export interface ResumeResult {
  /** The work's outputs as one label (`"novel"`, `"novel, radio"`, `"core"` with none). */
  readonly format: string;
  readonly title: string;
  /** The work's track (AGT-2099): `pablo.json` `track`, else `fiction`. */
  readonly track: TrackId;
  /** `false` when `pablo.json` sets `realNames: false` (AGT-2107); omitted otherwise (real names allowed). */
  readonly realNames?: false;
  /** The story core's state and stages (AGT-1667). */
  readonly core: CoreReport;
  /** Each output the marker names, with its units. `{}` for a core with nothing derived yet. */
  readonly outputs: Readonly<Record<string, OutputReport>>;
  /** Branches with changes `main` does not have yet: the ones waiting for review. */
  readonly waiting: readonly string[];
  readonly last: {
    readonly note?: NoteSummary;
    readonly commit?: CommitSummary;
  };
  readonly open: readonly OpenItem[];
  /** The next action, naming the layer that is short: `core: ...`, `add an output`, or `<type>: ...`. */
  readonly next: string;
  /** The `think brief` output, trimmed, when it landed inside the timeout. */
  readonly brief?: string;
  /** One-line notices — a missing `think`, a timeout, or a non-zero exit — never a failure. */
  readonly notices?: readonly string[];
}

export interface RunResumeOptions {
  /** Defaults to `process.env`. Overridden in tests to point PATH at a fake `think`. */
  readonly env?: Record<string, string | undefined>;
  /** Defaults to 20_000ms. Overridden in tests to exercise the timeout path quickly. */
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** The newest `YYYY-MM-DD-*.md` file in `<workDir>/notes/`, if any. */
function readLastNote(workDir: string): NoteSummary | undefined {
  const dir = join(workDir, "notes");
  if (!existsSync(dir)) return undefined;

  const names = readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}-.*\.md$/.test(name))
    .sort();
  const newest = names[names.length - 1];
  if (newest === undefined) return undefined;

  const path = join(dir, newest);
  const text = readFileSync(path, "utf8");
  const heading = /^#\s+(.*)$/m.exec(text);
  const summary = heading !== null ? (heading[1] ?? "").trim() : "";

  return { file: relative(workDir, path), date: newest.slice(0, 10), summary };
}

/** `git -C <workDir> log -1 --format=%h%x09%as%x09%s -- .` — omitted, never thrown, on any failure. */
function readLastCommit(workDir: string): CommitSummary | undefined {
  try {
    const result = Bun.spawnSync(["git", "-C", workDir, "log", "-1", "--format=%h%x09%as%x09%s", "--", "."], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) return undefined;

    const line = result.stdout.toString("utf8").trim();
    if (line === "") return undefined;

    const [sha, date, ...subjectParts] = line.split("\t");
    if (sha === undefined || sha === "" || date === undefined) return undefined;

    return { sha, date, subject: subjectParts.join("\t") };
  } catch {
    return undefined;
  }
}

/** Every `[pick]` row the core state already found, as `"<name> ([pick] in <file>)"`. */
function picksToOpen(state: CoreState): OpenItem[] {
  return state.bible.picks.map((pick) => ({
    source: pick.file,
    text: `${pick.name} ([pick] in ${pick.file})`,
  }));
}

/**
 * Bullets (`- `/`* ` lines) under a `## Decisions...` or `## Open questions...`
 * heading in `text`, until the next `## ` heading. A deeper heading (e.g. the
 * real vault's `### Open questions for Act I`) does not open or close a
 * section — only an exact `## ` heading does.
 */
function headingBullets(text: string, fileLabel: string): OpenItem[] {
  const items: OpenItem[] = [];
  let capturing = false;

  for (const line of text.split("\n")) {
    if (/^## /.test(line)) {
      capturing = /^## (Decisions|Open questions)/.test(line);
      continue;
    }
    if (!capturing) continue;

    const trimmed = line.trimStart();
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      items.push({ source: fileLabel, text: trimmed.slice(2).trim() });
    }
  }

  return items;
}

/** Every `.md` file under `dir`, recursively, sorted for a deterministic scan order. */
function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];

  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkMarkdown(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) results.push(full);
  }
  return results;
}

/** `headingBullets` over every `bible/**\/*.md` file plus the beats file (`outline/beats.md`, or `outline/chapters.md` unmigrated). */
function bibleAndOutlineOpen(workDir: string): OpenItem[] {
  const outlinePath = join(workDir, beatsFile(workDir));
  const files = [...walkMarkdown(join(workDir, "bible")), ...(existsSync(outlinePath) ? [outlinePath] : [])];

  const items: OpenItem[] = [];
  for (const path of files) {
    items.push(...headingBullets(readFileSync(path, "utf8"), relative(workDir, path)));
  }
  return items;
}

interface BriefOutcome {
  readonly brief?: string;
  readonly notice?: string;
}

/**
 * `think brief --cortex writing --context <slug>`, raced against `timeoutMs`
 * and killed on timeout. A missing `think`, a timeout, or a non-zero exit are
 * all one-line notices — never a thrown error, per AC3.
 */
async function runBrief(
  slug: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<BriefOutcome> {
  const thinkPath = Bun.which("think", { PATH: env["PATH"] });
  if (thinkPath === null) return { notice: "think not on PATH" };

  const proc = Bun.spawn([thinkPath, "brief", "--cortex", "writing", "--context", slug], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const outcome = await Promise.race([proc.exited, timedOut]);
  if (timer !== undefined) clearTimeout(timer);

  if (outcome === "timeout") {
    proc.kill();
    return { notice: `think brief timed out after ${Math.round(timeoutMs / 1000)}s` };
  }

  if (outcome !== 0) {
    return { notice: `think brief exited ${outcome}` };
  }

  const stdout = await new Response(proc.stdout).text();
  return { brief: stdout.trim() };
}

/**
 * Assembles the resume summary for `workDir` (a resolved, marker-valid
 * project directory). `slug` is the project's `--project` value, used only
 * for the `think brief --context` call. The brief is started first and
 * awaited last so it overlaps every other (synchronous) file read.
 */
export async function buildResume(
  workDir: string,
  slug: string,
  options: RunResumeOptions = {},
): Promise<ResumeResult> {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const briefPromise = runBrief(slug, env, timeoutMs);

  const markerResult = readMarker(workDir);
  const format = markerResult.ok ? outputsLabel(markerResult.marker) : "";
  const title = markerResult.ok ? markerResult.marker.title : "";
  const track = markerResult.ok ? trackOf(markerResult.marker) : DEFAULT_TRACK;

  const realNamesOff = markerResult.ok && !realNamesOf(markerResult.marker);

  const report = readWorkReport(workDir, markerResult.ok ? markerResult.marker.outputs : {}, track);

  const last: { note?: NoteSummary; commit?: CommitSummary } = {};
  const note = readLastNote(workDir);
  if (note !== undefined) last.note = note;
  const commit = readLastCommit(workDir);
  if (commit !== undefined) last.commit = commit;

  const open = [...picksToOpen(report.core), ...bibleAndOutlineOpen(workDir)];

  const briefOutcome = await briefPromise;

  const result: ResumeResult = {
    format,
    title,
    core: report.core,
    outputs: report.outputs,
    waiting: waitingForReview(workDir),
    last,
    open,
    next: report.next,
    track,
    ...(realNamesOff ? { realNames: false as const } : {}),
  };
  if (briefOutcome.brief !== undefined) return { ...result, brief: briefOutcome.brief };
  if (briefOutcome.notice !== undefined) return { ...result, notices: [briefOutcome.notice] };
  return result;
}

const MAX_PROSE_LINES = 30;
const MAX_OPEN_BULLETS = 8;
const MAX_BRIEF_LINES = 8;

/**
 * The prose form: title, the core's stages, one line per output
 * (`novel: 2 of 24 chapters drafted`), `track: <id>`, `last`, `open` (max 8 bullets,
 * then `+N more`), `brief` if present (indented, max ~8 lines), then
 * `next: …` as the FINAL line. Under 30 lines total — truncated from the
 * body above, the `next:` line is never cut.
 */
export function formatResumeProse(result: ResumeResult): string {
  const body: string[] = [result.title, ...coreLines(result.core), ...outputLines(result.outputs), `track: ${result.track}`];
  if (result.realNames === false) body.push("real names: kept out of distilled facts (realNames: false)");
  if (result.waiting.length > 0) body.push(`waiting for review: ${result.waiting.join(", ")}`);

  if (result.last.note !== undefined) {
    body.push(`last note (${result.last.note.date}): ${result.last.note.summary}`);
  }
  if (result.last.commit !== undefined) {
    body.push(`last commit (${result.last.commit.date} ${result.last.commit.sha}): ${result.last.commit.subject}`);
  }

  if (result.open.length > 0) {
    body.push("open:");
    const shown = result.open.slice(0, MAX_OPEN_BULLETS);
    for (const item of shown) body.push(`  - ${item.text}`);
    if (result.open.length > shown.length) body.push(`  +${result.open.length - shown.length} more`);
  }

  if (result.brief !== undefined && result.brief !== "") {
    body.push("brief:");
    for (const line of result.brief.split("\n").slice(0, MAX_BRIEF_LINES)) body.push(`  ${line}`);
  }

  if (result.notices !== undefined) {
    for (const notice of result.notices) body.push(`note: ${notice}`);
  }

  const truncated = body.length > MAX_PROSE_LINES - 1 ? body.slice(0, MAX_PROSE_LINES - 1) : body;
  return [...truncated, `next: ${result.next}`].join("\n");
}

/** The `resume` verb's CLI glue: build the summary, emit it, exit 0. */
export async function runResumeVerb(
  json: boolean,
  workDir: string,
  slug: string,
  options: RunResumeOptions = {},
): Promise<number> {
  const result = await buildResume(workDir, slug, options);
  console.log(json ? JSON.stringify(result) : formatResumeProse(result));
  return 0;
}
