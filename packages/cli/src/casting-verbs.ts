/**
 * `casting-verbs.ts` (AGT-1679, pm project `pablo-casting`) — the voice
 * library's verbs, one `VERBS` entry each, so the CLI, `pablo mcp` and the
 * harness all reach them from the same zod shape and the same `run`:
 *
 * - `audition --role R --describe "..." [--designer qwen3|voxcpm2] [-n 6]`
 *   renders candidates of the shared audition passage into the library's
 *   `voices/<slug>/auditions/` (untracked), scored and with near duplicates
 *   marked. `--dry-run` only checks the casting side (AGT-1678).
 * - `cast --role R --candidate n [--recast]` freezes a candidate into the
 *   voice's card (`card.json`, `reference.flac`/`.txt`, `embedding.ecapa.npy`)
 *   and returns the card hash. There is no `--from-wav`: voices are synthetic
 *   only, and `cli.ts` refuses the flag by name.
 * - `cast --auto --project W [--episode N | --all]` (AGT-1698) auto-casts
 *   the work's described `CAST:` roles from the library (`matching.py`):
 *   `cast.json` gets `by: match`, the score, the runner-up and `review`;
 *   roles with no fit come back as `needsDesign`.
 * - `voices list|show|retire` reads the library; `retire` marks a voice
 *   unmatchable without changing its card hash.
 * - `perform --project W --episode N [--engine chatterbox-turbo|dia]
 *   [--json-lines]` (AGT-1683) renders the episode through the decided engine
 *   with the gates, retakes and pace policy into takes and `v1.json`; it
 *   provisions the `scorers` extra, and with `--json-lines` relays each line's
 *   progress event to stdout as it lands (always on stderr).
 *
 * Each `run` resolves what it can from `ctx` (the vault, for the library's
 * default `<vault>/casting`; the work, when `project` is given, for receipts)
 * and hands the rest to the Python side through `runCasting`, which
 * provisions it lazily on first use. All the casting logic (cards, hashes,
 * the library layout) lives in `packages/casting`; this file only builds argv.
 *
 * `castingVerbs(deps)` takes the machine as a parameter so `bun test` passes
 * a fake `CastingDeps` and never needs uv, Python or a model.
 */

import { resolve } from "node:path";
import { z } from "zod";
import { ensureProvisioned, realCastingDeps, runCasting, runPython, runPythonStreaming, SCORERS_EXTRA } from "./casting";
import type { CastingDeps } from "./casting";
import { readMarker } from "./marker";
import { findVault, resolveProject } from "./project";
import type { Verb, VerbContext, VerbResult } from "./verbs";

type Env = Record<string, string | undefined>;

const projectField = z
  .string()
  .optional()
  .describe("Optional work slug: receipts for the model calls go under <work>/.pablo/casting/. The voice library is shared across works.");
const libraryField = z
  .string()
  .optional()
  .describe("The voice library root (default: the casting config's `library`, else <vault>/casting). Cards live under <library>/voices/<slug>/.");
const vaultField = z.string().optional().describe("The vault whose <vault>/casting is the library, when it is not the one found from the current directory.");
const roleField = z.string().describe('The role, as the script names it (e.g. "CORA"); its voice slug is the role lowercased.');
const slugField = z.string().optional().describe("The voice's slug in the library, when it should differ from the role's.");
const traitsField = z
  .string()
  .optional()
  .describe(
    'The traits block as JSON: gender (f|m|x, required for a card), age (child|teen|20s|30s|40s|50s|60s|70s), pitch (low|low-medium|medium|medium-high|high), energy (subdued|measured|lively|intense), warmth (warm|cool), register (dry|formal|folksy|theatrical|plain|gruff), era (period|modern), roles (["lead", ...]).',
  );

const AUDITION_ARGS = z.object({
  project: projectField,
  library: libraryField,
  vault: vaultField,
  role: roleField.optional(),
  describe: z.string().optional().describe("The voice in words, 15-40 words: gender, age, pitch, pace, manner (the designer's instruct)."),
  designer: z.enum(["qwen3", "voxcpm2"]).optional().describe("Which designer renders the candidates (default qwen3)."),
  n: z.number().int().min(1).max(24).optional().describe("How many candidates (default 6)."),
  seed: z.number().int().nonnegative().optional().describe("The first candidate's seed; candidate k uses seed + k - 1 (default random)."),
  traits: traitsField,
  slug: slugField,
  "dry-run": z.boolean().optional().default(false).describe("Only check that the casting side is provisioned and runnable; no model is loaded."),
});

const CAST_ARGS = z.object({
  project: projectField,
  library: libraryField,
  vault: vaultField,
  role: roleField.optional(),
  candidate: z.number().int().positive().optional().describe("The audition candidate to freeze, as `audition` numbered it (required unless `auto`)."),
  auto: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Auto-cast the work's scripts instead (needs `project`): every unbound described role in `CAST:` is matched to the best distinct, non-retired library voice and pinned with by: match, its score and the runner-up; a middle-band match is marked review; roles with no fit or no distinct candidate come back as needsDesign.",
    ),
  episode: z.number().int().positive().optional().describe("auto: only the roles of episode N (default: every episode)."),
  all: z.boolean().optional().default(false).describe("auto: every episode's roles (the default; not with `episode`)."),
  recast: z.boolean().optional().default(false).describe("Replace an existing card; the old one is archived under recast/<timestamp>/."),
  traits: traitsField,
  notes: z.string().optional().describe('Why this candidate, e.g. "picked over 1 and 5; 2 too young".'),
  by: z.string().optional().describe("Who cast it (default $USER)."),
  slug: slugField,
});

const PERFORM_ARGS = z.object({
  project: z.string().describe("The work whose radio episode to perform."),
  episode: z
    .number()
    .int()
    .positive()
    .describe("The episode number: its script is outputs/radio/episodes/NN-*.md, else the novel's chapter file NN-*.md carrying a CAST: line."),
  engine: z
    .enum(["chatterbox-turbo", "dia"])
    .optional()
    .describe("The performance engine: chatterbox-turbo (the decided engine, default) or dia (the radio prototype's, for A/B against old renders only)."),
  "json-lines": z
    .boolean()
    .optional()
    .default(false)
    .describe("Also write each line's progress event (take key, path, status, stretch) to stdout as a JSON line as it lands; they always go to stderr."),
});

const VOICES_ARGS = z.object({
  sub: z.enum(["list", "show", "retire"]).describe("`list` the library, `show` one card, `retire` a voice so it is never matched again."),
  name: z.string().optional().describe("The voice slug, for show and retire."),
  "auto-admitted": z.boolean().optional().default(false).describe("list: only the voices the product admitted on its own."),
  reason: z.string().optional().describe("retire: why, recorded on the card."),
  project: projectField,
  library: libraryField,
  vault: vaultField,
});

/** `<vault>` for the library default, and the work directory when `project` names one. */
function locate(ctx: Pick<VerbContext, "cwd" | "env">, project: string | undefined): { readonly vault?: string; readonly work?: string } | VerbResult {
  const vault = findVault(ctx.cwd, ctx.env);
  if (project === undefined) return vault.ok ? { vault: vault.path } : {};
  if (!vault.ok) return { body: { ok: false, code: vault.code, message: vault.message, tried: vault.tried }, exitCode: vault.code };
  const work = resolveProject(vault.path, project);
  if (!work.ok) return { body: { ok: false, code: work.code, message: work.message, tried: work.tried }, exitCode: work.code };
  const marker = readMarker(work.path);
  if (!marker.ok) return { body: { ok: false, code: marker.code, message: marker.message, tried: marker.tried }, exitCode: marker.code };
  return { vault: vault.path, work: work.path };
}

/** `--name=value`, one argv token, so a value that starts with a dash is never read as a flag. */
function flag(name: string, value: string | number | undefined): string[] {
  return value === undefined ? [] : [`${name}=${String(value)}`];
}

function refuse(message: string): VerbResult {
  return { body: { ok: false, code: 2, message }, exitCode: 2 };
}

/** `cast --auto` binds a work's roles: it needs the work, and none of the hand-casting fields. */
function autoRefusal(args: z.infer<typeof CAST_ARGS>): VerbResult | undefined {
  if (args.project === undefined) return refuse("pablo cast --auto needs --project <slug>: the work whose scripts name the roles");
  const manual: string[] = (["role", "candidate", "traits", "notes", "by", "slug"] as const).filter((key) => args[key] !== undefined);
  if (args.recast) manual.push("recast");
  if (manual.length > 0) return refuse(`pablo cast --auto matches from the library; it takes no ${manual.map((key) => `--${key}`).join(", ")}`);
  if (args.episode !== undefined && args.all) return refuse("pablo cast --auto takes --episode N or --all, not both");
  return undefined;
}

/** The options every casting verb shares: the work (receipts) and where the library is (`--library`, `--vault`). */
interface Where {
  readonly project?: string | undefined;
  readonly library?: string | undefined;
  readonly vault?: string | undefined;
}

/**
 * `extras` are the optional Python extras the command needs: a real `audition`
 * and `cast` render and score audio, so they provision with `scorers` (AGT-1709);
 * `voices`, `cast --auto` and `audition --dry-run` need none.
 */
function run(args: readonly string[], where: Where, ctx: VerbContext, deps: (env: Env) => CastingDeps, extras: readonly string[] = []): VerbResult {
  // The library and vault are the author's to aim: a model (or text it read) must not redirect where `cast` writes cards.
  // Only the CLI (caller unset or "cli") may; `pablo mcp` and the harness (harness/agent.ts) both set "mcp".
  if (ctx.caller !== undefined && ctx.caller !== "cli" && (where.library !== undefined || where.vault !== undefined)) {
    return refuse("pablo: --library and --vault are CLI options; through MCP the library is the vault's <vault>/casting or the casting config's `library`");
  }
  const located = locate(ctx, where.project);
  if ("exitCode" in located) return located;
  const vault = where.vault === undefined ? located.vault : resolve(ctx.cwd, where.vault);
  const library = where.library === undefined ? undefined : resolve(ctx.cwd, where.library);
  return runCasting([...args, ...flag("--vault", vault), ...flag("--library", library)], { env: ctx.env, stderr: ctx.stderr }, deps(ctx.env), located.work, extras);
}

/** The casting verbs (audition, cast, voices, perform), over `deps` (the real machine by default). */
export function castingVerbs(deps: (env: Env) => CastingDeps = realCastingDeps): readonly Verb[] {
  const audition: Verb<typeof AUDITION_ARGS.shape> = {
    name: "audition",
    description:
      "Audition voices for a role: the designer (Qwen3-TTS VoiceDesign or VoxCPM2) renders n candidates reading the shared audition passage from a description, each scored (naturalness, pitch, words/s, speaker similarity to the others, near duplicates marked) into the voice library's auditions/. Listen, then `cast` one. Loads models; `dry-run` only checks the casting side.",
    args: AUDITION_ARGS,
    run: async (args, ctx) => {
      if (args["dry-run"]) return run(["audition", "--dry-run"], args, ctx, deps);
      return run(
        [
          "audition",
          ...flag("--role", args.role),
          ...flag("--describe", args.describe),
          ...flag("--designer", args.designer),
          ...flag("--n", args.n),
          ...flag("--seed", args.seed),
          ...flag("--traits", args.traits),
          ...flag("--slug", args.slug),
        ],
        args,
        ctx,
        deps,
        [SCORERS_EXTRA],
      );
    },
  };

  const cast: Verb<typeof CAST_ARGS.shape> = {
    name: "cast",
    description:
      "Freeze an audition candidate as the role's cast card in the shared voice library (24 kHz mono FLAC reference trimmed by the aligner, its transcript, an ECAPA embedding, the traits block and the designer's provenance) and return the card hash a story pins. Refuses to replace an existing card unless `recast`, which archives the old one. Voices are synthetic only: there is no way to cast from a recording. With `auto` (and `project`), cast the work's script roles from the library instead: each unbound role is matched by its CAST: description (gender a hard filter, weighted trait agreement, never a voice that sounds like one already in the story, never a retired voice), bound with its score and runner-up, marked review in the middle band, or returned in needsDesign.",
    args: CAST_ARGS,
    run: async (args, ctx) => {
      if (args.auto) {
        const refusal = autoRefusal(args);
        if (refusal !== undefined) return refusal;
        return run(["cast", "--auto", ...flag("--episode", args.episode), ...(args.all ? ["--all"] : [])], args, ctx, deps);
      }
      if (args.role === undefined || args.candidate === undefined) {
        return refuse("pablo cast needs --role R and --candidate n (or --auto --project <slug> to match the work's roles from the library)");
      }
      return run(
        [
          "cast",
          ...flag("--role", args.role),
          ...flag("--candidate", args.candidate),
          ...(args.recast ? ["--recast"] : []),
          ...flag("--traits", args.traits),
          ...flag("--notes", args.notes),
          ...flag("--by", args.by),
          ...flag("--slug", args.slug),
        ],
        args,
        ctx,
        deps,
        [SCORERS_EXTRA],
      );
    },
  };

  const voices: Verb<typeof VOICES_ARGS.shape> = {
    name: "voices",
    description:
      "The shared voice library: `list` every voice (card hash, traits, retired, auditions; `auto-admitted` for the ones the product added), `show` one card and whether its reference is intact, `retire` a voice so auto-casting never matches it again (stories that already pin it keep it; its card hash does not change).",
    args: VOICES_ARGS,
    run: async (args, ctx) =>
      run(
        ["voices", args.sub, ...(args.name === undefined ? [] : [args.name]), ...(args["auto-admitted"] ? ["--auto-admitted"] : []), ...flag("--reason", args.reason)],
        args,
        ctx,
        deps,
      ),
    positionalArgs: ["sub", "name"],
  };

  const perform: Verb<typeof PERFORM_ARGS.shape> = {
    name: "perform",
    description:
      "Perform a radio episode: every spoken line is rendered through the decided engine (Chatterbox-Turbo; `dia` for A/B only) in its bound voice, scored by the quality gates, and retaken up to 4 times with derived seeds (first passing take kept, else the best kept and flagged automatically); the pace policy stretches each take to its role's pace (slow/quick directions scale it) within 0.75-1.05, retaking lines that would need more. Writes immutable takes and the episode's v1 manifest (with rtf_total) and a receipt per engine pass; each line's take is reported as it lands. Refuses an unbound role, a changed card pin, or an episode that already has a manifest (use fix). Loads models and uses the GPU.",
    args: PERFORM_ARGS,
    run: async (args, ctx) => {
      const where = locate(ctx, args.project);
      if ("exitCode" in where) return where;
      const work = where.work as string;
      const machine = deps(ctx.env);
      const casting = { env: ctx.env, stderr: ctx.stderr };
      // A real engine and the gates' scorers: the `scorers` extra (mlx-audio included).
      const ready = ensureProvisioned(casting, machine, work, [SCORERS_EXTRA]);
      if (!ready.ok) return ready.result;
      const relay = args["json-lines"] ? ctx.stdout : undefined;
      const pythonArgs = [
        "perform",
        ...flag("--episode", args.episode),
        ...flag("--engine", args.engine),
        ...(relay !== undefined ? ["--json-lines"] : []),
        ...flag("--vault", where.vault),
        "--work",
        work,
      ];
      const result =
        relay === undefined
          ? runPython(ready.layout, machine, casting, pythonArgs)
          : await runPythonStreaming(ready.layout, machine, casting, pythonArgs, (line) => {
              if (isProgressEvent(line)) relay.write(`${line}\n`);
            });
      return {
        body: { ...(result.body as object), provisioned: ready.outcome.provisioned, ...(ready.outcome.receipt ? { receipt: ready.outcome.receipt } : {}) },
        exitCode: result.exitCode,
      };
    },
  };

  return [audition, cast, voices, perform] as readonly Verb[];
}

/** A `perform` progress line (`{"event": ...}`), as opposed to the final body. */
function isProgressEvent(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as unknown;
    return typeof parsed === "object" && parsed !== null && typeof (parsed as { event?: unknown }).event === "string";
  } catch {
    return false;
  }
}
