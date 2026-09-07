/**
 * `pablo prose --voice <name> --brief <file|-> [--context <file>]...
 *   [--format email|post|page|reply|note] [--words N] --dry-run` (AGT-1241):
 * the freeform prose path — a voice plus a brief, no stage machine, no
 * `--project`. See the design doc's extension
 * (`~/saltline-digital-vault/projects/ai-terminal/prose.md`).
 *
 * This ticket wires assembly and `--dry-run` only. Without `--dry-run`,
 * `proseCore` refuses with exit 1 "not wired to the model yet" — the send
 * path (routing, the model call, the receipt, `--out`) lands in AGT-1242.
 *
 * `proseCore` is the pure-over-I/O core `saveCore`/`checkWork` already use
 * for this file's siblings: it resolves the voice, reads the brief and
 * context files, assembles the pack, and returns the exact `--json` body —
 * never prints, never throws. `runProse` is the CLI's thin printing wrapper
 * over it (mirroring `runSave` over `saveCore`); `verbs.ts`'s `runProseVerb`
 * calls it directly for MCP, after its own vault-boundary check (see that
 * file's comment on why `--brief`/`--context` are bounded there, not here).
 */

import { readFileSync } from "node:fs";
import {
  assemblePack,
  createProviders,
  loadConfig,
  renderPack,
} from "@openthink/pablo-core";
import type { Intent, Pack, SliceAction, SliceAdjustment, TextSource } from "@openthink/pablo-core";
import { FORMAT_STANZAS, KNOWN_FORMATS } from "./formats";
import { readVoice, resolveVoice } from "./voice";
import type { Voice } from "./voice";

/** What `proseCore` needs beyond the CLI's own env/cwd — mirrors `write.ts`'s minimal context shape. */
export interface ProseCoreContext {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
}

/**
 * `proseCore`'s own fields, already the right *types* (voice resolved by
 * name, words a number, `dryRun` a boolean) — the CLI's raw string argv and
 * MCP's already-typed zod args each map onto this the same way.
 */
export interface ProseCoreArgs {
  readonly voice: string | undefined;
  /** A file path, or `"-"` for stdin (CLI only — see `readBrief`). */
  readonly brief: string | undefined;
  /** File paths, in the order they were given. */
  readonly context: readonly string[];
  /** `email` | `post` | `page` | `reply` | `note`. */
  readonly format: string | undefined;
  readonly words: number | undefined;
  readonly dryRun: boolean;
}

/** The CLI's own argv shape — `words` still a raw string, `json` added for the printing wrapper. */
export interface ProseCliArgs {
  readonly voice: string | undefined;
  readonly brief: string | undefined;
  readonly context: readonly string[];
  readonly format: string | undefined;
  readonly words: string | undefined;
  readonly dryRun: boolean;
  readonly json: boolean;
}

export interface ProseRefusalBody {
  readonly ok: false;
  readonly code: number;
  readonly message: string;
  readonly tried?: readonly string[];
}

/** AC2's exact `--dry-run --json` shape. */
export interface ProseDryRunSlice {
  readonly name: string;
  readonly heading: string;
  readonly source: string | undefined;
  readonly tokens: number;
  readonly action?: SliceAction;
}

export interface ProseDryRunBody {
  readonly ok: true;
  readonly dryRun: true;
  readonly slices: readonly ProseDryRunSlice[];
  readonly totalTokens: number;
  readonly expectedOutputTokens: number;
  readonly prompt_hash: string;
  readonly adjustments: readonly SliceAdjustment[];
}

export type ProseBody = ProseRefusalBody | ProseDryRunBody;

export interface ProseOutcome {
  readonly body: ProseBody;
  readonly exitCode: number;
  /** Present only alongside a successful dry-run body — the CLI's non-JSON rendering needs the `Pack` itself, not just its JSON-safe body. */
  readonly pack?: Pack;
}

/**
 * The intent prose's dry-run render routes under, for the wait estimate
 * only — `createProviders`/`loadConfig` never open a connection here;
 * `providers.rates()` just reads back whatever the endpoint's own
 * `RateMeter` has already measured. `kind: "drafting"` rather than the
 * design doc's proposed "copy" `IntentKind`: adding a new `IntentKind` is
 * model-routing work that belongs to the send ticket (AGT-1242), and
 * `route()`'s only branch (`kind !== "planning" -> local`) makes "drafting"
 * and "copy" route identically, so there is nothing to gain from widening
 * the kind here just to price a dry run.
 */
const PROSE_INTENT: Intent = { name: "prose", kind: "drafting" };

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

type ReadResult = { readonly ok: true; readonly source: TextSource } | { readonly ok: false; readonly code: number; readonly message: string };

function readProseFile(path: string, flagLabel: string): ReadResult {
  try {
    return { ok: true, source: { path, text: readFileSync(path, "utf8") } };
  } catch (err) {
    return { ok: false, code: 1, message: `pablo: prose: could not read ${flagLabel} ${path}: ${errMessage(err)}` };
  }
}

/**
 * `--brief -` reads stdin to end (`readFileSync(0, ...)`, not
 * `Bun.stdin.text()`, so `proseCore` stays synchronous — the same reasoning
 * `save.ts`'s `readSaveInput` already documents). A TTY with no piped input
 * refuses (exit 2) rather than blocking forever. Over MCP, `"-"` is refused
 * before this is ever called (`verbs.ts`'s `runProseVerb` — there is no
 * stdin to read in a tool call, mirroring `save`'s MCP rule), so this
 * function only ever sees `"-"` from the CLI.
 */
function readBrief(raw: string): ReadResult {
  if (raw !== "-") return readProseFile(raw, "--brief");

  if (process.stdin.isTTY) {
    return { ok: false, code: 2, message: "pablo: prose: --brief - reads stdin; pipe input or pass a file" };
  }
  try {
    return { ok: true, source: { path: "(stdin)", text: readFileSync(0, "utf8") } };
  } catch (err) {
    return { ok: false, code: 1, message: `pablo: prose: could not read stdin: ${errMessage(err)}` };
  }
}

export interface BuildProseOptions {
  readonly brief: TextSource;
  readonly context: readonly TextSource[];
  /** A format *name* (`email`, `post`, ...) — resolved to its stanza text here, not in core. */
  readonly format: string | undefined;
  readonly words: number | undefined;
}

export type BuildProseResult = { readonly ok: true; readonly pack: Pack } | { readonly ok: false; readonly code: 2; readonly message: string };

/**
 * Pure over already-read `TextSource`s (AC1/AC5): resolves `--format` to its
 * fixed stanza (refusing an unknown one, AC4) and calls
 * `@openthink/pablo-core`'s `assemblePack("prose", ...)`. No filesystem, no
 * network, no clock — same inputs, same `Pack`, same hash (AC3).
 */
export function buildProsePack(voice: Voice, options: BuildProseOptions): BuildProseResult {
  if (options.format !== undefined && !(options.format in FORMAT_STANZAS)) {
    return {
      ok: false,
      code: 2,
      message: `pablo: prose: unknown --format "${options.format}" (expected ${KNOWN_FORMATS.join(", ")})`,
    };
  }

  const pack = assemblePack("prose", {
    voice: { rules: voice.rules, exemplars: voice.exemplars, never: voice.never },
    format: options.format === undefined ? undefined : FORMAT_STANZAS[options.format],
    context: options.context,
    brief: options.brief,
    wordTarget: options.words,
  });

  return { ok: true, pack };
}

function refuse(code: number, message: string): ProseOutcome {
  return { body: { ok: false, code, message }, exitCode: code };
}

function dryRunBody(pack: Pack): ProseDryRunBody {
  const actionByName = new Map(pack.adjustments.map((adjustment) => [adjustment.name, adjustment.action]));
  return {
    ok: true,
    dryRun: true,
    slices: pack.slices.map((slice) => {
      const action = actionByName.get(slice.name);
      return {
        name: slice.name,
        heading: slice.heading,
        source: slice.source,
        tokens: slice.tokens,
        ...(action !== undefined ? { action } : {}),
      };
    }),
    totalTokens: pack.totalTokens,
    expectedOutputTokens: pack.expectedOutputTokens,
    prompt_hash: pack.hash,
    adjustments: pack.adjustments,
  };
}

/**
 * The pure core: resolve `--voice` (AC4: works with no vault at all — a
 * global voice resolves from `~/.config/pablo/voices/`, `resolveVoice`'s own
 * fallback), read the brief and every `--context` file, assemble the pack,
 * and either return the dry-run body (AC2) or (without `--dry-run`) refuse
 * with exit 1 — the send path isn't wired up yet. Every failure is returned
 * data, never a thrown exception, exactly like `saveCore`/`checkWork`.
 */
export function proseCore(args: ProseCoreArgs, ctx: ProseCoreContext): ProseOutcome {
  if (args.voice === undefined) {
    return refuse(2, "pablo: prose requires --voice <name>");
  }

  const resolution = resolveVoice(args.voice, { cwd: ctx.cwd, env: ctx.env });
  if (!resolution.ok) {
    return { body: { ok: false, code: resolution.code, message: resolution.message, tried: resolution.tried }, exitCode: resolution.code };
  }
  const voice = readVoice(resolution.path);

  if (args.brief === undefined) {
    return refuse(2, "pablo: prose requires --brief <file|->");
  }

  const briefResult = readBrief(args.brief);
  if (!briefResult.ok) return { body: { ok: false, code: briefResult.code, message: briefResult.message }, exitCode: briefResult.code };

  const context: TextSource[] = [];
  for (const path of args.context) {
    const result = readProseFile(path, "--context");
    if (!result.ok) return { body: { ok: false, code: result.code, message: result.message }, exitCode: result.code };
    context.push(result.source);
  }

  const built = buildProsePack(voice, { brief: briefResult.source, context, format: args.format, words: args.words });
  if (!built.ok) return { body: built, exitCode: built.code };

  if (!args.dryRun) {
    return { body: { ok: false, code: 1, message: "pablo: prose: not wired to the model yet (next ticket)" }, exitCode: 1 };
  }

  return { body: dryRunBody(built.pack), exitCode: 0, pack: built.pack };
}

/** `--words`'s value as a positive integer, or `undefined` for anything else (including absent) — mirrors `write.ts`'s own parser, duplicated rather than imported since `write.ts` is another ticket's file this build must not touch. */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value > 0 ? value : undefined;
}

/**
 * `pablo prose`'s CLI entry point: parses `--words`, calls `proseCore`, and
 * prints — JSON (AC2's exact shape) or, for a human, the pack's rendered
 * table and estimated wait via `renderPack` (the same view `pablo write
 * --dry-run` uses). Returns the process exit code; never throws.
 */
export function runProse(args: ProseCliArgs, ctx: ProseCoreContext): number {
  const outcome = proseCore(
    {
      voice: args.voice,
      brief: args.brief,
      context: args.context,
      format: args.format,
      words: parsePositiveInt(args.words),
      dryRun: args.dryRun,
    },
    ctx,
  );

  if (!outcome.body.ok) {
    if (args.json) {
      console.log(JSON.stringify(outcome.body));
    } else {
      console.error(outcome.body.message);
    }
    return outcome.exitCode;
  }

  if (args.json) {
    console.log(JSON.stringify(outcome.body));
    return outcome.exitCode;
  }

  const providers = createProviders(loadConfig({ env: ctx.env }));
  const providerId = providers.route(PROSE_INTENT);
  console.log(renderPack(outcome.pack as Pack, providers.rates(providerId)).text);
  return outcome.exitCode;
}
