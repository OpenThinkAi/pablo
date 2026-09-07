/**
 * `verbs.ts` (AGT-1235) — the single source of truth for pablo's five
 * MCP-exposed verbs (resume, status, write, save, check): one zod schema and
 * one `run` per verb, used by BOTH `cli.ts` (which derives its `parseArgs`
 * option table from these shapes, so the CLI's argv and the MCP tool schemas
 * cannot drift) and `mcp.ts` (which registers one MCP tool per verb straight
 * off the same shape and calls the same `run`). See the design doc's
 * "Commands" section (`~/saltline-digital-vault/projects/ai-terminal/README.md`):
 * "`pablo mcp` serves the same verbs as MCP tools with the same schemas, so
 * Claude Code, Codex and pi see one contract."
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
 * verbs (CLI `write`, MCP `write`) impossible to drift apart.
 */

import { z } from "zod";
import { checkWork } from "./check";
import { readMarker } from "./marker";
import { chapterPreconditions, readNovelState } from "./novel/machine";
import { findVault, resolveProject } from "./project";
import type { Refusal } from "./project";
import { buildResume } from "./resume";
import { saveCore } from "./save";
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

  const { exitCode, text } = await captureConsoleLog(() => runWrite(writeArgs, resolved.vaultRoot, resolved.projectPath, deps));

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

  const { body, exitCode } = saveCore({ stage: args.stage, file: args.file }, resolved.projectPath);
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

  const outcome = checkWork(resolved.vaultRoot, resolved.projectPath, args.file);
  if (!outcome.ok) {
    return { body: { ok: false, code: outcome.code, message: outcome.message, tried: outcome.tried }, exitCode: outcome.code };
  }
  return { body: { ok: true, hits: outcome.hits, unprovenanced: outcome.unprovenanced }, exitCode: 0 };
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
];

// ---------------------------------------------------------------------------
// CLI argv derivation — cli.ts's parseArgs option table, sourced from the
// same zod shapes above so it cannot drift from what the verbs actually take.
// ---------------------------------------------------------------------------

export type CliOptionConfig = { readonly type: "string" } | { readonly type: "boolean"; readonly default: boolean };

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
      const inner = (current as unknown as { _def: { defaultValue: unknown } })._def.defaultValue;
      if (typeof inner === "boolean") defaultValue = inner;
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    break;
  }

  return { base: current, defaultValue };
}

/** `ZodBoolean` -> `{type:"boolean", default}`; every other zod primitive (`ZodString`, `ZodNumber`, ...) -> `{type:"string"}` — `node:util`'s `parseArgs` only knows string/boolean, so a numeric CLI flag stays text until the verb itself coerces it (as every verb already did before this ticket). */
function cliOptionFor(schema: z.ZodTypeAny): CliOptionConfig {
  const { base, defaultValue } = unwrapToBase(schema);
  if (base instanceof z.ZodBoolean) {
    return { type: "boolean", default: defaultValue ?? false };
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
