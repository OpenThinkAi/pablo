#!/usr/bin/env bun
/**
 * `pablo` — the CLI that writes: the manager for writing projects, driven by
 * whatever agent you like (Claude Code, Codex, pi). See
 * `pm project show ai-terminal` for the design.
 *
 * This is the P0 skeleton: argument parsing, `--help`, `--project`
 * resolution, and `init` (which writes the `pablo.json` marker every other
 * verb requires) are real; every other verb body is a stub. Exit codes are
 * the contract every later ticket builds on: 0 ok, 2 refused (a framework
 * precondition — an unresolvable `--project`, a missing/invalid marker, or
 * later an unmet stage precondition), 1 error (including "not implemented
 * yet").
 */

import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { bookStages } from "./book";
import { branchDiff, repoRoot, waitingBranches, waitingForReview } from "./branch";
import { runCheck, screenChecks } from "./check";
import { reviewCommentsOf } from "./critique";
import { migrateLines } from "./migrate";
import { mergeDraftInProject } from "./novel/merge";
import { initAdopt, initNovel } from "./init";
import type { InitResult } from "./init";
import { readMarker } from "./marker";
import type { Composer } from "@openthink/pablo-tui";
import { loadConfig } from "@openthink/pablo-core";
import { runAgent } from "./harness/agent";
import { harnessAuth } from "./harness/auth";
import { createComposer } from "./harness/compose";
import { loadPromptWork } from "./harness/prompt";
import type { HarnessSpec } from "./harness/session";
import { runMcp } from "./mcp";
import { chapterPreconditions, readNovelState } from "./novel/machine";
import type { NovelState } from "./novel/machine";
import { findVault, resolveProjectFromCwd } from "./project";
import type { Refusal } from "./project";
import { runProse } from "./prose";
import { publishWork } from "./publish";
import { runRevise } from "./revise";
import type { ReviseCoreContext } from "./revise";
import { readTool, searchTool } from "./harness-tools";
import { runResumeVerb } from "./resume";
import { runSave } from "./save";
import { screenEditor } from "./edit-session";
import { screenCommenter, screenFinisher } from "./review-finish";
import { screenReviser } from "./screen-revise";
import { screenVoicer } from "./screen-voice";
import { screenWriter } from "./screen-write";
import { deriveCliOptions, notesWith, parseForChapter, shareWith } from "./verbs";
import { realRunner } from "./share";
import type { Runner } from "./share";
import { fetchRound, listReaderRounds, parseRoundRef, roundRefLabel } from "./read";
import { openReader } from "./reader-host";
import { addExemplar, flagLine, listVoices, readVoice, resolveVoice, scaffoldVoice } from "./voice";
import type { Voice } from "./voice";
import { runWrite } from "./write";

/** Verbs P0 ships: the manager for novels (see the design doc's build order). */
const P0_VERBS = [
  "init",
  "resume",
  "status",
  "write",
  "save",
  "check",
  "migrate",
  "merge",
  "publish",
  "share",
  "notes",
  "mcp",
  "voice",
  "prose",
  "revise",
  "agent",
  "read",
  "search",
] as const;

/** Verbs planned for P1/P2 — listed in `--help` as later, not yet wired up. */
const LATER_VERBS = ["dry-run"] as const;

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
    "dry-run as its own verb is later; today use `write --dry-run` (or `prose`/`revise --dry-run`).",
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
    "  pablo migrate lines --project <slug> [--dry-run]",
    "                                            one-time split of chapters/*.md to one",
    "                                            sentence per line, committed on its own",
    "  pablo merge --project <slug> <draft/chNN>",
    "                                            merge a reviewed draft branch to main, then run",
    "                                            the after-write steps (outline, note, README,",
    "                                            continuity, commit, think sync)",
    "  pablo publish --project <slug> --target draft",
    "                                            compile every chapter into one markdown file",
    "                                            under <work>/.pablo/out/ (frontmatter stripped,",
    "                                            sentences joined, quotes curled)",
    "  pablo share --project <slug> --reader <name> --chapters N|N-M",
    "                                            open a reading round: push those chapters (all",
    "                                            on main) to the book's private reading repo as a",
    "                                            PR, request the reader's review, record the round",
    "  pablo share --list --project <slug>       the work's rounds: open, submitted (waiting to",
    "                                            pull), pulled",
    "  pablo read --list [--json]               the reading rounds waiting for you on GitHub (and",
    "                                            those you have sent); no vault or project needed",
    "  pablo read <slug>-reading#<pr> [--no-open]",
    "                                            fetch a round's chapters at its head commit into",
    "                                            $XDG_STATE_HOME/pablo/rounds/<repo>/<pr>/ and open",
    "                                            the reader window on it (needs Google Chrome);",
    "                                            --no-open only fetches",
    "  pablo notes pull --project <slug>        each reader's submitted review becomes a",
    "                                            reader/<round> branch: one commit per suggestion,",
    "                                            authored as the reader; comments for review mode",
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
    "  pablo revise --project <slug> --file F",
    '              (--passage "<quoted text>" | --start N --end N)',
    '              --instruction "<text>" [--json] [--dry-run]',
    "                                            send one located passage to the local model;",
    "                                            returns {candidate, span, receipt} and writes",
    "                                            nothing — the file is never touched",
    '  pablo agent --project <slug> [--new] "<message>"',
    "                                            one headless harness session (Claude on",
    "                                            the subscription, or the config's key);",
    "                                            prints the transcript; resumes the work's",
    "                                            saved session, --new starts a fresh one",
    "  pablo agent --project <slug> --tag-facts",
    "                                            tag every untagged bible and continuity fact",
    "                                            (researched/invented/author) on a plan/ branch;",
    "                                            chapters are never touched",
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
  /** `agent --tag-facts` (AGT-1570): tag every untagged fact on a plan branch. */
  readonly tagFacts: boolean;
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
  /** `write --temperature T`: sampling temperature; validated by `runWrite`. */
  readonly temperature: string | undefined;
  /** `write --seed N`: sampling seed; validated by `runWrite`. */
  readonly seed: string | undefined;
  /** `write --direction "<text>"` (AGT-1562): a steer for the chapter; its own pack slice. */
  readonly direction: string | undefined;
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
  /** `prose --instruction "<text>"` / `revise --instruction "<text>"`: what to change. */
  readonly instruction: string | undefined;
  /** `revise --passage "<quoted text>"` (AGT-1264): located with `locatePassage`. Alternative to `--start`/`--end`. */
  readonly passage: string | undefined;
  /** `revise --start <n>` (AGT-1264): a UTF-16 offset into the frontmatter-stripped body. Requires `--end`. */
  readonly start: string | undefined;
  /** `revise --end <n>` (AGT-1264): a UTF-16 offset into the frontmatter-stripped body. Requires `--start`. */
  readonly end: string | undefined;
  /** `publish --target draft|review|final` (AGT-1534). */
  readonly target: string | undefined;
  /** `share --reader <name>` (AGT-1582): a reader named in the config's `readers`. */
  readonly reader: string | undefined;
  /** `share --chapters 3|3-5` (AGT-1582). */
  readonly chapters: string | undefined;
  /** `agent --new` (AGT-1565): start a fresh harness session; the old one stays on disk. */
  readonly new: boolean;
  /** `read --list` (AGT-1583): the reader's open rounds. */
  readonly list: boolean;
  /** `read <round> --no-open` (AGT-1586): fetch the round into the cache without opening the reader window. */
  readonly noOpen: boolean;
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
      "tag-facts": { type: "boolean", default: false },
      new: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
      "no-open": { type: "boolean", default: false },
    },
  });

  return {
    verb: positionals[0],
    rest: positionals.slice(1),
    project: typeof values["project"] === "string" ? values["project"] : undefined,
    json: values["json"] === true,
    help: values["help"] === true,
    adopt: values["adopt"] === true,
    tagFacts: values["tag-facts"] === true,
    new: values["new"] === true,
    list: values["list"] === true,
    noOpen: values["no-open"] === true,
    for: typeof values["for"] === "string" ? values["for"] : undefined,
    stage: typeof values["stage"] === "string" ? values["stage"] : undefined,
    file: typeof values["file"] === "string" ? values["file"] : undefined,
    chapter: typeof values["chapter"] === "string" ? values["chapter"] : undefined,
    words: typeof values["words"] === "string" ? values["words"] : undefined,
    scenes: typeof values["scenes"] === "string" ? values["scenes"] : undefined,
    dryRun: values["dry-run"] === true,
    force: values["force"] === true,
    temperature: typeof values["temperature"] === "string" ? values["temperature"] : undefined,
    seed: typeof values["seed"] === "string" ? values["seed"] : undefined,
    direction: typeof values["direction"] === "string" ? values["direction"] : undefined,
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
    passage: typeof values["passage"] === "string" ? values["passage"] : undefined,
    start: typeof values["start"] === "string" ? values["start"] : undefined,
    end: typeof values["end"] === "string" ? values["end"] : undefined,
    target: typeof values["target"] === "string" ? values["target"] : undefined,
    reader: typeof values["reader"] === "string" ? values["reader"] : undefined,
    chapters: typeof values["chapters"] === "string" ? values["chapters"] : undefined,
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
    console.log(result.adoptedLine ?? `pablo: created ${result.path}${committedNote}`);
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
function proseState(state: NovelState, waiting: readonly string[]): string {
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
  lines.push(waiting.length === 0 ? "waiting for review: none" : `waiting for review: ${waiting.length} (${waiting.join(", ")})`);

  return lines.join("\n");
}

/**
 * `pablo status --project <slug> [--for "chapter N"]`. With no `--for`, the
 * novel machine's state plus the branches waiting for review (JSON: the state
 * object with `waiting`; prose: `proseState`). With
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

  const waiting = waitingForReview(projectPath);
  if (args.json) {
    console.log(JSON.stringify({ ...state, waiting }));
  } else {
    console.log(proseState(state, waiting));
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
 * `pablo read --list` / `pablo read <repo>#<pr>` (AGT-1583): the reader's rounds on GitHub, with the
 * `gh` runner and environment injectable so tests never reach GitHub.
 */
export function runReadRounds(args: ParsedArgs, run: Runner = realRunner, env: Record<string, string | undefined> = process.env): number {
  if (args.list) {
    const listed = listReaderRounds({ run, env });
    if (!listed.ok) {
      emit({ ok: false, code: listed.code, message: listed.message }, args.json);
      return listed.code;
    }
    if (args.json) {
      console.log(JSON.stringify({ ok: true, rounds: listed.rounds, notices: listed.notices }));
    } else {
      if (listed.rounds.length === 0) console.log("pablo: no reading rounds waiting for you");
      for (const round of listed.rounds) {
        const chapters = round.chapters.map((c) => (c.number > 0 ? String(c.number) : c.path)).join(", ") || "-";
        const sent = round.status === "sent" ? "  [sent]" : "";
        console.log(`${round.ref}  chapters ${chapters}  from ${round.sender || "?"}  ${round.date.slice(0, 10)}${sent}`);
      }
      for (const notice of listed.notices) console.error(notice);
    }
    return EXIT_OK;
  }
  const ref = parseRoundRef(args.rest[0] ?? "");
  if (ref === undefined) {
    emit({ ok: false, code: EXIT_REFUSED, message: "pablo: read requires a round like <slug>-reading#<pr>" }, args.json);
    return EXIT_REFUSED;
  }
  const fetched = fetchRound({ run, env, ref });
  if (!fetched.ok) {
    emit({ ok: false, code: fetched.code, message: fetched.message }, args.json);
    return fetched.code;
  }
  if (args.json) console.log(JSON.stringify({ ok: true, reused: fetched.reused, dir: fetched.dir, ...fetched.round }));
  else console.log(`pablo: ${fetched.reused ? "already have" : "fetched"} ${fetched.round.repo}#${fetched.round.pr} at ${fetched.round.commit.slice(0, 7)}: ${fetched.dir}`);
  return EXIT_OK;
}

/**
 * `pablo read <repo>#<pr>` (AGT-1586): fetch the round, then open the reader window on it and hold the
 * process until the window closes. `--no-open` is the fetch alone (`runReadRounds`). `open` is injectable
 * so tests never start a window.
 */
export async function runReadView(args: ParsedArgs, open: typeof openReader = openReader): Promise<number> {
  const ref = parseRoundRef(args.rest[0] ?? "");
  if (ref === undefined) {
    emit({ ok: false, code: EXIT_REFUSED, message: "pablo: read requires a round like <slug>-reading#<pr>" }, args.json);
    return EXIT_REFUSED;
  }
  const opened = await open(ref);
  if (!opened.ok) {
    emit({ ok: false, code: opened.code, message: opened.message }, args.json);
    return opened.code;
  }
  if (args.json) console.log(JSON.stringify({ ok: true, ref: roundRefLabel(ref), url: opened.view.url }));
  else console.log(`pablo: opened ${roundRefLabel(ref)} in the reader window; close it when you are done`);
  await opened.closed;
  return EXIT_OK;
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

/**
 * The project the screen opens on: the nearest ancestor of `cwd` (inclusive)
 * with a valid `pablo.json`, or undefined when `cwd` is not inside a project.
 */
export function bareScreenTarget(cwd: string): { title: string; format: string; dir: string } | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const found = readMarker(dir);
    if (found.ok) return { title: found.marker.title, format: found.marker.format, dir };
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * The compose view's session spec for the project at `dir` (AGT-1566): the same inputs `pablo agent` builds, so the
 * two run the same agent: the marker, the work's judgement policy and its QWEN.md (`loadPromptWork`), the config's
 * credential. Throws with the refusal's message; the composer calls it on the first message, so a refusal (an unknown
 * policy, no credential) shows in the conversation, not before the screen opens. pablo's tools run in this process;
 * their progress goes nowhere (stderr would draw over the screen).
 */
export function composeSpec(dir: string, cwd: string, env: Record<string, string | undefined> = process.env): HarnessSpec {
  const marker = readMarker(dir);
  if (!marker.ok) throw new Error(marker.message);
  const work = loadPromptWork(dir, marker.marker, basename(dir));
  if (!work.ok) throw new Error(work.message);
  return {
    work: work.work,
    projectPath: dir,
    auth: harnessAuth(loadConfig({ env }), env),
    ctx: { cwd, env, stderr: { write: () => {} }, caller: "mcp" },
  };
}

const screenComposer = (dir: string, cwd: string): Composer => createComposer(() => composeSpec(dir, cwd));

/** Runs the CLI for `argv` (already stripped of `bun`/script name) and returns the process exit code. */
export async function main(argv: readonly string[], cwd: string = process.cwd()): Promise<number> {
  const args = parseCliArgs(argv);

  // Bare `pablo` (no verb, no flags) inside a pablo project opens the screen
  // (AGT-1522). Anywhere else — no project, or no terminal to draw on — it
  // prints usage as it always did.
  if (args.verb === undefined && !args.help && argv.length === 0) {
    const screen = bareScreenTarget(cwd);
    if (screen !== undefined && process.stdin.isTTY && process.stdout.isTTY) {
      const { runScreen } = await import("@openthink/pablo-tui");
      // The book's stages come from the same stage machine `pablo status` reads (AGT-1526).
      // `dir` goes on too: the main pane reads the selected stage's file from it (AGT-1527).
      // Branches waiting for review and their diffs against main come from the branch layer (AGT-1538).
      const repo = repoRoot(screen.dir);
      const waiting = repo === undefined ? undefined : waitingBranches(repo);
      const vault = findVault(cwd);
      return await runScreen({
        ...screen,
        stages: bookStages(readNovelState(screen.dir), waiting?.ok ? waiting.branches : []),
        // A chapter opened there is scanned with `check`'s rules from the vault, each hit a box under its line (AGT-1528).
        ...(vault.ok ? { checks: screenChecks(vault.path) } : {}),
        // `a w` writes the selected chapter through the same `runWrite` the verb uses (AGT-1542).
        ...(vault.ok ? { writer: screenWriter(vault.path, screen.dir) } : {}),
        // `a r` revises the selected sentences; taking the candidate commits it on a revise/ branch (AGT-1544).
        ...(vault.ok ? { reviser: screenReviser(vault.path, screen.dir) } : {}),
        // `a v` adds the selected sentences to the project's voice: flagged, or kept as an exemplar (AGT-1547).
        ...(vault.ok ? { voicer: screenVoicer(vault.path, screen.dir) } : {}),
        // The compose view's session is built when the first message is sent (AGT-1566).
        composer: screenComposer(screen.dir, cwd),
        // `s` in a review merges the accepted changes and runs the after-write steps (AGT-1540).
        finisher: screenFinisher(screen.dir),
        // `c` in a review stores the author's own comment on the branch (AGT-1581).
        commentSaver: screenCommenter(screen.dir),
        // `v e` edits on an `edit/` branch in its own worktree; `v s` saves it through the finisher above (AGT-1545).
        editSession: screenEditor(screen.dir),
        ...(repo !== undefined && waiting?.ok ? { branches: waiting.branches, diffOf: (branch: string) => branchDiff(repo, branch), commentsOf: (branch: string) => reviewCommentsOf(screen.dir, branch) } : {}),
      });
    }
  }

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

  // `agent` (AGT-1552) resolves its own project and marker (`harness/agent.ts`),
  // the way an MCP verb does, so it is dispatched before the shared block too.
  if (args.verb === "agent") {
    return await runAgent(
      { project: args.project, message: args.rest.length === 0 ? undefined : args.rest.join(" "), json: args.json, tagFacts: args.tagFacts, new: args.new },
      { cwd, env: process.env, stdout: process.stdout, stderr: process.stderr, stdin: process.stdin },
    );
  }

  // The reader's `read` (AGT-1583) lists/fetches reading rounds from GitHub: no vault, no project.
  // `read <path> --project <slug>` (a file in a work) is the author's, below.
  if (args.verb === "read" && args.project === undefined && (args.list || parseRoundRef(args.rest[0] ?? "") !== undefined)) {
    return args.list || args.noOpen ? runReadRounds(args) : await runReadView(args);
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

  if (args.verb === "migrate") {
    const [sub] = args.rest;
    if (sub !== "lines") {
      const message = `pablo: migrate: unknown migration "${sub ?? ""}" (expected lines)`;
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    if (projectPath === undefined) {
      const message = "pablo: migrate lines requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const vaultResult = findVault(cwd);
    if (!vaultResult.ok) {
      emit(refusalResult(vaultResult), args.json);
      return vaultResult.code;
    }
    const outcome = migrateLines(vaultResult.path, projectPath, { dryRun: args.dryRun });
    if (!outcome.ok) {
      emit({ ok: false, code: outcome.code, message: outcome.message }, args.json);
      return outcome.code;
    }
    if (args.json) {
      console.log(JSON.stringify(outcome));
    } else {
      const verb = outcome.dryRun ? "would change" : "changed";
      console.log(`pablo: migrate lines: ${verb} ${outcome.changed.length} chapter(s)${outcome.committed ? " (committed)" : ""}`);
      for (const f of outcome.changed) console.log(`  ${f}`);
      if (outcome.notice) console.log(outcome.notice);
    }
    return EXIT_OK;
  }

  if (args.verb === "merge") {
    const [branch] = args.rest;
    if (projectPath === undefined || branch === undefined) {
      const message = "pablo: usage: pablo merge --project <slug> <draft/chNN>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const outcome = await mergeDraftInProject(projectPath, branch);
    if (args.json) {
      console.log(JSON.stringify(outcome.body));
    } else if (outcome.body["ok"] === true) {
      console.log(`pablo: merged ${branch} to main (${String(outcome.body["commit"]).slice(0, 7)})`);
      for (const r of outcome.body["rituals"] as { name: string; status: string; detail: string }[]) {
        console.log(`ritual ${r.name}: ${r.status} — ${r.detail}`);
      }
      for (const n of outcome.body["notices"] as string[]) console.log(n);
    } else {
      console.error(outcome.body["message"]);
    }
    return outcome.exitCode;
  }

  if (args.verb === "publish") {
    if (projectPath === undefined) {
      const message = "pablo: publish requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const markerResult = readMarker(projectPath);
    if (!markerResult.ok) {
      emit(refusalResult(markerResult), args.json);
      return markerResult.code;
    }
    const outcome = publishWork(projectPath, markerResult.marker.slug, markerResult.marker.title, args.target);
    if (!outcome.ok) {
      emit(refusalResult(outcome), args.json);
      return outcome.code;
    }
    if (args.json) {
      console.log(JSON.stringify({ ok: true, target: outcome.target, where: outcome.where, chapters: outcome.chapters, words: outcome.words }));
    } else {
      console.log(`pablo: published ${outcome.target}: ${outcome.where} (${outcome.chapters} chapters, ${outcome.words} words)`);
    }
    return EXIT_OK;
  }

  if (args.verb === "share") {
    if (projectPath === undefined) {
      const message = "pablo: share requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    if (args.list) {
      const outcome = await shareWith({ project: args.project as string, list: true }, { cwd, env: process.env, stderr: process.stderr }, realRunner);
      const body = outcome.body as { ok?: boolean; message?: string; rounds?: { id: string; chapters: number[]; status: string; closed?: boolean; prUrl: string }[]; notices?: string[] };
      if (args.json) console.log(JSON.stringify(body));
      else if (body.rounds === undefined) console.error(String(body.message));
      else {
        if (body.rounds.length === 0) console.log("pablo: no reading rounds for this project");
        for (const r of body.rounds) console.log(`${r.id}  chapters ${r.chapters.join(", ") || "-"}  ${r.status}${r.status === "pulled" && r.closed === false ? " (not closed yet)" : ""}  ${r.prUrl}`);
        for (const notice of body.notices ?? []) console.error(notice);
      }
      return outcome.exitCode;
    }
    if (!args.reader || !args.chapters) {
      const message = `pablo: share requires ${args.reader ? "--chapters <N|N-M>" : "--reader <name>"}`;
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const outcome = await shareWith(
      { project: args.project as string, reader: args.reader, chapters: args.chapters },
      { cwd, env: process.env, stderr: process.stderr },
      realRunner,
    );
    const body = outcome.body as Record<string, unknown>;
    if (args.json) {
      console.log(JSON.stringify(body));
    } else if (body["ok"] === true) {
      console.log(`pablo: opened round ${String(body["id"])}: ${String(body["prUrl"])}`);
      for (const notice of body["notices"] as string[]) console.log(notice);
    } else {
      console.error(String(body["message"]));
    }
    return outcome.exitCode;
  }

  if (args.verb === "notes") {
    if (args.rest[0] !== "pull" || projectPath === undefined) {
      const message = args.rest[0] !== "pull" ? 'pablo: notes: the only action is "pull" (pablo notes pull --project <slug>)' : "pablo: notes pull requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const outcome = await notesWith({ sub: "pull", project: args.project as string }, { cwd, env: process.env, stderr: process.stderr }, realRunner);
    const body = outcome.body as {
      ok?: boolean;
      message?: string;
      pulled?: { round: string; branch: string; commits: string[]; comments: number }[];
      skipped?: { reason: string; message: string }[];
      notices?: string[];
    };
    if (args.json) {
      console.log(JSON.stringify(body));
    } else if (body.pulled === undefined) {
      console.error(String(body.message));
    } else {
      for (const p of body.pulled) {
        console.log(`pablo: pulled round ${p.round} into ${p.branch} (${p.commits.length} suggestions, ${p.comments} comments)`);
      }
      for (const s of body.skipped ?? []) (s.reason === "error" || s.reason === "refused" ? console.error : console.log)(s.message);
      for (const n of body.notices ?? []) console.log(n);
      if (body.pulled.length === 0 && (body.skipped ?? []).length === 0) console.log("pablo: notes pull: no rounds for this work");
    }
    return outcome.exitCode;
  }

  if (args.verb === "voice") {
    return runVoice(args, cwd);
  }

  if (args.verb === "revise") {
    if (projectPath === undefined) {
      const message = "pablo: revise requires --project <slug>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    const vaultResult = findVault(cwd);
    if (!vaultResult.ok) {
      emit(refusalResult(vaultResult), args.json);
      return vaultResult.code;
    }
    const reviseCtx: ReviseCoreContext = { vaultRoot: vaultResult.path, projectPath, env: process.env };
    return await runRevise(
      {
        file: args.file,
        passage: args.passage,
        start: args.start,
        end: args.end,
        instruction: args.instruction,
        dryRun: args.dryRun,
        json: args.json,
      },
      reviseCtx,
    );
  }

  if (args.verb === "read" || args.verb === "search") {
    const argument = args.verb === "read" ? args.rest[0] : args.rest.join(" ");
    if (projectPath === undefined || !argument) {
      const message =
        projectPath === undefined
          ? `pablo: ${args.verb} requires --project <slug>`
          : args.verb === "read"
            ? "pablo: read requires a <path> in the work"
            : "pablo: search requires a <phrase>";
      emit({ ok: false, code: EXIT_REFUSED, message }, args.json);
      return EXIT_REFUSED;
    }
    // The same pure functions the read/search verbs (and so `pablo mcp`) wrap;
    // `read <path>` and `search <phrase...>` only supply the positional.
    const result = args.verb === "read" ? readTool(projectPath, argument) : searchTool(projectPath, argument);
    if (args.json) console.log(JSON.stringify(result));
    else if (!result.ok) console.error(result.message);
    else if ("text" in result) console.log(result.text);
    else if ("entries" in result) console.log(result.entries.join("\n"));
    else {
      for (const match of result.matches) console.log(`${match.file}:${match.line}: ${match.sentence}`);
      if (result.truncated) console.log("(more matches; narrow the phrase)");
    }
    return result.ok ? EXIT_OK : result.code;
  }

  const message = `pablo: "${args.verb}" not implemented yet`;
  emit({ ok: false, code: EXIT_ERROR, message }, args.json);
  return EXIT_ERROR;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
