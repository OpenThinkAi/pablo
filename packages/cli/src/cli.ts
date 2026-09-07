#!/usr/bin/env bun
/**
 * `pablo` — the CLI that writes: the manager for writing projects, driven by
 * whatever agent you like (Claude Code, Codex, pi). See
 * `~/saltline-digital-vault/projects/ai-terminal/README.md` for the design.
 *
 * This is the P0 skeleton: argument parsing, `--help`, `--project`
 * resolution, and `init` (which writes the `pablo.json` marker every other
 * verb requires) are real; every other verb body is a stub. Exit codes are
 * the contract every later ticket builds on: 0 ok, 2 refused (a framework
 * precondition — an unresolvable `--project`, a missing/invalid marker, or
 * later an unmet stage precondition), 1 error (including "not implemented
 * yet").
 */

import { parseArgs } from "node:util";
import { initAdopt, initNovel } from "./init";
import type { InitResult } from "./init";
import { readMarker } from "./marker";
import { chapterPreconditions, readNovelState } from "./novel/machine";
import type { NovelState } from "./novel/machine";
import { findVault, resolveProjectFromCwd } from "./project";
import type { Refusal } from "./project";
import { runResumeVerb } from "./resume";
import { runSave } from "./save";
import { runWrite } from "./write";

/** Verbs P0 ships: the manager for novels (see the design doc's build order). */
const P0_VERBS = ["init", "resume", "status", "write", "save", "check", "dry-run", "mcp"] as const;

/** Verbs planned for P1/P2 — listed in `--help` as later, not yet wired up. */
const LATER_VERBS = ["revise", "voice", "edit", "share", "notes", "publish"] as const;

const ALL_VERBS: readonly string[] = [...P0_VERBS, ...LATER_VERBS];

export const EXIT_OK = 0;
export const EXIT_REFUSED = 2;
export const EXIT_ERROR = 1;

function helpText(): string {
  return [
    "pablo — the CLI that writes: the manager for writing projects (novels, stories, essays)",
    "",
    "Usage: pablo <verb> [--project <slug>] [--json] [options]",
    "",
    "Verbs:",
    ...P0_VERBS.map((verb) => `  ${verb}`),
    "",
    "Later (not yet implemented):",
    ...LATER_VERBS.map((verb) => `  ${verb}`),
    "",
    "Every verb accepts --project <slug> and --json.",
    "--project resolves to <vault>/<kind>/<slug> (kind: novels, stories, essays).",
    "The vault is $PABLO_VAULT if set, else the nearest ancestor of the current",
    "directory holding a style/ directory.",
    "",
    "  pablo init <format> <slug> \"<Title>\"    scaffold a new work and write its marker",
    "  pablo init --adopt --project <slug>      write only the marker into an existing work",
    "  pablo status --project <slug>            the novel machine's per-stage summary",
    "  pablo status --project <slug> --for \"chapter N\"",
    "                                            {ready, missing[]} for one chapter;",
    "                                            exit 0 if ready, 2 if not",
    "",
    "Every verb but init refuses (exit 2) when the resolved project has no",
    "pablo.json marker.",
    "",
    "Exit codes: 0 ok, 2 refused (a framework precondition), 1 error.",
  ].join("\n");
}

interface ParsedArgs {
  readonly verb: string | undefined;
  /** Positionals after the verb — e.g. `<format> <slug> "<Title>"` for `init`. */
  readonly rest: readonly string[];
  readonly project: string | undefined;
  readonly json: boolean;
  readonly help: boolean;
  readonly adopt: boolean;
  /** `status --for "chapter N"` (also accepts `chapter-N`, `ch N`, or bare `N`). */
  readonly for: string | undefined;
  /** `save --stage acts|beats|premise|bible/<file>`. */
  readonly stage: string | undefined;
  /** `save --file <path>` — stdin is read when omitted. */
  readonly file: string | undefined;
  /** `write --chapter N`; parsed and validated by `runWrite`, not here. */
  readonly chapter: string | undefined;
  /** `write --words W`; defaults to `DEFAULT_WORD_TARGET` when absent. */
  readonly words: string | undefined;
  /** `write --scenes S`; defaults to `DEFAULT_MIN_SCENES` when absent. */
  readonly scenes: string | undefined;
  /** `write --dry-run`: assemble and render the pack, send nothing. */
  readonly dryRun: boolean;
}

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const { values, positionals } = parseArgs({
    args: argv as string[],
    allowPositionals: true,
    strict: false,
    options: {
      project: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      adopt: { type: "boolean", default: false },
      for: { type: "string" },
      stage: { type: "string" },
      file: { type: "string" },
      chapter: { type: "string" },
      words: { type: "string" },
      scenes: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });

  return {
    verb: positionals[0],
    rest: positionals.slice(1),
    project: typeof values["project"] === "string" ? values["project"] : undefined,
    json: values["json"] === true,
    help: values["help"] === true,
    adopt: values["adopt"] === true,
    for: typeof values["for"] === "string" ? values["for"] : undefined,
    stage: typeof values["stage"] === "string" ? values["stage"] : undefined,
    file: typeof values["file"] === "string" ? values["file"] : undefined,
    chapter: typeof values["chapter"] === "string" ? values["chapter"] : undefined,
    words: typeof values["words"] === "string" ? values["words"] : undefined,
    scenes: typeof values["scenes"] === "string" ? values["scenes"] : undefined,
    dryRun: values["dry-run"] === true,
  };
}

interface Result {
  readonly ok: boolean;
  readonly code: number;
  readonly message: string;
  readonly tried?: readonly string[];
}

function emit(result: Result, json: boolean): void {
  if (json) {
    const body: Record<string, unknown> = { ok: result.ok, code: result.code, message: result.message };
    if (result.tried) body["tried"] = result.tried;
    console.log(JSON.stringify(body));
    return;
  }
  if (result.ok) console.log(result.message);
  else console.error(result.message);
}

function refusalResult(refusal: Refusal): Result {
  return { ok: false, code: refusal.code, message: refusal.message, tried: refusal.tried };
}

/**
 * The AC4 gate: every verb but `init` refuses (exit 2) when the resolved
 * project has no valid `pablo.json`. Delegates to `readMarker`, whose
 * refusal already names the missing/invalid key or points at
 * `pablo init --adopt`.
 */
function requireMarker(projectPath: string): Refusal | undefined {
  const marker = readMarker(projectPath);
  return marker.ok ? undefined : marker;
}

function emitInitResult(result: InitResult, json: boolean): number {
  if (!result.ok) {
    emit(refusalResult(result), json);
    return result.code;
  }

  if (json) {
    const body: Record<string, unknown> = {
      ok: true,
      path: result.path,
      format: result.format,
      slug: result.slug,
      title: result.title,
      committed: result.committed,
    };
    if (result.notice) body["notice"] = result.notice;
    console.log(JSON.stringify(body));
  } else {
    const committedNote = result.committed ? " (committed)" : "";
    console.log(`pablo: created ${result.path}${committedNote}`);
    if (result.notice) console.log(result.notice);
  }

  return EXIT_OK;
}

function runInit(args: ParsedArgs, cwd: string): number {
  const vaultResult = findVault(cwd);
  if (!vaultResult.ok) {
    emit(refusalResult(vaultResult), args.json);
    return vaultResult.code;
  }
  const vault = vaultResult.path;

  if (args.adopt) {
    if (args.project === undefined) {
      const message = "pablo: init --adopt requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }

    const resolved = resolveProjectFromCwd(cwd, args.project);
    if (!resolved.ok) {
      emit(refusalResult(resolved), args.json);
      return resolved.code;
    }

    return emitInitResult(initAdopt(vault, resolved.path, args.project), args.json);
  }

  const [format, slug, title] = args.rest;
  if (format === undefined || slug === undefined || title === undefined) {
    const message = 'pablo: usage: pablo init <format> <slug> "<Title>"';
    emit({ ok: false, code: EXIT_ERROR, message }, args.json);
    return EXIT_ERROR;
  }

  if (format !== "novel") {
    const message = `pablo: init: only "novel" is implemented (got "${format}")`;
    emit({ ok: false, code: EXIT_ERROR, message }, args.json);
    return EXIT_ERROR;
  }

  return emitInitResult(initNovel(vault, slug, title), args.json);
}

/**
 * Parses `--for`'s value into a chapter number. Accepts `chapter N`,
 * `chapter-N`, `ch N`, or a bare `N`; anything else is `undefined`, which the
 * caller turns into a refusal.
 */
export function parseForChapter(raw: string): number | undefined {
  const trimmed = raw.trim();
  for (const pattern of [/^chapter\s+(\d+)$/i, /^chapter-(\d+)$/i, /^ch\s+(\d+)$/i, /^(\d+)$/]) {
    const match = pattern.exec(trimmed);
    if (match) return Number(match[1]);
  }
  return undefined;
}

/**
 * `status`'s prose: one line per stage, in the state's own order. `bible`'s
 * file count is how many of the checked files exist, not how many were
 * checked — an absent `places.md` shouldn't read as "1 file" the way a
 * present one does.
 */
function proseState(state: NovelState): string {
  const lines: string[] = [];
  lines.push(`premise: ${state.premise ? "ok" : "missing"}`);

  const existingBibleFiles = state.bible.files.filter((f) => f.exists).length;
  lines.push(`bible: ${existingBibleFiles} files, ${state.bible.picks.length} [pick] rows`);

  lines.push(`acts: ${state.acts.length}`);

  if (state.beats.length === 0) {
    lines.push("beats: 0");
  } else {
    const numbers = state.beats.map((b) => b.chapter);
    lines.push(`beats: ${state.beats.length} (chapters ${Math.min(...numbers)}–${Math.max(...numbers)})`);
  }

  const statusCounts = new Map<string, number>();
  for (const chapter of state.chapters) {
    const key = chapter.status ?? "unknown";
    statusCounts.set(key, (statusCounts.get(key) ?? 0) + 1);
  }
  const counts = [...statusCounts.entries()].map(([status, count]) => `${status}: ${count}`).join(", ");
  lines.push(`chapters: ${state.chapters.length} written${counts ? ` (${counts})` : ""}`);

  return lines.join("\n");
}

/**
 * `pablo status --project <slug> [--for "chapter N"]`. With no `--for`, the
 * novel machine's state (JSON: the state object; prose: `proseState`). With
 * `--for`, one chapter's preconditions — JSON body is `{ready, missing}`
 * (no `ok`/`code` wrapper: a refused precondition is data here, not a
 * framework-resolution failure), and the exit code carries readiness: 0 when
 * ready, 2 when not (a framework precondition, same as every other refusal).
 */
function runStatus(args: ParsedArgs, projectPath: string): number {
  const state = readNovelState(projectPath);

  if (args.for !== undefined) {
    const chapter = parseForChapter(args.for);
    if (chapter === undefined) {
      const message = 'pablo: --for expects "chapter N"';
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }

    const result = chapterPreconditions(state, chapter);
    if (args.json) {
      console.log(JSON.stringify({ ready: result.ready, missing: result.missing }));
    } else {
      console.log(`chapter ${chapter}: ${result.ready ? "ready" : "not ready"}`);
      for (const item of result.missing) console.log(`  ${item}`);
    }
    return result.ready ? EXIT_OK : EXIT_REFUSED;
  }

  if (args.json) {
    console.log(JSON.stringify(state));
  } else {
    console.log(proseState(state));
  }
  return EXIT_OK;
}

/** Runs the CLI for `argv` (already stripped of `bun`/script name) and returns the process exit code. */
export async function main(argv: readonly string[], cwd: string = process.cwd()): Promise<number> {
  const args = parseCliArgs(argv);

  if (args.help || args.verb === undefined) {
    console.log(helpText());
    return EXIT_OK;
  }

  if (!ALL_VERBS.includes(args.verb)) {
    const message = `pablo: unknown verb "${args.verb}" — run "pablo --help" for the list`;
    emit({ ok: false, code: EXIT_ERROR, message }, args.json);
    return EXIT_ERROR;
  }

  if (args.verb === "init") {
    return runInit(args, cwd);
  }

  let projectPath: string | undefined;
  if (args.project !== undefined) {
    const resolved = resolveProjectFromCwd(cwd, args.project);
    if (!resolved.ok) {
      emit(refusalResult(resolved), args.json);
      return resolved.code;
    }

    const markerRefusal = requireMarker(resolved.path);
    if (markerRefusal) {
      emit(refusalResult(markerRefusal), args.json);
      return markerRefusal.code;
    }
    projectPath = resolved.path;
  }

  if (args.verb === "status") {
    if (projectPath === undefined) {
      const message = "pablo: status requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    return runStatus(args, projectPath);
  }

  if (args.verb === "resume") {
    if (projectPath === undefined) {
      const message = "pablo: resume requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    return await runResumeVerb(args.json, projectPath, args.project as string);
  }

  if (args.verb === "save") {
    if (projectPath === undefined) {
      const message = "pablo: save requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    return runSave({ stage: args.stage, file: args.file, json: args.json }, projectPath);
  }

  if (args.verb === "write") {
    if (projectPath === undefined) {
      const message = "pablo: write requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const vaultResult = findVault(cwd);
    if (!vaultResult.ok) {
      emit(refusalResult(vaultResult), args.json);
      return vaultResult.code;
    }
    return runWrite(args, vaultResult.path, projectPath);
  }

  const message = `pablo: "${args.verb}" not implemented yet`;
  emit({ ok: false, code: EXIT_ERROR, message }, args.json);
  return EXIT_ERROR;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
