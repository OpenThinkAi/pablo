/**
 * The mixer's Cast panel host (AGT-2157, pm project `pablo-platform`, D-19): casting in the mixer, through the same
 * functions as the casting verbs. Like the markers' host (`mixer-notes-host.ts`) it is spread into the mixer's host
 * and its mutations into the window's (`mixer-host.ts`); names and payloads are `views/mixer-cast-protocol.ts`'s.
 *
 *  - `castRoles({episode})` — each role the episode's script needs, its `CAST:` description, the voice bound to it and
 *    its lines (`python -m pablo_casting castpanel roles`, the one read no verb gives);
 *  - `listVoices()` — the `voices` verb's `list`;
 *  - `previewVoice({episode, line, voice})` — a library voice reading one line of the role through the performance
 *    engine (`castpanel preview`: no take, no binding, a receipt), to audition the library on the role's own words;
 *  - `describeVoice({describe, gender?, role?})` — the `describe_voice` verb;
 *  - `auditionVoices({role, describe, slug?, n?, designer?})` — the `audition` verb's argv (`auditionArgv`): a new
 *    voice designed from a description, candidates into the library's `auditions/`; `candidateAudio({slug,
 *    candidate})` plays one of them back (only a file that audition named);
 *  - `castCandidate({role, candidate, slug?, recast?})` — the `cast` verb's argv (`castArgv`): a candidate frozen
 *    into a card;
 *  - `bindVoice({episode, role, voice})` — the `bind` verb; its answer lists the role's lines performed in the old
 *    voice, which the panel offers to re-perform;
 *  - `reperformRole({episode, role})` — flags exactly those lines (`flags.json`, as the player and the markers write
 *    them) and runs the `fix` verb, which re-records only flagged lines (a rebound role is allowed once all of its
 *    lines are flagged). A refused or failed fix puts `flags.json` back as it was.
 *
 * Audition, cast, preview and fix load models and take a while, so their child runs asynchronously
 * (`runPythonStreaming`), as `renderMix` does: the window's server keeps answering meanwhile. A failure is a thrown
 * plain-words `Error`; ui-leaf hands it to the view.
 */

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { MutationHandler } from "@openthink/ui-leaf";
import type {
  AuditionCandidate,
  AuditionPayload,
  BindPayload,
  CandidateAudioPayload,
  CastCandidatePayload,
  CastMutation,
  CastRolesPayload,
  DescribePayload,
  LibraryVoice,
  PreviewPayload,
  ReperformPayload,
  VoicesPayload,
} from "../views/mixer-cast-protocol";
import { SCORERS_EXTRA, ensureProvisioned, runCasting, runPythonStreaming } from "./casting";
import type { CastingDeps } from "./casting";
import { auditionArgv, castArgv, castingVerbs } from "./casting-verbs";
import { defaultSlug, plural } from "../views/mixer-cast-logic";
import { readFlagsFile, writeFlagsFile } from "./review-host";
import { VERBS } from "./verbs";
import type { Verb, VerbContext, VerbResult } from "./verbs";

type Env = Record<string, string | undefined>;

export interface CastHostOptions {
  /** The work's directory (`<vault>/<kind>/<slug>`). */
  readonly work: string;
  /** The vault the work lives in; the library defaults to `<vault>/casting`. */
  readonly vault?: string;
  /** `--library DIR`: the library root, over the config and the vault. */
  readonly library?: string;
  readonly env: Env;
  readonly casting: CastingDeps;
  readonly stderr?: { write(text: string): unknown };
  readonly now?: () => Date;
}

export interface CastHost {
  castRoles(args: unknown): CastRolesPayload;
  listVoices(args: unknown): Promise<VoicesPayload>;
  previewVoice(args: unknown): Promise<PreviewPayload>;
  describeVoice(args: unknown): Promise<DescribePayload>;
  auditionVoices(args: unknown): Promise<AuditionPayload>;
  candidateAudio(args: unknown): CandidateAudioPayload;
  castCandidate(args: unknown): Promise<CastCandidatePayload>;
  bindVoice(args: unknown): Promise<BindPayload>;
  reperformRole(args: unknown): Promise<ReperformPayload>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function field(args: unknown, key: string): unknown {
  return isRecord(args) ? args[key] : undefined;
}

function wholeArg(args: unknown, key: string, required: true, min?: number, max?: number): number;
function wholeArg(args: unknown, key: string, required: false, min?: number, max?: number): number | undefined;
function wholeArg(args: unknown, key: string, required: boolean, min = 1, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const value = field(args, key);
  if (value === undefined && !required) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${key} must be a whole number${max === Number.MAX_SAFE_INTEGER ? ` of ${min} or more` : ` from ${min} to ${max}`}`);
  }
  return value;
}

function textArg(args: unknown, key: string, required: true): string;
function textArg(args: unknown, key: string, required: false): string | undefined;
function textArg(args: unknown, key: string, required: boolean): string | undefined {
  const value = field(args, key);
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} must be some text`);
  return value.trim();
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;
function slugArg(args: unknown, key: string, required: true): string;
function slugArg(args: unknown, key: string, required: false): string | undefined;
function slugArg(args: unknown, key: string, required: boolean): string | undefined {
  const value = required ? textArg(args, key, true) : textArg(args, key, false);
  if (value !== undefined && !SLUG.test(value)) throw new Error(`${key} must be a voice slug (lowercase letters, digits and dashes)`);
  return value;
}

/** A verb's body as the panel's answer, or its refusal's own words as a thrown `Error`. */
function unwrap(result: VerbResult, what: string): Record<string, unknown> {
  const body = isRecord(result.body) ? result.body : {};
  if (result.exitCode !== 0 || body["ok"] === false) throw new Error(typeof body["message"] === "string" ? body["message"] : `could not ${what} (exit ${result.exitCode})`);
  return body;
}

export function createCastHost(options: CastHostOptions): CastHost {
  const { work } = options;
  const stderr = options.stderr ?? { write: () => undefined };
  const ctx = { env: options.env, stderr };
  const now = options.now ?? (() => new Date());
  const project = basename(work);
  const where = [...(options.vault === undefined ? [] : [`--vault=${options.vault}`]), ...(options.library === undefined ? [] : [`--library=${options.library}`])];
  /** What the panel's last audition of a slug wrote, by candidate number: `candidateAudio` serves only these files. */
  const auditioned = new Map<string, Map<number, string>>();

  // The verbs, as the CLI and `pablo mcp` run them. The panel is the author's own window: it calls them as the CLI.
  const casting = castingVerbs(() => options.casting);
  const verb = (name: string): Verb => {
    const found = [...casting, ...VERBS].find((v) => v.name === name);
    if (found === undefined) throw new Error(`pablo has no ${name} verb`);
    return found;
  };
  const verbCtx = (): VerbContext => ({
    cwd: options.vault ?? dirname(dirname(work)),
    env: options.env,
    stderr,
    stdout: { write: () => undefined },
    casting: options.casting,
  });
  async function runVerb(name: string, raw: Record<string, unknown>, what: string): Promise<Record<string, unknown>> {
    const v = verb(name);
    const parsed = v.args.safeParse(raw);
    if (!parsed.success) throw new Error(`${what}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    return unwrap(await v.run(parsed.data, verbCtx()), what);
  }

  /** A Python command that loads models, run asynchronously in the provisioned venv with the `scorers` extra. */
  async function heavy(argv: readonly string[], what: string): Promise<Record<string, unknown>> {
    const ready = ensureProvisioned(ctx, options.casting, work, [SCORERS_EXTRA]);
    const result = ready.ok ? await runPythonStreaming(ready.layout, options.casting, ctx, [...argv, ...where, "--work", work], () => undefined) : ready.result;
    return unwrap(result, what);
  }

  function castRoles(args: unknown): CastRolesPayload {
    const episode = wholeArg(args, "episode", true);
    const body = unwrap(runCasting(["castpanel", "roles", "--episode", String(episode), ...where], ctx, options.casting, work), "read the episode's cast");
    return { episode, performed: body["performed"] === true, roles: Array.isArray(body["roles"]) ? (body["roles"] as CastRolesPayload["roles"]) : [] };
  }

  return {
    castRoles,

    async listVoices() {
      const body = await runVerb("voices", { sub: "list", ...(options.library === undefined ? {} : { library: options.library }) }, "list the voice library");
      return { voices: Array.isArray(body["voices"]) ? (body["voices"] as LibraryVoice[]) : [] };
    },

    async previewVoice(args) {
      const episode = wholeArg(args, "episode", true);
      const line = wholeArg(args, "line", true, 0);
      const voice = slugArg(args, "voice", true);
      const body = await heavy(["castpanel", "preview", "--episode", String(episode), "--line", String(line), "--voice", voice], `preview ${voice}`);
      return {
        episode,
        line,
        role: String(body["role"]),
        text: String(body["text"]),
        voice,
        mime: "audio/wav",
        b64: String(body["b64"]),
        seconds: typeof body["seconds"] === "number" ? body["seconds"] : 0,
      };
    },

    async describeVoice(args) {
      const describe = textArg(args, "describe", true);
      const gender = field(args, "gender");
      const role = textArg(args, "role", false);
      const body = await runVerb("describe_voice", { describe, ...(gender === undefined ? {} : { gender }), ...(role === undefined ? {} : { role }) }, "describe the voice");
      return {
        traits: isRecord(body["traits"]) ? body["traits"] : {},
        freeText: Array.isArray(body["freeText"]) ? (body["freeText"] as string[]) : [],
        instruct: typeof body["instruct"] === "string" ? body["instruct"] : "",
      };
    },

    async auditionVoices(args) {
      const role = textArg(args, "role", true).toUpperCase();
      const describe = textArg(args, "describe", true);
      const slug = slugArg(args, "slug", false) ?? defaultSlug(role);
      const n = wholeArg(args, "n", false, 1, 24);
      const designer = field(args, "designer");
      if (designer !== undefined && designer !== "qwen3" && designer !== "voxcpm2") throw new Error("designer must be qwen3 or voxcpm2");
      const body = await heavy(auditionArgv({ role, describe, slug, n, designer }), `audition voices for ${role}`);
      const rows = Array.isArray(body["candidates"]) ? (body["candidates"] as Record<string, unknown>[]) : [];
      const files = new Map<number, string>();
      const candidates: AuditionCandidate[] = rows.map((r) => {
        const candidate = Number(r["candidate"]);
        if (typeof r["file"] === "string") files.set(candidate, r["file"]);
        const scores = isRecord(r["scores"]) ? r["scores"] : {};
        return {
          candidate,
          seconds: typeof r["seconds"] === "number" ? r["seconds"] : 0,
          referenceOk: r["reference_ok"] === true,
          nearDuplicates: Array.isArray(r["near_duplicates"]) ? (r["near_duplicates"] as number[]) : [],
          utmos: typeof scores["utmos"] === "number" ? scores["utmos"] : null,
        };
      });
      auditioned.set(slug, files);
      return { role, slug, candidates, message: typeof body["message"] === "string" ? body["message"] : "" };
    },

    candidateAudio(args) {
      const slug = slugArg(args, "slug", true);
      const candidate = wholeArg(args, "candidate", true);
      const file = auditioned.get(slug)?.get(candidate);
      if (file === undefined) throw new Error(`candidate ${candidate} of ${slug} is not from this window's audition; audition again`);
      return { slug, candidate, mime: "audio/wav", b64: readFileSync(file).toString("base64") };
    },

    async castCandidate(args) {
      const role = textArg(args, "role", true).toUpperCase();
      const candidate = wholeArg(args, "candidate", true);
      const slug = slugArg(args, "slug", false);
      const recast = field(args, "recast") === true;
      const body = await heavy(castArgv({ role, candidate, recast, ...(slug === undefined ? {} : { slug }) }), `cast candidate ${candidate}`);
      return { slug: String(body["slug"]), hash: String(body["hash"]), message: typeof body["message"] === "string" ? body["message"] : "" };
    },

    async bindVoice(args) {
      const episode = wholeArg(args, "episode", true);
      const role = textArg(args, "role", true).toUpperCase();
      const voice = slugArg(args, "voice", true);
      const body = await runVerb("bind", { project, role, voice }, `bind ${role}`);
      const roles = castRoles({ episode });
      return {
        role: String(body["role"]),
        slug: String(body["slug"]),
        cardHash: String(body["cardHash"]),
        replaced: typeof body["replaced"] === "string" ? body["replaced"] : null,
        reperform: roles.roles.find((r) => r.role === role)?.stale ?? [],
        roles,
      };
    },

    async reperformRole(args) {
      const episode = wholeArg(args, "episode", true);
      const role = textArg(args, "role", true).toUpperCase();
      const entry = castRoles({ episode }).roles.find((r) => r.role === role);
      if (entry === undefined) throw new Error(`episode ${episode} has no role ${role}`);
      if (entry.voice === null) throw new Error(`${role} is not bound to a voice; bind one first`);
      const lines = [...entry.stale];
      if (lines.length === 0) throw new Error(`every line of ${role} is already performed in ${entry.voice.slug}; nothing to re-perform`);
      const before = readFlagsFile(work);
      const at = now().toISOString();
      const stamp = at.replace(/[^0-9]/g, "");
      const added = lines.map((line) => ({ id: `f-recast-${episode}-${line}-${stamp}`, episode, line, reason: "other", note: `recast ${role} to ${entry.voice?.slug}`, source: "human", by: "mixer", at }));
      writeFlagsFile(work, before, [...before.flags, ...added]);
      let body: Record<string, unknown>;
      try {
        body = await runVerb("fix", { project, episode, "json-lines": true }, `re-perform ${role}`);
      } catch (error) {
        // Nothing was fixed: the flags this call added go again, so flags.json is as the author left it.
        const current = readFlagsFile(work);
        const ours = new Set(added.map((f) => f.id));
        writeFlagsFile(work, current, current.flags.filter((f) => !ours.has(String(f["id"]))));
        throw error;
      }
      return {
        episode,
        role,
        lines,
        version: typeof body["version"] === "number" ? body["version"] : null,
        message: `re-performed ${plural(lines.length, "line")} of ${role} in ${entry.voice.slug}${typeof body["version"] === "number" ? ` (manifest v${body["version"]})` : ""} and remixed the episode`,
      };
    },
  };
}

/** The Cast panel's mutations, for the mixer's `mixerMutations`. */
export function castMutations(host: CastHost): Record<CastMutation, MutationHandler> {
  return {
    castRoles: async (args) => host.castRoles(args),
    listVoices: async (args) => host.listVoices(args),
    previewVoice: async (args) => host.previewVoice(args),
    describeVoice: async (args) => host.describeVoice(args),
    auditionVoices: async (args) => host.auditionVoices(args),
    candidateAudio: async (args) => host.candidateAudio(args),
    castCandidate: async (args) => host.castCandidate(args),
    bindVoice: async (args) => host.bindVoice(args),
    reperformRole: async (args) => host.reperformRole(args),
  };
}
