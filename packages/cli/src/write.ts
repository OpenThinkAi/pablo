/**
 * `pablo write --project <slug> --chapter N` (AGT-1230 part 1: the pack and
 * `--dry-run`; AGT-1237 part 2: send, normalize, write the file, receipt).
 * See the design doc's `The write pipeline` section
 * (`pm project show ai-terminal`) — this file now
 * covers every step: check, pack, dry-run OR send, normalize, write, and the
 * post-write mechanical-tells check. The chapter is committed on its own
 * `draft/chNN` branch in a worktree, never on `main` (AGT-1536); the
 * after-write steps (outline, note, README, continuity, git, think sync) run
 * when that branch is merged (`novel/merge.ts`), not here. `save`'s ritual
 * commit (AGT-1231) is a separate concern and does not happen here.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  createProviders,
  DEFAULT_MIN_SCENES,
  EndpointHung,
  fileReceiptSink,
  NoModelConfiguredError,
  loadConfig,
  normalizeOutput,
  packTimeoutMs,
  ProviderConfigError,
  ProviderResponseError,
  renderPack,
  splitManuscript,
  withReceipts,
} from "@openthink/pablo-core";
import type { Adapter, CompletionStats, Intent, PabloConfig, Providers } from "@openthink/pablo-core";
import { branchExists, commitAs, createBranch, deleteBranch, repoRoot } from "./branch";
import { checkDraft, checkFile, loadCheckRules } from "./check";
import type { Hit } from "./check";
import { NO_WAIT_ESTIMATE_NOTE } from "./starter-config";
import { readMarker, trackOf } from "./marker";
import { readCoreState, trackGate } from "./core/machine";
import { novelUnitFileName, slugify } from "./outputs/novel/units";
import { resolveOutput } from "./outputs/registry";

export { slugify };

/**
 * Exit codes: the contract every ticket builds on, defined once in `cli.ts`
 * (`EXIT_OK`, `EXIT_REFUSED`, `EXIT_ERROR`) and used here as the same three
 * literals — `0` ok, `2` refused, `1` error — the way `marker.ts` and
 * `project.ts` already do (each refusal there is a literal `2`, no local
 * constant), rather than a second, importable copy of the same three names.
 */

/** The fields `runWrite` needs off the CLI's parsed args. `cli.ts`'s `ParsedArgs` satisfies this. */
export interface WriteArgs {
  /** `write --chapter N`: the novel's spelling of `--output novel --unit N`. */
  readonly chapter: string | undefined;
  /**
   * `write --output <type>` (AGT-1669): which of the work's outputs to draft
   * a unit of. Optional when the work has one output (the default-output
   * rule); a work with several refuses without it, naming them.
   */
  readonly output?: string | undefined;
  /** `write --unit N` (AGT-1669): the unit of that output (a chapter, an episode). */
  readonly unit?: string | undefined;
  readonly words: string | undefined;
  readonly scenes: string | undefined;
  readonly dryRun: boolean;
  readonly json: boolean;
  /** `write --force`: overwrite an existing chapter file. Defaults to `false`. */
  readonly force: boolean;
  /** `write --temperature T`: sampling temperature, 0 to 2. Defaults to the provider's config, then `DEFAULT_WRITE_TEMPERATURE`. */
  readonly temperature?: string | undefined;
  /** `write --seed N`: sampling seed, for a reproducible draw. Absent means the endpoint picks one. */
  readonly seed?: string | undefined;
  /** `write --direction "<text>"` (AGT-1562): a steer for this chapter, its own pack slice, recorded in the frontmatter as `direction:`. */
  readonly direction?: string | undefined;
  /**
   * `write --voices narrator|characters` (AGT-2137): who reads a derived
   * output's unit (the narrated output). Refused for an output drafted by
   * the writer.
   */
  readonly voices?: string | undefined;
  /** `write --no-check` (AGT-2115): skip the track's checks after the draft (the mechanical tells still run). */
  readonly noCheck?: boolean | undefined;
}

/** A minimal `process.stderr`-shaped sink, so tests can capture progress without a real TTY. */
export interface ProgressSink {
  write(text: string): void;
}

/** Dependencies a caller can inject; production code omits all of them. */
export interface RunWriteDeps {
  /** Overrides the provider registry's adapter entirely — the only way tests avoid the network. */
  readonly adapter?: Adapter | undefined;
  /** Overrides the clock used for the frontmatter's `generated` timestamp. */
  readonly now?: (() => Date) | undefined;
  /** Overrides where streaming progress is written. Defaults to `process.stderr`. */
  readonly stderr?: ProgressSink | undefined;
  /** Overrides `process.env` for the branch worktree location (`PABLO_HOME`). */
  readonly env?: Record<string, string | undefined> | undefined;
}

/** The intent a drafting pack routes under — see `providers/registry.ts`'s `route`. */
const DRAFT_INTENT: Intent = { name: "draft", kind: "drafting" };

/**
 * The temperature a chapter draft is sampled at when neither `--temperature`
 * nor the provider's config names one. Without any, mlx_lm.server decodes
 * greedily and an identical pack reproduces byte-identical prose (AGT-1272),
 * which makes a second opinion on a chapter, and `--variants`, impossible.
 */
export const DEFAULT_WRITE_TEMPERATURE = 0.8;

/** The `model` a derived unit (AGT-2137) records: pablo made it from another unit, no model drew it. */
export const DERIVED_MODEL = "pablo-derived";

/** How often (ms) the streaming progress line refreshes once tokens are flowing. */
const PROGRESS_INTERVAL_MS = 2000;

/** `--chapter`'s value as a positive integer, or `undefined` for anything else (including absent). */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value > 0 ? value : undefined;
}

/** `--temperature`'s value as a number from 0 to 2, `undefined` when absent, `null` for anything else. */
function parseTemperature(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= 2 ? value : null;
}

/** `--seed`'s value as a non-negative integer, `undefined` when absent, `null` for anything else. */
function parseSeed(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * The config and the provider the `draft` intent routes to, or the refusal that
 * says why there is none: no model configured (AGT-2131) or a config pablo
 * cannot read. Nothing is sent and nothing is created before this passes.
 */
function routeDraft(
  projectPath: string,
):
  | { readonly ok: true; readonly config: PabloConfig; readonly providers: Providers; readonly providerId: string }
  | { readonly ok: false; readonly message: string; readonly noModel: boolean } {
  try {
    const config = loadConfig({ projectDir: projectPath });
    const providers = createProviders(config);
    return { ok: true, config, providers, providerId: providers.route(DRAFT_INTENT) };
  } catch (error) {
    if (error instanceof ProviderConfigError) return { ok: false, message: error.message, noModel: error instanceof NoModelConfiguredError };
    throw error;
  }
}

function emitError(message: string, missing: readonly string[] | undefined, code: number, json: boolean): void {
  if (json) {
    const body: Record<string, unknown> = { ok: false, code, message };
    if (missing !== undefined) body["missing"] = missing;
    console.log(JSON.stringify(body));
    return;
  }
  console.error(message);
  if (missing !== undefined) for (const item of missing) console.error(`  ${item}`);
}

/** `NN-<slug>.md`, `NN` zero-padded to at least two digits — the novel output's `unitFileName`, the filename `chapterPreconditions`'s `readChapters` also expects. */
export function chapterFileName(chapter: number, beatTitle: string): string {
  return novelUnitFileName(chapter, beatTitle);
}

/** A YAML scalar needs quoting only when it contains `:` or opens with a quote/indicator character. */
const YAML_INDICATOR_START = /^[-?:,[\]{}#&*!|>'"%@`]/;

/** Exported for `prose.ts`'s `--out` frontmatter (AGT-1242) — one quoting rule for every frontmatter block pablo writes, not a second copy of it. */
export function yamlScalar(value: string): string {
  if (!value.includes(":") && !YAML_INDICATOR_START.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface FrontmatterFields {
  /** The frontmatter key the unit number goes under: the output's noun (`chapter` for the novel). */
  readonly noun: string;
  readonly chapter: number;
  readonly title: string;
  readonly pov: string;
  readonly storyDate: string;
  readonly words: number;
  readonly model: string;
  readonly generated: string;
  readonly promptHash: string;
  /** The direction the draft was steered with, when one was given. */
  readonly direction?: string | undefined;
}

/**
 * The hand-written frontmatter block, key order fixed: `chapter`, `title`,
 * `pov`, `story_date`, `status`, `words`, `model`, `generated`,
 * `prompt_hash` — the real vault's chapter 1 order (AC2), plus the
 * provenance keys `pablo check` requires, then `direction` when one steered
 * the draft (AGT-1562).
 */
function buildFrontmatter(fields: FrontmatterFields): string {
  return [
    "---",
    `${fields.noun}: ${fields.chapter}`,
    `title: ${yamlScalar(fields.title)}`,
    `pov: ${yamlScalar(fields.pov)}`,
    `story_date: ${yamlScalar(fields.storyDate)}`,
    "status: draft",
    `words: ${fields.words}`,
    `model: ${yamlScalar(fields.model)}`,
    `generated: ${fields.generated}`,
    `prompt_hash: ${fields.promptHash}`,
    ...(fields.direction === undefined ? [] : [`direction: ${yamlScalar(fields.direction)}`]),
    "---",
  ].join("\n");
}

/** The branch a draft was committed on: its name, worktree and commit. */
interface DraftBranch {
  readonly name: string;
  readonly worktree: string;
  readonly sha: string;
}

/** The output's draft branch (`draft/chNN`), or the first free `<branch>-vK` when that branch already exists (a re-draft). */
function draftBranchName(repo: string, base: string): string {
  if (!branchExists(repo, base)) return base;
  for (let v = 2; ; v += 1) {
    if (!branchExists(repo, `${base}-v${v}`)) return `${base}-v${v}`;
  }
}

/** One line per `pablo check` hit, in the exact format `check.ts`'s `runCheck` prints. */
function formatHitLine(hit: Hit): string {
  const detail = hit.detail !== undefined ? ` (${hit.detail})` : "";
  return `${hit.path}:${hit.line} ${hit.rule} — ${hit.excerpt}${detail}`;
}

function seconds(ms: number): string {
  return (Math.max(ms, 0) / 1000).toFixed(1);
}

export interface WriteReceiptSummary {
  readonly prompt_hash: string;
  readonly model: string;
  readonly tokensRead: number;
  readonly tokensWritten: number;
  readonly timeToFirstTokenMs: number;
  readonly wallMs: number;
  readonly words: number;
  /** The sampling the draft was made with; also in the receipts.jsonl line's `params`. */
  readonly temperature?: number;
  readonly seed?: number;
}

/** A unit write's receipt (AGT-1669): the summary plus the output and unit it drafted, also in the receipts.jsonl line. */
export interface UnitReceiptSummary extends WriteReceiptSummary {
  readonly output: string;
  /** The unit drafted (the chapter number for the novel). */
  readonly unit: number;
}

function emitWriteSuccess(
  json: boolean,
  path: string,
  receipt: UnitReceiptSummary,
  hits: readonly Hit[],
  branch: DraftBranch,
  /** For a derived unit: the unit file it was made from (no model ran). */
  from?: string,
  /** A check that could not run (AGT-2115): reported, never fatal. */
  notices: readonly string[] = [],
): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, path, branch: branch.name, worktree: branch.worktree, commit: branch.sha, receipt, check: hits, ...(notices.length === 0 ? {} : { checkNotices: notices }), ...(from === undefined ? {} : { from }) }));
    return;
  }
  console.log(`wrote ${path} (${receipt.words} words) on branch ${branch.name}`);
  if (from !== undefined) {
    console.log(`made from ${from}, word for word; no model ran`);
    return;
  }
  const writeMs = receipt.wallMs - receipt.timeToFirstTokenMs;
  console.log(
    `read ${receipt.tokensRead} tokens in ${seconds(receipt.timeToFirstTokenMs)}s, ` +
      `wrote ${receipt.tokensWritten} in ${seconds(writeMs)}s`,
  );
  if (receipt.temperature !== undefined) {
    console.log(`sampled at temperature ${receipt.temperature}${receipt.seed === undefined ? "" : `, seed ${receipt.seed}`}`);
  }
  for (const hit of hits) console.log(formatHitLine(hit));
  for (const notice of notices) console.error(notice);
}

/**
 * `runWrite`: parse `--chapter`; check the novel machine's preconditions for
 * it (refuse, exit 2, naming `missing[]`, if unmet — AC1); assemble the
 * drafting pack (`buildChapterPack`, which also refuses on a `neverSend`
 * violation, AC3). With `--dry-run`, render it and exit 0. Without, send the
 * pack once to the routed provider, normalize the answer, write the unit
 * file (`<artifactDir>/NN-<slug>.md`) with provenance frontmatter (refusing instead of
 * overwriting unless `--force`), append a receipt, run the post-write
 * mechanical-tells check, and return the receipt.
 */
export async function runWrite(
  args: WriteArgs,
  vaultRoot: string,
  projectPath: string,
  deps: RunWriteDeps = {},
): Promise<number> {
  // `--chapter N` is `--output novel --unit N` (AGT-1669); it never addresses another output.
  if (args.chapter !== undefined && args.output !== undefined && args.output !== "novel") {
    emitError(`pablo: write: --chapter is the novel's spelling; for the ${args.output} output use --unit <N>`, undefined, 2, args.json);
    return 2;
  }
  if (args.chapter !== undefined && args.unit !== undefined && args.chapter.trim() !== args.unit.trim()) {
    emitError("pablo: write: --chapter and --unit name different units; pass one", undefined, 2, args.json);
    return 2;
  }
  const requestedOutput = args.output ?? (args.chapter !== undefined ? "novel" : undefined);
  const unitRaw = args.unit ?? args.chapter;
  let chapter = parsePositiveInt(unitRaw);
  const unitMessage = "pablo: write requires --unit <N> (a positive integer; --chapter <N> for the novel)";
  if (chapter === undefined && unitRaw !== undefined) {
    emitError(unitMessage, undefined, 2, args.json);
    return 2;
  }

  // The length is the request's; absent, the addressed output picks its own default.
  const words = parsePositiveInt(args.words);
  const scenes = parsePositiveInt(args.scenes) ?? DEFAULT_MIN_SCENES;

  const requestedTemperature = parseTemperature(args.temperature);
  if (requestedTemperature === null) {
    emitError("pablo: write --temperature must be a number from 0 to 2", undefined, 2, args.json);
    return 2;
  }
  const seed = parseSeed(args.seed);
  if (seed === null) {
    emitError("pablo: write --seed must be a non-negative integer", undefined, 2, args.json);
    return 2;
  }

  // One line: it goes in a frontmatter scalar. A blank direction is no direction.
  const direction = args.direction?.replace(/\s+/g, " ").trim() || undefined;

  const markerResult = readMarker(projectPath);
  if (!markerResult.ok) {
    emitError(markerResult.message, undefined, markerResult.code, args.json);
    return markerResult.code;
  }

  // The work's track gates drafting first (AGT-2100, D-5): a historical work with no period brief,
  // no sourced research or no period facts is refused, naming the track and the short stage.
  const gate = trackGate(readCoreState(projectPath, trackOf(markerResult.marker)));
  if (gate !== undefined) {
    emitError(`pablo: ${gate.message}`, gate.missing, 2, args.json);
    return 2;
  }

  // The addressed output owns the preconditions, the pack, the file's place and the branch.
  const resolved = resolveOutput(markerResult.marker.outputs, requestedOutput, "write", trackOf(markerResult.marker));
  if (!resolved.ok) {
    emitError(resolved.message, resolved.missing, resolved.code, args.json);
    return resolved.code;
  }
  const output = resolved.output;
  if (args.voices !== undefined && output.derive === undefined) {
    emitError(`pablo: write: --voices is for the narrated output; the ${output.id} output's ${output.plural} are drafted by the writer`, undefined, 2, args.json);
    return 2;
  }
  // An output with one unit (the story) implies it: no --unit needed.
  chapter ??= output.soleUnit;
  if (chapter === undefined) {
    emitError(unitMessage, undefined, 2, args.json);
    return 2;
  }
  const preconditions = output.preconditions(projectPath, chapter);
  if (!preconditions.ready) {
    emitError(`pablo: ${output.noun} ${chapter} is not ready to draft`, preconditions.missing, 2, args.json);
    return 2;
  }

  const packResult = output.pack(vaultRoot, projectPath, chapter, {
    words,
    scenes,
    marker: markerResult.marker,
    direction,
    output: output.id,
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(args.voices === undefined ? {} : { voices: args.voices }),
  });
  if (!packResult.ok) {
    emitError(packResult.message, undefined, packResult.code, args.json);
    return packResult.code;
  }

  const { pack } = packResult;

  if (args.dryRun) {
    if (args.json) {
      const actionByName = new Map(pack.adjustments.map((a) => [a.name, a.action]));
      const body = {
        ok: true,
        dryRun: true,
        output: output.id,
        unit: chapter,
        slices: pack.slices.map((slice) => {
          const entry: Record<string, unknown> = {
            name: slice.name,
            heading: slice.heading,
            source: slice.source,
            tokens: slice.tokens,
          };
          const action = actionByName.get(slice.name);
          if (action !== undefined) entry["action"] = action;
          return entry;
        }),
        totalTokens: pack.totalTokens,
        expectedOutputTokens: pack.expectedOutputTokens,
        prompt_hash: pack.hash,
        adjustments: pack.adjustments,
        // The layered voice (AGT-2139): every layer used, lowest first, and any voice pablo.json names that was not found.
        ...(pack.voiceLayers === undefined ? {} : { voiceLayers: pack.voiceLayers }),
        // AGT-2110: how many facts/period.md rows the prompt carries, when the work has the file.
        ...(pack.periodFacts === undefined ? {} : { periodFacts: pack.periodFacts }),
      };
      console.log(JSON.stringify(body));
    } else {
      const routed = routeDraft(projectPath);
      if (routed.ok) {
        console.log(renderPack(pack, routed.providers.rates(routed.providerId)).text);
      } else if (routed.noModel) {
        // The preview is how an author inspects the pack before choosing a model: only the wait estimate needs one.
        console.log(`${renderPack(pack).text}\n\n${NO_WAIT_ESTIMATE_NOTE}`);
      } else {
        emitError(routed.message, undefined, 2, args.json);
        return 2;
      }
    }
    return 0;
  }

  // The filename comes from the beat's own title, not the model's answer — it
  // has to exist before anything is sent, so an existing file (without
  // --force) refuses before the model is ever called.
  const fileName = output.unitFileName(chapter, packResult.inputs.beat.title);
  const workRelativePath = join(output.artifactDir, fileName).split(sep).join("/");
  const filePath = join(projectPath, output.artifactDir, fileName);

  // A unit that is a section of a shared file (the essay, AGT-2134) exists when the file has its text, not when the file does.
  const shared = output.shared;
  if (shared !== undefined) {
    if (existsSync(filePath) && shared.has(projectPath, readFileSync(filePath, "utf8"), chapter) && !args.force) {
      emitError(`pablo: ${output.noun} ${chapter} already has text in ${workRelativePath}; use --force to replace it`, undefined, 2, args.json);
      return 2;
    }
  } else if (existsSync(filePath) && !args.force) {
    emitError(`pablo: ${workRelativePath} already exists; use --force to overwrite`, undefined, 2, args.json);
    return 2;
  }

  // No model configured is a refusal before anything is made: no branch, no worktree (AGT-2131).
  // A derived output (narrated) is made with no model, so it needs none configured.
  if (output.derive === undefined) {
    const early = routeDraft(projectPath);
    if (!early.ok) {
      emitError(early.message, undefined, 2, args.json);
      return 2;
    }
  }

  // The chapter is committed on its own branch, never on main (AGT-1536). The
  // branch and worktree are made before the model is called so a project that
  // is not a git repository refuses up front rather than after the draw.
  const repo = repoRoot(projectPath);
  if (repo === undefined) {
    emitError(`pablo: write needs ${projectPath} inside a git repository (the draft is committed on ${output.branch(chapter)})`, undefined, 2, args.json);
    return 2;
  }
  const env = deps.env ?? process.env;
  const branchName = draftBranchName(repo, output.branch(chapter));
  const created = createBranch(repo, markerResult.marker.slug, branchName, env);
  if (!created.ok) {
    emitError(created.notice, undefined, 1, args.json);
    return 1;
  }
  const worktree = created.path as string;
  // A draw that produces nothing leaves no branch behind.
  const discardBranch = (): void => {
    deleteBranch(repo, markerResult.marker.slug, branchName, { force: true, env });
  };

  // A derived output (the narrated output, AGT-2137) is made from another output's unit with no model.
  if (output.derive !== undefined) {
    const derived = output.derive(projectPath, chapter, { voices: args.voices });
    if (!derived.ok) {
      discardBranch();
      emitError(derived.message, undefined, derived.code, args.json);
      return derived.code;
    }
    const text = derived.text.trim();
    const words = text.split(/\s+/).filter((w) => w !== "").length;
    const frontmatter = buildFrontmatter({
      noun: output.noun,
      chapter,
      title: packResult.inputs.beat.title,
      pov: packResult.inputs.beat.pov,
      storyDate: packResult.inputs.beat.storyDate,
      words,
      model: DERIVED_MODEL,
      generated: (deps.now ?? (() => new Date()))().toISOString(),
      promptHash: pack.hash,
    });
    const projectInRepo = relative(realpathSync(repo), realpathSync(projectPath));
    const worktreeFile = join(worktree, projectInRepo, output.artifactDir, fileName);
    mkdirSync(dirname(worktreeFile), { recursive: true });
    writeFileSync(worktreeFile, `${frontmatter}\n\n${text}\n`, "utf8");
    const committed = commitAs(worktree, {
      message: `${markerResult.marker.slug}: ${output.noun} ${chapter} from ${derived.source}`,
      author: { name: DERIVED_MODEL, email: `${DERIVED_MODEL}@pablo.local` },
      receipt: pack.hash,
      paths: [join(projectInRepo, output.artifactDir, fileName)],
    });
    if (!committed.ok) {
      emitError(`${committed.notice}\n  the ${output.noun} is in ${worktree}, uncommitted`, undefined, 1, args.json);
      return 1;
    }
    const receipt: UnitReceiptSummary = { output: output.id, unit: chapter, prompt_hash: pack.hash, model: DERIVED_MODEL, tokensRead: 0, tokensWritten: 0, timeToFirstTokenMs: 0, wallMs: 0, words };
    emitWriteSuccess(args.json, workRelativePath, receipt, [], { name: branchName, worktree, sha: committed.sha as string }, derived.source);
    return 0;
  }

  const routed = routeDraft(projectPath);
  if (!routed.ok) {
    discardBranch();
    emitError(routed.message, undefined, 2, args.json);
    return 2;
  }
  const { config, providers, providerId } = routed;

  // The flag wins, then the routed provider's own config, then the default. The
  // pack (and so `prompt_hash`) never sees any of this: sampling is a property
  // of the call, recorded in the receipt's `params`.
  const temperature =
    requestedTemperature ?? config.providers.get(providerId)?.temperature ?? DEFAULT_WRITE_TEMPERATURE;

  // "Serialized per endpoint": createProviders/registry.ts's gateFor gives every
  // local endpoint one shared Gate (queue.ts), and the OpenAI-compatible
  // adapter (openai.ts's complete()) holds it for the whole stream. That
  // already serializes concurrent calls to the same endpoint across a single
  // Providers instance; runWrite builds one Providers per CLI invocation (one
  // call per process), so no additional serialization is needed here.
  const draftAdapter = deps.adapter ?? providers.adapter(providerId);
  const wrapped = withReceipts(draftAdapter, fileReceiptSink(projectPath), { pack, intent: "draft", address: { output: output.id, unit: chapter } });

  const stderr = deps.stderr ?? process.stderr;
  const now = deps.now ?? (() => new Date());

  const startedAt = Date.now();
  let firstTokenAt: number | undefined;
  let lastProgressAt = startedAt;
  let tokenEvents = 0;
  let text = "";
  let stats: CompletionStats | undefined;

  stderr.write("waiting for first token…\n");

  try {
    for await (const ev of wrapped.complete({
      prompt: pack.prompt,
      maxTokens: pack.expectedOutputTokens * 2,
      temperature,
      ...(seed === undefined ? {} : { seed }),
      timeoutMs: packTimeoutMs(pack, providers.rates(providerId)),
    })) {
      if (ev.type === "token") {
        text += ev.text;
        tokenEvents += 1;
        const nowMs = Date.now();
        if (firstTokenAt === undefined) {
          firstTokenAt = nowMs;
          lastProgressAt = nowMs;
          stderr.write(`first token after ${seconds(nowMs - startedAt)}s\n`);
        } else if (nowMs - lastProgressAt >= PROGRESS_INTERVAL_MS) {
          const rate = tokenEvents / Math.max((nowMs - firstTokenAt) / 1000, 0.001);
          stderr.write(`${tokenEvents} tokens, ${rate.toFixed(1)} tok/s\n`);
          lastProgressAt = nowMs;
        }
      } else {
        stats = ev.stats;
      }
    }
  } catch (error) {
    stderr.write("\n");
    discardBranch();
    if (error instanceof EndpointHung || error instanceof ProviderResponseError || error instanceof ProviderConfigError) {
      emitError(error.message, undefined, 2, args.json);
      return 2;
    }
    throw error;
  }

  stderr.write("\n");

  const normalized = normalizeOutput(text);
  if (normalized === "" || stats === undefined) {
    discardBranch();
    emitError("pablo: the model returned an empty answer; nothing written", undefined, 2, args.json);
    return 2;
  }

  const wordCount = normalized.split(/\s+/).filter((w) => w !== "").length;
  const generated = now().toISOString();

  const frontmatter = buildFrontmatter({
    noun: output.noun,
    chapter,
    title: packResult.inputs.beat.title,
    pov: packResult.inputs.beat.pov,
    storyDate: packResult.inputs.beat.storyDate,
    words: wordCount,
    model: draftAdapter.model,
    generated,
    promptHash: pack.hash,
    direction,
  });
  // One sentence per line on disk (AGT-1531); the model only ever sees paragraphs. A type whose lines are its
  // structure (a radio script: a speaker, a cue or the CAST: line per line, AGT-1686; a screenplay's Fountain,
  // AGT-2132) is stored as written.
  const asWritten = output.manuscript === "lines" || output.manuscript === "screenplay";
  const body = asWritten ? normalized : splitManuscript(normalized);

  // The project's path inside the repo, so the file lands at the same place in the worktree.
  const projectInRepo = relative(realpathSync(repo), realpathSync(projectPath));
  const worktreeFile = join(worktree, projectInRepo, output.artifactDir, fileName);
  mkdirSync(dirname(worktreeFile), { recursive: true });
  // A shared file (the essay) gets the unit put into the branch's copy, every other unit kept.
  const fileContent =
    shared === undefined
      ? `${frontmatter}\n\n${body}\n`
      : shared.put(projectPath, existsSync(worktreeFile) ? readFileSync(worktreeFile, "utf8") : undefined, chapter, body, frontmatter);
  writeFileSync(worktreeFile, fileContent, "utf8");

  const hits = checkFile(normalized, workRelativePath, loadCheckRules(vaultRoot));

  const receipt: UnitReceiptSummary = {
    output: output.id,
    unit: chapter,
    prompt_hash: pack.hash,
    model: draftAdapter.model,
    tokensRead: stats.tokensRead ?? pack.totalTokens,
    tokensWritten: stats.tokensWritten,
    timeToFirstTokenMs: Math.round(stats.timeToFirstTokenMs),
    wallMs: Math.round(stats.elapsedMs),
    words: wordCount,
    temperature,
    ...(seed === undefined ? {} : { seed }),
  };

  // The draft is committed as the model that wrote it, with the prompt hash as
  // its receipt. The after-write steps (outline tick, note, README,
  // continuity, think sync) are not run here: they run when the branch is
  // merged (`novel/merge.ts`).
  const committed = commitAs(worktree, {
    message: `${markerResult.marker.slug}: draft ${output.noun} ${chapter}`,
    author: { name: draftAdapter.model, email: `${slugify(draftAdapter.model) || "model"}@pablo.local` },
    receipt: pack.hash,
    paths: [join(projectInRepo, output.artifactDir, fileName)],
  });
  if (!committed.ok) {
    emitError(`${committed.notice}\n  the draft is in ${worktree}, uncommitted`, undefined, 1, args.json);
    return 1;
  }
  const branch: DraftBranch = { name: branchName, worktree, sha: committed.sha as string };

  // The track's checks on the fresh unit (AGT-2115, D-10): hits join the receipt, the text is never touched, and a check
  // that cannot run is a notice. They run in the draft's worktree, where the unit now sits.
  let reported: readonly Hit[] = hits;
  let notices: readonly string[] = [];
  if (args.noCheck !== true) {
    const checked = await checkDraft(vaultRoot, join(worktree, projectInRepo), output.id, chapter, { env: env as NodeJS.ProcessEnv, progress: (line) => stderr.write(`${line}\n`) });
    const seen = new Set(hits.map((h) => `${h.path}:${h.line}:${h.rule}`));
    reported = [...hits, ...checked.hits.filter((h) => !seen.has(`${h.path}:${h.line}:${h.rule}`))];
    notices = checked.notices;
  }

  emitWriteSuccess(args.json, workRelativePath, receipt, reported, branch, undefined, notices);
  return 0;
}
