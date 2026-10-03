/**
 * `verbs.ts` (AGT-1235; `voice` added AGT-1240; `prose` AGT-1241) — the
 * single source of truth for pablo's MCP-exposed verbs (resume, status,
 * write, save, check, voice, prose): one zod schema and one `run` per verb,
 * used by BOTH `cli.ts` (which derives its `parseArgs` option table from
 * these shapes, so the CLI's argv and the MCP tool schemas cannot drift) and
 * `mcp.ts` (which registers one MCP tool per verb straight off the same
 * shape and calls the same `run`). See the design doc's "Commands" section
 * (`pm project show ai-terminal`): "`pablo mcp`
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
 *
 * AGT-1245 — `voice` over MCP splits into four tools: the ticket that wrote
 * `voice` as a single verb with a `sub` positional (`new|list|show|flag|
 * exemplar`) also asked for `voice_list`/`voice_show`/`voice_flag`/
 * `voice_exemplar` as four SEPARATE MCP tools, each with a narrow schema
 * carrying only its own arguments — a model choosing a tool is better served
 * by four honest schemas than by one tool with a `sub` discriminator and a
 * union of half-applicable fields. The CLI keeps its `pablo voice <sub>`
 * form unchanged (this file's `voice` verb, `VOICE_ARGS`, `runVoiceVerb`, and
 * `deriveCliOptions`'s flag table are none of them touched by the split); only
 * the MCP registration surface narrows. That is expressed with one new,
 * optional `Verb.mcpTools` field: a verb with no override registers itself as
 * one MCP tool exactly as before (six of the seven still do); `voice`'s VERBS
 * entry sets `mcpTools` to the four narrow tools below, and `mcp.ts`'s
 * registration loop uses `verb.mcpTools ?? [verb]` — so `verbs.ts` stays the
 * single place both the CLI's argv and every MCP tool's schema come from,
 * with no second hand-written copy of the same fields (the four narrow
 * schemas are built from the same shared zod field definitions `VOICE_ARGS`
 * itself uses, just re-wrapped with each tool's own requiredness). `voice_new`
 * is deliberately NOT among them (AC1 doesn't ask for it, and scaffolding a
 * new voice by name has no obvious use for a model mid-conversation the way
 * reading/growing an existing one does) — it stays CLI-only.
 */

import { z } from "zod";
import { readFileSync } from "node:fs";
import { createPlanner, loadConfig, timelineAt } from "@openthink/pablo-core";
import { join, resolve, sep } from "node:path";
import { waitingForReview } from "./branch";
import { checkWork } from "./check";
import { adapterAsk, critiqueBranch, critiqueModel } from "./critique";
import { KNOWN_FORMATS } from "./formats";
import { migrateLines } from "./migrate";
import { mergeDraftInProject } from "./novel/merge";
import { readMarker } from "./marker";
import { chapterPreconditions, readNovelState } from "./novel/machine";
import { readTool, searchTool } from "./harness-tools";
import { findVault, resolveProject } from "./project";
import type { Refusal } from "./project";
import { proseCore } from "./prose";
import { publishWork } from "./publish";
import { realRunner, shareRound } from "./share";
import type { Runner } from "./share";
import { revisePassage } from "./screen-revise";
import { reviseCore } from "./revise";
import type { ReviseCoreArgs } from "./revise";
import { buildResume } from "./resume";
import { saveCore } from "./save";
import { addExemplar, flagLine, isVoicePathArgument, listVoices, readVoice, resolveVoice, scaffoldVoice } from "./voice";
import type { VoiceLocation } from "./voice";
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
  /**
   * AGT-1261: which surface invoked this verb. `mcp.ts`'s `runMcp` sets this
   * to `"mcp"`; `cli.ts` never sets it (every other caller — the CLI, and
   * every existing test's hand-built `ctx` — leaves it `undefined`, read as
   * `"cli"`). Only `review`'s `run` reads it today, to pick `decide`'s `by`
   * field (AC3's "`by: \"cli\"` (or `\"mcp\"` when invoked through the MCP
   * server)"); no other verb's behavior depends on who called it.
   */
  readonly caller?: "cli" | "mcp";
}

/** `run`'s return: `body` is the exact `--json` object; `exitCode` is the CLI's exit-code contract (0 ok, 2 refused, 1 error). */
export interface VerbResult {
  readonly body: unknown;
  readonly exitCode: number;
}

/** One MCP tool: a name, description, zod input shape, and `run` — exactly `Verb`'s own shape, minus `mcpTools` (a tool has no further tools of its own). `Verb` and `McpToolSpec` are kept as separate names even though they're structurally identical, so a reader sees which role a given value is playing (a CLI-and-MCP verb vs. one of a verb's MCP-only expansions). */
export interface McpToolSpec<Args extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: string;
  readonly description: string;
  readonly args: z.ZodObject<Args>;
  run(args: z.infer<z.ZodObject<Args>>, ctx: VerbContext): Promise<VerbResult>;
}

export interface Verb<Args extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: string;
  readonly description: string;
  readonly args: z.ZodObject<Args>;
  run(args: z.infer<z.ZodObject<Args>>, ctx: VerbContext): Promise<VerbResult>;
  /**
   * AGT-1245: the MCP tool(s) this verb exposes, when they differ from the
   * verb's own name/schema/run (today, only `voice` sets this — see the file
   * header comment). `mcp.ts`'s registration loop reads `verb.mcpTools ??
   * [verb]`, so a verb with no override (still six of the seven) registers
   * itself as one MCP tool exactly as it always did; `cli.ts`'s argv and
   * `deriveCliOptions` never look at this field at all — the CLI dispatches
   * on the verb's own name/args/run, unaffected by how MCP exposes it.
   */
  readonly mcpTools?: readonly McpToolSpec[];
  /**
   * AGT-1261 (standards review finding): field names in `args.shape` that
   * `cli.ts` reads from positionals (`args.rest`), not a named flag —
   * `deriveCliOptions` skips these for this verb so `parseArgs` never
   * declares e.g. `--action`/`--id` as recognized string options a caller
   * could pass and have silently ignored (previously: `pablo review --action
   * list` parsed as `values.action = "list"`, consumed the token, and left
   * `args.rest` empty — a misleading "unknown action" refusal). `voice`'s
   * `sub`/`name` predate this field and have the same latent gap, not
   * migrated here to keep this ticket's diff to the verb it touches.
   */
  readonly positionalArgs?: readonly string[];
}

function refusalBody(r: Refusal): { ok: false; code: number; message: string; tried: readonly string[] } {
  return { ok: false, code: r.code, message: r.message, tried: r.tried };
}

/**
 * The one place `resolve()` + `startsWith(root + sep)` is written (AGT-1245's
 * extraction, per the ticket) — every model-controlled path bound on this
 * surface (`save`'s/`check`'s `file`, `voice`'s path-shaped `name` and
 * `exemplar`'s `file`, `prose`'s five path arguments) calls this rather than
 * repeating the check. `resolveFrom` is where a relative `value` is joined
 * from — usually the same directory the result must stay inside, but
 * `check`'s `file` joins from `projectPath` while it must still land inside
 * `vaultRoot`, so the two are kept as separate parameters rather than one.
 * `boundary` is what the resolved path must equal or sit strictly under.
 * Returns the resolved absolute path on success, or a refusal built from
 * `message`.
 */
function boundedPath(
  resolveFrom: string,
  boundary: string,
  value: string,
  message: (abs: string) => string,
): { readonly ok: true; readonly path: string } | Refusal {
  const abs = resolve(resolveFrom, value);
  if (abs !== boundary && !abs.startsWith(boundary + sep)) {
    return { ok: false, code: 2, message: message(abs), tried: [] };
  }
  return { ok: true, path: abs };
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
    return { body: { ...state, waiting: waitingForReview(resolved.projectPath) }, exitCode: 0 };
  }

  const chapter = parseForChapter(args.for);
  if (chapter === undefined) {
    return { body: { ok: false, code: 2, message: 'pablo: --for expects "chapter N"' }, exitCode: 2 };
  }

  const preconditions = chapterPreconditions(state, chapter);
  return { body: { ready: preconditions.ready, missing: preconditions.missing }, exitCode: preconditions.ready ? 0 : 2 };
}

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------

const TIMELINE_ARGS = z.object({
  project: projectField,
  date: z.string().describe('A story date, e.g. "Winter 1931". Only the first four-digit year counts; a date with no year gates nothing.'),
});

/** AGT-1555: the story-time gate as a tool. Read-only; the same `gateTimeline` the drafting pack uses, via `timelineAt`. */
async function runTimelineVerb(args: z.infer<typeof TIMELINE_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;

  const path = join(resolved.projectPath, "bible", "timeline.md");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {
      body: {
        ok: false,
        code: 2,
        message: "pablo: bible/timeline.md does not exist; create it (a table with a four-digit Year column) to use the timeline gate",
      },
      exitCode: 2,
    };
  }
  const at = timelineAt(text, args.date, "bible/timeline.md");
  return { body: { date: at.date, exists: at.exists, notYet: at.notYet, source: at.source, text: at.text }, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// critique
// ---------------------------------------------------------------------------

const CRITIQUE_ARGS = z.object({
  project: projectField,
  branch: z.string().describe('A change branch to critique, e.g. "draft/ch03" or "revise/ch02-tighten": its changes against main.'),
});

/**
 * AGT-1564: continuity, timeline and voice comments on a branch's changes, each re-checked by a refute call; only
 * survivors come back, as line comments, and are saved under the work's `.pablo/critique/` for review mode. The book
 * is not changed and no branch is made.
 */
async function runCritiqueVerb(args: z.infer<typeof CRITIQUE_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;

  let ask = critiqueModel.ask;
  if (ask === undefined) {
    try {
      ask = adapterAsk(createPlanner(loadConfig({ env: ctx.env }), { keys: { env: ctx.env }, claude: { env: ctx.env } }).adapter);
    } catch (error) {
      return { body: { ok: false, code: 1, message: (error as Error).message }, exitCode: 1 };
    }
  }
  const result = await critiqueBranch({ vaultRoot: resolved.vaultRoot, projectPath: resolved.projectPath, branch: args.branch, ask, progress: (line) => ctx.stderr.write(`${line}\n`) });
  if (result.ok) return { body: result, exitCode: 0 };
  // A refusal (not a change branch, not in a repo) is exit 2; a run that failed (git, the model, the save) is exit 1.
  const code = result.kind === "refused" ? 2 : 1;
  return { body: { ok: false, code, message: result.notice }, exitCode: code };
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
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe("Sampling temperature, 0 to 2 (defaults to the provider's config, then 0.8). 0 decodes greedily: the same pack gives the same text."),
  seed: z.number().int().nonnegative().optional().describe("Sampling seed, to reproduce a draw (default: the endpoint picks one)."),
  direction: z.string().optional().describe("A steer for this chapter beyond its beat row, e.g. \"slower, stay on Cora\". Goes into the pack as its own slice and into the chapter's frontmatter as `direction:`."),
});

/**
 * Runs `fn` with `console.log` redirected into a buffer instead of stdout —
 * the one way to get `runWrite`'s JSON body back as data without changing
 * `runWrite` itself (it always prints; MCP must never write anything but the
 * protocol to stdout). Restores `console.log` even if `fn` throws.
 */
export async function captureConsoleLog(fn: () => Promise<number>): Promise<{ readonly exitCode: number; readonly text: string }> {
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

export async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
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
    temperature: args.temperature !== undefined ? String(args.temperature) : undefined,
    seed: args.seed !== undefined ? String(args.seed) : undefined,
    direction: args.direction,
  };
  const deps: RunWriteDeps = { stderr: ctx.stderr, env: ctx.env };

  const { exitCode, text } = await withWriteLock(() =>
    captureConsoleLog(() => runWrite(writeArgs, resolved.vaultRoot, resolved.projectPath, deps)),
  );

  const body: unknown = text === "" ? { ok: exitCode === 0 } : JSON.parse(text);
  return { body, exitCode };
}

// ---------------------------------------------------------------------------
// draft_chapter
// ---------------------------------------------------------------------------

const DRAFT_CHAPTER_ARGS = z.object({
  project: projectField,
  chapter: z.number().int().positive().describe("The chapter number to draft."),
  direction: WRITE_ARGS.shape.direction,
  words: WRITE_ARGS.shape.words,
  scenes: WRITE_ARGS.shape.scenes,
  force: WRITE_ARGS.shape.force,
  temperature: WRITE_ARGS.shape.temperature,
  seed: WRITE_ARGS.shape.seed,
});

/**
 * AGT-1562: `write` for the harness. The same pipeline (preconditions, pack,
 * local model, draft/chNN branch), with the harness's steer for the chapter as
 * its own pack slice. The result names the branch, path and receipt; it never
 * carries the prose, and the rule-check hits drop their excerpts for the same
 * reason. The harness reads the chapter through `read` when it wants it.
 */
async function runDraftChapterVerb(args: z.infer<typeof DRAFT_CHAPTER_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const result = await runWriteVerb({ ...args, "dry-run": false }, ctx);
  return { body: draftChapterBody(result.body), exitCode: result.exitCode };
}

/** `write`'s success body narrowed to what the harness is given: branch, path, receipt, no excerpts. A refusal body passes through. */
export function draftChapterBody(body: unknown): unknown {
  const written = body as Record<string, unknown>;
  if (written["ok"] !== true) return body;
  const check = Array.isArray(written["check"])
    ? (written["check"] as { path: string; line: number; rule: string }[]).map(({ path, line, rule }) => ({ path, line, rule }))
    : [];
  const { ok, path, branch, worktree, commit, receipt } = written;
  return { ok, branch, path, worktree, commit, receipt, check };
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
  const bound = boundedPath(
    resolved.vaultRoot,
    resolved.vaultRoot,
    args.file,
    (abs) => `pablo: save file must be inside the vault (${abs})`,
  );
  if (!bound.ok) return { body: refusalBody(bound), exitCode: bound.code };

  const { body, exitCode } = saveCore({ stage: args.stage, file: bound.path }, resolved.projectPath);
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
    const bound = boundedPath(
      resolved.projectPath,
      resolved.vaultRoot,
      args.file,
      (abs) => `pablo: check file must be inside the vault (${abs})`,
    );
    if (!bound.ok) return { body: refusalBody(bound), exitCode: bound.code };
  }

  const outcome = checkWork(resolved.vaultRoot, resolved.projectPath, args.file);
  if (!outcome.ok) {
    return { body: { ok: false, code: outcome.code, message: outcome.message, tried: outcome.tried }, exitCode: outcome.code };
  }
  return { body: { ok: true, hits: outcome.hits, unprovenanced: outcome.unprovenanced }, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// migrate (AGT-1533)
// ---------------------------------------------------------------------------

const MIGRATE_ARGS = z.object({
  sub: z.enum(["lines"]).describe("The migration to run: `lines` splits chapters to one sentence per line."),
  project: projectField,
  "dry-run": z.boolean().optional().default(false).describe("List the chapters that would change; write and commit nothing."),
});

async function runMigrateVerb(args: z.infer<typeof MIGRATE_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;

  const outcome = migrateLines(resolved.vaultRoot, resolved.projectPath, { dryRun: args["dry-run"] });
  if (!outcome.ok) return { body: outcome, exitCode: outcome.code };
  return { body: outcome, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// merge (AGT-1536)
// ---------------------------------------------------------------------------

const MERGE_ARGS = z.object({
  project: projectField,
  branch: z.string().describe("The draft branch to merge to main, e.g. draft/ch02 (the receipt of `write` names it)."),
});

async function runMergeVerb(args: z.infer<typeof MERGE_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;
  const outcome = await mergeDraftInProject(resolved.projectPath, args.branch, ctx.env);
  return { body: outcome.body, exitCode: outcome.exitCode };
}

// ---------------------------------------------------------------------------
// publish (AGT-1534)
// ---------------------------------------------------------------------------

const PUBLISH_ARGS = z.object({
  project: projectField,
  target: z.string().describe("draft|review|final — the publish target. Only draft is implemented: one compiled markdown file under .pablo/out/."),
});

async function runPublishVerb(args: z.infer<typeof PUBLISH_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;

  const marker = readMarker(resolved.projectPath);
  if (!marker.ok) return { body: refusalBody(marker), exitCode: marker.code };

  const outcome = publishWork(resolved.projectPath, marker.marker.slug, marker.marker.title, args.target);
  if (!outcome.ok) return { body: refusalBody(outcome), exitCode: outcome.code };
  return { body: { ok: true, target: outcome.target, where: outcome.where, chapters: outcome.chapters, words: outcome.words }, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// share (AGT-1582)
// ---------------------------------------------------------------------------

const SHARE_ARGS = z.object({
  project: projectField,
  reader: z.string().describe('A reader named in pablo\'s config "readers" (e.g. "atara").'),
  chapters: z.string().describe('The chapters to share, all on main: "3" or "3-5".'),
});

/**
 * `share`, with the `gh`/git runner injectable: `runShareVerb` (the verb's
 * `run`) passes `realRunner`; tests pass a fake so nothing reaches GitHub.
 */
export async function shareWith(args: z.infer<typeof SHARE_ARGS>, ctx: VerbContext, run: Runner): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;

  const marker = readMarker(resolved.projectPath);
  if (!marker.ok) return { body: refusalBody(marker), exitCode: marker.code };

  let readers;
  try {
    readers = loadConfig({ env: ctx.env }).readers;
  } catch (error) {
    return { body: { ok: false, code: 1, message: (error as Error).message }, exitCode: 1 };
  }

  const outcome = shareRound({
    vaultRoot: resolved.vaultRoot,
    projectPath: resolved.projectPath,
    slug: marker.marker.slug,
    title: marker.marker.title,
    reader: args.reader,
    chapters: args.chapters,
    readers,
    run,
  });
  if (!outcome.ok) return { body: { ok: false, code: outcome.code, message: outcome.message, tried: outcome.tried }, exitCode: outcome.code };
  return { body: { ok: true, ...outcome.round, record: outcome.recordPath, notices: outcome.notices }, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// voice (AGT-1240; MCP split into four tools AGT-1245)
// ---------------------------------------------------------------------------

// Shared field definitions: `VOICE_ARGS` (the CLI's `sub`-discriminated
// shape, unchanged by this ticket) and the four narrow `voice_*` MCP schemas
// below both build from these rather than each hand-writing its own copy of
// "a voice name" / "a rejected line" / etc. Each caller re-wraps a base with
// its OWN requiredness: `VOICE_ARGS.name` is optional (only `list` can do
// without it, checked at runtime by `runVoiceVerb`), while `voice_show`'s
// `name` is required in the schema itself, structurally — a model calling
// `voice_show` with no `name` gets rejected before `run` is ever invoked.
const voiceNameField = z
  .string()
  .describe('Voice name, or a path (containing "/" or ending ".md") for a one-off voice.');
const voiceLineField = z.string().describe('The rejected line, verbatim — written as `Flagged: "<line>"`.');
const voiceSectionField = z.string().describe('The `## ` section heading to append under (default "Flagged").');
const voiceFileField = z.string().describe("The piece to keep, copied verbatim.");
const voiceTitleField = z.string().describe("The title to file it under (else its first `# ` heading, else its filename).");

const VOICE_ARGS = z.object({
  sub: z
    .enum(["new", "list", "show", "flag", "exemplar"])
    .describe("Which voice action: new (scaffold), list, show, flag (record a rejected line), or exemplar (keep a piece)."),
  name: voiceNameField.optional().describe(
    'Voice name, or a path (containing "/" or ending ".md") for a one-off voice. Required for new/show/flag/exemplar; ignored for list.',
  ),
  global: z
    .boolean()
    .optional()
    .default(false)
    .describe("voice new: scaffold under the global ~/.config/pablo/voices/ directory instead of the vault."),
  line: voiceLineField.optional().describe('voice flag: the rejected line, verbatim — written as `Flagged: "<line>"`.'),
  section: voiceSectionField.optional().describe('voice flag: the `## ` section heading to append under (default "Flagged").'),
  file: voiceFileField.optional().describe("voice exemplar: the piece to keep, copied verbatim."),
  title: voiceTitleField.optional().describe("voice exemplar: the title to file it under (else its first `# ` heading, else its filename)."),
});

type VoiceLocationLookup =
  | { readonly ok: true; readonly location: VoiceLocation }
  | { readonly ok: false; readonly result: VerbResult };

/**
 * Resolves `name` to a voice location, bounding a path-shaped `name` to the
 * vault first (AGT-1235's convention, extracted so the CLI-facing
 * `runVoiceVerb` and all four narrow `voice_*` tools below share exactly one
 * implementation — the ticket's ask for a single audit point applies here
 * just as much as it does to `boundedPath`). Uses `voice.ts`'s own exported
 * `isVoicePathArgument` (the same predicate `resolveVoice` itself branches
 * on) rather than a second, hand-rolled copy of "contains / or ends .md" —
 * that duplicate (`looksLikeVoicePath`) is exactly the drift `voice.ts`'s
 * docstring on `isVoicePathArgument` warns a bound can suffer from.
 */
function resolveVoiceLocationOrRefusal(ctx: VerbContext, name: string): VoiceLocationLookup {
  if (isVoicePathArgument(name)) {
    const message = (abs: string) => `pablo: voice path must be inside the vault (${abs})`;
    const vault = findVault(ctx.cwd, ctx.env);
    if (!vault.ok) {
      return { ok: false, result: { body: { ok: false, code: 2, message: message(resolve(ctx.cwd, name)) }, exitCode: 2 } };
    }
    const bound = boundedPath(ctx.cwd, vault.path, name, message);
    if (!bound.ok) return { ok: false, result: { body: refusalBody(bound), exitCode: bound.code } };
  }

  const resolution = resolveVoice(name, { cwd: ctx.cwd, env: ctx.env });
  if (!resolution.ok) return { ok: false, result: { body: refusalBody(resolution), exitCode: resolution.code } };
  return { ok: true, location: resolution };
}

/**
 * Bounds `voice exemplar`'s `file` to the vault (AGT-1235's convention, same
 * shape as `resolveVoiceLocationOrRefusal`'s path bound) — shared between
 * `runVoiceVerb`'s `exemplar` branch and `voice_exemplar`'s narrow `run`.
 */
function boundVoiceExemplarFile(ctx: VerbContext, file: string): { readonly ok: true; readonly path: string } | Refusal {
  const message = (abs: string) => `pablo: voice exemplar file must be inside the vault (${abs})`;
  const vault = findVault(ctx.cwd, ctx.env);
  if (!vault.ok) return { ok: false, code: 2, message: message(resolve(ctx.cwd, file)), tried: [] };
  return boundedPath(ctx.cwd, vault.path, file, message);
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
  const located = resolveVoiceLocationOrRefusal(ctx, args.name);
  if (!located.ok) return located.result;
  const resolution = located.location;

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
    const bound = boundVoiceExemplarFile(ctx, args.file);
    if (!bound.ok) return { body: refusalBody(bound), exitCode: bound.code };
    const result = addExemplar(resolution, bound.path, { title: args.title });
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
// voice_list / voice_show / voice_flag / voice_exemplar (AGT-1245) — the four
// narrow MCP tools `voice`'s VERBS entry exposes instead of registering
// itself directly (see the file header comment and `Verb.mcpTools`). Each
// `run` below reuses `runVoiceVerb`'s own helpers (`resolveVoiceLocationOrRefusal`,
// `boundVoiceExemplarFile`) rather than re-deriving the bound/resolve logic,
// so there is exactly one implementation of each behind both surfaces.
// ---------------------------------------------------------------------------

const VOICE_LIST_MCP_ARGS = z.object({});

const VOICE_SHOW_MCP_ARGS = z.object({
  name: voiceNameField,
});

const VOICE_FLAG_MCP_ARGS = z.object({
  name: voiceNameField,
  line: voiceLineField,
  section: voiceSectionField.optional(),
});

const VOICE_EXEMPLAR_MCP_ARGS = z.object({
  name: voiceNameField,
  file: voiceFileField.describe(
    "The piece to keep, copied verbatim — resolved and bounded to the vault (or the server's cwd when there is none).",
  ),
  title: voiceTitleField.optional(),
});

async function runVoiceListMcp(_args: z.infer<typeof VOICE_LIST_MCP_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  return { body: { ok: true, voices: listVoices({ cwd: ctx.cwd, env: ctx.env }) }, exitCode: 0 };
}

async function runVoiceShowMcp(args: z.infer<typeof VOICE_SHOW_MCP_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const located = resolveVoiceLocationOrRefusal(ctx, args.name);
  if (!located.ok) return located.result;
  const voice = readVoice(located.location.path);
  return { body: { ok: true, ...voice }, exitCode: 0 };
}

async function runVoiceFlagMcp(args: z.infer<typeof VOICE_FLAG_MCP_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const located = resolveVoiceLocationOrRefusal(ctx, args.name);
  if (!located.ok) return located.result;
  const result = flagLine(located.location, args.line, { section: args.section });
  if (!result.ok) return { body: refusalBody(result), exitCode: result.code };
  return {
    body: { ok: true, path: result.path, committed: result.committed, ...(result.notice ? { notice: result.notice } : {}) },
    exitCode: 0,
  };
}

async function runVoiceExemplarMcp(args: z.infer<typeof VOICE_EXEMPLAR_MCP_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const located = resolveVoiceLocationOrRefusal(ctx, args.name);
  if (!located.ok) return located.result;
  const bound = boundVoiceExemplarFile(ctx, args.file);
  if (!bound.ok) return { body: refusalBody(bound), exitCode: bound.code };
  const result = addExemplar(located.location, bound.path, { title: args.title });
  if (!result.ok) return { body: refusalBody(result), exitCode: result.code };
  return {
    body: { ok: true, path: result.path, committed: result.committed, ...(result.notice ? { notice: result.notice } : {}) },
    exitCode: 0,
  };
}

const VOICE_MCP_TOOLS: readonly McpToolSpec[] = [
  {
    name: "voice_list",
    description: "Every voice pablo can find: the fiction alias (if the vault has a style/ directory), every vault voice, and every global voice.",
    args: VOICE_LIST_MCP_ARGS,
    run: runVoiceListMcp,
  },
  {
    name: "voice_show",
    description: "Read one voice as a model would see it: its rules, exemplars, an optional never list, and its routed model.",
    args: VOICE_SHOW_MCP_ARGS,
    run: runVoiceShowMcp,
  },
  {
    name: "voice_flag",
    description: 'Record a rejected line under a voice\'s "## Flagged" section (or another heading) so future packs avoid it.',
    args: VOICE_FLAG_MCP_ARGS,
    run: runVoiceFlagMcp,
  },
  {
    name: "voice_exemplar",
    description: "Keep a piece as-is under a voice's exemplars/ directory, newest first into every future pack.",
    args: VOICE_EXEMPLAR_MCP_ARGS,
    run: runVoiceExemplarMcp,
  },
];

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
  draft: z
    .string()
    .optional()
    .describe("The revise loop (AGT-1244): a file path to the previous piece to rewrite. Requires instruction."),
  instruction: z
    .string()
    .optional()
    .describe("The revise loop: what to change about draft, in the author's own words. Requires draft."),
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
  const bound = boundedPath(boundary, boundary, value, (abs) => `pablo: prose ${label} must be inside ${boundary} (${abs})`);
  return bound.ok ? undefined : bound;
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
  // `draft` is a new READ path (AGT-1244), bound exactly like `--brief` and
  // `--context` above — a compromised/prompt-injected caller must not be able
  // to name an arbitrary file (e.g. an SSH key) as the "previous piece" and
  // have its contents echoed back in the pack (and, with `--out`, on disk).
  // `instruction` is NOT a path — it is inline text with no file to bind —
  // and is sanitized instead, in `prose.ts`'s `assembleProse`/
  // `sanitizeInstruction`, on the one code path both the CLI and this verb
  // share, so the defense cannot drift between the two callers the way
  // AGT-1243's `line`/`section` split briefly did.
  if (args.draft !== undefined) {
    const problem = bindProsePath(ctx, "--draft", args.draft);
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
      draft: args.draft,
      instruction: args.instruction,
    },
    { cwd: ctx.cwd, env: ctx.env },
    { stderr: ctx.stderr },
  );
  return { body: outcome.body, exitCode: outcome.exitCode };
}

// ---------------------------------------------------------------------------
// revise (AGT-1264) — sends ONE located passage to the local model and
// returns a candidate. Writes nothing: no `--out`, no `--force`, no file
// mutation of any kind. See `revise.ts`'s header comment for the pure/CLI
// split this verb's `run` calls into (`reviseCore`, mirroring `proseCore`).
// ---------------------------------------------------------------------------

const REVISE_ARGS = z.object({
  project: projectField,
  file: z.string().describe("Chapter file to read the passage from (work-relative or absolute); must resolve inside the project."),
  passage: z
    .string()
    .optional()
    .describe(
      "The passage to rewrite, quoted verbatim (whitespace-run tolerant). Exactly one of passage or start+end is required.",
    ),
  start: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("UTF-16 offset into the frontmatter-stripped body where the passage begins (half-open, with end). Alternative to passage."),
  end: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("UTF-16 offset into the frontmatter-stripped body where the passage ends (half-open, with start)."),
  instruction: z.string().describe("What to change about the passage, in the author's own words."),
  "dry-run": z
    .boolean()
    .optional()
    .default(false)
    .describe("Assemble and render the pack (slice by slice, with its prompt hash); send nothing to the model."),
});

/**
 * `file` is model-controlled over MCP, exactly like `check`'s/`save`'s own
 * `file` field: bound to the vault before it is ever read (defense in depth —
 * `reviseCore`'s own resolution additionally requires it to resolve INSIDE
 * the project, a stricter bound than the vault-wide one applied here).
 */
async function runReviseVerb(args: z.infer<typeof REVISE_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;

  const bound = boundedPath(
    resolved.projectPath,
    resolved.vaultRoot,
    args.file,
    (abs) => `pablo: revise file must be inside the vault (${abs})`,
  );
  if (!bound.ok) return { body: refusalBody(bound), exitCode: bound.code };

  const reviseArgs: ReviseCoreArgs = {
    file: args.file,
    passage: args.passage,
    start: args.start,
    end: args.end,
    instruction: args.instruction,
    dryRun: args["dry-run"],
  };

  const outcome = await reviseCore(
    reviseArgs,
    { vaultRoot: resolved.vaultRoot, projectPath: resolved.projectPath, env: ctx.env },
    { stderr: ctx.stderr },
  );
  return { body: outcome.body, exitCode: outcome.exitCode };
}

// ---------------------------------------------------------------------------
// revise_passage (AGT-1563) — `revise` for the harness: the candidate is
// committed on a revise/<id> branch instead of being returned.
// ---------------------------------------------------------------------------

const REVISE_PASSAGE_ARGS = z.object({
  project: projectField,
  file: REVISE_ARGS.shape.file,
  passage: z.string().describe("The passage to rewrite, quoted verbatim (whitespace-run tolerant)."),
  instruction: REVISE_ARGS.shape.instruction,
});

/**
 * The same locate-and-revise as `revise`, then the candidate lands on a
 * `revise/<id>` branch authored as the model (what `a r` does when the author
 * takes it). The result names the branch, file and receipt; it never carries
 * the prose, so the harness reads the branch through `read` to see it.
 */
async function runRevisePassageVerb(args: z.infer<typeof REVISE_PASSAGE_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;
  const bound = boundedPath(
    resolved.projectPath,
    resolved.vaultRoot,
    args.file,
    (abs) => `pablo: revise_passage file must be inside the vault (${abs})`,
  );
  if (!bound.ok) return { body: refusalBody(bound), exitCode: bound.code };
  const result = await revisePassage(resolved.vaultRoot, resolved.projectPath, args, { env: ctx.env });
  return { body: result, exitCode: result.ok ? 0 : result.code };
}

// ---------------------------------------------------------------------------
// read / search (AGT-1554) — the harness's way to find what the work has
// already established; the logic is `harness-tools.ts`.
// ---------------------------------------------------------------------------

const READ_ARGS = z.object({
  project: projectField,
  path: z
    .string()
    .describe(
      'A file of the work, relative to it: a bible file ("bible/overview.md"), a chapter ("chapters/01-….md", returned joined into paragraphs), an outline, "continuity.md", or a research note ("research/…"). A directory lists its entries.',
    ),
});

async function runReadVerb(args: z.infer<typeof READ_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;
  const result = readTool(resolved.projectPath, args.path);
  return { body: result, exitCode: result.ok ? 0 : result.code };
}

const SEARCH_ARGS = z.object({
  project: projectField,
  phrase: z.string().describe("A name, place, phrase or fact to find, matched case-insensitively across the bible, chapters, outline, continuity and research."),
});

async function runSearchVerb(args: z.infer<typeof SEARCH_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;
  const result = searchTool(resolved.projectPath, args.phrase);
  return { body: result, exitCode: result.ok ? 0 : result.code };
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
    name: "timeline",
    description:
      "What exists yet at a story date: the work's timeline rows at or before the date, and the rows after it marked as not existing yet (do not mention or foreshadow). The same story-time gate the drafting pack uses.",
    args: TIMELINE_ARGS,
    run: runTimelineVerb,
  },
  {
    name: "critique",
    description:
      "Critique a change branch: line comments for continuity contradictions (against continuity.md and the bible), things mentioned before their story date (the timeline gate), and voice tells (the style guide). Each comment is re-checked with more of the text and only survivors come back; they show as line comments in review mode. Changes nothing in the book.",
    args: CRITIQUE_ARGS,
    run: runCritiqueVerb,
  },
  {
    name: "write",
    description: "Draft one chapter on the configured local model: check preconditions, assemble the pack, send, write, receipt.",
    args: WRITE_ARGS,
    run: runWriteVerb,
  },
  {
    name: "draft_chapter",
    description:
      "Draft chapter n on the local model (Gemma) from its beat, steered by an optional direction such as \"slower, stay on Cora\". The draft lands on a draft/chNN branch for the author to review. Returns the branch, path and receipt, never the prose; read the chapter to see it.",
    args: DRAFT_CHAPTER_ARGS,
    run: runDraftChapterVerb,
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
    name: "migrate",
    description:
      "One-time migrations of a project. `lines` splits chapters/*.md to one sentence per line (frontmatter untouched) and commits exactly those files; idempotent, `dry-run` lists what would change.",
    args: MIGRATE_ARGS,
    run: runMigrateVerb,
    positionalArgs: ["sub"],
  },
  {
    name: "merge",
    description:
      "Merge a reviewed draft branch (draft/chNN, named in `write`'s receipt) into main, then run the after-write steps for its chapter: outline tick, dated note, README, continuity, commit, think sync. A conflict changes nothing.",
    args: MERGE_ARGS,
    run: runMergeVerb,
    positionalArgs: ["branch"],
    // Merging is the human's review gate: a model connected over MCP must not
    // be able to land its own draft, so this verb registers no MCP tool.
    mcpTools: [],
  },
  {
    name: "publish",
    description:
      "Compile the work's chapters into one publishable markdown file (frontmatter stripped, sentence lines joined into paragraphs, quotes curled) under .pablo/out/. Only the draft target exists today.",
    args: PUBLISH_ARGS,
    run: runPublishVerb,
  },
  {
    name: "share",
    description:
      "Open a reading round: push the named chapters (all on main) to the book's private reading repo as a PR the reader can comment on, request the reader's review, and record the round in the vault.",
    args: SHARE_ARGS,
    run: (args: z.infer<typeof SHARE_ARGS>, ctx: VerbContext) => shareWith(args, ctx, realRunner),
    // Sending the manuscript to a person is the author's act: a model connected
    // over MCP must not be able to do it, so this verb registers no MCP tool.
    mcpTools: [],
  },
  {
    name: "voice",
    description:
      "Find, scaffold, grow, or inspect a named voice directory: `new` scaffolds one, `list` finds every one, `show` reads one as a model would see it, `flag` records a rejected line, `exemplar` keeps a piece as-is.",
    args: VOICE_ARGS,
    run: runVoiceVerb,
    // AGT-1245: over MCP this verb registers as four narrow tools
    // (voice_list/voice_show/voice_flag/voice_exemplar) instead of itself —
    // see the file header comment and `Verb.mcpTools`. The CLI's own
    // `pablo voice <sub>` dispatch (cli.ts's `runVoice`) never reads this
    // verb's `run` at all (it calls `voice.ts`'s functions directly), and
    // `deriveCliOptions` reads only `args`/`name` above, so this field has no
    // effect on the CLI whatsoever.
    mcpTools: VOICE_MCP_TOOLS,
  },
  {
    name: "prose",
    description:
      "Write a piece in a named voice from a brief: assemble the pack, send it to the routed model, return the text plus a receipt and check hits (or, with `dry-run`, just render the pack). No `--project`, no vault required.",
    args: PROSE_ARGS,
    run: runProseVerb,
  },
  {
    name: "revise",
    description:
      "Send one located passage of a manuscript to the local model and return a candidate: locate it (by quoted text or a start/end offset pair), assemble the pack with the project's own style and work rules, send once, and return {candidate, span, receipt} — never writes the file.",
    args: REVISE_ARGS,
    run: runReviseVerb,
  },
  {
    name: "revise_passage",
    description:
      "Revise one passage of a chapter on the local model (Gemma) following an instruction such as \"tighten, keep the dread\". The revision lands on a revise/<id> branch for the author to review. Returns the branch, file and receipt, never the prose; read the branch to see it.",
    args: REVISE_PASSAGE_ARGS,
    run: runRevisePassageVerb,
  },
  {
    name: "read",
    description: "Read one file of the work: a bible file, chapter (joined into paragraphs), outline, continuity or research note. Refuses any path outside the work.",
    args: READ_ARGS,
    run: runReadVerb,
    positionalArgs: ["path"],
  },
  {
    name: "search",
    description: "Find a phrase across the work's bible, chapters, outline, continuity and research; returns each match's file, line and sentence.",
    args: SEARCH_ARGS,
    run: runSearchVerb,
    positionalArgs: ["phrase"],
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
    const positional = new Set(verb.positionalArgs ?? []);
    for (const [key, schema] of Object.entries(verb.args.shape)) {
      if (positional.has(key)) continue;
      if (!(key in options)) options[key] = cliOptionFor(schema as z.ZodTypeAny);
    }
  }
  return options;
}
