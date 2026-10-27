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
 * error — AC3). `init` (AGT-2143) has an entry for MCP's sake; the CLI
 * dispatches it itself (it runs before any marker exists), through the same
 * `initWork` the entry's `run` calls.
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
import { CHECK_INTENT, createPlanner, loadConfig, timelineAt } from "@openthink/pablo-core";
import type { Adapter } from "@openthink/pablo-core";
import { join, resolve, sep } from "node:path";
import { checkWork, radioScriptsChecked, runModelChecks } from "./check";
import { checkAcross, promoteFinding } from "./across";
import { adapterAsk, critiqueBranch, critiqueModel } from "./critique";
import type { Ask } from "./critique";
import { KNOWN_FORMATS } from "./formats";
import { migrateLines } from "./migrate";
import { migrateOutputs } from "./migrate-outputs";
import { migrateTrack } from "./migrate-track";
import { mergeDraftInProject } from "./novel/merge";
import { readMarker, trackOf } from "./marker";
import { FACT_KINDS } from "./record-fact";
import {
  distillFactsInProject,
  linkChecklistItem,
  planChecklist,
  recordFactInProject,
  saveResearchInProject,
  waiveChecklistItem,
} from "./research-verbs";
import { guide } from "./guide";
import { readTool, searchTool } from "./harness-tools";
import { runWebVerb, WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "./web-tools";
import type { WebSeams } from "./web-tools";
import { addOutput, listOutputs, planOutput, removeOutput } from "./output-verbs";
import { initBody, initWork } from "./init";
import { findVault, resolveProject } from "./project";
import type { Refusal } from "./project";
import { proseCore } from "./prose";
import { parseForEpisode, radioBind, radioCheck, radioStatus, realCastingDeps } from "./radio";
import type { CastingDeps } from "./radio";
import { isOutputId, OUTPUTS, outputIds, resolveOutput } from "./outputs/registry";
import { revisePassage } from "./screen-revise";
import { reviseCore } from "./revise";
import type { ReviseCoreArgs } from "./revise";
import { buildResume } from "./resume";
import { readWorkStatus } from "./work-state";
import { castingVerbs } from "./casting-verbs";
import { saveCore } from "./save";
import { addExemplar, addRule, flagLine, isVoicePathArgument, listVoices, readVoice, resolveVoice, scaffoldVoice } from "./voice";
import type { VoiceLocation } from "./voice";
import { editRule, listRules, parseLayerTarget, removeRule, ruleFileFor, TARGET_USAGE, useVoice, workFromCwd } from "./voice-rules";
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
   * AGT-1683: where a verb that streams JSON lines (`perform --json-lines`)
   * writes them as they happen. `cli.ts` sets it to the process's stdout;
   * `pablo mcp` never does (its stdout is the protocol), so a streaming verb
   * called over MCP keeps its events on stderr only.
   */
  readonly stdout?: ProgressSink;
  /**
   * AGT-1261: which surface invoked this verb. `mcp.ts`'s `runMcp` sets this
   * to `"mcp"`; `cli.ts` never sets it (every other caller — the CLI, and
   * every existing test's hand-built `ctx` — leaves it `undefined`, read as
   * `"cli"`). Only `review`'s `run` reads it today, to pick `decide`'s `by`
   * field (AC3's "`by: \"cli\"` (or `\"mcp\"` when invoked through the MCP
   * server)"); no other verb's behavior depends on who called it.
   */
  readonly caller?: "cli" | "mcp";
  /**
   * AGT-1680: the machine the casting verbs (`check` on a radio work, `status
   * --for "episode N"`, `bind`) reach the Python side through. Tests inject a
   * fake; left `undefined`, the real one (`uv`, the venv) is used, and only
   * once a radio work actually needs it.
   */
  readonly casting?: CastingDeps;
  /**
   * AGT-1669: the writer `write`, `draft_chapter` and `draft_unit` draft with. Tests inject a fake adapter so a
   * draft never reaches a model; left `undefined`, the routed provider is used, as on the CLI.
   */
  readonly writer?: Adapter;
  /**
   * AGT-2109: the research agent `research distill` (`distill_facts`) asks to distil the notes. Tests inject a fake
   * adapter so distillation never reaches a model; left `undefined`, the `research` intent's routed provider is used.
   */
  readonly researcher?: Adapter;
  /** AGT-2126: network seams for `web_search` and `web_fetch`. Tests inject fakes so a tool never reaches the network. */
  readonly web?: WebSeams;
  /**
   * AGT-2143: the continuity extractor `merge` (and `story`'s merges) run the after-write rituals with. Tests inject a
   * fake adapter so a merge never reaches a model; left `undefined`, the routed extraction provider is used, as on the CLI.
   */
  readonly extractor?: Adapter;
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
  /**
   * AGT-2143: `false` serves the tool over `pablo mcp` only and keeps it out of
   * pablo's own agent loop (`harnessTools()`). For the author's acts an outside
   * agent may take on the author's word but the in-app agent never takes on its
   * own: starting a work (`init`), running the drafting pipeline (`story`), and
   * accepting a draft (`merge`). Absent, the tool reaches both.
   */
  readonly harness?: false;
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
  /** AGT-2143: as `McpToolSpec.harness`, for a verb that registers itself as its own MCP tool. */
  readonly harness?: false;
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
function resolveVerbProject(ctx: Pick<VerbContext, "cwd" | "env">, project: string): ResolvedProject | UnresolvedProject {
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

/**
 * `--for`'s value as an output and a unit (AGT-1669): `"<type> N"` (or
 * `"<type>-N"`) names the output, `chapter N` / `chapter-N` / `ch N` are the
 * novel's spelling, and a bare `N` leaves the output to the default-output
 * rule (`output` undefined). `"episode N"` is the radio casting check
 * (`parseForEpisode`), matched before this. Anything else is `undefined`.
 */
export function parseForUnit(raw: string): { readonly output: string | undefined; readonly unit: number } | undefined {
  const trimmed = raw.trim();
  const bare = /^(\d+)$/.exec(trimmed);
  if (bare) return { output: undefined, unit: Number(bare[1]) };
  const chapter = parseForChapter(trimmed);
  if (chapter !== undefined) return { output: OUTPUTS.novel.id, unit: chapter };
  const typed = /^([a-z][a-z0-9_]*)(?:\s+|-)(\d+)$/i.exec(trimmed);
  if (typed) return { output: (typed[1] as string).toLowerCase(), unit: Number(typed[2]) };
  return undefined;
}

/** The refusal `--for` gives a value it cannot read. */
export const FOR_USAGE = 'pablo: --for expects "chapter N" (the novel), "<output> N" (e.g. "novel 3"), a bare "N" on a work with one output, or "episode N"';

/**
 * `status --for <type> N` (AGT-1669), for the CLI and the `status` verb alike:
 * the addressed output's preconditions for unit N, `{ready, missing}`, exit 0
 * when ready and 2 when not; a work with several outputs and no type named,
 * or a type it does not have, is a refusal naming them.
 */
export function unitStatus(projectPath: string, raw: string): VerbResult & { readonly label?: string; readonly lines?: readonly string[] } {
  const parsed = parseForUnit(raw);
  if (parsed === undefined) return { body: { ok: false, code: 2, message: FOR_USAGE }, exitCode: 2 };
  if (parsed.output !== undefined && !isOutputId(parsed.output)) {
    const message = `${FOR_USAGE}; "${parsed.output}" is not an output type (known: ${outputIds().join(", ")})`;
    return { body: { ok: false, code: 2, message, missing: [`--for: ${outputIds().map((id) => `"${id} N"`).join(" | ")}`] }, exitCode: 2 };
  }
  const marker = readMarker(projectPath);
  const resolved = resolveOutput(marker.ok ? marker.marker.outputs : {}, parsed.output, "status", marker.ok ? trackOf(marker.marker) : undefined);
  if (!resolved.ok) return { body: { ok: false, code: resolved.code, message: resolved.message, missing: resolved.missing }, exitCode: resolved.code };
  const label = `${resolved.output.noun} ${parsed.unit}`;
  // A type with stages after the write (the radio output, AGT-1686) reports where the unit stands in them.
  if (resolved.output.unitStatus !== undefined) {
    const report = resolved.output.unitStatus(projectPath, parsed.unit);
    return {
      body: { ready: report.ready, missing: report.missing, ...(report.detail ?? {}) },
      exitCode: report.ready ? 0 : 2,
      label,
      ...(report.lines !== undefined ? { lines: report.lines } : {}),
    };
  }
  const preconditions = resolved.output.preconditions(projectPath, parsed.unit);
  return { body: { ready: preconditions.ready, missing: preconditions.missing }, exitCode: preconditions.ready ? 0 : 2, label };
}

/** A zod field naming one of the work's outputs; the CLI's `--output <type>`. */
const outputField = z
  .string()
  .describe(
    'The output to act on, e.g. "novel" or "radio": one of the work\'s pablo.json outputs. Optional when the work has one output; a work with several refuses without it, naming them.',
  );

/** The CLI's and MCP's refusal body for an output that did not resolve. */
function outputRefusalBody(refusal: { readonly code: number; readonly message: string; readonly missing: readonly string[] }): VerbResult {
  return { body: { ok: false, code: refusal.code, message: refusal.message, missing: refusal.missing }, exitCode: refusal.code };
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
      'A unit of one output, "<output> N", e.g. "novel 3" (the novel also takes "chapter 3", "chapter-3", "ch 3"; a bare "3" names the work\'s one output): {ready, missing[]} for drafting it. A radio episode, e.g. "episode 3", is ready only when every role in its script is bound to a voice. Omit for the whole work: {core: {stages, ...}, outputs: {<type>: {units, drafted, total, next?}}, waiting, next}, where next names the layer that is short.',
    ),
});

async function runStatusVerb(args: z.infer<typeof STATUS_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;

  if (args.for === undefined) {
    return { body: readWorkStatus(resolved.projectPath), exitCode: 0 };
  }

  const episode = parseForEpisode(args.for);
  if (episode !== undefined) {
    return radioStatus({ env: ctx.env, stderr: ctx.stderr }, ctx.casting ?? realCastingDeps(ctx.env), resolved.projectPath, episode);
  }

  return unitStatus(resolved.projectPath, args.for);
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
/** The critic's model (the planner role, under the `check` intent), or the test injection; a planner that cannot be built is exit 1. Shared by `critique` and `check --across`. */
function criticAsk(ctx: VerbContext, projectDir: string): Ask | VerbResult {
  if (critiqueModel.ask !== undefined) return critiqueModel.ask;
  try {
    return adapterAsk(createPlanner(loadConfig({ env: ctx.env, projectDir }), { keys: { env: ctx.env }, intent: CHECK_INTENT }).adapter);
  } catch (error) {
    return { body: { ok: false, code: 1, message: (error as Error).message }, exitCode: 1 };
  }
}

async function runCritiqueVerb(args: z.infer<typeof CRITIQUE_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;

  const ask = criticAsk(ctx, resolved.projectPath);
  if (typeof ask !== "function") return ask;
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
  output: outputField.optional(),
  unit: z.number().int().positive().optional().describe("The unit of the output to draft (a chapter of the novel, an episode of the radio show)."),
  chapter: z.number().int().positive().optional().describe("The chapter number to draft: the novel's spelling of output novel, unit N."),
  words: z.number().int().positive().optional().describe("Target word count (defaults to the format's own target)."),
  scenes: z.number().int().positive().optional().describe("Minimum scene count (defaults to the format's own minimum)."),
  "dry-run": z.boolean().optional().default(false).describe("Assemble and render the pack; send nothing to the model."),
  force: z.boolean().optional().default(false).describe("Overwrite an existing chapter file."),
  "no-check": z.boolean().optional().default(false).describe("Skip the track's checks (anachronism, fact accuracy, claim support, the core check) after the draft. They never rewrite the draft; a hit is reported."),
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe("Sampling temperature, 0 to 2 (defaults to the provider's config, then 0.8). 0 decodes greedily: the same pack gives the same text."),
  seed: z.number().int().nonnegative().optional().describe("Sampling seed, to reproduce a draw (default: the endpoint picks one)."),
  direction: z.string().optional().describe("A steer for this chapter beyond its beat row, e.g. \"slower, stay on Cora\". Goes into the pack as its own slice and into the chapter's frontmatter as `direction:`."),
  voices: z
    .enum(["narrator", "characters"])
    .optional()
    .describe("The narrated output only: who reads the unit. narrator (default): one narrator reads it all. characters: quoted dialogue whose speaker the paragraph names goes to that character's line."),
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
    output: args.output,
    unit: args.unit !== undefined ? String(args.unit) : undefined,
    chapter: args.chapter !== undefined ? String(args.chapter) : undefined,
    words: args.words !== undefined ? String(args.words) : undefined,
    scenes: args.scenes !== undefined ? String(args.scenes) : undefined,
    dryRun: args["dry-run"] ?? false,
    json: true,
    force: args.force ?? false,
    temperature: args.temperature !== undefined ? String(args.temperature) : undefined,
    seed: args.seed !== undefined ? String(args.seed) : undefined,
    direction: args.direction,
    voices: args.voices,
    noCheck: args["no-check"] ?? false,
  };
  const deps: RunWriteDeps = { stderr: ctx.stderr, env: ctx.env, ...(ctx.writer ? { adapter: ctx.writer } : {}) };

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
  const result = await runWriteVerb({ ...args, "dry-run": false, "no-check": false }, ctx);
  return { body: draftChapterBody(result.body), exitCode: result.exitCode };
}

// ---------------------------------------------------------------------------
// draft_unit (AGT-1669)
// ---------------------------------------------------------------------------

const DRAFT_UNIT_ARGS = z.object({
  project: projectField,
  output: z.string().describe('The output to draft a unit of, e.g. "novel" or "radio": one of the work\'s pablo.json outputs.'),
  n: z.number().int().positive().describe("The unit number to draft (chapter N of the novel, episode N of the radio show)."),
  direction: z.string().optional().describe("A steer for this unit beyond its beat row, e.g. \"slower, stay on Cora\". Goes into the pack as its own slice."),
  words: WRITE_ARGS.shape.words,
  scenes: WRITE_ARGS.shape.scenes,
  force: WRITE_ARGS.shape.force,
  temperature: WRITE_ARGS.shape.temperature,
  seed: WRITE_ARGS.shape.seed,
});

/**
 * AGT-1669: `draft_chapter` for any output. The same `write` verb with
 * `--output <output> --unit <n>` (preconditions, pack, local model, the
 * output's draft branch), narrowed the same way: branch, path and receipt
 * (which names `output` and `unit`), never the prose.
 */
async function runDraftUnitVerb(args: z.infer<typeof DRAFT_UNIT_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const { n, ...rest } = args;
  const result = await runWriteVerb({ ...rest, unit: n, "dry-run": false, "no-check": false }, ctx);
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
  const notices = Array.isArray(written["checkNotices"]) ? { checkNotices: written["checkNotices"] } : {};
  return { ok, branch, path, worktree, commit, receipt, check, ...notices };
}

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

const SAVE_ARGS = z.object({
  project: projectField,
  stage: z.string().optional().describe("acts|beats|premise|bible/<file> — which planning target to replace (a nonfiction work: thesis|claims|outline)."),
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
  file: z
    .string()
    .optional()
    .describe(`Work-relative or absolute path to scan; omit to scan every unit of the output (the novel's ${OUTPUTS.novel.artifactDir}/*.md).`),
  output: outputField.optional(),
  unit: z.number().int().positive().optional().describe("With `output`: only this unit of the output."),
  across: z
    .boolean()
    .optional()
    .default(false)
    .describe("Compare every output's continuity ledger and report facts that contradict between tellings, each re-checked by the critic's refute step, with a promote action per side."),
});

async function runCheckVerb(args: z.infer<typeof CHECK_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;

  // AGT-1671: contradictions between the outputs' ledgers, through the critic's refute step.
  if (args.across) {
    const ask = criticAsk(ctx, resolved.projectPath);
    if (typeof ask !== "function") return ask;
    const result = await checkAcross({ projectPath: resolved.projectPath, ask, progress: (line) => ctx.stderr.write(`${line}\n`) });
    if (result.ok) return { body: result, exitCode: 0 };
    const code = result.kind === "refused" ? 2 : 1;
    return { body: { ok: false, code, message: result.notice }, exitCode: code };
  }

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

  const outcome = checkWork(resolved.vaultRoot, resolved.projectPath, args.file, args.output, args.unit);
  if (!outcome.ok) {
    return {
      body: { ok: false, code: outcome.code, message: outcome.message, tried: outcome.tried, ...(outcome.missing ? { missing: outcome.missing } : {}) },
      exitCode: outcome.code,
    };
  }
  // A historical-fiction work also gets the model-backed checks, on the `check` intent: anachronism (AGT-2113, cached
  // verdicts first) and, with `output`, fact accuracy against facts/period.md (AGT-2112).
  const model = await runModelChecks(outcome, resolved.projectPath, args.output, { env: ctx.env, progress: (line) => ctx.stderr.write(`${line}\n`) });
  const body: Record<string, unknown> = { ok: true, hits: model.hits, unprovenanced: outcome.unprovenanced, ...(outcome.core ? { core: outcome.core } : {}), ...(model.factAccuracy ? { factAccuracy: model.factAccuracy } : {}) };
  // A radio work also gets its scripts read: unknown directions and unbound roles (AGT-1680).
  const radio = radioScriptsChecked(args.file, args.output) ? radioCheck({ env: ctx.env, stderr: ctx.stderr }, ctx.casting ?? realCastingDeps(ctx.env), resolved.projectPath) : undefined;
  if (radio !== undefined) {
    if (radio.exitCode !== 0) return radio;
    const { ok: _ok, ...rest } = radio.body as Record<string, unknown>;
    body["radio"] = rest;
  }
  if (model.anachronism !== undefined) body["anachronism"] = model.anachronism;
  return { body, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// promote
// ---------------------------------------------------------------------------

const PROMOTE_ARGS = z.object({
  project: projectField,
  finding: z.string().regex(/^x[0-9a-f]{8}$/, "a finding id from check --across, e.g. x1a2b3c4d").describe("A finding id from the last `check --across`."),
  keep: outputField.describe('The output whose side of the finding is kept, e.g. "novel": its fact goes to facts.md.'),
});

/**
 * AGT-1671: a `check --across` finding's promote action. The kept side's fact goes to facts.md with
 * `established-by: <type>/<unit>` on a plan/ branch, and each contradicting unit gets a comment on its line there,
 * shown in review mode.
 */
async function runPromoteVerb(args: z.infer<typeof PROMOTE_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;
  const result = promoteFinding({ projectPath: resolved.projectPath, finding: args.finding, keep: args.keep, env: ctx.env });
  if (result.ok) return { body: result, exitCode: 0 };
  return { body: { ok: false, code: result.code, message: result.notice }, exitCode: result.code };
}

// ---------------------------------------------------------------------------
// research save / fact record (AGT-2106, D-9)
// ---------------------------------------------------------------------------

const RESEARCH_ARGS = z.object({
  sub: z
    .enum(["save", "distill", "plan", "waive", "link"])
    .describe(
      "`save`: keep a research finding with its sources as research/<slug>.md. `distill`: turn research/ into short, sourced period facts in facts/period.md. " +
        "`plan`: derive research/checklist.md from the period brief or thesis. `waive <#> \"<reason>\"`: close a checklist item with a reason. " +
        "`link <#> <note>`: close a checklist item with an existing research note.",
    ),
  project: projectField,
  title: z.string().optional().describe("What the note is about, e.g. 'Grape prices, 1919'. Becomes the file name."),
  note: z.string().optional().describe("The finding, in your own words: the checkable facts and what they mean for the story."),
  source: z.array(z.string()).optional().default([]).describe("Where a fact came from: a URL or full citation. Repeatable; at least one."),
  item: z.array(z.string()).optional().default([]).describe("`save`: the research checklist item(s) this note sources, by number. Repeatable."),
  entry: z.string().optional().describe("`waive`/`link`: the checklist item's number."),
  // One positional slot, read per action: the CLI's `waive <#> "<reason>"` and `link <#> <note>`. The MCP tools name it `reason` and `note`.
  text: z.string().optional().describe("The action's second positional, overloaded: `waive`'s reason (why the item needs no research), or `link`'s research note id (its path under research/ without .md)."),
});

/** `pablo research save` (the harness's `save_research`) and `research distill` (`distill_facts`), on a `plan/` branch for the author to review. */
async function runResearchVerb(args: z.infer<typeof RESEARCH_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;
  if (args.sub === "distill") return distillFactsInProject(resolved.projectPath, ctx.env, { researcher: ctx.researcher, stderr: ctx.stderr });
  if (args.sub === "plan") return planChecklist(resolved.projectPath, ctx.env, { researcher: ctx.researcher, stderr: ctx.stderr });
  if (args.sub === "waive") return waiveChecklistItem(resolved.projectPath, args.entry, args.text, ctx.env);
  if (args.sub === "link") return linkChecklistItem(resolved.projectPath, args.entry, args.text, ctx.env);
  return saveResearchInProject(resolved.projectPath, { title: args.title ?? "", note: args.note ?? "", sources: args.source ?? [] }, ctx.env, args.item ?? []);
}

const FACT_ARGS = z.object({
  sub: z.enum(["record"]).describe("`record`: append one fact, tagged with where it came from, on a plan/ branch."),
  project: projectField,
  fact: z.string().optional().describe("The fact, in one sentence."),
  where: z.string().optional().describe("`continuity` or a bible file (`places`, `bible/places.md`). Ignored with --promote."),
  kind: z.string().optional().describe(`researched (needs --source), invented or author. One of: ${FACT_KINDS.join(", ")}.`),
  // Same key as `research save`'s repeatable --source, so the CLI option is one declaration; several are joined into one citation.
  source: z.array(z.string()).optional().default([]).describe("The citation for a researched fact."),
  heading: z.string().optional().describe("The `## ` heading of the section to file under (default: the end of the file)."),
  chapter: z.string().optional().describe("An optional chapter tag, e.g. ch03."),
  promote: z.boolean().optional().default(false).describe("File the fact in facts.md (the story core's facts every output honours); needs --established-by."),
  "established-by": z.string().optional().describe("With --promote: the output and unit that established it, e.g. novel/ch03 or radio/ep05."),
});

/** `pablo fact record`: the harness's `record_fact`, on a `plan/` branch for the author to review. */
async function runFactVerb(args: z.infer<typeof FACT_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;
  const source = (args.source ?? []).map((s) => s.trim()).filter(Boolean).join("; ");
  return recordFactInProject(
    resolved.projectPath,
    {
      fact: args.fact ?? "",
      where: args.where ?? "",
      kind: args.kind ?? "",
      ...(source ? { source } : {}),
      ...(args.heading !== undefined ? { heading: args.heading } : {}),
      ...(args.chapter !== undefined ? { chapter: args.chapter } : {}),
      ...(args.promote ? { promote: true } : {}),
      ...(args["established-by"] !== undefined ? { establishedBy: args["established-by"] } : {}),
    },
    ctx.env,
  );
}

// The MCP names are the harness's own (`save_research`, `record_fact`) so a prompt that names them works over any
// front end; the harness's session-bound copies (`harness/plan-tools.ts`) replace these in its own server.
const SAVE_RESEARCH_MCP_ARGS = z.object({
  project: projectField,
  title: z.string().describe("What the note is about, e.g. 'Grape prices, 1919'. Becomes the file name."),
  note: z.string().describe("The finding, in your own words: the checkable facts and what they mean for the story."),
  sources: z.array(z.string()).describe("Where each fact came from: URLs or full citations. At least one."),
  items: z.array(z.number().int().positive()).optional().describe("The research checklist item numbers this note sources (research/checklist.md)."),
});

const RECORD_FACT_MCP_ARGS = z.object({
  project: projectField,
  fact: z.string().describe("The fact, in one sentence."),
  where: z
    .string()
    .regex(/^[a-z0-9][a-z0-9/_.-]*$/i)
    .refine((w) => !w.includes(".."), "where must stay inside the work")
    .optional()
    .describe("`continuity` or a bible file (`places`, `bible/places.md`). Ignored when promote is true."),
  kind: z.string().describe("researched (needs a source citation), invented or author."),
  source: z.string().optional().describe("The citation for a researched fact."),
  heading: z.string().optional().describe("The `## ` heading of the section to file under (default: the end of the file)."),
  chapter: z.string().optional().describe("An optional chapter tag, e.g. ch03."),
  promote: z.boolean().optional().describe("File the fact in facts.md instead (the story core's facts every output honours); needs established_by."),
  established_by: z
    .string()
    .regex(/^[a-z][a-z0-9-]*\/[a-z]{2}\d+$/)
    .optional()
    .describe("With promote: the output and unit that established the fact, e.g. novel/ch03 or radio/ep05."),
});

const SAVE_RESEARCH_MCP: McpToolSpec = {
  name: "save_research",
  description:
    "Save a research finding with its sources to the work's research/ notes (research/<slug>.md, with the retrieval date), on a new plan/ branch the author reviews. At least one source is required. The writer model never sees these notes; distilled facts are what reach a draft.",
  args: SAVE_RESEARCH_MCP_ARGS,
  run: async (raw, ctx) => {
    const args = SAVE_RESEARCH_MCP_ARGS.parse(raw);
    const resolved = resolveVerbProject(ctx, args.project);
    if (!resolved.ok) return resolved.result;
    return saveResearchInProject(resolved.projectPath, { title: args.title, note: args.note, sources: args.sources }, ctx.env, args.items ?? []);
  },
};

// AGT-2111 (D-9): the research checklist as MCP tools, so any agent knows what still needs researching.
const PLAN_RESEARCH_MCP_ARGS = z.object({ project: projectField });

const PLAN_RESEARCH_MCP: McpToolSpec = {
  name: "plan_research",
  description:
    "Derive the work's research checklist (research/checklist.md) from its period brief (people, places, technology, language, daily life, politics, dates) or, on a nonfiction work, its thesis (the claims to support), on a new plan/ branch the author reviews. Existing items are kept; new ones are appended. The research gate passes only once every item is sourced (save_research with items, or link_research_item) or waived (waive_research_item); status and resume list the open ones.",
  args: PLAN_RESEARCH_MCP_ARGS,
  run: async (raw, ctx) => {
    const args = PLAN_RESEARCH_MCP_ARGS.parse(raw);
    const resolved = resolveVerbProject(ctx, args.project);
    if (!resolved.ok) return resolved.result;
    return planChecklist(resolved.projectPath, ctx.env, { researcher: ctx.researcher, stderr: ctx.stderr });
  },
};

const WAIVE_RESEARCH_ITEM_MCP_ARGS = z.object({
  project: projectField,
  item: z.number().int().positive().describe("The checklist item's number."),
  reason: z.string().min(1).describe("Why the item needs no research."),
});

const WAIVE_RESEARCH_ITEM_MCP: McpToolSpec = {
  name: "waive_research_item",
  description: "Waive one research checklist item with a reason (research/checklist.md), on a new plan/ branch the author reviews. A waived item no longer holds the research gate shut.",
  args: WAIVE_RESEARCH_ITEM_MCP_ARGS,
  run: async (raw, ctx) => {
    const args = WAIVE_RESEARCH_ITEM_MCP_ARGS.parse(raw);
    const resolved = resolveVerbProject(ctx, args.project);
    if (!resolved.ok) return resolved.result;
    return waiveChecklistItem(resolved.projectPath, String(args.item), args.reason, ctx.env);
  },
};

const LINK_RESEARCH_ITEM_MCP_ARGS = z.object({
  project: projectField,
  item: z.number().int().positive().describe("The checklist item's number."),
  note: z.string().min(1).describe("The research note's id: its path under research/ without .md."),
});

const LINK_RESEARCH_ITEM_MCP: McpToolSpec = {
  name: "link_research_item",
  description:
    "Mark one research checklist item sourced by an existing research note that has a ## Sources entry (the note's id joins the item's Sources), on a new plan/ branch the author reviews. To save a new finding for an item, use save_research with items instead.",
  args: LINK_RESEARCH_ITEM_MCP_ARGS,
  run: async (raw, ctx) => {
    const args = LINK_RESEARCH_ITEM_MCP_ARGS.parse(raw);
    const resolved = resolveVerbProject(ctx, args.project);
    if (!resolved.ok) return resolved.result;
    return linkChecklistItem(resolved.projectPath, String(args.item), args.note, ctx.env);
  },
};

const DISTILL_FACTS_MCP_ARGS = z.object({ project: projectField });

const DISTILL_FACTS_MCP: McpToolSpec = {
  name: "distill_facts",
  description:
    "Distil the work's research/ notes into short, sourced period facts in facts/period.md (one fact per row with the research note it came from and an optional story date), on a new plan/ branch the author reviews. These facts, never the raw notes, are what reach a draft. A fact with no existing source note is rejected. On a work with realNames: false, research names are swapped for the bible's invented ones mapped in research/names.md, and a name with no mapping refuses the run, listing the names to map.",
  args: DISTILL_FACTS_MCP_ARGS,
  run: async (raw, ctx) => {
    const args = DISTILL_FACTS_MCP_ARGS.parse(raw);
    const resolved = resolveVerbProject(ctx, args.project);
    if (!resolved.ok) return resolved.result;
    return distillFactsInProject(resolved.projectPath, ctx.env, { researcher: ctx.researcher, stderr: ctx.stderr });
  },
};

const RECORD_FACT_MCP: McpToolSpec = {
  name: "record_fact",
  description:
    "Record a fact on a new plan/ branch for the author to review: where is `continuity` or a bible file (`places`, `bible/places.md`); kind is researched (needs a source citation), invented or author. With promote true the fact goes to facts.md instead (where is ignored) and needs established_by, the output and unit that established it (`novel/ch03`, `radio/ep05`).",
  args: RECORD_FACT_MCP_ARGS,
  run: async (raw, ctx) => {
    const args = RECORD_FACT_MCP_ARGS.parse(raw);
    const resolved = resolveVerbProject(ctx, args.project);
    if (!resolved.ok) return resolved.result;
    return recordFactInProject(
      resolved.projectPath,
      {
        fact: args.fact,
        where: args.where ?? "",
        kind: args.kind,
        ...(args.source !== undefined ? { source: args.source } : {}),
        ...(args.heading !== undefined ? { heading: args.heading } : {}),
        ...(args.chapter !== undefined ? { chapter: args.chapter } : {}),
        ...(args.promote === true ? { promote: true } : {}),
        ...(args.established_by !== undefined ? { establishedBy: args.established_by } : {}),
      },
      ctx.env,
    );
  },
};

// ---------------------------------------------------------------------------
// bind
// ---------------------------------------------------------------------------

const BIND_ARGS = z.object({
  project: projectField,
  role: z.string().describe('A role from a script\'s `CAST:` line, e.g. "CORA".'),
  voice: z.string().describe("A voice slug in the shared library (<vault>/casting/voices/<slug>/card.json). Refused when absent or retired."),
});

/**
 * AGT-1680: bind a role to a library voice. `cast.json` pins the card's hash and records `by: "manual"`, so a
 * voice recast later is noticed instead of silently changing under the story.
 */
async function runBindVerb(args: z.infer<typeof BIND_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;
  return radioBind({ env: ctx.env, stderr: ctx.stderr }, ctx.casting ?? realCastingDeps(ctx.env), resolved.vaultRoot, resolved.projectPath, args);
}

// ---------------------------------------------------------------------------
// migrate (AGT-1533)
// ---------------------------------------------------------------------------

const MIGRATE_ARGS = z.object({
  sub: z
    .enum(["lines", "outputs", "track"])
    .describe(
      "The migration to run: `lines` splits chapters to one sentence per line; `outputs` turns a `format: novel` work into a story core plus a novel output (pablo.json `outputs`, outputs/novel/, outline/beats.md, facts.md); `track` writes `--track` into pablo.json.",
    ),
  project: projectField,
  track: z
    .string()
    .optional()
    .describe("`migrate track` only: the track to write into pablo.json (fiction, historical-fiction or nonfiction)."),
  "dry-run": z.boolean().optional().default(false).describe("List the paths that would change; write and commit nothing."),
});

async function runMigrateVerb(args: z.infer<typeof MIGRATE_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;

  const outcome =
    args.sub === "track"
      ? migrateTrack(resolved.vaultRoot, resolved.projectPath, { track: args.track, dryRun: args["dry-run"] })
      : args.sub === "outputs"
        ? migrateOutputs(resolved.vaultRoot, resolved.projectPath, { dryRun: args["dry-run"] })
        : migrateLines(resolved.vaultRoot, resolved.projectPath, { dryRun: args["dry-run"] });
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
  const outcome = await mergeDraftInProject(resolved.projectPath, args.branch, ctx.env, ctx.extractor);
  return { body: outcome.body, exitCode: outcome.exitCode };
}

// ---------------------------------------------------------------------------
// publish (AGT-1534)
// ---------------------------------------------------------------------------

const PUBLISH_ARGS = z.object({
  project: projectField,
  target: z
    .string()
    .describe(
      "The publish target, by output: novel and story draft|review|final (one compiled markdown file under .pablo/out/; the novel's review numbers each source line, and its final also writes an .epub); radio bundle|player|stream (bundle: every episode's script plus its newest mixed audio and manifest in one directory, .pablo/out/<slug>-radio-bundle/; player is `pablo review`; stream: each episode's newest mixed audio and manifest, with its time to first audio, in the listening directory .pablo/out/stream/ where the review player finds it).",
    ),
  output: outputField.optional(),
});

/**
 * `publish [--output <type>] --target T` for the CLI and the verb alike: the
 * addressed output's own publish targets (AGT-1669). Success is `{ok,
 * output, target, where, chapters, words}`; an output that does not resolve
 * is a refusal naming the work's outputs.
 */
export function publishOutput(projectPath: string, target: string | undefined, output: string | undefined): VerbResult {
  const marker = readMarker(projectPath);
  if (!marker.ok) return { body: refusalBody(marker), exitCode: marker.code };
  const resolved = resolveOutput(marker.marker.outputs, output, "publish", trackOf(marker.marker));
  if (!resolved.ok) return outputRefusalBody(resolved);
  const outcome = resolved.output.publish.run(projectPath, marker.marker.slug, marker.marker.title, target);
  if (!outcome.ok) return { body: refusalBody(outcome), exitCode: outcome.code };
  return {
    body: {
      ok: true,
      output: resolved.output.id,
      target: outcome.target,
      where: outcome.where,
      chapters: outcome.chapters,
      words: outcome.words,
      ...(outcome.files !== undefined ? { files: outcome.files } : {}),
      ...(outcome.notes !== undefined ? { notes: outcome.notes } : {}),
    },
    exitCode: 0,
  };
}

async function runPublishVerb(args: z.infer<typeof PUBLISH_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;
  return publishOutput(resolved.projectPath, args.target, args.output);
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
const voiceRuleTextField = z.string().describe("The rule, one line: written as a bullet under the target's `## Rules` section.");
const voiceRuleExampleField = z
  .string()
  .describe('The sentences the rule came from, verbatim: written under the bullet as `Flagged: "<example>"`, so `check` catches them (style/prose.md only).');
const voiceRuleTargetField = z
  .string()
  .describe(
    "Where the rule goes: `voice` (default) is the voice's own rules file (style/prose.md for fiction); or a layer: `global` (the global default voice), `vault` (style/prose.md), `work` (the work's STYLE.md, needs `project`), `output:<type>` (that output's RULES.md, needs `project`).",
  );
const voiceRuleIdField = z.string().describe("A rule's id, as `voice list` shows it (six hex digits).");
const voiceRuleProjectField = z.string().describe("The work's slug; needed for targets work and output:<type>, and for use.");
const voiceFileField = z.string().describe("The piece to keep, copied verbatim.");
const voiceTitleField = z.string().describe("The title to file it under (else its first `# ` heading, else its filename).");

const VOICE_ARGS = z.object({
  sub: z
    .enum(["new", "list", "show", "flag", "exemplar", "rule", "edit", "remove", "use"])
    .describe(
      "Which voice action: new (scaffold), list (voices and rules with ids), show, flag (record a rejected line), exemplar (keep a piece), rule (add a typed rule), edit (change a rule by id), remove (delete a rule by id), or use (add a named voice to a work).",
    ),
  name: voiceNameField.optional().describe(
    'Voice name, or a path (containing "/" or ending ".md") for a one-off voice. Required for new/show/flag/exemplar/use; for edit/remove it is the rule id; ignored for list.',
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
  text: voiceRuleTextField.optional().describe("voice rule: the rule, one line."),
  example: voiceRuleExampleField.optional().describe("voice rule: the sentences the rule came from, written as a Flagged line under it."),
  target: voiceRuleTargetField.optional().describe(`voice rule/edit/remove: \`voice\` (default for rule) or a layer (${TARGET_USAGE}); for edit/remove it only narrows which file the id is looked up in.`),
  project: voiceRuleProjectField.optional().describe("voice rule/edit/remove/list/use: the work's slug (needed for work, output:<type> and use)."),
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
function resolveVoiceLocationOrRefusal(ctx: Pick<VerbContext, "cwd" | "env">, name: string): VoiceLocationLookup {
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

/**
 * `voice rule` (AGT-1594), the one function behind `pablo voice rule`, `runVoiceVerb`'s `rule` branch and the
 * `voice_rule` MCP tool (and so the compose agent's tool). Over MCP (`ctx.caller === "mcp"`) a path-shaped `name` is
 * bounded to the vault like `voice_flag`'s; the CLI's is author-typed and is not. `target: "work"` resolves `project`
 * to the work's own STYLE.md and ignores `name`'s voice.
 */
export function runVoiceRule(
  args: { readonly name?: string | undefined; readonly text: string; readonly example?: string | undefined; readonly target?: string | undefined; readonly project?: string | undefined },
  ctx: Pick<VerbContext, "cwd" | "env" | "caller">,
): VerbResult {
  const done = (result: ReturnType<typeof addRule>): VerbResult =>
    result.ok
      ? { body: { ok: true, path: result.path, target: result.target, committed: result.committed, ...(result.notice ? { notice: result.notice } : {}) }, exitCode: 0 }
      : { body: refusalBody(result), exitCode: result.code };
  const fail = (message: string): VerbResult => ({ body: { ok: false, code: 2, message, tried: [] }, exitCode: 2 });

  if (args.target !== undefined && args.target !== "voice") {
    const layer = parseLayerTarget(args.target);
    if (layer === undefined) return fail(`pablo: voice rule: --target must be voice or ${TARGET_USAGE} (got "${args.target}")`);
    let projectPath: string | undefined;
    if (layer === "work" || layer.startsWith("output:")) {
      if (args.project === undefined) return fail(`pablo: voice rule: --target ${layer} needs --project <slug>`);
      const resolved = resolveVerbProject(ctx, args.project);
      if (!resolved.ok) return resolved.result;
      projectPath = resolved.projectPath;
    }
    const file = ruleFileFor(layer, { cwd: ctx.cwd, env: ctx.env, projectPath });
    if (!file.ok) return { body: refusalBody(file), exitCode: file.code };
    return done(addRule(undefined, args.text, { file: { path: file.path, target: layer, commit: file.commit }, ...(args.example ? { example: args.example } : {}) }));
  }

  if (args.name === undefined) return fail("pablo: voice rule requires name (or a layer --target)");
  let location: VoiceLocation;
  if (ctx.caller === "mcp") {
    const located = resolveVoiceLocationOrRefusal(ctx, args.name);
    if (!located.ok) return located.result;
    location = located.location;
  } else {
    const resolution = resolveVoice(args.name, { cwd: ctx.cwd, env: ctx.env });
    if (!resolution.ok) return { body: refusalBody(resolution), exitCode: resolution.code };
    location = resolution;
  }
  return done(addRule(location, args.text, { target: "voice", ...(args.example ? { example: args.example } : {}) }));
}

/** The work a rule verb looks in: `--project`, else the work `cwd` is inside, else none. */
function ruleWork(ctx: Pick<VerbContext, "cwd" | "env">, project: string | undefined): { ok: true; projectPath: string | undefined } | { ok: false; result: VerbResult } {
  if (project === undefined) return { ok: true, projectPath: workFromCwd(ctx.cwd) };
  const resolved = resolveVerbProject(ctx, project);
  return resolved.ok ? { ok: true, projectPath: resolved.projectPath } : resolved;
}

/** `voice list`: every voice, and every rule with its id (work and output rules need `--project` or a cwd inside the work). */
export function runVoiceList(args: { readonly project?: string | undefined }, ctx: Pick<VerbContext, "cwd" | "env">): VerbResult {
  const work = ruleWork(ctx, args.project);
  if (!work.ok) return work.result;
  const rules = listRules({ cwd: ctx.cwd, env: ctx.env, projectPath: work.projectPath });
  return { body: { ok: true, voices: listVoices({ cwd: ctx.cwd, env: ctx.env }), rules }, exitCode: 0 };
}

const changedBody = (r: { id: string; target: string; path: string; committed: boolean; notice?: string }) => ({
  ok: true,
  id: r.id,
  target: r.target,
  path: r.path,
  committed: r.committed,
  ...(r.notice ? { notice: r.notice } : {}),
});

/** `voice edit <id> "<text>"` (the new id comes back). */
export function runVoiceEdit(
  args: { readonly id: string; readonly text: string; readonly target?: string | undefined; readonly project?: string | undefined },
  ctx: Pick<VerbContext, "cwd" | "env">,
): VerbResult {
  const work = ruleWork(ctx, args.project);
  if (!work.ok) return work.result;
  const r = editRule(args.id, args.text, { cwd: ctx.cwd, env: ctx.env, projectPath: work.projectPath }, { target: args.target });
  return "code" in r ? { body: refusalBody(r), exitCode: r.code } : { body: changedBody(r), exitCode: 0 };
}

/** `voice remove <id>`. */
export function runVoiceRemove(
  args: { readonly id: string; readonly target?: string | undefined; readonly project?: string | undefined },
  ctx: Pick<VerbContext, "cwd" | "env">,
): VerbResult {
  const work = ruleWork(ctx, args.project);
  if (!work.ok) return work.result;
  const r = removeRule(args.id, { cwd: ctx.cwd, env: ctx.env, projectPath: work.projectPath }, { target: args.target });
  return "code" in r ? { body: refusalBody(r), exitCode: r.code } : { body: changedBody(r), exitCode: 0 };
}

/** `voice use <name> --project <slug>`: adds a named voice to the work's `pablo.json` `voice`. */
export function runVoiceUse(args: { readonly name: string; readonly project?: string | undefined }, ctx: Pick<VerbContext, "cwd" | "env">): VerbResult {
  if (args.project === undefined) return { body: { ok: false, code: 2, message: "pablo: voice use needs --project <slug>", tried: [] }, exitCode: 2 };
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;
  const r = useVoice(args.name, ctx, resolved.projectPath);
  if ("code" in r) return { body: refusalBody(r), exitCode: r.code };
  return { body: { ok: true, voice: r.voice, added: r.added, path: r.path, committed: r.committed, ...(r.notice ? { notice: r.notice } : {}) }, exitCode: 0 };
}

async function runVoiceVerb(args: z.infer<typeof VOICE_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  if (args.sub === "list") return runVoiceList({ project: args.project }, ctx);

  const needs = (what: string): VerbResult => ({ body: { ok: false, code: 2, message: `pablo: voice ${args.sub} requires ${what}`, tried: [] }, exitCode: 2 });
  if (args.sub === "edit") {
    if (args.name === undefined || args.text === undefined) return needs("name (the rule id) and text");
    return runVoiceEdit({ id: args.name, text: args.text, target: args.target, project: args.project }, ctx);
  }
  if (args.sub === "remove") {
    if (args.name === undefined) return needs("name (the rule id)");
    return runVoiceRemove({ id: args.name, target: args.target, project: args.project }, ctx);
  }
  if (args.sub === "use") {
    if (args.name === undefined) return needs("name");
    return runVoiceUse({ name: args.name, project: args.project }, ctx);
  }

  if (args.sub === "rule") {
    if (args.text === undefined) return { body: { ok: false, code: 2, message: "pablo: voice rule requires text" }, exitCode: 2 };
    return runVoiceRule({ name: args.name, text: args.text, example: args.example, target: args.target, project: args.project }, ctx);
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

const VOICE_LIST_MCP_ARGS = z.object({
  project: voiceRuleProjectField.optional().describe("The work's slug, to include its work and output rules (else the work the server's cwd is inside)."),
});

const VOICE_EDIT_MCP_ARGS = z.object({
  id: voiceRuleIdField,
  text: voiceRuleTextField.describe("The rule's new text, one line."),
  target: voiceRuleTargetField.optional().describe("Narrows which file the id is looked up in (only needed when two files hold the same rule)."),
  project: voiceRuleProjectField.optional(),
});

const VOICE_REMOVE_MCP_ARGS = z.object({
  id: voiceRuleIdField,
  target: voiceRuleTargetField.optional().describe("Narrows which file the id is looked up in (only needed when two files hold the same rule)."),
  project: voiceRuleProjectField.optional(),
});

const VOICE_USE_MCP_ARGS = z.object({
  name: z.string().describe("The named voice to add (a voice slug under the vault's voices/ or the global voices directory)."),
  project: z.string().describe("The work's slug."),
});

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

const VOICE_RULE_MCP_ARGS = z.object({
  name: voiceNameField.optional().describe("The voice to write into; not needed when `target` names a layer."),
  text: voiceRuleTextField,
  example: voiceRuleExampleField.optional(),
  target: voiceRuleTargetField.optional(),
  project: voiceRuleProjectField.optional(),
});

async function runVoiceRuleMcp(args: z.infer<typeof VOICE_RULE_MCP_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  return runVoiceRule(args, ctx);
}

async function runVoiceListMcp(args: z.infer<typeof VOICE_LIST_MCP_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  return runVoiceList({ project: args.project }, ctx);
}

async function runVoiceEditMcp(args: z.infer<typeof VOICE_EDIT_MCP_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  return runVoiceEdit(args, ctx);
}

async function runVoiceRemoveMcp(args: z.infer<typeof VOICE_REMOVE_MCP_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  return runVoiceRemove(args, ctx);
}

async function runVoiceUseMcp(args: z.infer<typeof VOICE_USE_MCP_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  return runVoiceUse(args, ctx);
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
    description:
      "Every voice pablo can find (the fiction alias, every vault voice, every global voice) and every rule with its id, per layer (global, vault, named voices, the work's, each output's). Use the ids with voice_edit and voice_remove.",
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
  {
    name: "voice_rule",
    description:
      "Add a rule the author dictated to a voice: a bullet under its `## Rules` section (created if missing; style/prose.md for the fiction voice), committed. `example` adds the sentences it came from as a Flagged line; `target` writes into a layer instead: global, vault, work (the work's STYLE.md) or output:<type> (that output's RULES.md); work and output targets need `project`.",
    args: VOICE_RULE_MCP_ARGS,
    run: runVoiceRuleMcp,
  },
  {
    name: "voice_edit",
    description: "Change one rule's text by its id (from voice_list), keeping its example lines. Returns the rule's new id.",
    args: VOICE_EDIT_MCP_ARGS,
    run: runVoiceEditMcp,
  },
  {
    name: "voice_remove",
    description: "Delete one rule (and its example lines) by its id (from voice_list).",
    args: VOICE_REMOVE_MCP_ARGS,
    run: runVoiceRemoveMcp,
  },
  {
    name: "voice_use",
    description: "Add a named voice to a work's pablo.json `voice` list, so every pack for the work carries it.",
    args: VOICE_USE_MCP_ARGS,
    run: runVoiceUseMcp,
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
  branch: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Land the revision on a `revise/<id>` branch for the author instead of returning the candidate; the result names the branch, file and receipt and never carries the prose. Needs `passage` (not start+end).",
    ),
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

  // AGT-2144: `branch` is what `revise_passage` (now a deprecated alias) did.
  if (args.branch) {
    if (args.passage === undefined || args["dry-run"]) {
      return {
        body: { ok: false, code: 2, message: "pablo: revise with `branch` needs `passage` and cannot be a dry run" },
        exitCode: 2,
      };
    }
    return runRevisePassageVerb({ project: args.project, file: args.file, passage: args.passage, instruction: args.instruction }, ctx);
  }

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
      'A file of the work, relative to it: a bible file ("bible/overview.md"), a chapter ("' +
        OUTPUTS.novel.artifactDir +
        '/01-….md", returned joined into paragraphs), an outline, "continuity.md", or a research note ("research/…"). A directory lists its entries.',
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
// output (AGT-1669) — the work's outputs: list, add, remove, plan
// (`output-verbs.ts`).
// ---------------------------------------------------------------------------

const OUTPUT_ARGS = z.object({
  sub: z
    .enum(["list", "add", "remove", "plan"])
    .describe(
      "list: the work's outputs with units drafted and next step. add <type>: declare the output in pablo.json and scaffold outputs/<type>/ (plan.md, RULES.md), refused until the story core is at beats (on nonfiction, until the core is complete). remove <type>: undeclare it and archive outputs/<type>/ under outputs/_removed/. plan <type>: rewrite outputs/<type>/plan.md from the beats. Each write is one commit.",
    ),
  type: z.string().optional().describe("The output type for add, remove and plan, e.g. \"novel\" or \"radio\"."),
  from: z.string().optional().describe("add narrated: the output the narration reads, a prose output the work has (e.g. \"novel\", \"story\", \"essay\")."),
  thesis: z.string().max(4000).optional().describe("add essay on a fiction or historical-fiction work: the one thing the essay argues about the story; written to outputs/essay/thesis.md with an outline drawn from the story core. Required there unless the file already has one."),
  project: projectField,
  "dry-run": z.boolean().optional().default(false).describe("plan: show the rows; write and commit nothing."),
});

async function runOutputVerb(args: z.infer<typeof OUTPUT_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const resolved = resolveVerbProject(ctx, args.project);
  if (!resolved.ok) return resolved.result;
  const outcome =
    args.sub === "list"
      ? listOutputs(resolved.projectPath)
      : args.sub === "add"
        ? addOutput(resolved.vaultRoot, resolved.projectPath, args.type, { from: args.from, thesis: args.thesis })
        : args.sub === "remove"
          ? removeOutput(resolved.vaultRoot, resolved.projectPath, args.type)
          : planOutput(resolved.vaultRoot, resolved.projectPath, args.type, { dryRun: args["dry-run"] });
  return { body: outcome, exitCode: outcome.ok ? 0 : outcome.code };
}

// AGT-2143 (D-16): over MCP, adding an output is its own tool with a narrow schema, and the `output` tool keeps
// list, remove and plan, so there is one way to add an output, not two. The CLI's `pablo output add` is unchanged.
const OUTPUT_MCP_ARGS = OUTPUT_ARGS.omit({ thesis: true }).extend({
  sub: z
    .enum(["list", "remove", "plan"])
    .describe(
      "list: the work's outputs with units drafted and next step. remove <type>: undeclare it and archive outputs/<type>/ under outputs/_removed/. plan <type>: rewrite outputs/<type>/plan.md from the beats. Each write is one commit. To add an output use output_add.",
    ),
});

const OUTPUT_MCP: McpToolSpec = {
  name: "output",
  description:
    "The work's outputs (novel, story, radio, ...) derived from its story core: `list` them, `remove <type>` (archived under outputs/_removed/, never deleted), or regenerate a type's `plan`. Each write is one commit. Adding one is `output_add`.",
  args: OUTPUT_MCP_ARGS,
  run: async (raw, ctx) => runOutputVerb(OUTPUT_MCP_ARGS.parse(raw), ctx),
};

const OUTPUT_ADD_MCP_ARGS = z.object({
  project: projectField,
  type: z.string().describe('The output type to add, e.g. "story", "novel", "screenplay", "radio", "narrated" or "essay"; the work\'s track decides which it allows.'),
  from: z.string().optional().describe('narrated only: the prose output the narration reads, one the work has (e.g. "novel", "story", "essay").'),
  thesis: z
    .string()
    .max(4000)
    .optional()
    .describe("essay on a fiction or historical-fiction work only: the one thing the essay argues about the story. Ask the author for it; the add is refused without one."),
});

const OUTPUT_ADD_MCP: McpToolSpec = {
  name: "output_add",
  description:
    "Add an output to the work (`pablo output add <type>`): declare it in pablo.json and scaffold outputs/<type>/ (plan.md, RULES.md), in one commit. Refused until the story core is at beats (on nonfiction, until the core is complete), for a type the work's track does not allow, or for one the work already has; the refusal names what is missing.",
  args: OUTPUT_ADD_MCP_ARGS,
  run: async (raw, ctx) => {
    const args = OUTPUT_ADD_MCP_ARGS.parse(raw);
    return runOutputVerb({ sub: "add", type: args.type, from: args.from, thesis: args.thesis, project: args.project, "dry-run": false }, ctx);
  },
};

// ---------------------------------------------------------------------------
// init (AGT-2143): `initWork`, shared with `cli.ts`'s `runInit`
// ---------------------------------------------------------------------------

const INIT_ARGS = z.object({
  output: z
    .string()
    .optional()
    .describe('The output to scaffold the work with: only "novel" today. Omit it, and pass `track`, for a core-only work with no output yet (add one later with output_add).'),
  slug: z.string().optional().describe('The new work\'s slug: lowercase letters, digits and hyphens (e.g. "ice-house").'),
  title: z.string().optional().describe("The new work's title."),
  track: z
    .string()
    .optional()
    .describe("The work's track (fiction, historical-fiction or nonfiction), written to pablo.json with that track's core files. Default: fiction."),
  adopt: z.boolean().optional().default(false).describe("Write only pablo.json into the existing work named by `project`, touching nothing else."),
  project: z.string().optional().describe("adopt: the existing work's slug."),
});

async function runInitVerb(args: z.infer<typeof INIT_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const outcome = initWork(ctx.cwd, ctx.env, args);
  if (!outcome.ok) {
    const body = { ok: false, code: outcome.code, message: outcome.message, ...(outcome.tried === undefined ? {} : { tried: outcome.tried }) };
    return { body, exitCode: outcome.code };
  }
  return { body: initBody(outcome), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// story (AGT-1690): `story.ts`, loaded on first use (it brings the harness)
// ---------------------------------------------------------------------------

const STORY_ARGS = z.object({
  prompt: z.string().optional().describe("What to write, in the author's words. Starts a new work; omit it with `project` to continue a run."),
  output: z
    .array(z.string())
    .optional()
    .describe('Outputs to make from the core, repeatable (e.g. "story", "novel", "radio"). Default: one written output, story or novel by the prompt\'s length cue.'),
  review: z.boolean().optional().default(false).describe("Human in the loop: stop on every stage's branch for the author to accept, then continue with `project`."),
  title: z.string().optional().describe("The work's title (default: a working title from the prompt)."),
  words: z.number().int().positive().optional().describe("The story's length in words (default: the prompt's word cue, else the story output's own)."),
  project: z.string().optional().describe("Continue the `pablo story` run recorded in this work (its slug)."),
  "no-check": WRITE_ARGS.shape["no-check"],
  track: z
    .string()
    .optional()
    .describe(
      "The work's track (fiction or historical-fiction), written to pablo.json with that track's core files. nonfiction is refused: story writes fiction (start a nonfiction work with `pablo init --track nonfiction`). Default: inferred from the prompt by one planner call, historical-fiction when it names a historical period or event, else fiction.",
    ),
});

async function runStoryVerb(args: z.infer<typeof STORY_ARGS>, ctx: VerbContext): Promise<VerbResult> {
  const { runStory } = await import("./story");
  return runStory(args, ctx, {
    ...(ctx.writer === undefined ? {} : { writer: ctx.writer }),
    ...(ctx.extractor === undefined ? {} : { extractor: ctx.extractor }),
  });
}

// ---------------------------------------------------------------------------
// guide (AGT-2142, D-16): the path for a track x output, composed from the registries
// ---------------------------------------------------------------------------

const GUIDE_ARGS = z.object({
  track: z.string().optional().describe("The work's track (fiction, historical-fiction or nonfiction). With no `output`: the outputs that track allows."),
  output: z
    .string()
    .optional()
    .describe('The output to finish, e.g. "novel", "story", "screenplay", "radio", "narrated" or "essay". Without `track`: fiction when it allows the output. Omit both to list the tracks and outputs.'),
});

async function runGuideVerb(args: z.infer<typeof GUIDE_ARGS>): Promise<VerbResult> {
  const body = guide(args);
  return { body, exitCode: body.ok ? 0 : body.code };
}

// ---------------------------------------------------------------------------
// VERBS — the single source of truth `cli.ts` and `mcp.ts` both read
// ---------------------------------------------------------------------------

export const VERBS: readonly Verb[] = [
  {
    name: "guide",
    description:
      "Call this first. The step-by-step path from nothing to a finished piece for a track and an output: create the work, each core stage with the verb that meets it, research where the track gates it, add the output, write, check, publish. With no arguments: the tracks and the outputs each allows. Reads nothing; needs no project.",
    args: GUIDE_ARGS,
    run: runGuideVerb,
  },
  {
    name: "init",
    description:
      "Start a new work in the vault: with `output` \"novel\", `slug` and `title` a novel scaffolded from the vault's template (`track` optional); with `track`, `slug` and `title` and no `output`, a core-only work with its track's core files and no output yet; with `adopt` and `project`, only the marker written into an existing work. One commit (adopt commits nothing). Refuses a bad slug, an unknown track, a work that already exists.",
    args: INIT_ARGS,
    run: runInitVerb,
    positionalArgs: ["output", "slug", "title"],
    // Starting a work is outside any session: an outside agent may do it on the author's word, the harness never.
    harness: false,
  },
  {
    name: "resume",
    description: "The structured session summary an agent picks a project up from: stage per part, last event, open decisions, next step.",
    args: RESUME_ARGS,
    run: runResumeVerb,
  },
  {
    name: "status",
    description:
      "The work in both layers: the story core's stages, then each output's units, or (with `for`, e.g. \"novel 3\") one unit's draft preconditions and which are unmet.",
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
    description:
      "Canonical drafting tool. Draft one unit of an output (`output` and `unit`; `chapter` is the novel's spelling) on the configured writer model: check preconditions, assemble the pack, send, write, receipt (naming output and unit). A work with several outputs needs `output`.",
    args: WRITE_ARGS,
    run: runWriteVerb,
  },
  {
    name: "draft_unit",
    description:
      "Deprecated alias of `write` (kept for one release; use `write` with `output` and `unit`). Draft unit n of an output (e.g. output \"novel\", n 3 is chapter 3) on the configured writer model from its beat, steered by an optional direction. The draft lands on the output's draft branch for the author to review. Returns the branch, path and receipt (naming output and unit), never the prose; read the unit to see it.",
    args: DRAFT_UNIT_ARGS,
    run: runDraftUnitVerb,
  },
  {
    name: "output",
    description:
      "The work's outputs (novel, radio, ...) derived from its story core: `list` them, `add <type>` (pablo.json plus outputs/<type>/ plan.md and RULES.md, once the core is at beats), `remove <type>` (archived under outputs/_removed/, never deleted), or regenerate a type's `plan`. Each write is one commit.",
    args: OUTPUT_ARGS,
    run: runOutputVerb,
    positionalArgs: ["sub", "type"],
    mcpTools: [OUTPUT_MCP, OUTPUT_ADD_MCP],
  },
  {
    name: "story",
    description:
      "Write a story from a prompt, end to end: create the work, build its story core through the harness (research, premise, bible, acts, beats, each on a plan/ branch), then draft, merge and publish each requested output (default: a written story or novel by the prompt's length cue). On demand every branch is accepted as it lands and the harness's questions are answered by stated assumptions; with `review` the run stops on each branch and `project` resumes it.",
    args: STORY_ARGS,
    run: runStoryVerb,
    positionalArgs: ["prompt"],
    // AGT-2143: an MCP tool, so an outside agent can start a work on the author's
    // word. Never one of the harness's own tools: a run drafts prose through the
    // whole pipeline, accepts its own branches and starts its own harness session.
    harness: false,
  },
  {
    name: "draft_chapter",
    description:
      "Deprecated alias of `write` (kept for one release; use `write` with `chapter`). Draft chapter n on the configured writer model from its beat, steered by an optional direction such as \"slower, stay on Cora\". The draft lands on a draft/chNN branch for the author to review. Returns the branch, path and receipt, never the prose; read the chapter to see it.",
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
    description:
      "Scan a work's chapters for mechanical tells (em-dashes, curly quotes, flagged phrases) and provenance gaps. With `output` it adds the core check under `core`: story-time (a mention dated after the unit's year) and names the bible, facts.md and the output's own ledger do not know. With `across` it instead compares every output's continuity ledger and reports contradictions between tellings, each with a promote action. On a work with radio scripts it also reports directions outside the vocabulary (with line numbers) and roles with no voice, under `radio`. On a historical-fiction work it also reports `anachronism` hits (a word out of the period in bible/period.md, with why and the period it belongs to), verdicts cached in facts/lexicon.json. With `output` on a historical-fiction work it also runs fact-accuracy: each draft sentence a distilled period fact in facts/period.md contradicts is a `fact-accuracy` hit quoting the sentence, the fact and its source note (summary under `factAccuracy`). `unit` narrows it to one unit of the output.",
    args: CHECK_ARGS,
    run: runCheckVerb,
  },
  {
    name: "promote",
    description:
      "Promote one side of a `check --across` finding: its fact goes to facts.md (the story core's facts every output honours) with established-by, on a plan/ branch for review, and each contradicting unit gets a comment on its line there.",
    args: PROMOTE_ARGS,
    run: runPromoteVerb,
  },
  {
    name: "research",
    description:
      "`research save`: keep a research finding with its sources and retrieval date as research/<slug>.md, on a new plan/ branch for the author to review. At least one source is required (--source, repeatable). Over MCP this is the `save_research` tool. `research distill`: turn research/ into short, sourced period facts in facts/period.md on a plan/ branch (real names swapped for the bible's when the work sets realNames: false); over MCP the `distill_facts` tool. `research plan`: derive research/checklist.md from the period brief or thesis (`plan_research`); `research waive <#> \"<reason>\"` (`waive_research_item`) and `research link <#> <note>` (`link_research_item`) close an item, as does `research save --item <#>`; the research gate passes once every item is sourced or waived.",
    args: RESEARCH_ARGS,
    run: runResearchVerb,
    positionalArgs: ["sub", "entry", "text"],
    mcpTools: [SAVE_RESEARCH_MCP, DISTILL_FACTS_MCP, PLAN_RESEARCH_MCP, WAIVE_RESEARCH_ITEM_MCP, LINK_RESEARCH_ITEM_MCP],
  },
  {
    name: "fact",
    description:
      "`fact record`: append one fact, tagged researched (a source is required), invented or author, to a bible file or continuity.md (or, with --promote, facts.md) on a new plan/ branch for the author to review. Over MCP this is the `record_fact` tool.",
    args: FACT_ARGS,
    run: runFactVerb,
    positionalArgs: ["sub"],
    mcpTools: [RECORD_FACT_MCP],
  },
  {
    name: "bind",
    description:
      "Bind a radio script's role to a voice in the shared library: writes the role, the voice's slug and its card hash into the work's cast.json (by: manual). Refuses a voice that is not in the library or is retired.",
    args: BIND_ARGS,
    run: runBindVerb,
  },
  {
    name: "migrate",
    description:
      "One-time migrations of a project. `lines` splits " +
      OUTPUTS.novel.artifactDir +
      "/*.md to one sentence per line (frontmatter untouched) and commits exactly those files. `outputs` rewrites pablo.json's `format` to `outputs.novel`, creates outputs/novel/ (plan.md, RULES.md), moves continuity.md to outputs/novel/continuity.md and outline/chapters.md to outline/beats.md, creates facts.md, and commits exactly those paths. `track` (with `--track <id>`) writes `track` into pablo.json and commits exactly that file, reporting the new core stages the work lacks. All are idempotent; `dry-run` lists what would change.",
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
    // AGT-2143 (D-16): an MCP tool, so an outside agent can accept a draft once
    // the author says so. Merging stays the author's review gate inside pablo:
    // the harness's own agent is never offered it (it must not land its own
    // draft); the author accepts there in the screen.
    harness: false,
  },
  {
    name: "publish",
    description:
      "Publish one of the work's outputs to a target. The novel and the story compile into one markdown file (frontmatter stripped, sentence lines joined into paragraphs, quotes curled) under .pablo/out/; the radio output's bundle copies every episode's script and, for each mixed episode, its audio and manifest into one directory (episodes not yet mixed are listed in notes); its stream target publishes each mixed episode (newest version's audio and manifest, with its time to first audio) to the listening directory .pablo/out/stream/, where the review player finds it.",
    args: PUBLISH_ARGS,
    run: runPublishVerb,
  },
  {
    name: "voice",
    description:
      "Find, scaffold, grow, or inspect a named voice directory: `new` scaffolds one, `list` finds every one, `show` reads one as a model would see it, `flag` records a rejected line, `exemplar` keeps a piece as-is, `rule` adds a typed rule.",
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
    positionalArgs: ["text"],
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
      "Canonical revision tool (`branch: true` lands the result on a revise/ branch instead of returning it). Send one located passage of a manuscript to the configured writer model and return a candidate: locate it (by quoted text or a start/end offset pair), assemble the pack with the project's own style and work rules, send once, and return {candidate, span, receipt} — never writes the file.",
    args: REVISE_ARGS,
    run: runReviseVerb,
  },
  {
    name: "revise_passage",
    description:
      "Deprecated alias of `revise` with `branch: true` (kept for one release). Revise one passage of a chapter on the configured writer model following an instruction such as \"tighten, keep the dread\". The revision lands on a revise/<id> branch for the author to review. Returns the branch, file and receipt, never the prose; read the branch to see it.",
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
  // AGT-2126 (D-11): `web_search` and `web_fetch`, agent-facing only (web-tools.ts); the entry has no CLI form.
  {
    name: "web",
    description: "Agent tools `web_search` (the configured search backend) and `web_fetch` (one page as markdown, with its URL and retrieval date). No CLI command.",
    args: z.object({}),
    run: runWebVerb,
    mcpTools: [WEB_SEARCH_TOOL, WEB_FETCH_TOOL],
  },
  // AGT-1679: `audition`, `cast`, `voices` — the voice library (casting-verbs.ts).
  ...castingVerbs(),
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

/**
 * AGT-1679: the args object a verb's `run` takes, built from the CLI's parsed
 * `values` and positionals: positional fields (`positionalArgs`, in order)
 * from `rest`, every other field from its flag, and a numeric field's flag
 * text turned into a number (`parseArgs` only knows strings). The verb's own
 * zod shape validates the result, so a CLI call and an MCP call of the same
 * verb are checked by the same schema. Used by `cli.ts` for the verbs it
 * dispatches generically (the casting verbs).
 */
export function verbArgsFromCli(
  verb: Verb,
  values: Readonly<Record<string, unknown>>,
  rest: readonly string[],
): { readonly ok: true; readonly args: unknown } | { readonly ok: false; readonly message: string } {
  const positional = verb.positionalArgs ?? [];
  const raw: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(verb.args.shape)) {
    const index = positional.indexOf(key);
    const value = index >= 0 ? rest[index] : values[key];
    if (value === undefined) continue;
    const { base } = unwrapToBase(schema as z.ZodTypeAny);
    if (base instanceof z.ZodNumber && typeof value === "string") {
      const number = Number(value);
      if (value.trim() === "" || !Number.isFinite(number)) return { ok: false, message: `pablo ${verb.name}: --${key} must be a number (got "${value}")` };
      raw[key] = number;
    } else {
      raw[key] = value;
    }
  }
  const parsed = verb.args.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "args"}: ${issue.message}`).join("; ");
    return { ok: false, message: `pablo ${verb.name}: ${issues}` };
  }
  return { ok: true, args: parsed.data };
}
