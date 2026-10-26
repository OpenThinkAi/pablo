/**
 * The layered voice resolver (AGT-2138, pablo-platform D-15): one function that
 * says which voice material a work's pack carries, in what order, and where each
 * piece came from. Layers, lowest precedence first:
 *
 *     global   $XDG_CONFIG_HOME/pablo/voices/default/, then every named voice the
 *              work lists that lives in the global voices directory
 *     vault    <vault>/style/, then every named voice the work lists that lives in
 *              <vault>/voices/<name>/
 *     work     any other voice file or directory the work's `pablo.json` `voice`
 *              list names, then the work's own rules file (`QWEN.md`'s rule
 *              sections)
 *     output   outputs/<type>/RULES.md, when an output is named
 *
 * A `pablo.json` `voice` entry is either a path relative to the work
 * (`../../style`, `QWEN.md`, `../../voices/plain`: the shape `init` writes) or a
 * bare voice name (`plain`, `fiction`), resolved like `--voice`: `<vault>/voices/
 * <name>/` first, then the global voices directory; `fiction` is `<vault>/style/`.
 * An entry is placed in the layer of the place it resolves to, never by its
 * position in the list, so a global voice the work names still sits below the
 * vault's `style/`. The vault's `style/` and the work's rules file are always
 * their layers' base: listing them (the default list does) changes nothing, and
 * a piece reached twice is kept once, at its first place.
 *
 * Nothing here is an error. A layer with nothing on disk is reported in
 * `missing` (with the entry that named it, when one did) and the pack is built
 * without it; the caller decides whether a missing listed voice is worth
 * refusing over.
 *
 * Pure reading: no write, no git, no model. Each layer's rules and exemplars are
 * labelled by a path a receipt can show (vault-relative inside the vault,
 * absolute outside it).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { outputRulesFile, readStyle, readWorkRules } from "@openthink/pablo-core";
import type { PackVoice, PackVoiceMissing, TextSource } from "@openthink/pablo-core";
import { SLUG_PATTERN } from "./init";
import { DEFAULT_VOICE, markerPath } from "./marker";
import { globalVoicesDir, isVoicePathArgument, readVoice } from "./voice";

/** The four layers, lowest precedence first. */
export type VoiceLayerKind = "global" | "vault" | "work" | "output";
export const VOICE_LAYER_ORDER: readonly VoiceLayerKind[] = ["global", "vault", "work", "output"];

/** The global voice every work carries when it exists: `<global voices>/default/`. */
export const GLOBAL_DEFAULT_VOICE = "default";

/** The work's own rules file, its base work layer (D-15 renames it later with a fallback read). */
export const WORK_RULES_FILE = "QWEN.md";

/** One piece of one layer: a voice directory, a one-off file, `style/`, the work's rules or an output's RULES.md. */
export interface VoiceLayer {
  readonly layer: VoiceLayerKind;
  /** What the piece is: `default`, a voice name, `style`, the rules file's name, `RULES.md (<type>)`. */
  readonly name: string;
  /** Where it came from: the absolute directory or file read. */
  readonly path: string;
  /** `path` as a receipt shows it: vault-relative inside the vault, absolute outside it. */
  readonly label: string;
  /** The `pablo.json` entry that named it (`voice[0]: ../../style`); absent for a layer every work carries. */
  readonly via?: string;
  readonly rules: readonly TextSource[];
  readonly exemplars: readonly TextSource[];
  readonly never?: TextSource;
}

/** A layer piece looked for and not found (or found empty). */
export interface MissingVoiceLayer {
  readonly layer: VoiceLayerKind | undefined;
  readonly name: string;
  /** Where it was looked for; for an unresolvable name, every place tried. */
  readonly tried: readonly string[];
  /** The `pablo.json` entry that named it, when one did. */
  readonly via?: string;
  readonly reason: string;
}

export interface ResolvedVoiceLayers {
  /** Every piece found, in precedence order (lowest first). */
  readonly layers: readonly VoiceLayer[];
  readonly missing: readonly MissingVoiceLayer[];
}

export interface ResolveVoiceLayersOptions {
  /** The vault root, which holds `style/` and `voices/`. */
  readonly vaultRoot: string;
  /** The work root (`<vault>/novels/<slug>`), which holds `pablo.json` and the rules file. */
  readonly workRoot: string;
  /** The output the pack is for (`novel`, `radio`, ...): its `outputs/<type>/RULES.md` is the top layer. */
  readonly output?: string | undefined;
  /** Overrides the work's `pablo.json` `voice` list (a caller that already read the marker). */
  readonly voice?: readonly string[] | undefined;
  /** For `$XDG_CONFIG_HOME`; defaults to `process.env`. */
  readonly env?: Record<string, string | undefined> | undefined;
}

/** Everything a pack's voice needs for one work and output; see the file comment for the order. */
export function resolveVoiceLayers(options: ResolveVoiceLayersOptions): ResolvedVoiceLayers {
  const vaultRoot = resolve(options.vaultRoot);
  const workRoot = resolve(options.workRoot);
  const globalDir = globalVoicesDir(options.env ?? process.env);
  const vaultVoicesDir = join(vaultRoot, "voices");
  const styleDir = join(vaultRoot, "style");
  const rulesPath = join(workRoot, WORK_RULES_FILE);
  const display = (path: string) => labelOf(vaultRoot, path);

  const buckets: Record<VoiceLayerKind, VoiceLayer[]> = { global: [], vault: [], work: [], output: [] };
  const missing: MissingVoiceLayer[] = [];
  const seen = new Set<string>();

  // A voice directory or one-off file, read the way `--voice` reads it, labelled for receipts.
  const voicePiece = (layer: VoiceLayerKind, path: string, via?: string): VoiceLayer | undefined =>
    readPiece(layer, path, display, via);

  const add = (piece: VoiceLayer | undefined, want: { layer: VoiceLayerKind; name: string; path: string; via?: string }) => {
    if (seen.has(want.path)) return;
    seen.add(want.path);
    if (piece === undefined) {
      missing.push({
        layer: want.layer,
        name: want.name,
        tried: [want.path],
        ...(want.via === undefined ? {} : { via: want.via }),
        reason: existsSync(want.path) ? `${display(want.path)} is empty` : `no ${display(want.path)}`,
      });
      return;
    }
    buckets[want.layer].push(piece);
  };

  // Layer bases every work carries: the global default and the vault's style/.
  const globalDefault = join(globalDir, GLOBAL_DEFAULT_VOICE);
  add(existsSync(globalDefault) ? voicePiece("global", globalDefault) : undefined, { layer: "global", name: GLOBAL_DEFAULT_VOICE, path: globalDefault });
  add(stylePiece(vaultRoot, styleDir), { layer: "vault", name: "style", path: styleDir });

  // The work's list, each entry placed by where it resolves.
  const entries = options.voice ?? readVoiceList(workRoot);
  entries.forEach((entry, index) => {
    const via = `voice[${index}]: ${entry}`;
    const found = locateEntry(entry, { vaultRoot, workRoot, globalDir, vaultVoicesDir, styleDir, rulesPath });
    if (!found.ok) {
      missing.push({ layer: found.layer, name: entry, tried: found.tried, via, reason: found.reason });
      return;
    }
    const { path, layer } = found;
    if (path === styleDir || path === rulesPath) return; // a base layer, added in its own place
    add(voicePiece(layer, path, via), { layer, name: entry, path, via });
  });

  // The work's own rules file is the work layer's last word; the output's RULES.md tops everything.
  add(rulesPiece(vaultRoot, workRoot, rulesPath), { layer: "work", name: WORK_RULES_FILE, path: rulesPath });
  if (options.output !== undefined) {
    const outputRules = join(workRoot, outputRulesFile(options.output));
    add(textPiece("output", `RULES.md (${options.output})`, outputRules, display(outputRules)), {
      layer: "output",
      name: `RULES.md (${options.output})`,
      path: outputRules,
    });
  }

  return { layers: VOICE_LAYER_ORDER.flatMap((kind) => buckets[kind]), missing };
}

/** The pieces of one layer, in order. */
export function layerOf(resolved: ResolvedVoiceLayers, kind: VoiceLayerKind): readonly VoiceLayer[] {
  return resolved.layers.filter((piece) => piece.layer === kind);
}

/** What put a piece in the pack, as a receipt says it: its `pablo.json` entry, `global default`, or nothing for a layer base. */
export function viaOf(piece: VoiceLayer): string | undefined {
  if (piece.via !== undefined) return piece.via;
  return piece.layer === "global" && piece.name === GLOBAL_DEFAULT_VOICE ? "global default" : undefined;
}

/**
 * One line per piece for a receipt or `--dry-run`: `vault  style  (style/prose.md, style/anti-tells.md)`.
 * The global default is always labelled as such, and a voice the work's `pablo.json` names that was not found is a
 * `missing` line naming the entry (AGT-2139), never left out.
 */
export function describeVoiceLayers(resolved: ResolvedVoiceLayers): string[] {
  const found = resolved.layers.map((piece) => {
    const files = [...piece.rules, ...piece.exemplars, ...(piece.never ? [piece.never] : [])].map((s) => s.path);
    const via = viaOf(piece);
    return `${piece.layer}  ${piece.label}${via ? `  [${via}]` : ""}  (${files.join(", ")})`;
  });
  return [...found, ...listedMissing(resolved).map((m) => `missing  ${m.name}  [${m.via}]: ${m.reason}`)];
}

/** The `missing` entries a `pablo.json` entry named: the ones an author asked for and did not get. */
function listedMissing(resolved: ResolvedVoiceLayers): PackVoiceMissing[] {
  return resolved.missing.flatMap((m) =>
    m.via === undefined ? [] : [{ ...(m.layer === undefined ? {} : { layer: m.layer }), name: m.name, via: m.via, reason: m.reason }],
  );
}

/** The resolved layers in the shape a pack, its dry run and its receipt carry (core's `PackVoice`). */
export function packVoice(resolved: ResolvedVoiceLayers): PackVoice {
  return {
    layers: resolved.layers.map((piece) => {
      const via = viaOf(piece);
      return { layer: piece.layer, name: piece.name, source: piece.label, ...(via === undefined ? {} : { via }) };
    }),
    missing: listedMissing(resolved),
  };
}

/** The voice material of some layers, merged in the order a pack sends it. */
export interface MergedVoice {
  /** Every piece's rules, lowest precedence first, so the most specific rule is read last. */
  readonly rules: readonly TextSource[];
  /** Every piece's exemplars, most specific piece first, each piece's newest first. */
  readonly exemplars: readonly TextSource[];
  /** Every piece's `never.md`, lowest precedence first. */
  readonly never: readonly TextSource[];
}

/** Several sources as one, for a slice that takes one: texts in order, paths joined the way slice sources are; empty ones dropped. */
export function joinSources(sources: readonly TextSource[]): TextSource | undefined {
  const kept = sources.filter((source) => source.text.trim() !== "");
  if (kept.length === 0) return undefined;
  if (kept.length === 1) return kept[0];
  return { path: kept.map((source) => source.path).join(", "), text: kept.map((source) => source.text.trim()).join("\n\n") };
}

/** Merges the material of `pieces` (already in precedence order, lowest first) for a pack. */
export function mergeVoice(pieces: readonly VoiceLayer[]): MergedVoice {
  return {
    rules: pieces.flatMap((piece) => piece.rules),
    exemplars: [...pieces].reverse().flatMap((piece) => piece.exemplars),
    never: pieces.flatMap((piece) => (piece.never === undefined ? [] : [piece.never])),
  };
}

export interface ResolveProseVoiceOptions {
  /** Where `resolveVoice` found the `--voice` (a voice directory, `<vault>/style/`, or a one-off file). */
  readonly voicePath: string;
  /** The vault, when there is one: it decides whether the voice sits in the vault layer. */
  readonly vaultRoot?: string | undefined;
  /** For `$XDG_CONFIG_HOME`; defaults to `process.env`. */
  readonly env?: Record<string, string | undefined> | undefined;
}

/**
 * The layered voice of a `pablo prose` pack (AGT-2139, D-15): `prose` has no
 * work and no output, so its layers are the global default under the voice
 * `--voice` names, which sits in the layer of the place it lives (the global
 * voices directory, the vault's `voices/` or `style/`, else a one-off file:
 * the work layer, the most specific there is). The named voice reached twice
 * (`--voice default`) is kept once.
 */
export function resolveProseVoiceLayers(options: ResolveProseVoiceOptions): ResolvedVoiceLayers {
  const globalDir = globalVoicesDir(options.env ?? process.env);
  const vaultRoot = options.vaultRoot === undefined ? undefined : resolve(options.vaultRoot);
  const voicePath = resolve(options.voicePath);
  const display = (path: string) => (vaultRoot === undefined ? path : labelOf(vaultRoot, path));
  const layers: VoiceLayer[] = [];
  const missing: MissingVoiceLayer[] = [];

  const globalDefault = join(globalDir, GLOBAL_DEFAULT_VOICE);
  if (globalDefault !== voicePath) {
    const piece = existsSync(globalDefault) ? readPiece("global", globalDefault, display) : undefined;
    if (piece === undefined) {
      missing.push({ layer: "global", name: GLOBAL_DEFAULT_VOICE, tried: [globalDefault], reason: `no ${globalDefault}` });
    } else {
      layers.push(piece);
    }
  }

  const layer: VoiceLayerKind =
    within(globalDir, voicePath) ? "global"
    : vaultRoot !== undefined && (voicePath === join(vaultRoot, "style") || within(join(vaultRoot, "style"), voicePath) || within(join(vaultRoot, "voices"), voicePath)) ? "vault"
    : "work";
  const named = readPiece(layer, voicePath, display, "--voice");
  if (named !== undefined) layers.push(named);
  return { layers, missing };
}

/** A voice directory or one-off file read the way `--voice` reads it, labelled for receipts; `undefined` when it holds nothing. */
function readPiece(layer: VoiceLayerKind, path: string, display: (path: string) => string, via?: string): VoiceLayer | undefined {
  const voice = readVoice(path);
  const base = display(path);
  const file = isFile(path);
  const relabel = (s: TextSource): TextSource => ({ ...s, path: file ? base : `${base}/${s.path}` });
  const piece: VoiceLayer = {
    layer,
    name: voice.name,
    path,
    label: base,
    ...(via === undefined ? {} : { via }),
    rules: voice.rules.map(relabel),
    exemplars: voice.exemplars.map(relabel),
    ...(voice.never === undefined ? {} : { never: relabel(voice.never) }),
  };
  return isEmpty(piece) ? undefined : piece;
}

// ---------------------------------------------------------------------------

type Located =
  | { readonly ok: true; readonly path: string; readonly layer: VoiceLayerKind }
  | { readonly ok: false; readonly layer: VoiceLayerKind | undefined; readonly tried: readonly string[]; readonly reason: string };

interface Places {
  readonly vaultRoot: string;
  readonly workRoot: string;
  readonly globalDir: string;
  readonly vaultVoicesDir: string;
  readonly styleDir: string;
  readonly rulesPath: string;
}

/** Where one `voice` entry points, and so which layer it belongs to. */
function locateEntry(entry: string, places: Places): Located {
  const trimmed = entry.trim();
  if (trimmed === "") return { ok: false, layer: undefined, tried: [], reason: "an empty voice entry" };

  if (isVoicePathArgument(trimmed) || existsSync(join(places.workRoot, trimmed))) {
    const path = resolve(places.workRoot, trimmed);
    if (!existsSync(path)) return { ok: false, layer: layerOfPath(path, places), tried: [path], reason: `no ${labelOf(places.vaultRoot, path)}` };
    return { ok: true, path: voiceRoot(path, places), layer: layerOfPath(path, places) };
  }

  // A bare name, resolved like `--voice <name>`.
  if (!SLUG_PATTERN.test(trimmed)) {
    return { ok: false, layer: undefined, tried: [], reason: `"${trimmed}" is neither a path nor a voice name` };
  }
  if (trimmed === "fiction") return existsSync(places.styleDir)
    ? { ok: true, path: places.styleDir, layer: "vault" }
    : { ok: false, layer: "vault", tried: [places.styleDir], reason: `no voice "fiction" (no style/ directory)` };
  const inVault = join(places.vaultVoicesDir, trimmed);
  if (existsSync(inVault)) return { ok: true, path: inVault, layer: "vault" };
  const inGlobal = join(places.globalDir, trimmed);
  if (existsSync(inGlobal)) return { ok: true, path: inGlobal, layer: "global" };
  return { ok: false, layer: undefined, tried: [inVault, inGlobal], reason: `no voice "${trimmed}"` };
}

/** The layer a resolved path lives in: global voices, the vault's style/ or voices/, else the work. */
function layerOfPath(path: string, places: Places): VoiceLayerKind {
  if (within(places.globalDir, path)) return "global";
  if (path === places.styleDir || within(places.styleDir, path) || within(places.vaultVoicesDir, path)) return "vault";
  return "work";
}

/** A path inside a named voice directory stands for the whole voice (`voices/plain/voice.md` is the voice `plain`). */
function voiceRoot(path: string, places: Places): string {
  for (const dir of [places.globalDir, places.vaultVoicesDir]) {
    if (!within(dir, path)) continue;
    const name = relative(dir, path).split(sep)[0];
    if (name !== undefined && name !== "") return join(dir, name);
  }
  if (within(places.styleDir, path)) return places.styleDir;
  return path;
}

/** The work's `pablo.json` `voice` list, or the default list when the marker is missing, unreadable or has none. */
function readVoiceList(workRoot: string): readonly string[] {
  try {
    const data = JSON.parse(readFileSync(markerPath(workRoot), "utf8")) as { voice?: unknown };
    if (Array.isArray(data.voice)) return data.voice.filter((v): v is string => typeof v === "string");
  } catch {
    // No marker (or a malformed one): every other verb refuses that; the resolver reads the default.
  }
  return DEFAULT_VOICE;
}

function stylePiece(vaultRoot: string, styleDir: string): VoiceLayer | undefined {
  const rules = readStyle(vaultRoot);
  if (rules.length === 0) return undefined;
  return { layer: "vault", name: "style", path: styleDir, label: labelOf(vaultRoot, styleDir), rules, exemplars: [] };
}

function rulesPiece(vaultRoot: string, workRoot: string, rulesPath: string): VoiceLayer | undefined {
  const source = readWorkRules(vaultRoot, workRoot);
  if (source === undefined || source.text.trim() === "") return undefined;
  return { layer: "work", name: WORK_RULES_FILE, path: rulesPath, label: source.path, rules: [source], exemplars: [] };
}

function textPiece(layer: VoiceLayerKind, name: string, path: string, label: string): VoiceLayer | undefined {
  if (!isFile(path)) return undefined;
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return undefined;
  return { layer, name, path, label, rules: [{ path: label, text }], exemplars: [] };
}

function isEmpty(piece: VoiceLayer): boolean {
  return piece.rules.length === 0 && piece.exemplars.length === 0 && piece.never === undefined;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function within(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function labelOf(vaultRoot: string, path: string): string {
  return within(vaultRoot, path) ? relative(vaultRoot, path) : path;
}
