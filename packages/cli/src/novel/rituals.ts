/**
 * `runRituals` (AGT-1231, AGT-1232): the things every rules file already
 * asked the model to do after a chapter draft and that never actually
 * happened — tick the outline, drop a dated note, update the README's
 * "Where things stand" section, extract continuity facts, commit exactly the
 * touched paths, and `think sync`. See the design doc's stage table
 * (`~/saltline-digital-vault/projects/ai-terminal/README.md`, the
 * `chapter N` row's "After" column) and `packages/cli/src/write.ts`
 * (AGT-1237), which calls this once the chapter file is on disk and merges
 * the result into the write response as `rituals`.
 *
 * Every ritual is independent and wrapped so nothing it does can throw out
 * of `runRituals` or undo the chapter write that already landed — a failure
 * anywhere here is a `Ritual` with `status: "failed"`, not an exception. The
 * seven run in a fixed order: outline, note, readme, continuity, git, queue,
 * think. Continuity runs before git so `continuity.md` can be included in
 * the same commit — but only when it actually changed (AGT-1232's
 * `runContinuity` doc comment). `queue` (AGT-1262) runs after `git` so the
 * chapter file is already committed by the time the piece is queued for
 * review, and before `think` so a queue failure is never masked by a slower
 * `think sync` outcome.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { Adapter } from "@openthink/pablo-core";
import { stateReviewPath } from "../paths";
import { appendEvent } from "../review";
import type { QueuedEvent } from "../review";
import { runContinuity } from "./continuity";

export type RitualStatus = "ran" | "skipped" | "failed";

export interface Ritual {
  readonly name: string;
  readonly status: RitualStatus;
  readonly detail: string;
}

export interface RitualOptions {
  /** The project's slug (from `pablo.json`), used in the git and think messages. */
  readonly slug: string;
  readonly words: number;
  readonly model: string;
  /** The prose receipt line write.ts already prints (`read N tokens in Xs, wrote M in Ys`). */
  readonly receiptLine: string;
  /** Overrides the clock the "today" date and note filename are computed from. */
  readonly now?: (() => Date) | undefined;
  /** Overrides `process.env` for `Bun.which("think", ...)` and the spawned `think` process. */
  readonly env?: Record<string, string | undefined> | undefined;
  /** Overrides the `think sync` timeout (default 20s). */
  readonly thinkTimeoutMs?: number | undefined;
  /**
   * The adapter to run continuity extraction with (AGT-1232) — the routed
   * extraction adapter in production, or the same fake adapter a test
   * injected as `RunWriteDeps.adapter`. `undefined` (the default) skips the
   * ritual: "no extraction adapter". Optional on `Adapter` itself is a
   * different, narrower skip — see `runContinuity`.
   */
  readonly extractor?: Adapter | undefined;
  /** Overrides the continuity extraction ritual's 120s ceiling. */
  readonly continuityTimeoutMs?: number | undefined;
  /**
   * AGT-1262: what the `queue` ritual needs to append this chapter's
   * `queued` event — `write.ts` already has every one of these fields
   * (`packResult.inputs.beat.title`, `vaultRoot`, `pack.hash`) before it
   * calls `runRituals`, so they are passed in rather than re-derived here.
   * `id` is `write.ts`'s own `mintPieceId(...)` call, minted before
   * `runRituals` runs so it is available for the JSON `piece` field even
   * when the queue append itself fails.
   */
  readonly queue: QueueRitualInput;
}

/** `RitualOptions.queue` — the fields the `queue` ritual needs beyond `opts.slug` (the project) and `opts.words`. */
export interface QueueRitualInput {
  readonly id: string;
  readonly title: string;
  readonly vault: string;
  readonly promptHash: string;
}

const DEFAULT_THINK_TIMEOUT_MS = 20_000;
/** `~/.nvm/versions/node/v24.11.0/bin/think` — the dev machine's PATH-injection fallback, per AGT-1229's `resume.ts`. */
const NVM_THINK_FALLBACK = join(homedir(), ".nvm", "versions", "node", "v24.11.0", "bin", "think");

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The first non-empty line of `text`, trimmed — what a failed ritual's `detail` reports from a stack trace or stderr blob. */
function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line ?? text.trim();
}

/** Runs `fn`, catching anything it throws into a `"failed"` ritual — the guarantee nothing escapes `runRituals`. */
function attempt(name: string, fn: () => Ritual): Ritual {
  try {
    return fn();
  } catch (err) {
    return { name, status: "failed", detail: firstLine(errMessage(err)) };
  }
}

async function attemptAsync(name: string, fn: () => Promise<Ritual>): Promise<Ritual> {
  try {
    return await fn();
  } catch (err) {
    return { name, status: "failed", detail: firstLine(errMessage(err)) };
  }
}

/**
 * Finds `outline/chapters.md`'s row whose first cell is `chapter` (regex
 * `^\|\s*N\s*\|`) and ticks its last (status) cell to `draft`, preserving
 * every other cell byte-for-byte and the ticked cell's surrounding
 * whitespace.
 *
 * DELIBERATE DEVIATION from the ticket's literal "replace the LAST cell
 * `beat` with `draft`": nowhere in this codebase's actual data — not the
 * `ice-house` fixture, not `save.ts`'s `BEATS_HEADER`, not
 * `pack-vault.test.ts`/`save.test.ts`'s assertions — does a pre-draft status
 * cell ever hold the literal string "beat" (they hold "outline", matching
 * the design doc's own stage-table column header, which names the whole
 * *beat* column "beat" and is a different cell). Ticking on "cell is not
 * literally 'beat'" would make this ritual a permanent no-op against real
 * data. Ticking any non-"draft" value to "draft", and skipping only a
 * missing row or one already "draft" (AC: idempotent re-run), is what the
 * design doc's "outline tick (`beat` -> `draft`)" and this ticket's own
 * AC1 ("moves from `beat` to `draft`") actually require in practice.
 */
function tickOutline(workDir: string, chapter: number): Ritual {
  const path = join(workDir, "outline", "chapters.md");
  if (!existsSync(path)) {
    return { name: "outline", status: "skipped", detail: "outline/chapters.md not found" };
  }

  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const rowPattern = new RegExp(`^\\|\\s*${chapter}\\s*\\|`);
  const rowIndex = lines.findIndex((line) => rowPattern.test(line));
  if (rowIndex === -1) {
    return { name: "outline", status: "skipped", detail: `no outline row for chapter ${chapter}` };
  }

  const line = lines[rowIndex] ?? "";
  const cells = line.split("|");
  // A well-formed row is `| a | b | ... | z |`, which `split("|")` turns into
  // `["", " a ", ..., " z ", ""]` — the last data cell sits one before the
  // trailing empty string from the closing pipe.
  const lastIndex = cells.length > 0 && cells[cells.length - 1] === "" ? cells.length - 2 : cells.length - 1;
  if (lastIndex < 1) {
    return { name: "outline", status: "skipped", detail: `malformed outline row for chapter ${chapter}` };
  }

  const currentCell = cells[lastIndex] ?? "";
  const currentValue = currentCell.trim();

  if (currentValue === "draft") {
    return { name: "outline", status: "skipped", detail: `chapter ${chapter} is already marked draft` };
  }
  if (currentValue === "") {
    return { name: "outline", status: "skipped", detail: `malformed outline row for chapter ${chapter} (empty status cell)` };
  }

  const leading = currentCell.match(/^\s*/)?.[0] ?? "";
  const trailing = currentCell.match(/\s*$/)?.[0] ?? "";
  cells[lastIndex] = `${leading}draft${trailing}`;
  lines[rowIndex] = cells.join("|");
  writeFileSync(path, lines.join("\n"), "utf8");

  return { name: "outline", status: "ran", detail: `chapter ${chapter}: ${currentValue} -> draft` };
}

/** `notes/<today>-chapter-<NN>.md`'s absolute and work-relative path, `NN` zero-padded to at least two digits (matches `write.ts`'s `chapterFileName`). */
function notePath(workDir: string, chapter: number, today: string): { readonly abs: string; readonly rel: string } {
  const rel = join("notes", `${today}-chapter-${String(chapter).padStart(2, "0")}.md`)
    .split(sep)
    .join("/");
  return { abs: join(workDir, rel), rel };
}

/**
 * Writes (or, if today's file for this chapter already exists, appends to)
 * `notes/<today>-chapter-<NN>.md`: `# <today> — chapter N drafted` as the
 * heading on first write, then one line per run with the receipt and
 * words/model.
 */
function writeNote(workDir: string, chapter: number, today: string, receiptLine: string, words: number, model: string): Ritual {
  const { abs, rel } = notePath(workDir, chapter, today);
  mkdirSync(dirname(abs), { recursive: true });

  const bodyLine = `${receiptLine} — words: ${words}, model: ${model}`;

  if (existsSync(abs)) {
    const existing = readFileSync(abs, "utf8");
    const gap = existing.endsWith("\n") ? "" : "\n";
    writeFileSync(abs, `${existing}${gap}${bodyLine}\n`, "utf8");
    return { name: "note", status: "ran", detail: `appended to ${rel}` };
  }

  const heading = `# ${today} — chapter ${chapter} drafted`;
  writeFileSync(abs, `${heading}\n\n${bodyLine}\n`, "utf8");
  return { name: "note", status: "ran", detail: `created ${rel}` };
}

/** The bullet `tickReadme` inserts: `- <today>: chapter N drafted (<words> words, <model>).` */
function readmeBullet(today: string, chapter: number, words: number, model: string): string {
  return `- ${today}: chapter ${chapter} drafted (${words} words, ${model}).`;
}

/**
 * Appends `readmeBullet` as the last bullet under `## Where things stand` in
 * `README.md` (before the next `## ` heading, or at end of file); a missing
 * heading gets the heading appended along with the bullet; a missing
 * `README.md` gets a minimal one created.
 */
function tickReadme(workDir: string, chapter: number, today: string, words: number, model: string): Ritual {
  const path = join(workDir, "README.md");
  const bullet = readmeBullet(today, chapter, words, model);

  if (!existsSync(path)) {
    writeFileSync(path, `## Where things stand\n\n${bullet}\n`, "utf8");
    return { name: "readme", status: "ran", detail: "created README.md with 'Where things stand'" };
  }

  const content = readFileSync(path, "utf8");
  const lines = content.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === "## Where things stand");

  if (headingIndex === -1) {
    const gap = content.endsWith("\n") ? "" : "\n";
    writeFileSync(path, `${content}${gap}\n## Where things stand\n\n${bullet}\n`, "utf8");
    return { name: "readme", status: "ran", detail: "added 'Where things stand' section" };
  }

  let sectionEnd = lines.length;
  for (let i = headingIndex + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i] ?? "")) {
      sectionEnd = i;
      break;
    }
  }

  let insertAt = headingIndex + 1;
  for (let i = sectionEnd - 1; i > headingIndex; i--) {
    if ((lines[i] ?? "").trim() !== "") {
      insertAt = i + 1;
      break;
    }
  }

  lines.splice(insertAt, 0, bullet);
  writeFileSync(path, lines.join("\n"), "utf8");
  return { name: "readme", status: "ran", detail: `chapter ${chapter} bullet added` };
}

/**
 * `git -C workDir add -- <paths that exist>` then
 * `git -C workDir commit -m message -- <same paths>`, never `-A`. Paths that
 * don't exist on disk are dropped first (a `git add` of a missing path
 * fails outright). Not a git repo, or either command exiting non-zero, is a
 * `"failed"` ritual naming the repo or the command's first stderr line —
 * never a thrown exception, and never anything that touches the files
 * already written.
 */
function runGit(workDir: string, candidatePaths: readonly string[], message: string): Ritual {
  const paths = candidatePaths.filter((p) => existsSync(join(workDir, p)));
  if (paths.length === 0) {
    return { name: "git", status: "skipped", detail: "no paths to commit" };
  }

  const repoCheck = Bun.spawnSync(["git", "-C", workDir, "rev-parse", "--is-inside-work-tree"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (repoCheck.exitCode !== 0) {
    return { name: "git", status: "failed", detail: `${workDir} is not a git repository` };
  }

  const add = Bun.spawnSync(["git", "-C", workDir, "add", "--", ...paths], { stdout: "pipe", stderr: "pipe" });
  if (add.exitCode !== 0) {
    return { name: "git", status: "failed", detail: firstLine(add.stderr.toString("utf8")) };
  }

  const commit = Bun.spawnSync(["git", "-C", workDir, "commit", "-m", message, "--", ...paths], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (commit.exitCode !== 0) {
    return { name: "git", status: "failed", detail: firstLine(commit.stderr.toString("utf8")) };
  }

  return { name: "git", status: "ran", detail: message };
}

/**
 * `think -C writing sync "<slug>: drafted chapter N (<words> words)" --topic repo:<slug>`,
 * resolved off `env.PATH` and raced against `timeoutMs` — mirrors
 * `resume.ts`'s `runBrief`. A missing `think` is `"skipped"`; a timeout
 * (killed) or non-zero exit is `"failed"`.
 *
 * `allowNvmFallback` gates the dev machine's hardcoded nvm `think` fallback
 * (`NVM_THINK_FALLBACK`): it is `true` only when `RitualOptions.env` was left
 * undefined (the real production default, `process.env`), never when a
 * caller passed an explicit `env` — that literal path exists on this dev
 * machine regardless of what `PATH` a test injects, so honoring it
 * unconditionally would make a "think not on PATH" test actually shell out
 * to the real `think` and write to the real cortex. `runRituals` computes
 * this from whether `opts.env` is `undefined`, before defaulting it.
 */
async function runThink(
  chapter: number,
  words: number,
  slug: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
  allowNvmFallback: boolean,
): Promise<Ritual> {
  let thinkPath = Bun.which("think", { PATH: env["PATH"] });
  if (thinkPath === null && allowNvmFallback && existsSync(NVM_THINK_FALLBACK)) {
    thinkPath = NVM_THINK_FALLBACK;
  }
  if (thinkPath === null) {
    return { name: "think", status: "skipped", detail: "think not on PATH" };
  }

  const message = `${slug}: drafted chapter ${chapter} (${words} words)`;
  const proc = Bun.spawn([thinkPath, "-C", "writing", "sync", message, "--topic", `repo:${slug}`], {
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
    return { name: "think", status: "failed", detail: `timed out after ${Math.round(timeoutMs / 1000)}s` };
  }
  if (outcome !== 0) {
    return { name: "think", status: "failed", detail: `exited ${outcome}` };
  }

  return { name: "think", status: "ran", detail: message };
}

/**
 * Appends a `queued` event (AGT-1262) for the chapter file `write.ts` just
 * wrote and committed, to `stateReviewPath(env)` (the one global queue —
 * never vault-relative, see `paths.ts`'s `stateReviewPath`). Text-free:
 * `QueuedEvent` carries no manuscript content, only id/kind/title/path and
 * the bookkeeping fields (`review-no-text.test.ts` enforces this on the type
 * itself). `appendEvent` throws on a write failure (an unwritable state
 * directory); `attempt()` in `runRituals` turns that into a `"failed"`
 * ritual, never an exception out of this function.
 *
 * `env` is `runRituals`'s already-defaulted `opts.env ?? process.env` (the
 * same resolved value `runThink` takes below), not `opts.env` itself — a
 * second `opts.env ?? process.env` here would be a second place to keep in
 * sync with `runRituals`'s own defaulting.
 */
function runQueue(
  env: Record<string, string | undefined>,
  chapterPath: string,
  chapter: number,
  opts: RitualOptions,
  now: () => Date,
): Ritual {
  const event: QueuedEvent = {
    type: "queued",
    id: opts.queue.id,
    at: now().toISOString(),
    kind: "chapter",
    title: opts.queue.title,
    path: chapterPath,
    vault: opts.queue.vault,
    project: opts.slug,
    words: opts.words,
    prompt_hash: opts.queue.promptHash,
  };

  appendEvent(stateReviewPath(env), event);
  return { name: "queue", status: "ran", detail: `queued ${opts.queue.id} (chapter ${chapter})` };
}

/**
 * Strips a leading YAML frontmatter block (`---\n...\n---\n`, optionally
 * followed by a blank line) off a chapter file's full text, returning just
 * the prose — what `write.ts`'s `normalized` was before the frontmatter was
 * prepended. A file with no frontmatter block is returned unchanged.
 */
function stripFrontmatter(text: string): string {
  const match = text.match(/^---\n[\s\S]*?\n---\n\n?/);
  return match ? text.slice(match[0].length) : text;
}

/**
 * Runs the seven after-write rituals, in order: outline, note, readme,
 * continuity, git, queue, think. `workDir` is the project directory (e.g.
 * `<vault>/novels/<slug>`); `chapterPath` is the absolute path to the
 * chapter file `write.ts` just wrote. Always resolves to exactly seven
 * `Ritual`s, never throws, and is called only on the live write path — never
 * on `--dry-run`, never after a refusal (both return before this would be
 * reached).
 */
export async function runRituals(workDir: string, chapter: number, chapterPath: string, opts: RitualOptions): Promise<Ritual[]> {
  const now = opts.now ?? (() => new Date());
  // Captured before defaulting `env` — see `runThink`'s doc comment on `allowNvmFallback`.
  const allowNvmFallback = opts.env === undefined;
  const env = opts.env ?? process.env;
  const thinkTimeoutMs = opts.thinkTimeoutMs ?? DEFAULT_THINK_TIMEOUT_MS;
  const today = now().toISOString().slice(0, 10);

  const outline = attempt("outline", () => tickOutline(workDir, chapter));

  const { rel: noteRel } = notePath(workDir, chapter, today);
  const note = attempt("note", () => writeNote(workDir, chapter, today, opts.receiptLine, opts.words, opts.model));

  const readme = attempt("readme", () => tickReadme(workDir, chapter, today, opts.words, opts.model));

  // Reading the chapter file happens inside the wrapper too — a read failure
  // (the file `write.ts` just wrote should always exist, but nothing here
  // should be able to throw out of `runRituals`) becomes a "failed" ritual,
  // same as any other continuity failure.
  const continuity = await attemptAsync("continuity", () => {
    const chapterBody = stripFrontmatter(readFileSync(chapterPath, "utf8"));
    return runContinuity(workDir, chapter, chapterBody, { adapter: opts.extractor, timeoutMs: opts.continuityTimeoutMs });
  });

  const chapterRel = relative(workDir, chapterPath).split(sep).join("/");
  const gitPaths = [chapterRel, "outline/chapters.md", noteRel, "README.md"];
  if (continuity.status === "ran") gitPaths.push("continuity.md");
  const git = attempt("git", () => runGit(workDir, gitPaths, `${opts.slug}: draft chapter ${chapter}`));

  const queue = attempt("queue", () => runQueue(env, chapterPath, chapter, opts, now));

  const think = await attemptAsync("think", () => runThink(chapter, opts.words, opts.slug, env, thinkTimeoutMs, allowNvmFallback));

  return [outline, note, readme, continuity, git, queue, think];
}
