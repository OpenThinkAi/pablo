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

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runCheck } from "./check";
import { initAdopt, initNovel } from "./init";
import type { InitResult } from "./init";
import { readMarker } from "./marker";
import { runMcp } from "./mcp";
import { chapterPreconditions, readNovelState } from "./novel/machine";
import type { NovelState } from "./novel/machine";
import { findVault, resolveProjectFromCwd } from "./project";
import type { Refusal } from "./project";
import { runProse } from "./prose";
import { runResumeVerb } from "./resume";
import { runReview } from "./review-verbs";
import { runSave } from "./save";
import { deriveCliOptions, parseForChapter } from "./verbs";
import { addExemplar, flagLine, listVoices, readVoice, resolveVoice, scaffoldVoice } from "./voice";
import type { Voice } from "./voice";
import { runWrite } from "./write";

/** Verbs P0 ships: the manager for novels (see the design doc's build order). */
const P0_VERBS = ["init", "resume", "status", "write", "save", "check", "dry-run", "mcp", "voice", "prose", "review"] as const;

/** Verbs planned for P1/P2 — listed in `--help` as later, not yet wired up. */
const LATER_VERBS = ["revise", "edit", "share", "notes", "publish"] as const;

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
    "directory holding a style/ or voices/ directory.",
    "",
    "  pablo init <format> <slug> \"<Title>\"    scaffold a new work and write its marker",
    "  pablo init --adopt --project <slug>      write only the marker into an existing work",
    "  pablo status --project <slug>            the novel machine's per-stage summary",
    "  pablo status --project <slug> --for \"chapter N\"",
    "                                            {ready, missing[]} for one chapter;",
    "                                            exit 0 if ready, 2 if not",
    "  pablo voice new <name> [--global]        scaffold a voice directory",
    "  pablo voice list                         every voice in the vault and the global dir",
    "  pablo voice show <name>                  the assembled voice as a model will see it",
    '  pablo voice flag <name> "<line>" [--section <heading>]',
    "                                            record a rejected line under a voice.md/",
    "                                            style/prose.md section (default \"Flagged\")",
    '  pablo voice exemplar <name> <file> [--title "<t>"]',
    "                                            keep a piece as-is under the voice's exemplars/",
    "  pablo prose --voice <name> --brief <file|-> [--context <file>]...",
    "              [--format email|post|page|reply|note] [--words N]",
    "              [--draft <file> --instruction \"<text>\"]",
    "              [--out <file> [--force]] [--json] [--dry-run]",
    "                                            write a piece in a voice: assemble, send,",
    "                                            print the text, receipt it, check it;",
    "                                            no --project, no vault required;",
    "                                            --draft + --instruction revise a previous",
    "                                            piece instead of starting fresh",
    "  pablo review list [--all] [--json]       pending pieces (or, with --all, decided too)",
    "  pablo review show <id> [--json]          one piece's record, decision, and edits",
    "  pablo review approve <id> [--unread]     record an approval (--unread: read: false)",
    '  pablo review reject <id> [--reason "<text>"]',
    "                                            record a rejection",
    "  pablo review wait <id> [--timeout <seconds>]",
    "                                            block until a decision exists (default 3600s);",
    "                                            exit 0 approved, 2 rejected, 1 timeout, 2 unknown",
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
  /** `write --force`: overwrite an existing chapter file. */
  readonly force: boolean;
  /** `voice new --global`: scaffold under the global voices directory instead of the vault. */
  readonly global: boolean;
  /** `voice flag --section <heading>`: which `## ` section to append the flagged line under (default "Flagged"). */
  readonly section: string | undefined;
  /** `voice exemplar --title "<t>"`: the title to file the exemplar under. */
  readonly title: string | undefined;
  /** `prose --voice <name>`: which voice directory to write in. */
  readonly voice: string | undefined;
  /** `prose --brief <file|->`: the ask (a file, or `-` for stdin). */
  readonly brief: string | undefined;
  /** `prose --context <file>` (repeatable): sent verbatim, in argument order. */
  readonly context: readonly string[];
  /** `prose --format email|post|page|reply|note`. */
  readonly format: string | undefined;
  /** `prose --out <path>`: write the answer to a file (with `--force` to overwrite). */
  readonly out: string | undefined;
  /** `prose --draft <file>` (AGT-1244): the previous piece to revise. Requires `instruction`. */
  readonly draft: string | undefined;
  /** `prose --instruction "<text>"` (AGT-1244): what to change about `--draft`. Requires `draft`. */
  readonly instruction: string | undefined;
  /** `review list --all` (AGT-1261): include decided pieces, with their decision. */
  readonly all: boolean;
  /** `review approve --unread` (AGT-1261): record the approval as unread (`read: false`). */
  readonly unread: boolean;
  /** `review reject --reason "<text>"` (AGT-1261): why, recorded on the decision. */
  readonly reason: string | undefined;
  /** `review wait --timeout <seconds>` (AGT-1261); `runReview` defaults this to 3600 when absent. */
  readonly timeout: string | undefined;
}

/**
 * The five MCP-exposed verbs' own options (`project`, `for`, `stage`, `file`,
 * `chapter`, `words`, `scenes`, `dry-run`, `force`) are derived from
 * `verbs.ts`'s zod shapes (`deriveCliOptions`) rather than hand-typed here —
 * `pablo mcp` reads its tool schemas off the same shapes, so the CLI's argv
 * and the MCP surface cannot drift apart. `json`/`help`/`adopt` are CLI-only
 * flags no verb's contract includes, so they're added on top.
 */
export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const { values, positionals } = parseArgs({
    args: argv as string[],
    allowPositionals: true,
    strict: false,
    options: {
      ...deriveCliOptions(),
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      adopt: { type: "boolean", default: false },
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
    force: values["force"] === true,
    global: values["global"] === true,
    section: typeof values["section"] === "string" ? values["section"] : undefined,
    title: typeof values["title"] === "string" ? values["title"] : undefined,
    voice: typeof values["voice"] === "string" ? values["voice"] : undefined,
    brief: typeof values["brief"] === "string" ? values["brief"] : undefined,
    context: Array.isArray(values["context"]) ? (values["context"] as string[]) : [],
    format: typeof values["format"] === "string" ? values["format"] : undefined,
    out: typeof values["out"] === "string" ? values["out"] : undefined,
    draft: typeof values["draft"] === "string" ? values["draft"] : undefined,
    instruction: typeof values["instruction"] === "string" ? values["instruction"] : undefined,
    all: values["all"] === true,
    unread: values["unread"] === true,
    reason: typeof values["reason"] === "string" ? values["reason"] : undefined,
    timeout: typeof values["timeout"] === "string" ? values["timeout"] : undefined,
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

/** One line per rule/exemplar/never source — `voice show`'s prose rendering, "the assembled voice as a model will see it." */
function formatVoice(voice: Voice): string {
  const parts: string[] = [];
  for (const rule of voice.rules) parts.push(rule.text);
  if (voice.never) parts.push(voice.never.text);
  if (voice.exemplars.length > 0) {
    parts.push(["Exemplars:", ...voice.exemplars.map((ex) => `- ${ex.path}`)].join("\n"));
  }
  return parts.join("\n\n");
}

/**
 * `pablo voice new|list|show|flag|exemplar` (AGT-1240, `flag`/`exemplar`
 * AGT-1243). `sub`/`name` are positionals (`args.rest`), as is `flag`'s
 * `<line>` and `exemplar`'s `<file>` (`args.rest[2]`) — `--global`,
 * `--section`, `--title`, and `--json` are the only flags this verb takes.
 * There is no `--project`: a voice resolves from `cwd`/`PABLO_VAULT` (vault)
 * plus the global voices directory, never a `<vault>/<kind>/<slug>` project.
 */
function runVoice(args: ParsedArgs, cwd: string): number {
  const [sub, name, extra] = args.rest;
  const env = process.env;

  if (sub === "list") {
    const voices = listVoices({ cwd, env });
    if (args.json) {
      console.log(JSON.stringify({ ok: true, voices }));
    } else if (voices.length === 0) {
      console.log("pablo: no voices found");
    } else {
      for (const v of voices) console.log(`${v.name}\t${v.scope}\t${v.path}`);
    }
    return EXIT_OK;
  }

  if (sub === "new") {
    if (name === undefined) {
      const message = "pablo: usage: pablo voice new <name> [--global]";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const result = scaffoldVoice(name, { cwd, env, global: args.global });
    if (!result.ok) {
      emit(refusalResult(result), args.json);
      return result.code;
    }
    if (args.json) {
      const body: Record<string, unknown> = {
        ok: true,
        path: result.path,
        scope: result.scope,
        committed: result.committed,
      };
      if (result.notice) body["notice"] = result.notice;
      console.log(JSON.stringify(body));
    } else {
      console.log(`pablo: created ${result.path}${result.committed ? " (committed)" : ""}`);
      if (result.notice) console.log(result.notice);
    }
    return EXIT_OK;
  }

  if (sub === "show") {
    if (name === undefined) {
      const message = "pablo: usage: pablo voice show <name>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const resolution = resolveVoice(name, { cwd, env });
    if (!resolution.ok) {
      emit(refusalResult(resolution), args.json);
      return resolution.code;
    }
    const voice = readVoice(resolution.path);
    if (args.json) {
      console.log(JSON.stringify({ ok: true, ...voice }));
    } else {
      console.log(formatVoice(voice));
    }
    return EXIT_OK;
  }

  if (sub === "flag") {
    if (name === undefined || extra === undefined) {
      const message = 'pablo: usage: pablo voice flag <name> "<line>" [--section <heading>]';
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const resolution = resolveVoice(name, { cwd, env });
    if (!resolution.ok) {
      emit(refusalResult(resolution), args.json);
      return resolution.code;
    }
    const result = flagLine(resolution, extra, { section: args.section });
    if (!result.ok) {
      emit(refusalResult(result), args.json);
      return result.code;
    }
    if (args.json) {
      const body: Record<string, unknown> = { ok: true, path: result.path, committed: result.committed };
      if (result.notice) body["notice"] = result.notice;
      console.log(JSON.stringify(body));
    } else {
      console.log(`pablo: flagged in ${result.path}${result.committed ? " (committed)" : ""}`);
      if (result.notice) console.log(result.notice);
    }
    return EXIT_OK;
  }

  if (sub === "exemplar") {
    if (name === undefined || extra === undefined) {
      const message = 'pablo: usage: pablo voice exemplar <name> <file> [--title "<t>"]';
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const resolution = resolveVoice(name, { cwd, env });
    if (!resolution.ok) {
      emit(refusalResult(resolution), args.json);
      return resolution.code;
    }
    // The CLI's <file> is author-typed, exactly like `save`'s `--file` on
    // the CLI path — resolved against cwd, not bounded to the vault (that
    // bound applies over MCP, where the value is model-controlled instead).
    const sourceFile = resolve(cwd, extra);
    const result = addExemplar(resolution, sourceFile, { title: args.title });
    if (!result.ok) {
      emit(refusalResult(result), args.json);
      return result.code;
    }
    if (args.json) {
      const body: Record<string, unknown> = { ok: true, path: result.path, committed: result.committed };
      if (result.notice) body["notice"] = result.notice;
      console.log(JSON.stringify(body));
    } else {
      console.log(`pablo: kept ${result.path}${result.committed ? " (committed)" : ""}`);
      if (result.notice) console.log(result.notice);
    }
    return EXIT_OK;
  }

  const message = `pablo: voice: unknown subcommand "${sub ?? ""}" (expected new, list, show, flag, or exemplar)`;
  emit({ ok: false, code: EXIT_ERROR, message }, args.json);
  return EXIT_ERROR;
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

  if (args.verb === "mcp") {
    return await runMcp(cwd);
  }

  // `prose` (AGT-1241) has no `--project` at all — AC4 requires it to work
  // with no vault (a global voice, a brief anywhere), so it never enters the
  // shared `--project`/marker resolution below and is dispatched here,
  // before that block runs.
  if (args.verb === "prose") {
    return await runProse(
      {
        voice: args.voice,
        brief: args.brief,
        context: args.context,
        format: args.format,
        words: args.words,
        dryRun: args.dryRun,
        json: args.json,
        out: args.out,
        force: args.force,
        draft: args.draft,
        instruction: args.instruction,
      },
      { cwd, env: process.env },
    );
  }

  // `review` (AGT-1261), like `prose`, has no `--project` at all — the queue
  // is one global file, not per-vault — so it is dispatched here too, before
  // the shared `--project`/marker resolution block below ever runs.
  if (args.verb === "review") {
    const [action, id] = args.rest;
    const parsedTimeout = args.timeout !== undefined ? Number(args.timeout) : undefined;
    return await runReview(
      {
        action,
        id,
        all: args.all,
        unread: args.unread,
        reason: args.reason,
        // A non-numeric --timeout falls back to runReview's own default
        // (3600) rather than becoming NaN, which would never satisfy
        // waitForDecision's timeout comparison and spin forever.
        timeoutSeconds: parsedTimeout !== undefined && Number.isFinite(parsedTimeout) ? parsedTimeout : undefined,
        json: args.json,
      },
      process.env,
    );
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
    return await runWrite(args, vaultResult.path, projectPath);
  }

  if (args.verb === "check") {
    if (projectPath === undefined) {
      const message = "pablo: check requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const vaultResult = findVault(cwd);
    if (!vaultResult.ok) {
      emit(refusalResult(vaultResult), args.json);
      return vaultResult.code;
    }
    return runCheck(args, vaultResult.path, projectPath);
  }

  if (args.verb === "voice") {
    return runVoice(args, cwd);
  }

  const message = `pablo: "${args.verb}" not implemented yet`;
  emit({ ok: false, code: EXIT_ERROR, message }, args.json);
  return EXIT_ERROR;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
