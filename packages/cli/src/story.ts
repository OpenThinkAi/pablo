/**
 * `pablo story "<prompt>"` (AGT-1690, pm project `pablo-story-core`, "`pablo
 * story` and on demand"; pablo-casting decision 6c): the harness run end to
 * end. It creates a work under the vault (`stories/` for a written story,
 * `novels/` when a novel is asked for: the category is the output kind),
 * builds its story core stage by stage (research -> premise -> bible -> acts
 * -> beats, each stage one harness message whose writes land on its own
 * `plan/` branch), then runs each requested output's units through that
 * output's machine (`output add`, `write`, merge with the after-write
 * rituals) and publishes it through the output's first publish target.
 *
 * Two modes, one code path:
 *
 *  - on demand (default): every `plan/` and draft branch is accepted as soon
 *    as it lands, and `ask_author` is answered with an instruction to proceed
 *    on a stated assumption (each question is kept in the run's
 *    `assumptions`), so the run needs nobody;
 *  - `--review`: every stage stops on its branch. The run returns `waiting`
 *    naming the branch; the author accepts it in review mode (or `pablo
 *    merge` for a draft) and `pablo story --project <slug>` resumes. A branch
 *    that was dropped instead of merged is run again.
 *
 * The run's progress is `.pablo/story.json` in the work (machine state, never
 * committed), so a stopped or failed run resumes where it was.
 *
 * Output types: the default is one written output, `story` or `novel` by the
 * prompt's length cue (`defaultOutput`); `--output <type>` is repeatable. A
 * requested type the registry does not list, or one whose `ensure()` says it
 * cannot run here (an unprovisioned radio), is refused by name before
 * anything is written. A type that is not requested is never ensured.
 *
 * Every model call keeps its receipt in `<work>/.pablo/receipts.jsonl`
 * naming its `output` and `unit` (drafts and continuity extraction); the
 * harness's planning calls are Claude's and are not pablo receipts.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createProviders, loadConfig, receiptsPath } from "@openthink/pablo-core";
import type { Adapter, Intent, KeyLookup, LoadConfigOptions } from "@openthink/pablo-core";
import { branchExists, deleteBranch, mergeBranch, repoRoot } from "./branch";
import { coreStages, readCoreState } from "./core/machine";
import { ensureGitignoreEntry, gitCommit, SLUG_PATTERN } from "./init";
import { DEFAULT_AUTHOR, DEFAULT_NEVER_SEND, DEFAULT_PUBLISH, DEFAULT_VOICE, readMarker, writeMarker } from "./marker";
import { FACTS_TEXT } from "./migrate-outputs";
import { mergeDraft } from "./novel/merge";
import { addOutput } from "./output-verbs";
import { slugify } from "./outputs/novel/units";
import { outputDefinition, outputIds } from "./outputs/registry";
import type { OutputDefinition } from "./outputs/types";
import { startPlanSession } from "./plan";
import { findVault, resolveProject } from "./project";
import type { AskAuthor } from "./harness/ask-author";
import { harnessAuth } from "./harness/auth";
import type { HarnessAuth } from "./harness/auth";
import { planTools } from "./harness/plan-tools";
import { loadPromptWork } from "./harness/prompt";
import { runHarness, sdkQuery } from "./harness/session";
import type { HarnessQuery } from "./harness/session";
import { harnessTools } from "./harness/tools";
import { transcriptEntries } from "./harness/transcript";
import { captureConsoleLog, withWriteLock } from "./verbs";
import type { VerbContext, VerbResult } from "./verbs";
import { runWrite } from "./write";

/** The core stages `pablo story` runs, in order: each is one harness message and, when it writes, one `plan/` branch. */
export const STORY_CORE_STAGES = ["research", "premise", "bible", "acts", "beats"] as const;
export type StoryCoreStage = (typeof STORY_CORE_STAGES)[number];

/** A prompt asking for this many words or more is a novel; fewer is a story. */
export const NOVEL_WORDS = 20_000;

const STORY_CUE = /\b(short story|short fiction|flash fiction|vignette|bedtime story|fable|parable)\b/i;
const NOVEL_CUE = /\b(novels?|novella|book|saga|trilogy|chapters)\b/i;
const WORDS_CUE = /\b(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?[\s-]*words?\b/i;

/** The word count a prompt asks for (`a 1,500-word story`, `80k words`), or undefined. */
export function wordsCue(prompt: string): number | undefined {
  const m = WORDS_CUE.exec(prompt);
  if (m === null) return undefined;
  const n = Number((m[1] as string).replace(/,/g, "")) * (m[2] === undefined ? 1 : 1000);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined;
}

/**
 * The default written output for a prompt (decided 2026-10-10, #4): `story` for
 * a short piece or when the cue is unclear, `novel` when the prompt asks for a
 * novel or book, or for `NOVEL_WORDS` words or more.
 */
export function defaultOutput(prompt: string): "story" | "novel" {
  if (STORY_CUE.test(prompt)) return "story";
  const words = wordsCue(prompt);
  if (words !== undefined) return words >= NOVEL_WORDS ? "novel" : "story";
  return NOVEL_CUE.test(prompt) ? "novel" : "story";
}

/** A working title from the prompt: its first clause, at most eight words, capitalised. */
export function titleFromPrompt(prompt: string): string {
  const clause = (prompt.split(/[.;:!?\n]/)[0] ?? prompt).trim();
  const words = clause.split(/\s+/).filter((w) => w !== "").slice(0, 8).join(" ");
  const title = words === "" ? "Untitled story" : words;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export interface StoryArgs {
  /** The request, in the author's words. Required to start a run; absent when resuming with `project`. */
  readonly prompt?: string | undefined;
  /** `--output <type>`, repeatable. Absent: one written output by the prompt's length cue. */
  readonly output?: readonly string[] | undefined;
  /** `--review`: stop on every stage's branch for the author. */
  readonly review?: boolean | undefined;
  /** The work's title; absent, a working title from the prompt. */
  readonly title?: string | undefined;
  /** The length of a single-unit output (the story); absent, the prompt's word cue, else the type's default. */
  readonly words?: number | undefined;
  /** Resume the run recorded in this work. */
  readonly project?: string | undefined;
}

/** What a test injects so no model runs: the harness, the writer, the extractor, the author. */
export interface StoryDeps {
  /** The harness session (the Agent SDK's `query`); a fake in tests. */
  readonly query?: HarnessQuery;
  /** The writer units are drafted with; absent, the routed drafting provider (`write`). */
  readonly writer?: Adapter;
  /** The continuity extractor the merge rituals run; absent, the routed extraction provider. */
  readonly extractor?: Adapter;
  /** The harness's credentials; absent, read from pablo's config the way `pablo agent` does. */
  readonly auth?: HarnessAuth;
  readonly keys?: Partial<KeyLookup>;
  readonly readConfig?: LoadConfigOptions["readFile"];
  /** `--review`'s `ask_author`: the front end's question card. Absent, review runs answer by assumption too. */
  readonly ask?: AskAuthor;
  readonly now?: () => Date;
}

/** A question the harness put to an absent author, answered by assumption. */
export interface StoryAssumption {
  readonly stage: string;
  readonly question: string;
  readonly why: string;
  readonly options: readonly string[];
}

interface DraftRecord {
  readonly unit: number;
  readonly branch: string;
  readonly path: string;
  /** The merge commit on `main` (absent in review mode, where the author merges). */
  readonly merged?: string;
}

interface StoryState {
  readonly version: 1;
  readonly prompt: string;
  readonly outputs: readonly string[];
  review: boolean;
  readonly words?: number;
  readonly started: string;
  /** Steps finished: `core:<stage>`, `output:<type>`, `draft:<type>:<unit>`, `publish:<type>`. */
  done: string[];
  /** The branch a review run waits on. */
  pending?: { readonly step: string; readonly branch: string; readonly sha: string };
  plan: { readonly stage: string; readonly branch: string; readonly merged?: string }[];
  drafts: Record<string, DraftRecord[]>;
  published: Record<string, { readonly target: string; readonly where: string; readonly words: number }>;
  assumptions: StoryAssumption[];
  finished?: boolean;
}

const STATE_FILE = join(".pablo", "story.json");

function refuse(message: string, missing?: readonly string[]): VerbResult {
  return { body: { ok: false, code: 2, message, ...(missing === undefined ? {} : { missing }) }, exitCode: 2 };
}

function fail(message: string, extra: Record<string, unknown> = {}): VerbResult {
  return { body: { ok: false, code: 1, message, ...extra }, exitCode: 1 };
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function readState(work: string): StoryState | undefined {
  const path = join(work, STATE_FILE);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StoryState;
  } catch {
    return undefined;
  }
}

function saveState(work: string, state: StoryState): void {
  mkdirSync(join(work, ".pablo"), { recursive: true });
  writeFileSync(join(work, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { stdio: "pipe", encoding: "utf8" }).trim();
}

function isMerged(repo: string, sha: string): boolean {
  try {
    execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", sha, "main"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuses, by name and before anything is written, a requested output the
 * registry does not list or whose `ensure()` says it cannot run here. Only
 * the requested types are looked at: an unrequested type's `ensure` is never
 * called.
 */
async function ensureOutputs(outputs: readonly string[]): Promise<VerbResult | undefined> {
  for (const id of outputs) {
    const def = outputDefinition(id);
    if (def === undefined) {
      return refuse(`pablo: story: there is no ${id} output on this machine (pablo has: ${outputIds().join(", ")}); nothing was written`, [`output ${id}`]);
    }
    if (def.ensure !== undefined) {
      const ready = await def.ensure();
      if (!ready.ok) return refuse(`pablo: story: the ${id} output cannot run on this machine (${ready.message}); nothing was written`, ready.missing ?? [`output ${id}`]);
    }
  }
  return undefined;
}

/** The core files a new work starts with: empty sections the core stages fill, and no output's units (`output add` scaffolds those). */
function scaffold(title: string, prompt: string, date: string): Record<string, string> {
  return {
    "README.md": `# ${title}\n\nAsked for on ${date}:\n\n> ${prompt.replace(/\n/g, "\n> ")}\n\n## Where things stand\n\n- ${date}: created by \`pablo story\`.\n`,
    "QWEN.md": `# ${title}: the work's rules\n\n## Ground rules\n\n- Tell the story the request asks for, in the vault's voice.\n`,
    "bible/overview.md": "# Overview\n\n## Logline\n\n## Premise\n\n## Themes\n\n## Tone\n\n## Structure\n",
    "bible/places.md": "# Places\n",
    "bible/timeline.md": "# Timeline\n\n| Year | Real events | In the story |\n|---|---|---|\n",
    "bible/characters/.keep": "",
    "outline/beats.md": "# Outline\n",
    "facts.md": FACTS_TEXT,
    "research/.keep": "",
    "notes/.keep": "",
  };
}

/** The first free slug for `title` across every category of the vault. */
function freeSlug(vault: string, title: string): string {
  const base = slugify(title).split("-").slice(0, 6).join("-") || "story";
  const stem = SLUG_PATTERN.test(base) ? base : "story";
  let slug = stem;
  for (let n = 2; resolveProject(vault, slug).ok; n += 1) slug = `${stem}-${n}`;
  return slug;
}

const STAGE_TEXT: Readonly<Record<StoryCoreStage, string>> = {
  research:
    "Stage 1 of 5, research. Find what this story needs to be true to (its period, place, work and practice) and keep each finding with save_research, with its sources. If the request needs no research (pure invention), save nothing and say so. Propose nothing yet.",
  premise:
    'Stage 2 of 5, premise. Read the research notes (read, search) and propose the premise with propose (stage "premise"): bible/overview.md with ## Logline (one or two sentences), ## Premise, ## Themes, ## Tone and ## Structure.',
  bible:
    'Stage 3 of 5, bible. Propose the cast (propose stage "cast", one character per call, with a lowercase-hyphen name) and the places (stage "places"), and the timeline (stage "timeline": a | Year | Real events | In the story | table with a row for every year a beat will be set in). Record any other fact the story stands on with record_fact, tagged researched with its source, or invented.',
  acts: 'Stage 4 of 5, acts. Propose the acts table with propose (stage "acts"): rows of | Act | Years | What it accomplishes |.',
  beats:
    'Stage 5 of 5, beats. Propose the beats with propose (stage "beats"): one row per story unit, | # | Story date | Title (working) | Beat | POV | Status |, status "outline".',
};

const ON_DEMAND =
  "This is an on-demand run: nobody reviews the stages as they land. When a call is the author's, ask_author answers with an instruction to assume: make the most plausible choice, state it as an assumption (record_fact, kind invented), and continue.";
const REVIEW_MODE = "This is a review run: the author reviews this stage's plan branch before the next stage starts. Use ask_author only for what you cannot reasonably assume.";

/** The harness message for one core stage. */
export function stageMessage(stage: StoryCoreStage, state: Pick<StoryState, "prompt" | "outputs" | "review">, title: string, slug: string): string {
  const length =
    stage === "beats"
      ? state.outputs.includes("novel")
        ? " The story is told as a novel too: one beat per chapter."
        : " The story is a short piece: three to six beats."
      : "";
  return [
    `pablo story: "${title}" (${slug}), from the request:`,
    "",
    `> ${state.prompt.replace(/\n/g, "\n> ")}`,
    "",
    `${STAGE_TEXT[stage]}${length}`,
    "",
    state.review ? REVIEW_MODE : ON_DEMAND,
  ].join("\n");
}

/** On-demand `ask_author`: nobody is there, so every question is answered with "assume, and say so", and kept. */
function assumingAsk(stage: string, kept: StoryAssumption[]): AskAuthor {
  return async (q) => {
    kept.push({ stage, question: q.question, why: q.why, options: [...q.options] });
    const suggestion = q.options[0] === undefined ? "" : ` (for instance "${q.options[0]}")`;
    return `No author is available in this on-demand run. Choose the most plausible answer${suggestion}, state it as an assumption (record_fact, kind invented), and continue.`;
  };
}

/** The intent continuity extraction routes under, as `merge` routes it. */
const CONTINUITY_INTENT: Intent = { name: "continuity", kind: "extraction" };

interface Run {
  readonly vault: string;
  readonly repo: string;
  readonly work: string;
  readonly slug: string;
  readonly title: string;
  readonly state: StoryState;
  readonly ctx: VerbContext;
  readonly deps: StoryDeps;
}

function waiting(run: Run, step: string, branch: string): VerbResult {
  return {
    body: {
      ok: true,
      project: run.slug,
      path: run.work,
      waiting: { step, branch },
      next: `accept ${branch} in review mode${branch.startsWith("draft/") ? ` (or \`pablo merge ${branch} --project ${run.slug}\`)` : ""}, then run \`pablo story --project ${run.slug}\``,
      done: run.state.done,
      assumptions: run.state.assumptions,
    },
    exitCode: 0,
  };
}

function markDone(run: Run, step: string): void {
  if (!run.state.done.includes(step)) run.state.done.push(step);
  saveState(run.work, run.state);
}

function harnessAuthFor(run: Run): HarnessAuth | VerbResult {
  if (run.deps.auth !== undefined) return run.deps.auth;
  try {
    const config = loadConfig({ env: run.ctx.env, readFile: run.deps.readConfig });
    return harnessAuth(config, run.ctx.env, run.deps.keys ?? { env: run.ctx.env });
  } catch (error) {
    return fail((error as Error).message);
  }
}

/** One core stage: one harness message, its writes on a fresh `plan/` branch. `branch` is absent when it wrote nothing. */
async function runCoreStage(run: Run, stage: StoryCoreStage): Promise<{ ok: true; branch?: string; sha?: string } | { ok: false; result: VerbResult }> {
  const marker = readMarker(run.work);
  if (!marker.ok) return { ok: false, result: refuse(marker.message) };
  const prompt = loadPromptWork(run.work, marker.marker, run.slug);
  if (!prompt.ok) return { ok: false, result: refuse(prompt.message) };
  const auth = harnessAuthFor(run);
  if ("body" in auth) return { ok: false, result: auth };

  const session = startPlanSession(run.vault, run.slug, { env: run.ctx.env });
  const ask = run.state.review && run.deps.ask !== undefined ? run.deps.ask : assumingAsk(stage, run.state.assumptions);
  const spec = {
    work: prompt.work,
    projectPath: run.work,
    auth,
    ctx: { ...run.ctx, caller: "mcp" as const },
    tools: harnessTools(ask),
    sessionTools: planTools(session, run.work),
  };
  let finished: { ok: boolean; text: string; errors: readonly string[] } | undefined;
  try {
    for await (const message of runHarness(stageMessage(stage, run.state, run.title, run.slug), spec, run.deps.query ?? sdkQuery)) {
      for (const entry of transcriptEntries(message)) if (entry.kind === "result") finished = entry;
    }
  } catch (error) {
    return { ok: false, result: fail(`pablo: story: the harness failed in the ${stage} stage (${(error as Error).message})`, { stage }) };
  }
  saveState(run.work, run.state);
  if (finished?.ok !== true) {
    return { ok: false, result: fail(`pablo: story: the harness did not finish the ${stage} stage${finished === undefined ? "" : `: ${finished.errors.join("; ") || finished.text}`}`, { stage }) };
  }
  if (session.worktree === undefined) return { ok: true };
  return { ok: true, branch: session.branch, sha: git(run.repo, ["rev-parse", session.branch]) };
}

/** What a required core stage still lacks after its branch landed, or undefined when it is met. */
function stageMissing(work: string, stage: StoryCoreStage): readonly string[] | undefined {
  if (stage === "research") return undefined;
  const found = coreStages(readCoreState(work)).find((s) => s.id === stage);
  return found === undefined || found.done ? undefined : found.missing;
}

/** Drafts one unit through `write` (preconditions, pack, writer, draft branch, receipt naming output and unit). */
async function draftUnit(run: Run, def: OutputDefinition, unit: number): Promise<{ ok: true; branch: string; path: string } | { ok: false; result: VerbResult }> {
  const words = def.soleUnit !== undefined ? run.state.words : undefined;
  const { exitCode, text } = await withWriteLock(() =>
    captureConsoleLog(() =>
      runWrite(
        {
          chapter: undefined,
          output: def.id,
          unit: String(unit),
          words: words === undefined ? undefined : String(words),
          scenes: undefined,
          dryRun: false,
          json: true,
          force: false,
        },
        run.vault,
        run.work,
        { stderr: run.ctx.stderr, env: run.ctx.env, ...(run.deps.writer ? { adapter: run.deps.writer } : {}), ...(run.deps.now ? { now: run.deps.now } : {}) },
      ),
    ),
  );
  let body: Record<string, unknown> = { ok: exitCode === 0 };
  try {
    if (text !== "") body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { ok: false, code: 1, message: text };
  }
  if (exitCode !== 0 || body["ok"] !== true) {
    return { ok: false, result: { body: { ...body, output: def.id, unit }, exitCode: exitCode === 0 ? 1 : exitCode } };
  }
  return { ok: true, branch: body["branch"] as string, path: body["path"] as string };
}

function extractorFor(run: Run): Adapter | undefined {
  if (run.deps.extractor !== undefined) return run.deps.extractor;
  if (run.deps.writer !== undefined) return run.deps.writer;
  try {
    const providers = createProviders(loadConfig({ env: run.ctx.env, readFile: run.deps.readConfig }));
    return providers.adapter(providers.route(CONTINUITY_INTENT));
  } catch {
    return undefined;
  }
}

/** Runs every step not yet done, stopping on a branch in review mode. */
async function advance(run: Run): Promise<VerbResult> {
  const { state } = run;
  const env = run.ctx.env;

  for (const stage of STORY_CORE_STAGES) {
    const step = `core:${stage}`;
    if (state.done.includes(step)) continue;
    const ran = await runCoreStage(run, stage);
    if (!ran.ok) return ran.result;
    if (ran.branch === undefined) {
      const missing = stageMissing(run.work, stage);
      if (missing !== undefined) return fail(`pablo: story: the harness proposed nothing for the ${stage} stage`, { stage, missing });
      markDone(run, step);
      continue;
    }
    if (state.review) {
      state.pending = { step, branch: ran.branch, sha: ran.sha as string };
      state.plan.push({ stage, branch: ran.branch });
      saveState(run.work, state);
      return waiting(run, step, ran.branch);
    }
    // On demand: the stage's plan branch is accepted as it lands.
    const merged = mergeBranch(run.repo, ran.branch, env);
    if (!merged.ok) return fail(merged.notice, { stage, branch: ran.branch });
    deleteBranch(run.repo, run.slug, ran.branch, { env });
    state.plan.push({ stage, branch: ran.branch, merged: merged.sha as string });
    const missing = stageMissing(run.work, stage);
    if (missing !== undefined) {
      saveState(run.work, state);
      return fail(`pablo: story: the ${stage} stage landed without what the core needs`, { stage, missing });
    }
    markDone(run, step);
  }

  for (const id of state.outputs) {
    const def = outputDefinition(id);
    if (def === undefined) return refuse(`pablo: story: there is no ${id} output on this machine (pablo has: ${outputIds().join(", ")})`, [`output ${id}`]);

    const addStep = `output:${id}`;
    if (!state.done.includes(addStep)) {
      const marker = readMarker(run.work);
      if (!marker.ok) return refuse(marker.message);
      if (marker.marker.outputs[id] === undefined) {
        const added = addOutput(run.vault, run.work, id, run.deps.now ? { now: run.deps.now } : {});
        if (!added.ok) return { body: added, exitCode: added.code };
      }
      markDone(run, addStep);
    }

    const units = def
      .report(run.work, readCoreState(run.work))
      .units.filter((u) => u.file === undefined)
      .map((u) => u.unit)
      .sort((a, b) => a - b);
    for (const unit of units) {
      const drafted = await draftUnit(run, def, unit);
      if (!drafted.ok) return drafted.result;
      const step = `draft:${id}:${unit}`;
      if (state.review) {
        state.pending = { step, branch: drafted.branch, sha: git(run.repo, ["rev-parse", drafted.branch]) };
        (state.drafts[id] ??= []).push({ unit, branch: drafted.branch, path: drafted.path });
        saveState(run.work, state);
        return waiting(run, step, drafted.branch);
      }
      const merged = await mergeDraft(run.work, drafted.branch, {
        slug: run.slug,
        env,
        extractor: extractorFor(run),
        ...(run.deps.now ? { now: run.deps.now } : {}),
      });
      if (!merged.ok) return fail(merged.notice, { output: id, unit, branch: drafted.branch });
      (state.drafts[id] ??= []).push({ unit, branch: drafted.branch, path: drafted.path, merged: merged.sha });
      markDone(run, step);
    }

    const publishStep = `publish:${id}`;
    if (!state.done.includes(publishStep)) {
      const target = def.publish.targets[0] as string;
      const marker = readMarker(run.work);
      if (!marker.ok) return refuse(marker.message);
      const published = def.publish.run(run.work, marker.marker.slug, marker.marker.title, target);
      if (!published.ok) return { body: { ok: false, code: published.code, message: published.message, tried: published.tried, output: id }, exitCode: published.code };
      state.published[id] = { target: published.target, where: published.where, words: published.words };
      markDone(run, publishStep);
    }
  }

  state.finished = true;
  saveState(run.work, state);
  const core = coreStages(readCoreState(run.work)).map((s) => ({ id: s.id, done: s.done, summary: s.summary }));
  return {
    body: {
      ok: true,
      project: run.slug,
      path: run.work,
      title: run.title,
      outputs: state.outputs,
      review: state.review,
      core,
      plan: state.plan,
      drafts: state.drafts,
      published: state.published,
      assumptions: state.assumptions,
      receipts: receiptsPath(run.work),
    },
    exitCode: 0,
  };
}

/** A review run's pending branch: merged moves on, still open waits, dropped runs the step again. */
function settlePending(run: Run): VerbResult | undefined {
  const pending = run.state.pending;
  if (pending === undefined) return undefined;
  if (isMerged(run.repo, pending.sha)) {
    delete run.state.pending;
    if (pending.step.startsWith("core:")) {
      const entry = run.state.plan.find((p) => p.branch === pending.branch);
      if (entry !== undefined) Object.assign(entry, { merged: git(run.repo, ["rev-parse", "main"]) });
    }
    markDone(run, pending.step);
    return undefined;
  }
  if (branchExists(run.repo, pending.branch)) return waiting(run, pending.step, pending.branch);
  // Dropped without merging: the step runs again.
  delete run.state.pending;
  saveState(run.work, run.state);
  return undefined;
}

/**
 * `pablo story "<prompt>" [--output <type>]... [--review] [--title T] [--words N]`
 * starts a run; `pablo story --project <slug> [--review]` resumes one. The body
 * is the verb's `--json`: the finished run (`core`, `plan`, `drafts`,
 * `published`, `assumptions`, `receipts`), or `waiting` with the branch a
 * review run stops on, or a refusal (exit 2) / failure (exit 1).
 */
export async function runStory(args: StoryArgs, ctx: VerbContext, deps: StoryDeps = {}): Promise<VerbResult> {
  const vault = findVault(ctx.cwd, ctx.env);
  if (!vault.ok) return { body: { ok: false, code: vault.code, message: vault.message, tried: vault.tried }, exitCode: vault.code };
  const repo = repoRoot(vault.path);
  if (repo === undefined || realpathSync(repo) !== realpathSync(vault.path)) {
    return refuse(`pablo: story: the vault ${vault.path} must be a git repository of its own (every stage lands on a branch); nothing was written`);
  }
  const prompt = args.prompt?.trim() ?? "";

  if (args.project !== undefined) {
    if (prompt !== "") return refuse('pablo: story: pass "<prompt>" to start a story, or --project <slug> to continue one, not both');
    const project = resolveProject(vault.path, args.project);
    if (!project.ok) return { body: { ok: false, code: project.code, message: project.message, tried: project.tried }, exitCode: project.code };
    const state = readState(project.path);
    if (state === undefined) return refuse(`pablo: story: no pablo story run is recorded in ${join(project.path, STATE_FILE)}`, [`"<prompt>" (start a run)`]);
    const marker = readMarker(project.path);
    if (!marker.ok) return refuse(marker.message);
    if (args.review === true) state.review = true;
    const blocked = await ensureOutputs(state.outputs);
    if (blocked !== undefined) return blocked;
    const run: Run = { vault: vault.path, repo, work: project.path, slug: marker.marker.slug, title: marker.marker.title, state, ctx, deps };
    if (state.finished === true) return advance(run);
    const held = settlePending(run);
    return held ?? advance(run);
  }

  if (prompt === "") return refuse('pablo: story requires a prompt: pablo story "<what to write>" [--output <type>]...', ['"<prompt>"']);
  const outputs = [...new Set((args.output ?? []).map((o) => o.trim()).filter((o) => o !== ""))];
  if (outputs.length === 0) outputs.push(defaultOutput(prompt));
  // Refused by name before anything is written; a type nobody asked for is never ensured.
  const blocked = await ensureOutputs(outputs);
  if (blocked !== undefined) return blocked;

  const now = deps.now ?? (() => new Date());
  const date = localDate(now());
  const title = args.title?.trim() || titleFromPrompt(prompt);
  const slug = freeSlug(vault.path, title);
  const category = outputs.includes("novel") ? "novels" : "stories";
  const work = join(vault.path, category, slug);

  const files = scaffold(title, prompt, date);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    writeFileSync(join(work, rel), content, "utf8");
  }
  writeMarker(work, { title, slug, author: DEFAULT_AUTHOR, voice: DEFAULT_VOICE, neverSend: DEFAULT_NEVER_SEND, publish: DEFAULT_PUBLISH, outputs: {} });
  // Machine state (`.pablo/`: the run, receipts, published files) is never committed, as `pablo init` arranges.
  const ignored = ensureGitignoreEntry(vault.path, ".pablo/");
  const createdPaths = [...[...Object.keys(files), "pablo.json"].map((rel) => join(work, rel)), ...(ignored ? [join(vault.path, ".gitignore")] : [])];
  const created = gitCommit(vault.path, `${slug}: create (pablo story)`, createdPaths);
  if (!created.committed) return fail(created.notice ?? `pablo: story: could not commit ${work}`, { path: work });

  const words = args.words ?? (outputs.some((o) => outputDefinition(o)?.soleUnit !== undefined) ? wordsCue(prompt) : undefined);
  const state: StoryState = {
    version: 1,
    prompt,
    outputs,
    review: args.review === true,
    ...(words === undefined ? {} : { words }),
    started: now().toISOString(),
    done: [],
    plan: [],
    drafts: {},
    published: {},
    assumptions: [],
  };
  saveState(work, state);
  return advance({ vault: vault.path, repo, work, slug, title, state, ctx, deps });
}
