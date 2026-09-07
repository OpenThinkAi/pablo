/**
 * `verbs.ts` (AGT-1235; `voice` added AGT-1240) — the single source of truth
 * for pablo's MCP-exposed verbs (resume, status, write, save, check, voice):
 * one zod schema and one `run` per verb, used by BOTH `cli.ts` (which derives
 * its `parseArgs` option table from these shapes, so the CLI's argv and the
 * MCP tool schemas cannot drift) and `mcp.ts` (which registers one MCP tool
 * per verb straight off the same shape and calls the same `run`). See the
 * design doc's "Commands" section
 * (`~/saltline-digital-vault/projects/ai-terminal/README.md`): "`pablo mcp`
 * serves the same verbs as MCP tools with the same schemas, so Claude Code,
 * Codex and pi see one contract."
 *
 * `run(args, ctx)` returns `{body, exitCode}` — `body` is the EXACT object
 * the CLI's `--json` flag prints for that verb, success or refusal
 * (`{ok:false, code, message, missing[]/tried[]}` is data, never a thrown
 * error — AC3). `init` is P1 for MCP and has no entry here.
 *
 * Every verb's `run` does its OWN vault/project/marker resolution from
 * `ctx.cwd`/`ctx.env` (mirroring `cli.ts`'s own shared dispatch block) so it
 * is callable standalone — the way `mcp.ts` calls it, with no `cli.ts`
 * involved at all.
 *
 * `write`'s `run` is a thin wrapper around `write.ts`'s `runWrite` — AGT-1231
 * (after-write rituals) is landing on `write.ts` concurrently and this file
 * must never change `runWrite`'s signature, result shape, or internals.
 * `runWrite` still only knows how to print its JSON body via `console.log`;
 * `run` captures that one call (redirecting `console.log` for the duration)
 * rather than duplicating any of `runWrite`'s logic, which keeps the two
 * verbs (CLI `write`, MCP `write`) impossible to drift apart. Because that
 * capture works by swapping the process-global `console.log`, two `write`
 * tool calls in flight at once could interleave their captures (the MCP SDK
 * does not serialize concurrent tool calls) — `runWriteVerb` serializes
 * itself through `withWriteLock` (a simple promise-chain mutex, scoped to
 * this module) rather than fixing that inside `write.ts`, which the
 * AGT-1231 constraint above rules out.
 */

import { z } from "zod";
import { resolve, sep } from "node:path";
import { checkWork } from "./check";
import { KNOWN_FORMATS } from "./formats";
import { readMarker } from "./marker";
import { chapterPreconditions, readNovelState } from "./novel/machine";
import { findVault, resolveProject } from "./project";
import type { Refusal } from "./project";
import { proseCore } from "./prose";
import { buildResume } from "./resume";
import { saveCore } from "./save";
import { addExemplar, flagLine, isVoicePathArgument, listVoices, readVoice, resolveVoice, scaffoldVoice } from "./voice";
import { runWrite } from "./write";
import type { RunWriteDeps, WriteArgs } from "./write";

/** A minimal `process.stderr`-shaped sink — mirrors `write.ts`'s `ProgressSink`. */
export interface ProgressSink {
  write(text: string): void;
}

/** What every verb's `run` needs beyond its own (already zod-validated) args. */
export interface VerbContext {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly stderr: ProgressSink;
}

/** `run`'s return: `body` is the exact `--json` object; `exitCode` is the CLI's exit-code contract (0 ok, 2 refused, 1 error). */
export interface VerbResult {
  readonly body: unknown;
  readonly exitCode: number;
}

export interface Verb<Args extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: string;
  readonly description: string;
  readonly args: z.ZodObject<Args>;
  run(args: z.infer<z.ZodObject<Args>>, ctx: VerbContext): Promise<VerbResult>;
}

function refusalBody(r: Refusal): { ok: false; code: number; message: string; tried: readonly string[] } {
  return { ok: false, code: r.code, message: r.message, tried: r.tried };
}

type ResolvedProject = { readonly ok: true; readonly vaultRoot: string; readonly projectPath: string };
type UnresolvedProject = { readonly ok: false; readonly result: VerbResult };

/**
 * Shared resolution every verb but a future `init` goes through: vault ->
 * project -> marker, from `ctx.cwd`/`ctx.env` and a `project` slug. Mirrors
 * `cli.ts`'s own shared dispatch block (`findVault` + `resolveProject` +
 * `readMarker`), reusing the exact same functions so the two resolution
 * paths cannot diverge.
 */
function resolveVerbProject(ctx: VerbContext, project: string): ResolvedProject | UnresolvedProject {
  const vault = findVault(ctx.cwd, ctx.env);
  if (!vault.ok) return { ok: false, result: { body: refusalBody(vault), exitCode: vault.code } };

  const projectResult = resolveProject(vault.path, project);
  if (!projectResult.ok) return { ok: false, result: { body: refusalBody(projectResult), exitCode: projectResult.code } };

  const markerResult = readMarker(projectResult.path);
  if (!markerResult.ok) return { ok: false, result: { body: refusalBody(markerResult), exitCode: markerResult.code } };

  return { ok: true, vaultRoot: vault.path, projectPath: projectResult.path };
}

const projectField = z
  .string()
  .describe('Project slug, resolved under <vault>/novels|stories|essays/<slug> (e.g. "valleys-shadow").');

/**
 * Parses `--for`'s value (also `status`'s zod-validated `for` field) into a
 * chapter number. Accepts `chapter N`, `chapter-N`, `ch N`, or a bare `N`;
 * anything else is `undefined`. The one copy `cli.ts` and this file both use
 * — moved here (out of `cli.ts`) so it is a single source of truth.
 */
export function parseForChapter(raw: string): number | undefined {
  const trimmed = raw.trim();
  for (const pattern of [/^chapter\s+(\d+)$/i, /^chapter-(\d+)$/i, /^ch\s+(\d+)$/i, /^(\d+)$/]) {
    const match = pattern.exec(trimmed);
    if (match) return Number(match[1]);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

const RESUME_ARGS = z.object({ project: projectField });

async function runResumeVerb(args: z.infer<typeof RESUME_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;

  const result = await buildResume(resolved.projectPath, args.project, { env: ctx.env });
  return { body: result, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

const STATUS_ARGS = z.object({
  project: projectField,
  for: z
    .string()
    .optional()
    .describe(
      'A chapter target, e.g. "chapter 3" (also accepts "chapter-3", "ch 3", or a bare "3"). Omit for the whole-project stage summary.',
    ),
});

async function runStatusVerb(args: z.infer<typeof STATUS_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;

  const state = readNovelState(resolved.projectPath);
  if (args.for === undefined) {
    return { body: state, exitCode: 0 };
  }

  const chapter = parseForChapter(args.for);
  if (chapter === undefined) {
    return { body: { ok: false, code: 2, message: 'pablo: --for expects "chapter N"' }, exitCode: 2 };
  }

  const preconditions = chapterPreconditions(state, chapter);
  return { body: { ready: preconditions.ready, missing: preconditions.missing }, exitCode: preconditions.ready ? 0 : 2 };
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

const WRITE_ARGS = z.object({
  project: projectField,
  chapter: z.number().int().positive().optional().describe("The chapter number to draft."),
  words: z.number().int().positive().optional().describe("Target word count (defaults to the format's own target)."),
  scenes: z.number().int().positive().optional().describe("Minimum scene count (defaults to the format's own minimum)."),
  "dry-run": z.boolean().optional().default(false).describe("Assemble and render the pack; send nothing to the model."),
  force: z.boolean().optional().default(false).describe("Overwrite an existing chapter file."),
});

/**
 * Runs `fn` with `console.log` redirected into a buffer instead of stdout —
 * the one way to get `runWrite`'s JSON body back as data without changing
 * `runWrite` itself (it always prints; MCP must never write anything but the
 * protocol to stdout). Restores `console.log` even if `fn` throws.
 */
async function captureConsoleLog(fn: () => Promise<number>): Promise<{ readonly exitCode: number; readonly text: string }> {
  const captured: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    captured.push(values.map((value) => (typeof value === "string" ? value : String(value))).join(" "));
  };
  try {
    const exitCode = await fn();
    return { exitCode, text: captured.join("\n").trim() };
  } finally {
    console.log = originalLog;
  }
}

/**
 * A promise-chain mutex serializing every `write` tool call process-wide.
 * `captureConsoleLog` swaps the process-global `console.log`, which is only
 * safe with at most one call in flight at a time — the MCP SDK dispatches
 * concurrent tool calls without waiting for one to finish, so without this,
 * two simultaneous `write` calls could interleave each other's captured
 * output (or hand one call the other's JSON body). `write` is already a
 * single-flight operation per project by design (see `write.ts`'s own note
 * on `createProviders`' per-endpoint `Gate`), so serializing it here costs
 * nothing real — a second `write` call was always going to queue behind the
 * first at the provider layer anyway.
 */
let writeLock: Promise<void> = Promise.resolve();

async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = writeLock;
  let release!: () => void;
  writeLock = new Promise((resolveLock) => {
    release = resolveLock;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function runWriteVerb(args: z.infer<typeof WRITE_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;

  const writeArgs: WriteArgs = {
    chapter: args.chapter !== undefined ? String(args.chapter) : undefined,
    words: args.words !== undefined ? String(args.words) : undefined,
    scenes: args.scenes !== undefined ? String(args.scenes) : undefined,
    dryRun: args["dry-run"] ?? false,
    json: true,
    force: args.force ?? false,
  };
  const deps: RunWriteDeps = { stderr: ctx.stderr };

  const { exitCode, text } = await withWriteLock(() =>
    captureConsoleLog(() => runWrite(writeArgs, resolved.vaultRoot, resolved.projectPath, deps)),
  );

  const body: unknown = text === "" ? { ok: exitCode === 0 } : JSON.parse(text);
  return { body, exitCode };
}

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

const SAVE_ARGS = z.object({
  project: projectField,
  stage: z.string().optional().describe("acts|beats|premise|bible/<file> — which planning target to replace."),
  file: z
    .string()
    .optional()
    .describe("Path to read the input from. Required over MCP — a tool call has no stdin to read from."),
});

async function runSaveVerb(args: z.infer<typeof SAVE_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;

  // save.ts's CLI path reads stdin when `--file` is omitted; an MCP tool call
  // has no stdin of its own to read (stdin is the protocol's own transport),
  // so a missing `file` is refused here rather than risking a read against
  // the JSON-RPC pipe.
  if (args.file === undefined) {
    return {
      body: { ok: false, code: 2, message: "pablo: save over MCP requires file (a tool call has no stdin to read)" },
      exitCode: 2,
    };
  }

  // `file` is model-controlled over MCP (the CLI's `--file` is typed by the
  // user; a tool argument is typed by whatever called the tool), so unlike
  // the CLI path this bounds it to the vault before ever reading it — an
  // unbounded read here would let a compromised/prompt-injected caller pull
  // an arbitrary file (e.g. an SSH key) into a committed vault document.
  const absFile = resolve(resolved.vaultRoot, args.file);
  if (absFile !== resolved.vaultRoot && !absFile.startsWith(resolved.vaultRoot + sep)) {
    return { body: { ok: false, code: 2, message: `pablo: save file must be inside the vault (${absFile})` }, exitCode: 2 };
  }

  const { body, exitCode } = saveCore({ stage: args.stage, file: absFile }, resolved.projectPath);
  return { body, exitCode };
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

const CHECK_ARGS = z.object({
  project: projectField,
  file: z.string().optional().describe("Work-relative or absolute path to scan; omit to scan every chapters/*.md file."),
});

async function runCheckVerb(args: z.infer<typeof CHECK_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;

  // Over MCP `file` is model-controlled, exactly like save's. `checkWork` already
  // refuses anything outside the work directory (a stricter bound), so this is
  // defence in depth at the same layer as save's guard: no path outside the vault
  // is ever handed down, whatever the lower layer does.
  if (args.file !== undefined) {
    const absFile = resolve(resolved.projectPath, args.file);
    if (absFile !== resolved.vaultRoot && !absFile.startsWith(resolved.vaultRoot + sep)) {
      return { body: { ok: false, code: 2, message: `pablo: check file must be inside the vault (${absFile})` }, exitCode: 2 };
    }
  }

  const outcome = checkWork(resolved.vaultRoot, resolved.projectPath, args.file);
  if (!outcome.ok) {
    return { body: { ok: false, code: outcome.code, message: outcome.message, tried: outcome.tried }, exitCode: outcome.code };
  }
  return { body: { ok: true, hits: outcome.hits, unprovenanced: outcome.unprovenanced }, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// voice (AGT-1240)
// ---------------------------------------------------------------------------

const VOICE_ARGS = z.object({
  sub: z
    .enum(["new", "list", "show", "flag", "exemplar"])
    .describe("Which voice action: new (scaffold), list, show, flag (record a rejected line), or exemplar (keep a piece)."),
  name: z
    .string()
    .optional()
    .describe(
      'Voice name, or a path (containing "/" or ending ".md") for a one-off voice. Required for new/show/flag/exemplar; ignored for list.',
    ),
  global: z
    .boolean()
    .optional()
    .default(false)
    .describe("voice new: scaffold under the global ~/.config/pablo/voices/ directory instead of the vault."),
  line: z.string().optional().describe('voice flag: the rejected line, verbatim — written as `Flagged: "<line>"`.'),
  section: z
    .string()
    .optional()
    .describe('voice flag: the `## ` section heading to append under (default "Flagged").'),
  file: z.string().optional().describe("voice exemplar: the piece to keep, copied verbatim."),
  title: z
    .string()
    .optional()
    .describe("voice exemplar: the title to file it under (else its first `# ` heading, else its filename)."),
});

/**
 * `name` is model-controlled over MCP, exactly like `save`'s and `check`'s
 * `file` (AGT-1235's convention): a path-shaped value (contains "/" or ends
 * in ".md") is bound to the vault before it is ever resolved, so a
 * compromised/prompt-injected caller cannot use `voice show` to pull an
 * arbitrary file (e.g. an SSH key) off disk into a pack the model reads. A
 * plain voice *name* has no such risk — `resolveVoice` only ever joins it
 * under a vault's `voices/` directory or the global voices directory, never
 * as a free-form path.
 */
function looksLikeVoicePath(value: string): boolean {
  return value.includes("/") || value.endsWith(".md");
}

async function runVoiceVerb(args: z.infer<typeof VOICE_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  if (args.sub === "list") {
    return { body: { ok: true, voices: listVoices({ cwd: ctx.cwd, env: ctx.env }) }, exitCode: 0 };
  }

  if (args.name === undefined) {
    return { body: { ok: false, code: 2, message: `pablo: voice ${args.sub} requires name` }, exitCode: 2 };
  }

  if (args.sub === "new") {
    const result = scaffoldVoice(args.name, { cwd: ctx.cwd, env: ctx.env, global: args.global });
    if (!result.ok) return { body: refusalBody(result), exitCode: result.code };
    return {
      body: {
        ok: true,
        path: result.path,
        scope: result.scope,
        committed: result.committed,
        ...(result.notice ? { notice: result.notice } : {}),
      },
      exitCode: 0,
    };
  }

  // sub is show, flag, or exemplar — all three resolve `name` to a voice location first.
  if (looksLikeVoicePath(args.name)) {
    const vault = findVault(ctx.cwd, ctx.env);
    const resolved = resolve(ctx.cwd, args.name);
    if (!vault.ok || (resolved !== vault.path && !resolved.startsWith(vault.path + sep))) {
      return {
        body: { ok: false, code: 2, message: `pablo: voice path must be inside the vault (${resolved})` },
        exitCode: 2,
      };
    }
  }

  const resolution = resolveVoice(args.name, { cwd: ctx.cwd, env: ctx.env });
  if (!resolution.ok) return { body: refusalBody(resolution), exitCode: resolution.code };

  if (args.sub === "flag") {
    if (args.line === undefined) {
      return { body: { ok: false, code: 2, message: "pablo: voice flag requires line" }, exitCode: 2 };
    }
    const result = flagLine(resolution, args.line, { section: args.section });
    if (!result.ok) return { body: refusalBody(result), exitCode: result.code };
    return {
      body: { ok: true, path: result.path, committed: result.committed, ...(result.notice ? { notice: result.notice } : {}) },
      exitCode: 0,
    };
  }

  if (args.sub === "exemplar") {
    if (args.file === undefined) {
      return { body: { ok: false, code: 2, message: "pablo: voice exemplar requires file" }, exitCode: 2 };
    }
    // `file` is model-controlled over MCP, exactly like `save`'s and `check`'s
    // (AGT-1235's convention): bound it to the vault before it is ever read,
    // so a compromised/prompt-injected caller cannot commit an arbitrary file
    // (e.g. an SSH key) into the vault's voice exemplars.
    const vault = findVault(ctx.cwd, ctx.env);
    const absFile = resolve(ctx.cwd, args.file);
    if (!vault.ok || (absFile !== vault.path && !absFile.startsWith(vault.path + sep))) {
      return {
        body: { ok: false, code: 2, message: `pablo: voice exemplar file must be inside the vault (${absFile})` },
        exitCode: 2,
      };
    }
    const result = addExemplar(resolution, absFile, { title: args.title });
    if (!result.ok) return { body: refusalBody(result), exitCode: result.code };
    return {
      body: { ok: true, path: result.path, committed: result.committed, ...(result.notice ? { notice: result.notice } : {}) },
      exitCode: 0,
    };
  }

  // sub === "show"
  const voice = readVoice(resolution.path);
  return { body: { ok: true, ...voice }, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// prose (AGT-1241)
// ---------------------------------------------------------------------------

const PROSE_ARGS = z.object({
  voice: z.string().optional().describe("Voice name to write in (see `voice list`/`voice show`). Required."),
  brief: z
    .string()
    .optional()
    .describe('The ask, as a file path (CLI: "-" also reads stdin; not available over MCP). Required.'),
  context: z
    .array(z.string())
    .optional()
    .default([])
    .describe("File paths sent verbatim, in order. Repeatable."),
  format: z.string().optional().describe(`One of: ${KNOWN_FORMATS.join(", ")}.`),
  words: z.number().int().positive().optional().describe("Target word count (defaults to 300)."),
  "dry-run": z
    .boolean()
    .optional()
    .default(false)
    .describe("Preview the assembled pack (slices, tokens, prompt hash) without sending it to the model."),
  out: z
    .string()
    .optional()
    .describe(
      "Write the answer to this file with provenance frontmatter (voice, model, generated, prompt_hash, words); inside a git repository it is committed by pathspec. Must be inside the vault (or the working directory when there is none).",
    ),
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "CLI only: overwrite an existing `out` file instead of refusing. Refused over MCP — an existing file is never overwritten by a tool call.",
    ),
});

/**
 * `--brief`/each `--context` are model-controlled over MCP (AGT-1235's
 * convention, same as `save`'s/`check`'s `file`): bound to a boundary before
 * they are ever read. Unlike `save`/`check`, `prose` has no `--project` at
 * all — AC4 requires it to work with no vault (a global voice, a brief
 * anywhere), so there is no `vaultRoot` guaranteed to exist to bind against.
 * The CLI's own no-vault freedom and the MCP bound are deliberately NOT the
 * same constraint: a human typing `--brief ../notes/x.md` at a shell has
 * already chosen that path; a value arriving as a tool-call argument may
 * have been chosen by a compromised/prompt-injected caller instead, so it
 * always gets bounded, whether or not the run happens to have a vault. When
 * `findVault` finds one, the bound is the vault root (matching `save`); when
 * it doesn't, the bound falls back to `ctx.cwd` — a narrower boundary, but
 * still a boundary, so a "no vault" prose call can never read an arbitrary
 * path (e.g. an SSH key) merely because this particular call has no vault
 * to bind against. `"-"` (stdin) is refused outright: an MCP tool call has
 * no stdin of its own to read, exactly like `save`'s rule.
 */
function bindProsePath(ctx: VerbContext, label: string, value: string): Refusal | undefined {
  if (value === "-") {
    return { ok: false, code: 2, message: `pablo: prose ${label} "-" is not available over MCP; pass a file path instead`, tried: [] };
  }

  const vault = findVault(ctx.cwd, ctx.env);
  const boundary = vault.ok ? vault.path : resolve(ctx.cwd);
  const abs = resolve(boundary, value);
  if (abs !== boundary && !abs.startsWith(boundary + sep)) {
    return { ok: false, code: 2, message: `pablo: prose ${label} must be inside ${boundary} (${abs})`, tried: [] };
  }
  return undefined;
}

async function runProseVerb(args: z.infer<typeof PROSE_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  // `voice` is model-controlled here, and AGT-1240 deliberately accepts a
  // path-shaped voice argument as a one-off voice file. A plain NAME cannot
  // traverse — AGT-1240 slug-validates it before any join — but a path-shaped
  // one is unbounded unless it is bounded here, exactly as --brief and
  // --context are. Without this an MCP caller could name any readable
  // directory as its voice: today that returns the file's token count and
  // path, and once the send path lands (AGT-1242) the text itself would reach
  // the external model. The CLI keeps the unbounded form (author-typed, like
  // `save`'s --file); only the MCP surface is narrowed.
  if (args.voice !== undefined && isVoicePathArgument(args.voice)) {
    const problem = bindProsePath(ctx, "--voice", args.voice);
    if (problem) return { body: refusalBody(problem), exitCode: problem.code };
  }
  if (args.brief !== undefined) {
    const problem = bindProsePath(ctx, "--brief", args.brief);
    if (problem) return { body: refusalBody(problem), exitCode: problem.code };
  }
  for (const path of args.context) {
    const problem = bindProsePath(ctx, "--context", path);
    if (problem) return { body: refusalBody(problem), exitCode: problem.code };
  }
  // `out` is the first WRITE path on this verb (AGT-1242) and gets the same
  // bound the read paths above get — a stronger requirement, not a weaker one:
  // an unbounded model-supplied `out` would let a tool call create or (with
  // `force`) overwrite any file the user can write, anywhere on the machine.
  // The CLI's own `--out` stays unbounded and author-typed, exactly like
  // `save`'s `--file`.
  if (args.out !== undefined) {
    const problem = bindProsePath(ctx, "--out", args.out);
    if (problem) return { body: refusalBody(problem), exitCode: problem.code };
  }
  // `force` turns `out` from "create a file" into "destroy whatever is there",
  // and the vault bound above does not help with that — inside the vault, an
  // existing chapter or notice would simply be replaced, with no read-back and
  // nothing recoverable but git. A destructive overwrite is an author's
  // decision, so it lives on the author-typed CLI flag only: over MCP the
  // model may create a new file and must ask the author to overwrite an
  // existing one (security review, AGT-1242).
  if (args.force === true) {
    return {
      body: {
        ok: false,
        code: 2,
        message: "pablo: prose force is not available over MCP; an existing out file is never overwritten by a tool call",
        tried: [],
      },
      exitCode: 2,
    };
  }

  const outcome = await proseCore(
    {
      voice: args.voice,
      brief: args.brief,
      context: args.context,
      format: args.format,
      words: args.words,
      dryRun: args["dry-run"],
      out: args.out,
      force: false, // never over MCP — refused above, and pinned here so it cannot come back by way of a schema change
    },
    { cwd: ctx.cwd, env: ctx.env },
    { stderr: ctx.stderr },
  );
  return { body: outcome.body, exitCode: outcome.exitCode };
}

// ---------------------------------------------------------------------------
// VERBS — the single source of truth `cli.ts` and `mcp.ts` both read
// ---------------------------------------------------------------------------

export const VERBS: readonly Verb[] = [
  {
    name: "resume",
    description: "The structured session summary an agent picks a project up from: stage per part, last event, open decisions, next step.",
    args: RESUME_ARGS,
    run: runResumeVerb,
  },
  {
    name: "status",
    description: "The novel machine's per-stage state, or (with `for`) one chapter's draft preconditions and which are unmet.",
    args: STATUS_ARGS,
    run: runStatusVerb,
  },
  {
    name: "write",
    description: "Draft one chapter on the configured local model: check preconditions, assemble the pack, send, write, receipt.",
    args: WRITE_ARGS,
    run: runWriteVerb,
  },
  {
    name: "save",
    description: "Save the agent's planning output (acts, beats, bible facts, premise) into the files the novel stage machine reads.",
    args: SAVE_ARGS,
    run: runSaveVerb,
  },
  {
    name: "check",
    description: "Scan a work's chapters for mechanical tells (em-dashes, curly quotes, flagged phrases) and provenance gaps.",
    args: CHECK_ARGS,
    run: runCheckVerb,
  },
  {
    name: "voice",
    description:
      "Find, scaffold, grow, or inspect a named voice directory: `new` scaffolds one, `list` finds every one, `show` reads one as a model would see it, `flag` records a rejected line, `exemplar` keeps a piece as-is.",
    args: VOICE_ARGS,
    run: runVoiceVerb,
  },
  {
    name: "prose",
    description:
      "Write a piece in a named voice from a brief: assemble the pack, send it to the routed model, return the text plus a receipt and check hits (or, with `dry-run`, just render the pack). No `--project`, no vault required.",
    args: PROSE_ARGS,
    run: runProseVerb,
  },
];

// ---------------------------------------------------------------------------
// CLI argv derivation — cli.ts's parseArgs option table, sourced from the
// same zod shapes above so it cannot drift from what the verbs actually take.
// ---------------------------------------------------------------------------

export type CliOptionConfig =
  | { readonly type: "string"; readonly multiple?: boolean }
  | { readonly type: "boolean"; readonly default: boolean };

/** Unwraps `.optional()`/`.default()` wrappers, returning the base schema and any boolean default found along the way. */
function unwrapToBase(schema: z.ZodTypeAny): { readonly base: z.ZodTypeAny; readonly defaultValue: boolean | undefined } {
  let current: z.ZodTypeAny = schema;
  let defaultValue: boolean | undefined;

  for (;;) {
    if (current instanceof z.ZodOptional) {
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      // zod's public `.default()` accepts either a plain value or a thunk
      // (`.default(false)` or `.default(() => false)`) — `_def.defaultValue`
      // holds whichever form was passed (verified at runtime against
      // zod@4.5.4: a plain `.default(false)` stores the boolean directly,
      // not a thunk), so both are unwrapped here rather than assuming one.
      const raw = (current as unknown as { _def: { defaultValue: unknown } })._def.defaultValue;
      const inner = typeof raw === "function" ? (raw as () => unknown)() : raw;
      if (typeof inner === "boolean") defaultValue = inner;
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    break;
  }

  return { base: current, defaultValue };
}

/**
 * `ZodBoolean` -> `{type:"boolean", default}`; `z.array(z.string())` (AGT-1241's
 * `context`) -> `{type:"string", multiple:true}` — `node:util`'s `parseArgs`
 * collects a repeatable string flag into an array, in the order given, which
 * is exactly what "`--context` files, in argument order" needs (AC1) and
 * what `node:util` gives back as `undefined`, not `[]`, when the flag is
 * never passed — `cli.ts` defaults that to `[]` itself. Every other zod
 * primitive (`ZodString`, `ZodNumber`, ...) -> `{type:"string"}` — `parseArgs`
 * only knows string/boolean, so a numeric CLI flag stays text until the verb
 * itself coerces it (as every verb already did before this ticket).
 */
function cliOptionFor(schema: z.ZodTypeAny): CliOptionConfig {
  const { base, defaultValue } = unwrapToBase(schema);
  if (base instanceof z.ZodBoolean) {
    return { type: "boolean", default: defaultValue ?? false };
  }
  if (base instanceof z.ZodArray && base.element instanceof z.ZodString) {
    return { type: "string", multiple: true };
  }
  return { type: "string" };
}

/**
 * The `node:util` `parseArgs` `options` table for every field any of the five
 * verbs accepts, derived from their zod shapes. `cli.ts` merges this with its
 * own CLI-only flags (`--json`, `--help`, `--adopt`) — those aren't part of
 * any verb's contract, so they aren't derived here.
 */
export function deriveCliOptions(): Record<string, CliOptionConfig> {
  const options: Record<string, CliOptionConfig> = {};
  for (const verb of VERBS) {
    for (const [key, schema] of Object.entries(verb.args.shape)) {
      if (!(key in options)) options[key] = cliOptionFor(schema as z.ZodTypeAny);
    }
  }
  return options;
}
