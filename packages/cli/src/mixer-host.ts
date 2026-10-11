/**
 * The mixer's host (AGT-1766, pm project `pablo-mixer`, "The mixer view"): what `pablo mixer`'s window
 * (`views/mixer.tsx`, a later ticket) is mounted on. Like the review player's host it is the only thing that
 * touches the casting directory; the view is dumb and never reads a file.
 *
 * It answers four mutations (names and payloads in `views/mixer-protocol.ts`), each reading the disk afresh:
 *  - `loadMix({episode, version?})` — the mix document (the newest `renders/epNN/mix.v<m>.json` unless a version
 *    is asked for), the mix versions, the manifest line/cue info the document was made against, and the
 *    track/lane layout;
 *  - `peaks({source})` — waveform peaks of one clip source, computed once and cached by content key (on disk
 *    by the Python side, and in this host's memory, so a repeat ask spawns nothing);
 *  - `clipAudio({source})` — the audio the timeline plays for a clip source, as a base64 16-bit WAV: a take
 *    already **paced** by its stretch (the preview never time-stretches live), or a cue as the library holds it;
 *  - `saveMix({episode, base, document})` — validates the document and writes `mix.v<m+1>` `by: "human"` with
 *    a diff summary. Refused, writing nothing, when `base` is not the newest version: no silent overwrite, and
 *    no version is ever rewritten.
 *
 * The work is done by `python -m pablo_casting mixer <op>` (`packages/casting/.../mixer.py`), which owns the
 * mix document's validation and exclusive write (`mixdoc.py`) and the pacing (`mix.py`); this file validates
 * the shape of each call and relays. A failure is a thrown plain-words `Error`; ui-leaf hands it to the view.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutationHandler } from "@openthink/ui-leaf";
import { MUTATIONS } from "../views/mixer-protocol";
import type { ClipAudioPayload, ManifestCue, ManifestLine, MixDiff, MixPayload, MixSource, MixVersionInfo, PeaksPayload, SavedMixPayload } from "../views/mixer-protocol";
import { runCasting } from "./casting";
import type { CastingDeps } from "./casting";
import { episodeTitle } from "./review-host";

type Env = Record<string, string | undefined>;

export interface MixerHostOptions {
  /** The work's directory (`<vault>/<kind>/<slug>`). */
  readonly work: string;
  /** The vault the work lives in; the cue library defaults to `<vault>/casting/cues`. */
  readonly vault?: string;
  readonly env: Env;
  /** The casting side (`realCastingDeps(env)` in production, a fake under `bun test`). */
  readonly casting: CastingDeps;
  readonly stderr?: { write(text: string): unknown };
}

export interface MixerHost {
  loadMix(args: unknown): MixPayload;
  peaks(args: unknown): PeaksPayload;
  clipAudio(args: unknown): ClipAudioPayload;
  saveMix(args: unknown): SavedMixPayload;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const KEY = /^[0-9a-f]{64}$/;

function positiveInt(args: unknown, key: string, required: true): number;
function positiveInt(args: unknown, key: string, required: false): number | undefined;
function positiveInt(args: unknown, key: string, required: boolean): number | undefined {
  const value = isRecord(args) ? args[key] : undefined;
  if (value === undefined && !required) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${key} must be a whole number of 1 or more`);
  return value;
}

/** `{source: {kind, key, stretch?}}`, checked: a clip's own `source` object may be passed straight through. */
function sourceArg(args: unknown): MixSource {
  const raw = isRecord(args) ? args["source"] : undefined;
  if (!isRecord(raw)) throw new Error("source must be {kind: take|cue, key, stretch?}");
  const { kind, key, stretch } = raw;
  if (kind !== "take" && kind !== "cue") throw new Error("source.kind must be take or cue");
  if (typeof key !== "string" || !KEY.test(key)) throw new Error("source.key must be a 64-character hex key");
  if (stretch !== undefined) {
    if (typeof stretch !== "number" || !Number.isFinite(stretch) || stretch <= 0) throw new Error("source.stretch must be a positive number");
    if (kind === "cue" && stretch !== 1) throw new Error("only a take is paced: a cue takes no stretch");
  }
  return kind === "take" ? { kind, key, stretch: stretch ?? 1 } : { kind, key };
}

const sourceFlag = (source: MixSource): string[] => ["--source", `${source.kind}:${source.key}`, ...(source.kind === "take" ? ["--stretch", String(source.stretch ?? 1)] : [])];

export function createMixerHost(options: MixerHostOptions): MixerHost {
  const { work } = options;
  const ctx = { env: options.env, stderr: options.stderr ?? { write: () => undefined } };
  const peakCache = new Map<string, PeaksPayload>();

  /** One `mixer` call; a refusal or error is thrown with the Python side's own words. */
  function call(op: string, args: readonly string[]): Record<string, unknown> {
    const vault = options.vault === undefined ? [] : ["--vault", options.vault];
    const result = runCasting(["mixer", op, ...args, ...vault], ctx, options.casting, work);
    const body = isRecord(result.body) ? result.body : {};
    if (result.exitCode !== 0 || body["ok"] === false) {
      throw new Error(typeof body["message"] === "string" ? body["message"] : `the mixer could not ${op} (exit ${result.exitCode})`);
    }
    return body;
  }

  const versionRows = (rows: unknown): MixVersionInfo[] => (Array.isArray(rows) ? (rows as MixVersionInfo[]) : []);

  return {
    loadMix(args) {
      const episode = positiveInt(args, "episode", true);
      const version = positiveInt(args, "version", false);
      const body = call("load", ["--episode", String(episode), ...(version === undefined ? [] : ["--version", String(version)])]);
      const manifest = body["manifest"] as { version: number; duration: number | null; lines: ManifestLine[]; cues: ManifestCue[] };
      return {
        episode,
        title: episodeTitle(work, episode),
        version: body["version"] as number,
        newest: body["newest"] as number,
        versions: versionRows(body["versions"]),
        document: body["document"] as MixPayload["document"],
        manifest,
        latestManifest: body["latest_manifest"] as number,
        layout: body["layout"] as MixPayload["layout"],
      };
    },

    peaks(args) {
      const source = sourceArg(args);
      const id = `${source.kind}:${source.key}:${source.stretch ?? 1}`;
      const hit = peakCache.get(id);
      if (hit !== undefined) return { ...hit, cached: true };
      const body = call("peaks", sourceFlag(source));
      const payload: PeaksPayload = { source, seconds: body["seconds"] as number, perSecond: body["per_second"] as number, peaks: body["peaks"] as number[], cached: body["cached"] === true };
      peakCache.set(id, payload);
      return payload;
    },

    clipAudio(args) {
      const source = sourceArg(args);
      const body = call("audio", sourceFlag(source));
      return { source, mime: "audio/wav", b64: body["b64"] as string, sampleRate: body["sample_rate"] as number, seconds: body["seconds"] as number };
    },

    saveMix(args) {
      const episode = positiveInt(args, "episode", true);
      const base = positiveInt(args, "base", true);
      const document = isRecord(args) ? args["document"] : undefined;
      if (!isRecord(document)) throw new Error("document must be the mix document to save");
      const dir = mkdtempSync(join(tmpdir(), "pablo-mixer-save-"));
      try {
        const file = join(dir, "document.json");
        writeFileSync(file, JSON.stringify(document), "utf8");
        const body = call("save", ["--episode", String(episode), "--base", String(base), "--from", file]);
        return {
          episode,
          version: body["version"] as number,
          parent: body["parent"] as number,
          by: "human",
          summary: body["summary"] as MixDiff,
          document: body["document"] as SavedMixPayload["document"],
          versions: versionRows(body["versions"]),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

/** The mutations the window may call, and nothing else: ui-leaf answers 404 for any other name. */
export function mixerMutations(host: MixerHost): Record<string, MutationHandler> {
  const handlers: Record<(typeof MUTATIONS)[number], MutationHandler> = {
    loadMix: async (args) => host.loadMix(args),
    peaks: async (args) => host.peaks(args),
    clipAudio: async (args) => host.clipAudio(args),
    saveMix: async (args) => host.saveMix(args),
  };
  return handlers;
}
