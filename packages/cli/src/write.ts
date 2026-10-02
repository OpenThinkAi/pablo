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

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  createProviders,
  DEFAULT_MIN_SCENES,
  EndpointHung,
  fileReceiptSink,
  loadConfig,
  normalizeOutput,
  packTimeoutMs,
  ProviderConfigError,
  ProviderResponseError,
  renderPack,
  splitManuscript,
  withReceipts,
} from "@openthink/pablo-core";
import type { Adapter, CompletionStats, Intent } from "@openthink/pablo-core";
import { branchExists, commitAs, createBranch, deleteBranch, repoRoot } from "./branch";
import { checkFile, loadCheckRules } from "./check";
import type { Hit } from "./check";
import { readMarker } from "./marker";
import { buildChapterPack, DEFAULT_WORD_TARGET } from "./novel/pack";
import { chapterPreconditions, readNovelState } from "./novel/machine";
import { runQueueRitual } from "./novel/rituals";
import type { Ritual } from "./novel/rituals";
import { mintPieceId } from "./review";

/**
 * Exit codes: the contract every ticket builds on, defined once in `cli.ts`
 * (`EXIT_OK`, `EXIT_REFUSED`, `EXIT_ERROR`) and used here as the same three
 * literals — `0` ok, `2` refused, `1` error — the way `marker.ts` and
 * `project.ts` already do (each refusal there is a literal `2`, no local
 * constant), rather than a second, importable copy of the same three names.
 */

/** The fields `runWrite` needs off the CLI's parsed args. `cli.ts`'s `ParsedArgs` satisfies this. */
export interface WriteArgs {
  readonly chapter: string | undefined;
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
}

/** A minimal `process.stderr`-shaped sink, so tests can capture progress without a real TTY. */
export interface ProgressSink {
  write(text: string): void;
}

/** Dependencies a caller can inject; production code omits all of them. */
export interface RunWriteDeps {
  /** Overrides the provider registry's adapter entirely — the only way tests avoid the network. */
  readonly adapter?: Adapter | undefined;
  /** Overrides the clock used for the frontmatter's `generated` timestamp and the rituals' "today" (AGT-1231). */
  readonly now?: (() => Date) | undefined;
  /** Overrides where streaming progress is written. Defaults to `process.stderr`. */
  readonly stderr?: ProgressSink | undefined;
  /** Overrides `process.env` for the branch worktree location (`PABLO_HOME`) and the review queue's state directory. */
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

/** lowercase, non-alphanumerics collapsed to one `-`, leading/trailing `-` trimmed. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** `NN-<slug>.md`, `NN` zero-padded to at least two digits — the filename `chapterPreconditions`'s `readChapters` also expects. */
export function chapterFileName(chapter: number, beatTitle: string): string {
  return `${String(chapter).padStart(2, "0")}-${slugify(beatTitle)}.md`;
}

/** A YAML scalar needs quoting only when it contains `:` or opens with a quote/indicator character. */
const YAML_INDICATOR_START = /^[-?:,[\]{}#&*!|>'"%@`]/;

/** Exported for `prose.ts`'s `--out` frontmatter (AGT-1242) — one quoting rule for every frontmatter block pablo writes, not a second copy of it. */
export function yamlScalar(value: string): string {
  if (!value.includes(":") && !YAML_INDICATOR_START.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface FrontmatterFields {
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
    `chapter: ${fields.chapter}`,
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

/** `draft/chNN`, or the first free `draft/chNN-vK` when that branch already exists (a re-draft). */
function draftBranchName(repo: string, chapter: number): string {
  const base = `draft/ch${String(chapter).padStart(2, "0")}`;
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

function emitWriteSuccess(
  json: boolean,
  path: string,
  receipt: WriteReceiptSummary,
  hits: readonly Hit[],
  rituals: readonly Ritual[],
  piece: string,
  branch: DraftBranch,
): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, path, branch: branch.name, worktree: branch.worktree, commit: branch.sha, receipt, check: hits, rituals, piece }));
    return;
  }
  console.log(`wrote ${path} (${receipt.words} words) on branch ${branch.name}`);
  const writeMs = receipt.wallMs - receipt.timeToFirstTokenMs;
  console.log(
    `read ${receipt.tokensRead} tokens in ${seconds(receipt.timeToFirstTokenMs)}s, ` +
      `wrote ${receipt.tokensWritten} in ${seconds(writeMs)}s`,
  );
  if (receipt.temperature !== undefined) {
    console.log(`sampled at temperature ${receipt.temperature}${receipt.seed === undefined ? "" : `, seed ${receipt.seed}`}`);
  }
  for (const hit of hits) console.log(formatHitLine(hit));
  for (const ritual of rituals) console.log(`ritual ${ritual.name}: ${ritual.status} — ${ritual.detail}`);
  // AGT-1262 AC4: the review queue's piece id, so the agent driving `write`
  // can hand it straight to `pablo review wait <id>` without re-parsing the
  // rituals line.
  console.log(`piece ${piece}`);
}

/**
 * `runWrite`: parse `--chapter`; check the novel machine's preconditions for
 * it (refuse, exit 2, naming `missing[]`, if unmet — AC1); assemble the
 * drafting pack (`buildChapterPack`, which also refuses on a `neverSend`
 * violation, AC3). With `--dry-run`, render it and exit 0. Without, send the
 * pack once to the routed provider, normalize the answer, write
 * `chapters/NN-<slug>.md` with provenance frontmatter (refusing instead of
 * overwriting unless `--force`), append a receipt, run the post-write
 * mechanical-tells check, and return the receipt.
 */
export async function runWrite(
  args: WriteArgs,
  vaultRoot: string,
  projectPath: string,
  deps: RunWriteDeps = {},
): Promise<number> {
  const chapter = parsePositiveInt(args.chapter);
  if (chapter === undefined) {
    emitError("pablo: write requires --chapter <N> (a positive integer)", undefined, 2, args.json);
    return 2;
  }

  const words = parsePositiveInt(args.words) ?? DEFAULT_WORD_TARGET;
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

  const state = readNovelState(projectPath);
  const preconditions = chapterPreconditions(state, chapter);
  if (!preconditions.ready) {
    emitError(`pablo: chapter ${chapter} is not ready to draft`, preconditions.missing, 2, args.json);
    return 2;
  }

  const packResult = buildChapterPack(vaultRoot, projectPath, chapter, {
    words,
    scenes,
    marker: markerResult.marker,
    direction,
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
      };
      console.log(JSON.stringify(body));
    } else {
      const providers = createProviders(loadConfig());
      const providerId = providers.route(DRAFT_INTENT);
      console.log(renderPack(pack, providers.rates(providerId)).text);
    }
    return 0;
  }

  // The filename comes from the beat's own title, not the model's answer — it
  // has to exist before anything is sent, so an existing file (without
  // --force) refuses before the model is ever called.
  const fileName = chapterFileName(chapter, packResult.inputs.beat.title);
  const workRelativePath = join("chapters", fileName).split(sep).join("/");
  const filePath = join(projectPath, "chapters", fileName);

  if (existsSync(filePath) && !args.force) {
    emitError(`pablo: ${workRelativePath} already exists; use --force to overwrite`, undefined, 2, args.json);
    return 2;
  }

  // The chapter is committed on its own branch, never on main (AGT-1536). The
  // branch and worktree are made before the model is called so a project that
  // is not a git repository refuses up front rather than after the draw.
  const repo = repoRoot(projectPath);
  if (repo === undefined) {
    emitError(`pablo: write needs ${projectPath} inside a git repository (the draft is committed on draft/ch${String(chapter).padStart(2, "0")})`, undefined, 2, args.json);
    return 2;
  }
  const env = deps.env ?? process.env;
  const branchName = draftBranchName(repo, chapter);
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

  const config = loadConfig();
  const providers = createProviders(config);
  const providerId = providers.route(DRAFT_INTENT);
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
  const wrapped = withReceipts(draftAdapter, fileReceiptSink(projectPath), { pack, intent: "draft" });

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
  // One sentence per line on disk (AGT-1531); the model only ever sees paragraphs.
  const fileContent = `${frontmatter}\n\n${splitManuscript(normalized)}\n`;

  // The project's path inside the repo, so the file lands at the same place in the worktree.
  const projectInRepo = relative(realpathSync(repo), realpathSync(projectPath));
  const worktreeFile = join(worktree, projectInRepo, "chapters", fileName);
  mkdirSync(dirname(worktreeFile), { recursive: true });
  writeFileSync(worktreeFile, fileContent, "utf8");

  const hits = checkFile(normalized, workRelativePath, loadCheckRules(vaultRoot));

  const receipt: WriteReceiptSummary = {
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
  // merged (`novel/merge.ts`). AGT-1262: the piece id is minted here so it
  // reaches the output even if the queue append fails; the queue event names
  // the path the chapter will have on main.
  const committed = commitAs(worktree, {
    message: `${markerResult.marker.slug}: draft chapter ${chapter}`,
    author: { name: draftAdapter.model, email: `${slugify(draftAdapter.model) || "model"}@pablo.local` },
    receipt: pack.hash,
    paths: [join(projectInRepo, "chapters", fileName)],
  });
  if (!committed.ok) {
    emitError(`${committed.notice}\n  the draft is in ${worktree}, uncommitted`, undefined, 1, args.json);
    return 1;
  }
  const branch: DraftBranch = { name: branchName, worktree, sha: committed.sha as string };

  const pieceId = mintPieceId(now(), markerResult.marker.slug);
  const rituals = [
    runQueueRitual(
      filePath,
      chapter,
      {
        id: pieceId,
        slug: markerResult.marker.slug,
        words: wordCount,
        title: packResult.inputs.beat.title,
        vault: vaultRoot,
        promptHash: pack.hash,
      },
      { env: deps.env, now },
    ),
  ];

  emitWriteSuccess(args.json, workRelativePath, receipt, hits, rituals, pieceId, branch);
  return 0;
}
