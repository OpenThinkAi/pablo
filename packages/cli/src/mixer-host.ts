/**
 * The mixer's host (AGT-1766, pm project `pablo-mixer`, "The mixer view"): what `pablo mixer`'s window
 * (`views/mixer.tsx`, AGT-1768, opened by `openMixer` below) is mounted on. Like the review player's host it is the only thing that
 * touches the casting directory; the view is dumb and never reads a file.
 *
 * It answers five mutations (names and payloads in `views/mixer-protocol.ts`; the markers' own are `mixer-notes-host.ts`'s),
 * each reading the disk afresh:
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
 *  - `renderMix({episode, base})` (AGT-2152) — runs `pablo mix` on mix version `base` (the newest, just saved by the
 *    window when it had edits), writing the next episode file. Refused, rendering nothing, when `base` is not the
 *    newest or no longer fits the newest manifest's takes. It runs the child asynchronously: a render takes a while
 *    and the window's server must keep answering meanwhile.
 *
 * The work is done by `python -m pablo_casting mixer <op>` (`packages/casting/.../mixer.py`), which owns the
 * mix document's validation and exclusive write (`mixdoc.py`) and the pacing (`mix.py`); this file validates
 * the shape of each call and relays. A failure is a thrown plain-words `Error`; ui-leaf hands it to the view.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mount } from "@openthink/ui-leaf";
import type { MountOptions, MutationHandler, View } from "@openthink/ui-leaf";
import type { MixerData } from "../views/mixer";
import { MUTATIONS } from "../views/mixer-protocol";
import type { ClipAudioPayload, ManifestCue, ManifestLine, MixDiff, MixPayload, MixSource, MixVersionInfo, PeaksPayload, RenderedFrom, RenderedMixPayload, SavedMixPayload } from "../views/mixer-protocol";
import { MIX_EXTRA, ensureProvisioned, runCasting, runPythonStreaming } from "./casting";
import type { CastingDeps } from "./casting";
import { VIEWS_ROOT, findChrome, resolveUiLeafBinary } from "./reader-host";
import { createNotesHost } from "./mixer-notes-host";
import type { NotesHost } from "./mixer-notes-host";
import { REVIEW_CSP, castingDir, episodeTitle } from "./review-host";

type Env = Record<string, string | undefined>;

export interface MixerHostOptions {
  /** The work's directory (`<vault>/<kind>/<slug>`). */
  readonly work: string;
  /** The vault the work lives in; the cue library defaults to `<vault>/casting/cues`. */
  readonly vault?: string;
  /** The work's title, for the punch list. */
  readonly title?: string;
  readonly now?: () => Date;
  /** `--library DIR`: the library root whose `cues/` hold the cue audio (over the config and the vault). */
  readonly library?: string;
  readonly env: Env;
  /** The casting side (`realCastingDeps(env)` in production, a fake under `bun test`). */
  readonly casting: CastingDeps;
  readonly stderr?: { write(text: string): unknown };
}

export interface MixerHost extends NotesHost {
  loadMix(args: unknown): MixPayload;
  peaks(args: unknown): PeaksPayload;
  clipAudio(args: unknown): ClipAudioPayload;
  saveMix(args: unknown): SavedMixPayload;
  renderMix(args: unknown): Promise<RenderedMixPayload>;
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
  const notes = createNotesHost({ work, title: options.title ?? "radio", ...(options.now === undefined ? {} : { now: options.now }) });

  /** One `mixer` call; a refusal or error is thrown with the Python side's own words. */
  function call(op: string, args: readonly string[]): Record<string, unknown> {
    const vault = options.vault === undefined ? [] : ["--vault", options.vault];
    const library = options.library === undefined ? [] : ["--library", options.library];
    const result = runCasting(["mixer", op, ...args, ...vault, ...library], ctx, options.casting, work);
    const body = isRecord(result.body) ? result.body : {};
    if (result.exitCode !== 0 || body["ok"] === false) {
      throw new Error(typeof body["message"] === "string" ? body["message"] : `the mixer could not ${op} (exit ${result.exitCode})`);
    }
    return body;
  }

  /** `call`, but the child runs asynchronously (with the `mix` extra provisioned): for a render. */
  async function callAsync(op: string, args: readonly string[]): Promise<Record<string, unknown>> {
    const vault = options.vault === undefined ? [] : ["--vault", options.vault];
    const library = options.library === undefined ? [] : ["--library", options.library];
    const ready = ensureProvisioned(ctx, options.casting, work, [MIX_EXTRA]);
    const result = ready.ok ? await runPythonStreaming(ready.layout, options.casting, ctx, ["mixer", op, ...args, ...vault, ...library, "--work", work], () => undefined) : ready.result;
    const body = isRecord(result.body) ? result.body : {};
    if (result.exitCode !== 0 || body["ok"] === false) {
      throw new Error(typeof body["message"] === "string" ? body["message"] : `the mixer could not ${op} (exit ${result.exitCode})`);
    }
    return body;
  }

  const renderedFrom = (raw: unknown): RenderedFrom => {
    const whole = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
    return isRecord(raw) ? { manifest: whole(raw["manifest"]), mix: whole(raw["mix"]) } : { manifest: null, mix: null };
  };

  const versionRows = (rows: unknown): MixVersionInfo[] => (Array.isArray(rows) ? (rows as MixVersionInfo[]) : []);

  return {
    ...notes,
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
        rendered: renderedFrom(body["rendered"]),
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

    async renderMix(args) {
      const episode = positiveInt(args, "episode", true);
      const base = positiveInt(args, "base", true);
      const body = await callAsync("render", ["--episode", String(episode), "--base", String(base)]);
      return {
        episode,
        mixVersion: base,
        manifestVersion: body["version"] as number,
        audio: typeof body["audio"] === "string" ? body["audio"] : null,
        duration: body["duration"] as number,
        rendered: renderedFrom(body["rendered"]),
        message: typeof body["message"] === "string" ? body["message"] : "",
      };
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
    renderMix: async (args) => host.renderMix(args),
    listNotes: async (args) => host.listNotes(args),
    saveNote: async (args) => host.saveNote(args),
    deleteNote: async (args) => host.deleteNote(args),
    exportNotes: async (args) => host.exportNotes(args),
    notesToFlags: async (args) => host.notesToFlags(args),
  };
  return handlers;
}

// ---------------------------------------------------------------------------
// The window (AGT-1768)
// ---------------------------------------------------------------------------

export const NO_CHROME_MIXER_MESSAGE =
  "pablo: the mixer opens in Google Chrome, and I could not find it on this Mac. Install Chrome (https://www.google.com/chrome) and run this again; nothing was changed.";

/** The review player's CSP (ui-leaf's strict preset plus media from data:/blob:). */
export const MIXER_CSP = REVIEW_CSP;

/** After the window disconnects and does not come back, close its server. */
const DISCONNECT_CLOSE_DELAY_MS = 5000;

/** The mix versions on disk for an episode (`renders/epNN/mix.v<m>.json`), read without the Python side. */
export function mixVersionsOnDisk(work: string, episode: number): number[] {
  const dir = join(castingDir(work), "renders", `ep${String(episode).padStart(2, "0")}`);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => /^mix\.v(\d+)\.json$/.exec(name)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

export interface OpenMixerDeps {
  readonly env: Env;
  readonly mount: (options: MountOptions) => Promise<View>;
  readonly existsExecutable?: (path: string) => boolean;
  readonly binaryPath: () => string | undefined;
}

export interface OpenMixerRequest {
  readonly work: string;
  readonly title: string;
  readonly episode: number;
  readonly version?: number;
  readonly vault?: string;
  readonly library?: string;
  readonly casting: CastingDeps;
}

export type OpenMixerOutcome =
  | { readonly ok: true; readonly view: View; readonly closed: Promise<void>; readonly host: MixerHost }
  | { readonly ok: false; readonly code: 1 | 2; readonly message: string };

/**
 * Mounts the mixer on one episode's mix document. Refuses (exit 2), opening nothing, when the episode has no mix
 * document (or not the asked version), and (unless `UI_LEAF_NO_OPEN` is set, as headless runs and smoke tests
 * do) when Google Chrome is missing.
 */
export async function openMixer(request: OpenMixerRequest, signal?: AbortSignal, overrides: Partial<OpenMixerDeps> = {}): Promise<OpenMixerOutcome> {
  const deps: OpenMixerDeps = { env: process.env, mount, binaryPath: resolveUiLeafBinary, ...overrides };
  const { work, title, episode, version } = request;
  const headless = deps.env["UI_LEAF_NO_OPEN"] !== undefined && deps.env["UI_LEAF_NO_OPEN"] !== "0";
  if (!headless && findChrome(deps.existsExecutable) === undefined) return { ok: false, code: 2, message: NO_CHROME_MIXER_MESSAGE };

  const found = mixVersionsOnDisk(work, episode);
  if (found.length === 0) {
    return { ok: false, code: 2, message: `pablo: mixer: episode ${episode} has no mix document yet (run pablo mix --output radio --unit ${episode}); nothing was opened` };
  }
  if (version !== undefined && !found.includes(version)) {
    return { ok: false, code: 2, message: `pablo: mixer: episode ${episode} has no mix v${version} (it has ${found.map((v) => `v${v}`).join(", ")}); nothing was opened` };
  }

  const host = createMixerHost({
    work,
    title,
    env: deps.env,
    casting: request.casting,
    ...(request.vault === undefined ? {} : { vault: request.vault }),
    ...(request.library === undefined ? {} : { library: request.library }),
  });

  // ui-leaf reads this from its inherited environment and, on its own, suppresses the window under ssh;
  // this is a window meant to open. An explicit UI_LEAF_NO_OPEN is still honoured.
  if (process.env["UI_LEAF_NO_OPEN"] === undefined) process.env["UI_LEAF_NO_OPEN"] = "0";

  const data: MixerData = { title, episode, ...(version === undefined ? {} : { version }) };
  const binaryPath = deps.binaryPath();
  let view: View;
  try {
    view = await deps.mount({
      view: "mixer",
      viewsRoot: VIEWS_ROOT,
      data,
      title: `${title} — pablo mixer`,
      mutations: mixerMutations(host),
      shell: "app",
      windowSize: { width: 1280, height: 820 },
      port: 0,
      silent: true,
      csp: MIXER_CSP,
      heartbeatTimeoutMs: 90_000,
      ...(binaryPath === undefined ? {} : { binaryPath }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    return { ok: false, code: 1, message: `pablo: mixer: could not open the mixer (${(error as Error).message})` };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  view.onDisconnect(() => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => void view.close(), DISCONNECT_CLOSE_DELAY_MS);
  });
  view.onReconnect(() => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  });
  const closed = view.closed.then(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  return { ok: true, view, closed, host };
}
