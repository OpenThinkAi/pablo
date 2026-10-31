/**
 * `pablo story "<prompt>"` (AGT-1690, pm project `pablo-story-core`, "`pablo
 * story` and on demand"; pablo-casting decision 6c): the harness run end to
 * end. It creates a work under the vault (`stories/` for a written story,
 * `novels/` when a novel is asked for: the category is the output kind),
 * builds its story core stage by stage (research -> premise -> bible -> acts
 * -> beats, each stage one harness message whose writes land on its own
 * `plan/` branch; a historical-fiction work runs its track's core instead,
 * `HISTORICAL_STORY_STAGES`, AGT-2184), then runs each requested output's units through that
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
 *
 * The radio output (AGT-1700) runs its own machine after the script:
 * `radio-chain.ts`, imported only when a run asks for radio, so a written
 * run never loads the casting side. On demand, episode N+1 is written while
 * episode N is cast (`cast --auto --design`), performed with `--stream`
 * (mixed from the same timeline) and published to the listening directory;
 * a refusal anywhere stops both queues and leaves what is published. Under
 * `--review` each episode stops three times: on its draft branch, on its
 * bindings (`cast:radio:N`) and on its render (`render:radio:N`, played in
 * `pablo review`; a render with open flags, auto-flags included, keeps
 * waiting until they are fixed or cleared), and is published only once the
 * render is approved by resuming.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { PLAN_INTENT, WORK_RULES_FILE, createPlanner, createProviders, fileReceiptSink, loadConfig, receiptsPath, workRulesFile } from "@openthink/pablo-core";
import type { Adapter, Intent, KeyLookup, LoadConfigOptions } from "@openthink/pablo-core";
import { branchExists, deleteBranch, mergeBranch, repoRoot } from "./branch";
import { coreStages, readCoreState } from "./core/machine";
import { itemLabel } from "./core/checklist";
import { ensureGitignoreEntry, gitCommit, SLUG_PATTERN } from "./init";
import type { CastingDeps } from "./radio";
import { DEFAULT_AUTHOR, DEFAULT_NEVER_SEND, DEFAULT_PUBLISH, DEFAULT_VOICE, readMarker, trackOf, writeMarker } from "./marker";
import { mergeDraft } from "./novel/merge";
import { dirtyPaths } from "./migrate";
import { addOutput, removeOutput } from "./output-verbs";
import { applyArchive, archiveDest, moveDirToArchive, planArchive } from "./story-adopt";
import { cleanTitle, planTitle } from "./story-title";
import { assumedThesis } from "./outputs/essay/scaffold";
import { radioMachine } from "./outputs/radio/casting-side";
import { episodeState } from "./outputs/radio/state";
import { RADIO_ID } from "./outputs/radio/units";
import { slugify } from "./outputs/novel/units";
import { outputDefinition, outputIds, outputsOnTrack } from "./outputs/registry";
import type { OutputDefinition } from "./outputs/types";
import { startPlanSession } from "./plan";
import { findVault, resolveProject } from "./project";
import type { AskAuthor } from "./harness/ask-author";
import { RESEARCH_INTENT } from "./distill";
import { distillFactsInProject, planChecklist } from "./research-verbs";
import { harnessProvider, LOCAL_FALLBACK_NOTICE, shouldWarnLocal } from "./harness/provider";
import type { HarnessProvider } from "./harness/provider";
import { planTools } from "./harness/plan-tools";
import { loadPromptWork } from "./harness/prompt";
import type { TranscriptEntry } from "./harness/transcript";
import { loopQuery, runHarness } from "./harness/session";
import type { HarnessQuery } from "./harness/session";
import { harnessTools } from "./harness/tools";
import { explicitTrack, inferTrack } from "./tracks/infer";
import type { TrackChoice } from "./tracks/infer";
import { isTrackId, trackIds } from "./tracks/registry";
import type { TrackId } from "./tracks/registry";
import { trackCoreFiles } from "./tracks/scaffold";
import { captureConsoleLog, withWriteLock } from "./verbs";
import type { VerbContext, VerbResult } from "./verbs";
import { runWrite } from "./write";

/** The core stages `pablo story` runs on fiction, in order: each is one harness message and, when it writes, one `plan/` branch. */
export const STORY_CORE_STAGES = ["research", "premise", "bible", "acts", "beats"] as const;

/**
 * The historical-fiction core as `pablo story` runs it (AGT-2184, D-5, D-9, D-10, D-22): the premise, then the period
 * brief, then guided research (pablo plans the checklist from the brief, the harness sources or waives every item),
 * then pablo distils the notes into period facts, then the bible, acts and beats. `research-plan` and `period-facts`
 * are pablo's own steps (`research plan`, `research distill` on the `research` intent), not harness messages; every
 * step's writes land on a `plan/` branch accepted or stopped on like any other stage's.
 */
export const HISTORICAL_STORY_STAGES = ["premise", "period", "research-plan", "research", "period-facts", "bible", "acts", "beats"] as const;

export type StoryCoreStage = (typeof STORY_CORE_STAGES)[number] | (typeof HISTORICAL_STORY_STAGES)[number];

/** The stages pablo runs itself rather than as a harness message. */
const PABLO_STAGES: readonly StoryCoreStage[] = ["research-plan", "period-facts"];

/** The core stages a run on `track` goes through, in order (an absent track is a run started before tracks: fiction). */
export function storyStages(track: TrackId | undefined): readonly StoryCoreStage[] {
  return track === "historical-fiction" ? HISTORICAL_STORY_STAGES : STORY_CORE_STAGES;
}

/** The harness's tools a story stage never offers: pablo plans and distils itself, so the agent's own calls would only leave stray branches. */
const PABLO_RUN_TOOLS = new Set(["plan_research", "distill_facts"]);

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

const capitalised = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "... write me a story about X": X is the subject; the request's own verb phrase is not a title. */
const REQUEST_TAIL = /\b(?:write|tell|draft|compose|give)\b(?:\s+me)?(?:\s+(?:an?|the))?(?:\s+(?:short|long|new))*\s+(?:story|novel|novella|tale|book|fable|piece)\s+(?:about|of|on|where)\s+(.+)$/i;

/**
 * A working title from the prompt, used until the premise stage supplies the
 * real one: the subject after a "write me a story about ..." request when
 * there is one, else the first clause; at most eight words, capitalised.
 */
export function titleFromPrompt(prompt: string): string {
  const first = (prompt.split(/[.;:!?\n]/)[0] ?? prompt).trim();
  const clause = REQUEST_TAIL.exec(first)?.[1]?.trim() ?? first;
  const words = clause.split(/\s+/).filter((w) => w !== "").slice(0, 8).join(" ");
  return capitalised(words === "" ? "Untitled story" : words);
}

/** The words of a logline up to its main verb or clause: "A fishing family in 1900 Camogli is offered ..." -> "A fishing family in 1900 Camogli". */
const LOGLINE_CUT = /\s+(?:is|are|was|were|has|have|must|decides?|faces?|finds?|discovers?|learns?|wants?|tries|returns?|who|that|when|after|while|as)\b/i;

/**
 * The work's title from its premise (AGT-1705): the `## Title` section of
 * `bible/overview.md` when the premise stage wrote one, else the subject of
 * its logline (the words up to the main verb). Undefined when the overview
 * says neither, so the caller keeps the title it has.
 */
export function titleFromPremise(overviewText: string): string | undefined {
  // The title sits under the heading, or on it ("## Title: The Last Ferry", AGT-2290).
  const heading = /^##[ \t]+Title[ \t]*:[ \t]*([^\r\n]*\S[^\r\n]*)/im.exec(overviewText)?.[1] ?? /^##[ \t]+Title[ \t]*\r?\n+([^\r\n#][^\r\n]*)/im.exec(overviewText)?.[1];
  const given = heading === undefined ? undefined : cleanTitle(heading).replace(/^["'“”*_\s]+|["'“”*_.\s]+$/g, "").trim();
  if (given !== undefined && given !== "") return given;
  const logline = /^##[ \t]+Logline[ \t]*\r?\n+([^\r\n#][^\r\n]*)/im.exec(overviewText)?.[1]?.trim();
  if (logline === undefined || logline === "") return undefined;
  const subject = (LOGLINE_CUT.test(logline) ? logline.slice(0, logline.search(LOGLINE_CUT)) : logline).split(/[,.;:]/)[0] ?? "";
  const words = subject.split(/\s+/).filter((w) => w !== "");
  if (words.length < 2) return undefined;
  return capitalised(words.slice(0, 8).join(" "));
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
  /**
   * `--track <t>` (AGT-2103, D-6): the work's track, written to pablo.json with that track's core files. Absent, the
   * planner infers `historical-fiction` from a prompt naming a period or event, else `fiction`. Ignored on resume.
   */
  readonly track?: string | undefined;
  /**
   * `--from <stage>` (AGT-2289, D-22): adopt the work `project` names, whether or not `pablo story` built it, and run
   * from this core stage. Earlier stages must be complete and are kept; the stage's and later stages' files, and the
   * work's outputs, are archived (never deleted) under `_archived/`. Needs `project`.
   */
  readonly from?: string | undefined;
  /** `--no-check` (AGT-2115): skip the track's checks after each drafted unit. */
  readonly noCheck?: boolean | undefined;
  /** The same, as the verb's schema spells it (`pablo story --no-check`, the MCP tool). */
  readonly "no-check"?: boolean | undefined;
}

/** What a test injects so no model runs: the harness, the writer, the extractor, the author. */
export interface StoryDeps {
  /** The harness session (pablo's agent loop); a fake in tests that do not drive the loop. */
  readonly query?: HarnessQuery;
  /** The writer units are drafted with; absent, the routed drafting provider (`write`). */
  readonly writer?: Adapter;
  /** The continuity extractor the merge rituals run; absent, the routed extraction provider. */
  readonly extractor?: Adapter;
  /** The provider the harness runs on; absent, the config's `agent` intent decides, as for `pablo agent`. Tests pass a scripted adapter. */
  readonly agent?: HarnessProvider;
  readonly keys?: Partial<KeyLookup>;
  readonly readConfig?: LoadConfigOptions["readFile"];
  /** `--review`'s `ask_author`: the front end's question card. Absent, review runs answer by assumption too. */
  readonly ask?: AskAuthor;
  readonly now?: () => Date;
  /**
   * The casting side's machine the radio output runs on (AGT-1700); absent, the context's, else the radio
   * type's own seam (`radioMachine`). Never touched by a run with no radio output.
   */
  readonly casting?: CastingDeps;
  /**
   * The research agent a historical-fiction run plans the checklist and distils the period facts with (AGT-2184);
   * absent, the config's `research` intent, as for `pablo research plan|distill`. A fake in tests.
   */
  readonly researcher?: Adapter;
  /**
   * The planner `story` asks, once, which track an unflagged prompt is on (AGT-2103); absent, pablo's planner
   * (`createPlanner`). A fake in tests. Never called when `--track` is given or a run resumes.
   */
  readonly planner?: Adapter;
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
  /** The track's checks on the draft (AGT-2115): the hits (never a rewrite) and any check that could not run. */
  readonly check?: readonly unknown[];
  readonly checkNotices?: readonly string[];
}

interface StoryState {
  readonly version: 1;
  readonly prompt: string;
  readonly outputs: readonly string[];
  review: boolean;
  /** `--no-check` was given (AGT-2115): the track's checks do not run after a draft. */
  noCheck?: boolean;
  readonly words?: number;
  readonly started: string;
  /** The track the run chose and why (AGT-2103): `--track`, or inferred from the prompt. Absent on runs started before it. */
  readonly track?: TrackChoice;
  /** The work's title is settled: `--title` was given, or the premise stage has supplied it (AGT-1705). */
  titled?: boolean;
  /** Steps finished: `core:<stage>`, `output:<type>`, `draft:<type>:<unit>`, `publish:<type>`. */
  done: string[];
  /**
   * What a review run waits on: a branch to accept (`branch`, `sha`), or a radio episode's bindings or
   * render to approve (`approve`, `unit`), approved by resuming.
   */
  pending?: { readonly step: string; readonly branch?: string; readonly sha?: string; readonly approve?: "binding" | "render"; readonly unit?: number };
  plan: { readonly stage: string; readonly branch: string; readonly merged?: string }[];
  drafts: Record<string, DraftRecord[]>;
  published: Record<string, PublishedRecord>;
  assumptions: StoryAssumption[];
  finished?: boolean;
  /** Set when the run adopted an existing work with `--from` (AGT-2289): the stage, and where what it replaced went. */
  adopted?: { readonly from: string; readonly archived: string; readonly outputs: readonly string[] };
  /** Each core stage's saved transcript, as paths relative to the work (AGT-2191). */
  transcripts?: string[];
}

/** What an output's publish left: the radio output lists its published episodes (AGT-1700). */
interface PublishedRecord {
  readonly target: string;
  readonly where: string;
  readonly words: number;
  readonly episodes?: readonly { readonly episode: number; readonly version: number; readonly audio: string }[];
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

/** The files a new work starts with: its README and rules, then its track's core files (`tracks/scaffold.ts`), and no output's units (`output add` scaffolds those). */
function scaffold(title: string, prompt: string, date: string, track: TrackId): Record<string, string> {
  return {
    "README.md": `# ${title}\n\nAsked for on ${date}:\n\n> ${prompt.replace(/\n/g, "\n> ")}\n\n## Where things stand\n\n- ${date}: created by \`pablo story\`.\n`,
    [WORK_RULES_FILE]: `# ${title}: the work's rules\n\n## Ground rules\n\n- Tell the story the request asks for, in the vault's voice.\n`,
    ...trackCoreFiles(track),
  };
}

/**
 * The run's track (AGT-2103, D-6): `--track` when given (validated), else one planner call on the prompt. A refusal
 * comes back as a `VerbResult`.
 */
async function chooseTrack(args: StoryArgs, prompt: string, ctx: VerbContext, deps: StoryDeps): Promise<TrackChoice | VerbResult> {
  const named = args.track?.trim();
  if (named !== undefined && named !== "") {
    if (!isTrackId(named)) return refuse(`pablo: story: unknown track ${JSON.stringify(named)} (allowed: ${trackIds().join(", ")}); nothing was written`, [`--track ${trackIds().join(" | ")}`]);
    // `story` builds a fiction core (premise, bible, acts, beats); a nonfiction work starts from its own core.
    if (named === "nonfiction") {
      return refuse('pablo: story: pablo story writes fiction; start a nonfiction work with `pablo init --track nonfiction <slug> "<Title>"`; nothing was written', ["--track fiction | historical-fiction"]);
    }
    return explicitTrack(named);
  }
  // The planner can take seconds: say what the wait is.
  ctx.stderr.write("pablo story: choosing a track from the prompt\n");
  const planner = storyPlanner(ctx, deps);
  if (planner instanceof Error) return { track: "fiction", inferred: false, why: `the planner could not be set up (${planner.message}); fiction by default` };
  return inferTrack(prompt, planner);
}

/** The planner `story` asks (AGT-2103, AGT-2290): the injected one, else pablo's own; an Error when it cannot be set up. */
function storyPlanner(ctx: VerbContext, deps: StoryDeps): Adapter | Error {
  if (deps.planner !== undefined) return deps.planner;
  try {
    return createPlanner(loadConfig({ env: ctx.env, readFile: deps.readConfig }), { keys: deps.keys ?? { env: ctx.env } }).adapter;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** Refuses, before anything is written, a requested output the run's track does not allow (D-7). */
function outputsOffTrack(outputs: readonly string[], track: TrackId): VerbResult | undefined {
  const allowed = outputsOnTrack(track);
  const off = outputs.filter((id) => !allowed.includes(id));
  if (off.length === 0) return undefined;
  return refuse(
    `pablo: story: the ${off.join(", ")} output${off.length === 1 ? " is" : "s are"} not allowed on the ${track} track (allowed: ${allowed.length === 0 ? "none on this machine yet" : allowed.join(", ")}); nothing was written`,
    off.map((id) => `output ${id} on ${track}`),
  );
}

/** The receipt's line for the track: the track, and why. */
export function trackLine(choice: TrackChoice): string {
  return `${choice.track} (${choice.inferred ? `inferred: ${choice.why}` : choice.why})`;
}

/** The first free slug for `title` across every category of the vault. */
function freeSlug(vault: string, title: string): string {
  const base = slugify(title).split("-").slice(0, 6).join("-") || "story";
  const stem = SLUG_PATTERN.test(base) ? base : "story";
  let slug = stem;
  for (let n = 2; resolveProject(vault, slug).ok; n += 1) slug = `${stem}-${n}`;
  return slug;
}

/** What each fiction stage asks; the "Stage k of n, <stage>." prefix is `stageMessage`'s. */
const STAGE_TEXT: Readonly<Record<(typeof STORY_CORE_STAGES)[number], string>> = {
  research:
    "Find what this story needs to be true to (its period, place, work and practice). You have no web access: work from the work's saved notes and what you know with confidence, and keep each finding with save_research, citing only sources you can name exactly (author, title and year); never invent a source or a retrieval date, and leave out a finding you cannot source. If the request needs no research (pure invention), save nothing and say so. Propose nothing yet.",
  premise:
    'Read the research notes (read, search) and propose the premise with propose (stage "premise"): bible/overview.md with ## Title (the work\'s own short title, two to six words, about the story and not the request), ## Logline (one or two sentences), ## Premise, ## Themes, ## Tone and ## Structure.',
  bible:
    'Propose the cast (propose stage "cast", one character per call, with a lowercase-hyphen name; the content opens with a # heading holding the character display name as the story writes it) and the places (stage "places"), and the timeline (stage "timeline": a | Year | Real events | In the story | table with a row for every year a beat will be set in). Record any other fact the story stands on with record_fact, tagged researched with its source, or invented.',
  acts: 'Propose the acts table with propose (stage "acts"): rows of | Act | Years | What it accomplishes |.',
  beats: 'Propose the beats with propose (stage "beats"): one row per story unit, | # | Story date | Title (working) | Beat | POV | Status |, status "outline".',
};

/**
 * The research stage's text when a web search backend is configured (AGT-2185, D-9/D-11): the stage is offered
 * `web_search` and `web_fetch` and must use them, so every note cites at least one page it fetched.
 */
const RESEARCH_WEB =
  "Find what this story needs to be true to (its period, place, work and practice). Search the web with web_search, read the promising pages with web_fetch (a search snippet is not a source), and keep each finding with save_research. Every note cites at least one page you fetched, by the url web_fetch returned, with its retrievedAt date (e.g. \"https://... (retrieved 2026-10-27)\"); when no page exists for a finding, cite a book by author, title and year and say in the note why no page was found. Never cite general knowledge or memory, never invent a source or a retrieval date, and leave out a finding you cannot source. If the request needs no research (pure invention), save nothing and say so. Propose nothing yet.";

/** What the historical-fiction harness stages ask where they differ from fiction's (AGT-2184). */
const HISTORICAL_TEXT: Readonly<Partial<Record<StoryCoreStage, string>>> = {
  premise:
    'This is historical fiction: the story is set in a real period and place. Propose the premise with propose (stage "premise"): bible/overview.md with ## Title (the work\'s own short title, two to six words, about the story and not the request), ## Logline (one or two sentences), ## Premise, ## Themes, ## Tone and ## Structure. Research comes after the period brief; save nothing yet.',
  period:
    'Write the period brief with propose (stage "period"): bible/period.md with ## When and where (the years and the place), ## The events (the real history the story runs through) and ## What the story must be true to (the people, places, technology, language, daily life, politics and dates a reader could check). pablo derives the research checklist from it. Propose nothing else.',
  bible:
    'Propose the cast (propose stage "cast", one character per call, with a lowercase-hyphen name; the content opens with a # heading holding the character display name as the story writes it) and the places (stage "places"), and the timeline (stage "timeline": a | Year | Real events | In the story | table with a row for every year a beat will be set in). Keep them true to the period brief and the distilled period facts (facts/period.md). Record any other fact the story stands on with record_fact, tagged researched with its source, or invented.',
};

/**
 * The research stage's text on historical fiction: the checklist pablo planned from the period brief, and its open
 * items by number, each to be sourced (save_research with items, or link_research_item) or waived with a reason.
 */
function historicalResearchText(work: string | undefined, web: boolean): string {
  const items = work === undefined ? [] : (readCoreState(work, "historical-fiction").checklist?.items ?? []).filter((i) => i.status === "open");
  const list = items.length === 0 ? "" : `\n\nOpen checklist items:\n${items.map((i) => `- ${itemLabel(i)}`).join("\n")}`;
  return (
    `pablo planned the research checklist (research/checklist.md) from the period brief. Close every open item: keep a finding with save_research, passing items (the numbers it sources). ${web ? "Search the web with web_search and read the promising pages with web_fetch (a search snippet is not a source); cite each page by the url web_fetch returned, with its retrievedAt date, or a book by author, title and year" : "Cite only sources you can name exactly: a book by author, title and year, or a URL with its retrieval date"}; never cite general knowledge or memory, never invent a source or a retrieval date. A note already saved can close an item with link_research_item. An item the story does not need is waived with waive_research_item and a reason (items closes several at once). Propose nothing yet.` +
    list
  );
}

const ON_DEMAND =
  "This is an on-demand run: nobody reviews the stages as they land. When a call is the author's, ask_author answers with an instruction to assume: make the most plausible choice, state it as an assumption (record_fact, kind invented), and continue.";
const REVIEW_MODE = "This is a review run: the author reviews this stage's plan branch before the next stage starts. Use ask_author only for what you cannot reasonably assume.";

/**
 * The harness message for one core stage. `web` is whether the run has a web search backend (`webConfigured`);
 * `work` (the work's directory) lists a historical run's open checklist items (AGT-2184).
 */
export function stageMessage(stage: StoryCoreStage, state: Pick<StoryState, "prompt" | "outputs" | "review" | "track">, title: string, slug: string, web = false, work?: string): string {
  const track = state.track?.track;
  const harnessStages = storyStages(track).filter((s) => !PABLO_STAGES.includes(s));
  const historical = track === "historical-fiction";
  const text =
    historical && stage === "research"
      ? historicalResearchText(work, web)
      : stage === "research" && web
        ? RESEARCH_WEB
        : ((historical ? HISTORICAL_TEXT[stage] : undefined) ?? STAGE_TEXT[stage as (typeof STORY_CORE_STAGES)[number]] ?? "");
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
    `Stage ${harnessStages.indexOf(stage) + 1} of ${harnessStages.length}, ${stage}. ${text}${length}`,
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
  title: string;
  readonly state: StoryState;
  readonly ctx: VerbContext;
  readonly deps: StoryDeps;
  /** The agent provider, resolved once per run (`agentProviderFor`). */
  agent?: Map<string, HarnessProvider>;
}

function waiting(run: Run, step: string, branch: string): VerbResult {
  return {
    body: {
      ok: true,
      project: run.slug,
      path: run.work,
      waiting: { step, branch },
      next: `accept ${branch} in review mode${branch.startsWith("draft/") ? ` (or \`pablo merge ${branch} --project ${run.slug}\`)` : ""}, then run \`pablo story --project ${run.slug}\``,
      ...(run.state.track === undefined ? {} : { track: run.state.track }),
      done: run.state.done,
      assumptions: run.state.assumptions,
      ...transcriptsOf(run),
    },
    exitCode: 0,
  };
}

/** `transcripts` for a result body: the saved stage transcripts, absolute, when any exist. */
function transcriptsOf(run: Run): { transcripts?: string[] } {
  const saved = run.state.transcripts ?? [];
  return saved.length === 0 ? {} : { transcripts: saved.map((rel) => join(run.work, rel)) };
}

/** Saves one stage's transcript as JSONL under `<work>/.pablo/transcripts/` and records it in the run's state. */
function saveTranscript(run: Run, stage: StoryCoreStage, entries: readonly TranscriptEntry[]): void {
  const stamp = (run.deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const rel = join(".pablo", "transcripts", `${stage}-${stamp}.jsonl`);
  try {
    mkdirSync(join(run.work, ".pablo", "transcripts"), { recursive: true });
    writeFileSync(join(run.work, rel), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
    (run.state.transcripts ??= []).push(rel);
  } catch {
    // A transcript that cannot be saved must not lose the stage's work.
  }
}

function markDone(run: Run, step: string): void {
  if (!run.state.done.includes(step)) run.state.done.push(step);
  saveState(run.work, run.state);
}

/** One progress line on stderr per stage (AGT-1705): a run takes minutes and prints nothing else until it ends. */
function progress(run: Run, line: string): void {
  run.ctx.stderr.write(`pablo story: ${line}\n`);
}

/**
 * Once the premise is on `main`, names the work from it (AGT-1705): the
 * working title came from the request, which reads badly. The title in
 * `pablo.json` and the README's heading change and are committed on their
 * own; the slug and directory stay (every branch and the run's state name
 * them). A given `--title` is never replaced.
 */
function retitleFromPremise(run: Run): void {
  if (run.state.titled === true || !run.state.done.includes("core:premise")) return;
  run.state.titled = true;
  saveState(run.work, run.state);
  const overview = join(run.work, "bible", "overview.md");
  const title = existsSync(overview) ? titleFromPremise(readFileSync(overview, "utf8")) : undefined;
  if (title === undefined || title === run.title) return;
  const markerFile = join(run.work, "pablo.json");
  const raw = JSON.parse(readFileSync(markerFile, "utf8")) as Record<string, unknown>;
  writeFileSync(markerFile, `${JSON.stringify({ ...raw, title }, null, 2)}\n`, "utf8");
  const paths = [markerFile];
  // The headings scaffolded with the working title follow it.
  for (const [name, suffix] of [["README.md", ""], [workRulesFile(run.work), ": the work's rules"]] as const) {
    const file = join(run.work, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const old = `# ${run.title}${suffix}\n`;
    if (!text.startsWith(old)) continue;
    writeFileSync(file, `# ${title}${suffix}\n${text.slice(old.length)}`, "utf8");
    paths.push(file);
  }
  gitCommit(run.vault, `${run.slug}: title from the premise`, paths);
  progress(run, `title from the premise: "${title}" (the slug and directory stay ${run.slug}, so paths and branches do not move)`);
  run.title = title;
}

/**
 * The intent a core stage's model calls route under (AGT-2127, D-13): the research stage under `research` (map it to a
 * local provider to keep notes on this machine), premise through beats under `plan`. Drafting goes through `write`
 * and its own intents; the free-running `pablo agent` loop is the `agent` intent.
 */
export function stageIntent(stage: StoryCoreStage): Intent {
  return stage === "research" ? RESEARCH_INTENT : PLAN_INTENT;
}

/** The web tools the story stages are offered only when a search backend is configured (AGT-2185). */
const WEB_TOOLS: ReadonlySet<string> = new Set(["web_search", "web_fetch"]);

/**
 * Whether the run can search the web (AGT-2185): a `web.search` backend in the config file, as `web_search` itself
 * reads it, or (tests) an injected search backend. Without one the stages are not offered the web tools and the
 * research stage is told so, rather than told to use tools that can only fail.
 */
export function webConfigured(ctx: Pick<VerbContext, "env" | "web">, readConfig?: LoadConfigOptions["readFile"]): boolean {
  const seam = ctx.web?.search;
  if (seam?.backend !== undefined) return true;
  if (seam?.config !== undefined) return seam.config.search !== undefined;
  try {
    return loadConfig({ env: ctx.env, ...(readConfig === undefined ? {} : { readFile: readConfig }) }).web?.search !== undefined;
  } catch {
    return false;
  }
}

function agentProviderFor(run: Run, stage: StoryCoreStage): HarnessProvider | VerbResult {
  if (run.deps.agent !== undefined) return run.deps.agent;
  const intent = stageIntent(stage);
  const cached = run.agent?.get(intent.name);
  if (cached !== undefined) return cached;
  try {
    const config = loadConfig({ env: run.ctx.env, readFile: run.deps.readConfig, projectDir: run.work });
    const provider = harnessProvider(config, { keys: run.deps.keys ?? { env: run.ctx.env } }, intent);
    if (shouldWarnLocal(provider, config, intent)) run.ctx.stderr.write(`${LOCAL_FALLBACK_NOTICE(provider.adapter.id, intent.name)}\n`);
    (run.agent ??= new Map()).set(intent.name, provider);
    return provider;
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
  const provider = agentProviderFor(run, stage);
  if ("body" in provider) return { ok: false, result: provider };

  const session = startPlanSession(run.vault, run.slug, { env: run.ctx.env });
  const ask = run.state.review && run.deps.ask !== undefined ? run.deps.ask : assumingAsk(stage, run.state.assumptions);
  const web = webConfigured(run.ctx, run.deps.readConfig);
  const spec = {
    work: prompt.work,
    provider,
    ctx: { ...run.ctx, caller: "mcp" as const },
    tools: harnessTools(ask).filter((tool) => !PABLO_RUN_TOOLS.has(tool.name) && (web || !WEB_TOOLS.has(tool.name))),
    sessionTools: planTools(session, run.work),
    // Every agent-loop turn keeps a receipt in the work's log, under the stage's intent (AGT-2191).
    receipts: { sink: fileReceiptSink(run.work), intent: stageIntent(stage).name },
  };
  const entries: TranscriptEntry[] = [];
  let finished: { ok: boolean; text: string; errors: readonly string[] } | undefined;
  try {
    for await (const entry of runHarness(stageMessage(stage, run.state, run.title, run.slug, web, run.work), spec, run.deps.query ?? loopQuery)) {
      entries.push(entry);
      if (entry.kind === "result") finished = entry;
    }
  } catch (error) {
    saveTranscript(run, stage, entries);
    saveState(run.work, run.state);
    return { ok: false, result: fail(`pablo: story: the harness failed in the ${stage} stage (${(error as Error).message})`, { stage, ...transcriptsOf(run) }) };
  }
  saveTranscript(run, stage, entries);
  saveState(run.work, run.state);
  if (finished?.ok !== true) {
    return { ok: false, result: fail(`pablo: story: the harness did not finish the ${stage} stage${finished === undefined ? "" : `: ${finished.errors.join("; ") || finished.text}`}`, { stage, ...transcriptsOf(run) }) };
  }
  if (session.worktree === undefined) return { ok: true };
  return { ok: true, branch: session.branch, sha: git(run.repo, ["rev-parse", session.branch]) };
}

/**
 * pablo's own historical steps (AGT-2184): `research-plan` plans `research/checklist.md` from the period brief,
 * `period-facts` distils the notes into `facts/period.md`, each on a `plan/` branch as `pablo research plan|distill`
 * write it. A step whose file is already in place (a resumed run, or the author did it by hand) writes nothing.
 */
async function runPabloStage(run: Run, stage: StoryCoreStage): Promise<{ ok: true; branch?: string; sha?: string } | { ok: false; result: VerbResult }> {
  if (stageMissing(run.work, stage) === undefined) return { ok: true };
  const deps = { researcher: run.deps.researcher, stderr: run.ctx.stderr };
  const result = stage === "research-plan" ? await planChecklist(run.work, run.ctx.env, deps) : await distillFactsInProject(run.work, run.ctx.env, deps);
  const body = result.body as Record<string, unknown>;
  if (result.exitCode !== 0 || body["ok"] !== true) {
    return { ok: false, result: { body: { ...body, stage, message: `pablo: story: the ${stage} stage stopped: ${String(body["message"] ?? "")}` }, exitCode: result.exitCode === 0 ? 1 : result.exitCode } };
  }
  const branch = body["branch"] as string;
  return { ok: true, branch, sha: git(run.repo, ["rev-parse", branch]) };
}

/** What a required core stage still lacks after its branch landed, or undefined when it is met. */
function stageMissing(work: string, stage: StoryCoreStage): readonly string[] | undefined {
  const marker = readMarker(work);
  const track = marker.ok ? trackOf(marker.marker) : undefined;
  // Research is optional on fiction: a run that needed none saves nothing.
  if (stage === "research" && track !== "historical-fiction") return undefined;
  const state = readCoreState(work, track);
  if (stage === "research-plan") {
    return state.checklist !== undefined && state.checklist.items.length > 0 ? undefined : ["research/checklist.md has no items yet (pablo research plan)"];
  }
  const found = coreStages(state).find((s) => s.id === stage);
  return found === undefined || found.done ? undefined : found.missing;
}

/** Drafts one unit through `write` (preconditions, pack, writer, draft branch, receipt naming output and unit). */
async function draftUnit(run: Run, def: OutputDefinition, unit: number): Promise<{ ok: true; branch: string; path: string; check: readonly unknown[]; checkNotices: readonly string[] } | { ok: false; result: VerbResult }> {
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
          noCheck: run.state.noCheck === true,
        },
        run.vault,
        run.work,
        // The run's own stage line is its progress (AGT-1705): `write`'s token-by-token lines would bury it.
        { stderr: { write: () => {} }, env: run.ctx.env, ...(run.deps.writer ? { adapter: run.deps.writer } : {}), ...(run.deps.now ? { now: run.deps.now } : {}) },
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
  const check = Array.isArray(body["check"]) ? (body["check"] as unknown[]) : [];
  const notices = Array.isArray(body["checkNotices"]) ? (body["checkNotices"] as string[]) : [];
  return { ok: true, branch: body["branch"] as string, path: body["path"] as string, check, checkNotices: notices };
}

function extractorFor(run: Run): Adapter | undefined {
  if (run.deps.extractor !== undefined) return run.deps.extractor;
  if (run.deps.writer !== undefined) return run.deps.writer;
  try {
    const providers = createProviders(loadConfig({ env: run.ctx.env, readFile: run.deps.readConfig, projectDir: run.work }));
    return providers.adapter(providers.route(CONTINUITY_INTENT));
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The radio output (AGT-1700): its chain after the script, through radio-chain.ts
// ---------------------------------------------------------------------------

type RadioChainModule = typeof import("./radio-chain");

/** The chain for this run: imported on first use, on the casting machine the run was given (or the radio type's seam). */
async function radioChainFor(run: Run): Promise<{ mod: RadioChainModule; chain: import("./radio-chain").RadioChain }> {
  const mod = await import("./radio-chain");
  const casting = run.deps.casting ?? run.ctx.casting ?? radioMachine.deps(run.ctx.env);
  return {
    mod,
    chain: {
      vault: run.vault,
      work: run.work,
      slug: run.slug,
      ctx: run.ctx,
      casting,
      progress: (line) => progress(run, line),
      ...(run.deps.now ? { now: run.deps.now } : {}),
    },
  };
}

/** Records the radio output's published episodes (the listening directory's index) in the run. */
function recordRadioPublished(run: Run, where: string | undefined, chapters: readonly { episode: number; version: number; audio: string }[]): void {
  if (where === undefined) return;
  run.state.published[RADIO_ID] = { target: "stream", where, words: 0, episodes: chapters.map((c) => ({ episode: c.episode, version: c.version, audio: c.audio })) };
  saveState(run.work, run.state);
}

/** A refusal or failure in the radio chain: its own body, where the run stopped, and what is already published (left in place). */
function radioStopped(run: Run, unit: number, result: { body: unknown; exitCode: number }, queue?: "writer" | "engine"): VerbResult {
  const exitCode = result.exitCode === 0 ? 1 : result.exitCode;
  const body = (typeof result.body === "object" && result.body !== null ? result.body : { message: String(result.body) }) as Record<string, unknown>;
  return {
    body: {
      ...body,
      ok: false,
      code: typeof body["code"] === "number" ? body["code"] : exitCode,
      output: RADIO_ID,
      unit,
      ...(queue !== undefined ? { queue } : {}),
      project: run.slug,
      path: run.work,
      published: run.state.published,
      next: `fix what is named, then \`pablo story --project ${run.slug}\` continues from episode ${unit}`,
    },
    exitCode,
  };
}

/** What a review run shows for a radio approval: the episode's bindings, or its render and open flags. */
function radioApprovalDetail(run: Run, kind: "binding" | "render", unit: number, bindings?: readonly unknown[]): Record<string, unknown> {
  const state = episodeState(run.work, unit);
  if (kind === "binding") return { bindings: bindings ?? [] };
  return {
    render: {
      version: state.version ?? null,
      audio: state.audio ?? null,
      openFlags: state.openFlags,
      player: `pablo review --project ${run.slug} --episode ${unit}`,
    },
  };
}

/**
 * A review run stopped on a radio stage: the bindings to approve after `cast` (rebind with `pablo bind`), or the
 * render to play in the review player after `perform` and `mix` (open flags keep it waiting: `pablo fix`, or
 * clear them in the player). Resuming approves it.
 */
function radioApproval(run: Run, step: string, kind: "binding" | "render", unit: number, extra: Record<string, unknown> = {}): VerbResult {
  const detail = radioApprovalDetail(run, kind, unit, extra["bindings"] as readonly unknown[] | undefined);
  const flags = episodeState(run.work, unit).openFlags;
  const next =
    kind === "binding"
      ? `approve episode ${unit}'s voices (listen with \`pablo voices show <voice>\`, rebind with \`pablo bind --project ${run.slug} --role R --voice V\`), then run \`pablo story --project ${run.slug}\``
      : `play episode ${unit} in the review player (\`pablo review --project ${run.slug} --episode ${unit}\`)${flags > 0 ? `; it has ${flags} open flag(s): \`pablo fix --output radio --unit ${unit}\`, or clear them in the player` : ""}, then run \`pablo story --project ${run.slug}\` to publish it`;
  return {
    body: {
      ok: true,
      project: run.slug,
      path: run.work,
      waiting: { step, review: kind, output: RADIO_ID, unit, ...detail, ...("cast" in extra ? { cast: extra["cast"] } : {}) },
      ...(kind === "render" && flags > 0 ? { missing: [`episode ${unit} has ${flags} open flag(s) (pablo fix --output radio --unit ${unit})`] } : {}),
      next,
      done: run.state.done,
      assumptions: run.state.assumptions,
    },
    exitCode: 0,
  };
}

/**
 * The radio output after it is added: on demand, the whole chain over every episode not yet made (writer and
 * engine queues overlapping); under `--review`, one stage at a time. Undefined when every episode is made and
 * published; otherwise the result to return (a wait, a refusal or a failure).
 */
async function advanceRadio(run: Run): Promise<VerbResult | undefined> {
  const { state } = run;
  const { mod, chain } = await radioChainFor(run);
  const all = mod.radioUnits(run.work);
  const total = all.length;
  const writeDeps = { writer: run.deps.writer, extractor: run.deps.extractor, now: run.deps.now };

  if (!state.review) {
    const units = all.filter((u) => !state.done.includes(`episode:${RADIO_ID}:${u}`));
    const made = await mod.runRadioChain(chain, units, {
      write: async (unit) => {
        progress(run, `radio: writing episode ${unit} of ${total}`);
        const written = await mod.writeAndAcceptEpisode(chain, unit, writeDeps);
        if (written.ok) {
          (state.drafts[RADIO_ID] ??= []).push({ unit, branch: written.branch as string, path: written.path as string, merged: written.merged as string });
          markDone(run, `draft:${RADIO_ID}:${unit}`);
        }
        return written;
      },
      onMade: (unit) => markDone(run, `episode:${RADIO_ID}:${unit}`),
    });
    recordRadioPublished(run, made.where, made.published);
    const stopped = made.report.stopped;
    if (stopped !== undefined) return radioStopped(run, stopped.unit, stopped.outcome, stopped.queue);
    markDone(run, `publish:${RADIO_ID}`);
    return undefined;
  }

  for (const unit of all) {
    if (state.done.includes(`episode:${RADIO_ID}:${unit}`)) continue;
    const ep = episodeState(run.work, unit);
    if (!ep.script) {
      progress(run, `radio: writing episode ${unit} of ${total}`);
      const drafted = await mod.writeUnit(run.vault, run.work, RADIO_ID, unit, { env: run.ctx.env, writer: run.deps.writer, now: run.deps.now });
      if (!drafted.ok) return drafted.result;
      const step = `draft:${RADIO_ID}:${unit}`;
      state.pending = { step, branch: drafted.branch, sha: git(run.repo, ["rev-parse", drafted.branch]) };
      (state.drafts[RADIO_ID] ??= []).push({ unit, branch: drafted.branch, path: drafted.path });
      saveState(run.work, state);
      return waiting(run, step, drafted.branch);
    }
    const castStep = `cast:${RADIO_ID}:${unit}`;
    if (!state.done.includes(castStep)) {
      const cast = await mod.castEpisode(chain, unit);
      if (cast.exitCode !== 0) return radioStopped(run, unit, cast);
      state.pending = { step: castStep, approve: "binding", unit };
      saveState(run.work, state);
      return radioApproval(run, castStep, "binding", unit, { bindings: mod.episodeBindings(run.work, unit), cast: cast.body });
    }
    const renderStep = `render:${RADIO_ID}:${unit}`;
    if (!state.done.includes(renderStep)) {
      // Performed and mixed, not published: the review player gates the publish.
      const rendered = await mod.renderEpisode(chain, unit, false);
      if (rendered.exitCode !== 0) return radioStopped(run, unit, rendered);
      state.pending = { step: renderStep, approve: "render", unit };
      saveState(run.work, state);
      return radioApproval(run, renderStep, "render", unit);
    }
    const published = mod.publishEpisode(chain, unit);
    if (published.exitCode !== 0) return radioStopped(run, unit, published);
    markDone(run, `episode:${RADIO_ID}:${unit}`);
  }
  const index = mod.publishEpisodeIndex(chain);
  recordRadioPublished(run, index.where, index.published);
  markDone(run, `publish:${RADIO_ID}`);
  return undefined;
}

/** Runs every step not yet done, stopping on a branch in review mode. */
async function advance(run: Run): Promise<VerbResult> {
  const { state } = run;
  const env = run.ctx.env;

  const stages = storyStages(state.track?.track);
  for (const stage of stages) {
    retitleFromPremise(run);
    const step = `core:${stage}`;
    if (state.done.includes(step)) continue;
    progress(run, `${stage} (core stage ${stages.indexOf(stage) + 1} of ${stages.length})`);
    const ran = PABLO_STAGES.includes(stage) ? await runPabloStage(run, stage) : await runCoreStage(run, stage);
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

  retitleFromPremise(run);

  for (const id of state.outputs) {
    const def = outputDefinition(id);
    if (def === undefined) return refuse(`pablo: story: there is no ${id} output on this machine (pablo has: ${outputIds().join(", ")})`, [`output ${id}`]);

    const addStep = `output:${id}`;
    if (!state.done.includes(addStep)) {
      progress(run, `${id}: adding the output`);
      const marker = readMarker(run.work);
      if (!marker.ok) return refuse(marker.message);
      if (marker.marker.outputs[id] === undefined) {
        let added = addOutput(run.vault, run.work, id, run.deps.now ? { now: run.deps.now } : {});
        // A fiction essay argues a thesis (AGT-2135). Nobody is asked in a story run: the premise is assumed and recorded.
        const thesis = !added.ok && added.ask === "thesis" ? assumedThesis(run.work) : undefined;
        if (thesis !== undefined) {
          state.assumptions.push({
            stage: addStep,
            question: "What does the essay argue about the story?",
            why: "an essay on a fiction work argues a thesis; the story's premise is assumed (edit outputs/essay/thesis.md to change it)",
            options: [thesis],
          });
          saveState(run.work, state);
          added = addOutput(run.vault, run.work, id, { ...(run.deps.now ? { now: run.deps.now } : {}), thesis });
        }
        if (!added.ok) return { body: added, exitCode: added.code };
      }
      markDone(run, addStep);
    }

    if (id === RADIO_ID) {
      const stopped = await advanceRadio(run);
      if (stopped !== undefined) return stopped;
      continue;
    }

    const units = def
      .report(run.work, readCoreState(run.work))
      .units.filter((u) => u.file === undefined)
      .map((u) => u.unit)
      .sort((a, b) => a - b);
    const totalUnits = def.report(run.work, readCoreState(run.work)).total;
    for (const unit of units) {
      progress(run, `${id}: drafting ${def.noun} ${unit} of ${totalUnits}`);
      const drafted = await draftUnit(run, def, unit);
      if (!drafted.ok) return drafted.result;
      const step = `draft:${id}:${unit}`;
      if (state.review) {
        state.pending = { step, branch: drafted.branch, sha: git(run.repo, ["rev-parse", drafted.branch]) };
        (state.drafts[id] ??= []).push({ unit, branch: drafted.branch, path: drafted.path, check: drafted.check, checkNotices: drafted.checkNotices });
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
      (state.drafts[id] ??= []).push({ unit, branch: drafted.branch, path: drafted.path, merged: merged.sha, check: drafted.check, checkNotices: drafted.checkNotices });
      markDone(run, step);
    }

    const publishStep = `publish:${id}`;
    if (!state.done.includes(publishStep)) {
      const target = def.publish.targets[0] as string;
      progress(run, `${id}: publishing (${target})`);
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
  const finalMarker = readMarker(run.work);
  const core = coreStages(readCoreState(run.work, finalMarker.ok ? trackOf(finalMarker.marker) : undefined)).map((s) => ({ id: s.id, done: s.done, summary: s.summary }));
  return {
    body: {
      ok: true,
      project: run.slug,
      path: run.work,
      title: run.title,
      ...(state.track === undefined ? {} : { track: state.track }),
      ...(state.adopted === undefined ? {} : { adopted: state.adopted }),
      outputs: state.outputs,
      review: state.review,
      core,
      plan: state.plan,
      drafts: state.drafts,
      published: state.published,
      assumptions: state.assumptions,
      receipts: receiptsPath(run.work),
      ...transcriptsOf(run),
    },
    exitCode: 0,
  };
}

/** A review run's pending branch: merged moves on, still open waits, dropped runs the step again. A radio approval is given by resuming. */
function settlePending(run: Run): VerbResult | undefined {
  const pending = run.state.pending;
  if (pending === undefined) return undefined;
  if (pending.approve !== undefined) {
    const unit = pending.unit as number;
    // A render with open flags (the author's, or perform's automatic ones) is not approved: fix or clear them first.
    if (pending.approve === "render" && episodeState(run.work, unit).openFlags > 0) return radioApproval(run, pending.step, "render", unit);
    delete run.state.pending;
    markDone(run, pending.step);
    return undefined;
  }
  if (pending.branch === undefined || pending.sha === undefined) {
    delete run.state.pending;
    saveState(run.work, run.state);
    return undefined;
  }
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

/** The request a hand-built work was asked for: the README's `> ` quote under "Asked for", else the work's title. */
function promptOf(work: string, title: string): string {
  const readme = existsSync(join(work, "README.md")) ? readFileSync(join(work, "README.md"), "utf8") : "";
  const quote = /Asked for on [^\n]*:\n\n((?:>[^\n]*\n?)+)/.exec(readme)?.[1];
  const text = quote?.split("\n").map((l) => l.replace(/^>\s?/, "")).join("\n").trim();
  return text !== undefined && text !== "" ? text : `Continue the work titled "${title}".`;
}

/**
 * `pablo story --project <slug> --from <stage>` (AGT-2289, D-22): everything before `from` stays and must be complete
 * (the research gate open on historical-fiction); `from` and later stages' files, and every declared output, are
 * archived under `_archived/<from>-<date>/` (outputs through `output remove`'s own archive), never deleted; a fresh
 * run record then resumes at `from`. Every refusal comes before anything is moved.
 */
async function adoptFrom(args: StoryArgs, from: string, run0: { vault: string; repo: string; work: string; ctx: VerbContext; deps: StoryDeps }): Promise<VerbResult> {
  const { vault, repo, work, ctx, deps } = run0;
  const marker = readMarker(work);
  if (!marker.ok) return refuse(marker.message);
  const track = trackOf(marker.marker);
  if (track === "nonfiction") return refuse("pablo: story: pablo story writes fiction; a nonfiction work is built with its own verbs (pablo guide); nothing was moved");
  const stages = storyStages(track);
  const at = stages.indexOf(from as StoryCoreStage);
  if (at < 0) return refuse(`pablo: story: --from ${JSON.stringify(from)} is not a stage of the ${track} core (stages: ${stages.join(", ")}); nothing was moved`, [`--from ${stages.join(" | ")}`]);

  const prior = readState(work);
  if (prior?.pending?.branch !== undefined && branchExists(repo, prior.pending.branch) && prior.pending.sha !== undefined && !isMerged(repo, prior.pending.sha)) {
    return refuse(`pablo: story: the run is waiting on ${prior.pending.branch}; accept or drop it first; nothing was moved`, [prior.pending.branch]);
  }

  // The stages before `from` must already be complete.
  const missing = stages.slice(0, at).flatMap((stage) => (stageMissing(work, stage) ?? []).map((m) => `${stage}: ${m}`));
  if (missing.length > 0) {
    const short = [...new Set(missing.map((m) => m.split(":")[0]))];
    return refuse(`pablo: story: --from ${from} keeps the stages before it, and ${short.join(", ")} ${short.length === 1 ? "is" : "are"} not complete; nothing was moved`, missing);
  }

  const prompt = args.prompt?.trim() || prior?.prompt || promptOf(work, marker.marker.title);
  const declared = Object.keys(marker.marker.outputs);
  const requested = [...new Set((args.output ?? []).map((o) => o.trim()).filter((o) => o !== ""))];
  const outputs = requested.length > 0 ? requested : prior?.outputs !== undefined && prior.outputs.length > 0 ? [...prior.outputs] : declared.length > 0 ? declared : [defaultOutput(prompt)];
  const blocked = await ensureOutputs(outputs);
  if (blocked !== undefined) return blocked;
  const offTrack = outputsOffTrack(outputs, track);
  if (offTrack !== undefined) return offTrack;

  const now = deps.now ?? (() => new Date());
  const date = localDate(now());
  const plan = planArchive(work, stages.slice(at));
  const outputDirs = declared.flatMap((id) => {
    const dir = outputDefinition(id)?.artifactDir;
    return dir !== undefined && !dir.startsWith("outputs/") ? [dir] : [];
  });
  const abs = (rel: string): string => join(work, rel);
  // Everything this run will move or rewrite, including what `output remove` will archive, so no refusal comes after a move.
  const dirty = dirtyPaths(
    vault,
    [...plan.moves, ...plan.rewrites.map((r) => r.rel), ...outputDirs, ...declared.map((id) => `outputs/${id}`), "pablo.json"].filter((rel) => existsSync(abs(rel))).map((rel) => relative(vault, abs(rel))),
  );
  if (dirty.length > 0) return refuse(`pablo: story: uncommitted changes in ${dirty.join(", ")}; commit or discard them first; nothing was moved`, dirty);

  const dest = archiveDest(work, from, date);
  const touched = applyArchive(work, plan, dest);
  // A hand-built work may not ignore its machine state yet (`pablo story` arranges it for the works it creates).
  if (ensureGitignoreEntry(vault, ".pablo/")) touched.push(relative(work, join(vault, ".gitignore")));
  // Outputs derive from the core: archive each (readers first), as `output remove` does, then a directory it leaves (the novel's chapters).
  const derived = (id: string): boolean => outputDefinition(id)?.derive !== undefined;
  for (const id of [...declared].sort((a, b) => Number(derived(b)) - Number(derived(a)))) {
    const removed = removeOutput(vault, work, id, { now });
    if (!removed.ok) return { body: removed, exitCode: removed.code };
  }
  for (const dir of outputDirs) touched.push(...moveDirToArchive(work, dir, dest));
  if (touched.length > 0) {
    const committed = gitCommit(vault, `${marker.marker.slug}: archive the ${from} stage and later (pablo story --from)`, [...new Set(touched)].map(abs));
    if (!committed.committed) return fail(committed.notice ?? "pablo: story: could not commit the archive", { path: work });
  }

  const stageDone = stages.slice(0, at).map((s) => `core:${s}`);
  const state: StoryState = {
    version: 1,
    prompt,
    outputs,
    review: args.review === true || prior?.review === true,
    ...(args.noCheck === true || args["no-check"] === true || prior?.noCheck === true ? { noCheck: true } : {}),
    ...(args.words !== undefined ? { words: args.words } : prior?.words !== undefined ? { words: prior.words } : {}),
    started: now().toISOString(),
    track: prior?.track?.track === track ? prior.track : { track, inferred: false, why: "the adopted work's pablo.json" },
    // An adopted work keeps its own title; the premise stage does not rename it.
    titled: true,
    done: stageDone,
    plan: [],
    drafts: {},
    published: {},
    assumptions: prior?.assumptions ?? [],
    ...(prior?.transcripts === undefined ? {} : { transcripts: prior.transcripts }),
    adopted: { from, archived: plan.moves.length + plan.rewrites.length + outputDirs.length === 0 ? "" : dest, outputs: declared },
  };
  saveState(work, state);
  ctx.stderr.write(`pablo story: adopting ${marker.marker.slug} from ${from} (request: ${prompt.split("\n")[0]!.slice(0, 80)})${touched.length === 0 ? " (nothing to archive)" : `; archived to ${dest}`}\n`);
  return advance({ vault, repo, work, slug: marker.marker.slug, title: marker.marker.title, state, ctx, deps });
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

  if (args.from !== undefined && args.project === undefined) {
    return refuse("pablo: story: --from needs --project <slug>, the work to adopt and run from that stage", ["--project <slug>"]);
  }

  if (args.project !== undefined) {
    if (args.from !== undefined) {
      const project = resolveProject(vault.path, args.project);
      if (!project.ok) return { body: { ok: false, code: project.code, message: project.message, tried: project.tried }, exitCode: project.code };
      return adoptFrom(args, args.from.trim(), { vault: vault.path, repo, work: project.path, ctx, deps });
    }
    if (prompt !== "") return refuse('pablo: story: pass "<prompt>" to start a story, or --project <slug> to continue one, not both');
    const project = resolveProject(vault.path, args.project);
    if (!project.ok) return { body: { ok: false, code: project.code, message: project.message, tried: project.tried }, exitCode: project.code };
    const state = readState(project.path);
    if (state === undefined) return refuse(`pablo: story: no pablo story run is recorded in ${join(project.path, STATE_FILE)}; to adopt this work and run from a stage, pass --from <stage>`, [`--from <stage> (adopt this work)`, `"<prompt>" (start a new run)`]);
    const marker = readMarker(project.path);
    if (!marker.ok) return refuse(marker.message);
    if (args.review === true) state.review = true;
    if (args.noCheck === true || args["no-check"] === true) state.noCheck = true;
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
  const track = await chooseTrack(args, prompt, ctx, deps);
  if ("body" in track) return track;
  const offTrack = outputsOffTrack(outputs, track.track);
  if (offTrack !== undefined) return offTrack;
  ctx.stderr.write(`pablo story: track ${trackLine(track)}\n`);

  const now = deps.now ?? (() => new Date());
  const date = localDate(now());
  let title = args.title?.trim() ?? "";
  if (title === "") {
    // AGT-2290: one planner call names the work (a title, not a prompt prefix); the slug is cut from it.
    ctx.stderr.write("pablo story: titling the work from the prompt\n");
    const planner = storyPlanner(ctx, deps);
    title = (planner instanceof Error ? undefined : await planTitle(prompt, planner)) ?? titleFromPrompt(prompt);
  }
  const slug = freeSlug(vault.path, title);
  const category = outputs.includes("novel") ? "novels" : "stories";
  const work = join(vault.path, category, slug);

  const files = scaffold(title, prompt, date, track.track);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(work, rel)), { recursive: true });
    writeFileSync(join(work, rel), content, "utf8");
  }
  writeMarker(work, { title, slug, author: DEFAULT_AUTHOR, voice: DEFAULT_VOICE, neverSend: DEFAULT_NEVER_SEND, publish: DEFAULT_PUBLISH, outputs: {}, track: track.track });
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
    ...(args.noCheck === true || args["no-check"] === true ? { noCheck: true } : {}),
    ...(words === undefined ? {} : { words }),
    started: now().toISOString(),
    track,
    ...(args.title?.trim() ? { titled: true } : {}),
    done: [],
    plan: [],
    drafts: {},
    published: {},
    assumptions: [],
  };
  saveState(work, state);
  return advance({ vault: vault.path, repo, work, slug, title, state, ctx, deps });
}
