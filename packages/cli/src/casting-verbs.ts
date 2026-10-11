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
 * - `voices list|show|retire` reads the library; `retire` marks a voice
 *   unmatchable without changing its card hash.
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

import { z } from "zod";
import { realCastingDeps, runCasting } from "./casting";
import type { CastingDeps } from "./casting";
import { readMarker } from "./marker";
import { findVault, resolveProject } from "./project";
import type { Verb, VerbContext, VerbResult } from "./verbs";

type Env = Record<string, string | undefined>;

const projectField = z
  .string()
  .optional()
  .describe("Optional work slug: receipts for the model calls go under <work>/.pablo/casting/. The voice library is shared across works.");
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
  role: roleField,
  candidate: z.number().int().positive().describe("The audition candidate to freeze, as `audition` numbered it."),
  recast: z.boolean().optional().default(false).describe("Replace an existing card; the old one is archived under recast/<timestamp>/."),
  traits: traitsField,
  notes: z.string().optional().describe('Why this candidate, e.g. "picked over 1 and 5; 2 too young".'),
  by: z.string().optional().describe("Who cast it (default $USER)."),
  slug: slugField,
});

const VOICES_ARGS = z.object({
  sub: z.enum(["list", "show", "retire"]).describe("`list` the library, `show` one card, `retire` a voice so it is never matched again."),
  name: z.string().optional().describe("The voice slug, for show and retire."),
  "auto-admitted": z.boolean().optional().default(false).describe("list: only the voices the product admitted on its own."),
  reason: z.string().optional().describe("retire: why, recorded on the card."),
  project: projectField,
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

function run(args: readonly string[], project: string | undefined, ctx: VerbContext, deps: (env: Env) => CastingDeps): VerbResult {
  const where = locate(ctx, project);
  if ("exitCode" in where) return where;
  return runCasting([...args, ...flag("--vault", where.vault)], { env: ctx.env, stderr: ctx.stderr }, deps(ctx.env), where.work);
}

/** The three casting verbs, over `deps` (the real machine by default). */
export function castingVerbs(deps: (env: Env) => CastingDeps = realCastingDeps): readonly Verb[] {
  const audition: Verb<typeof AUDITION_ARGS.shape> = {
    name: "audition",
    description:
      "Audition voices for a role: the designer (Qwen3-TTS VoiceDesign or VoxCPM2) renders n candidates reading the shared audition passage from a description, each scored (naturalness, pitch, words/s, speaker similarity to the others, near duplicates marked) into the voice library's auditions/. Listen, then `cast` one. Loads models; `dry-run` only checks the casting side.",
    args: AUDITION_ARGS,
    run: async (args, ctx) => {
      if (args["dry-run"]) return run(["audition", "--dry-run"], args.project, ctx, deps);
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
        args.project,
        ctx,
        deps,
      );
    },
  };

  const cast: Verb<typeof CAST_ARGS.shape> = {
    name: "cast",
    description:
      "Freeze an audition candidate as the role's cast card in the shared voice library (24 kHz mono FLAC reference trimmed by the aligner, its transcript, an ECAPA embedding, the traits block and the designer's provenance) and return the card hash a story pins. Refuses to replace an existing card unless `recast`, which archives the old one. Voices are synthetic only: there is no way to cast from a recording.",
    args: CAST_ARGS,
    run: async (args, ctx) =>
      run(
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
        args.project,
        ctx,
        deps,
      ),
  };

  const voices: Verb<typeof VOICES_ARGS.shape> = {
    name: "voices",
    description:
      "The shared voice library: `list` every voice (card hash, traits, retired, auditions; `auto-admitted` for the ones the product added), `show` one card and whether its reference is intact, `retire` a voice so auto-casting never matches it again (stories that already pin it keep it; its card hash does not change).",
    args: VOICES_ARGS,
    run: async (args, ctx) =>
      run(
        ["voices", args.sub, ...(args.name === undefined ? [] : [args.name]), ...(args["auto-admitted"] ? ["--auto-admitted"] : []), ...flag("--reason", args.reason)],
        args.project,
        ctx,
        deps,
      ),
    positionalArgs: ["sub", "name"],
  };

  return [audition, cast, voices] as readonly Verb[];
}
