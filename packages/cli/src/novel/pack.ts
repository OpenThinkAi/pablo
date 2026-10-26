/**
 * The drafting pack for one chapter (AGT-1230).
 *
 * `@openthink/pablo-core` already has everything that reads the vault and
 * assembles a prompt (`readDraftingInputs`, `assemblePack`) — this module
 * wires them together with the two policies that are pablo's, not core's:
 *
 * 1. **The voice filter.** `style/*.md` carries sections addressed to the
 *    agent ("In replies to Matt…"), not the reader — see the design doc's
 *    `Voice` section. Those never enter a pack.
 * 2. **The `neverSend` check.** A work's `pablo.json` names path prefixes
 *    (`research/`, `notes/`, by default) that must never reach a model. A
 *    slice sourced under one of them is a refusal, not a silent drop —
 *    silence here is exactly the failure mode `neverSend` exists to prevent.
 *
 * Both run after `assemblePack`, over the pack's own slices, so the check is
 * against what would actually be sent — not against the inputs before the
 * budget had its say.
 */

import { isAbsolute, join, relative, sep } from "node:path";
import type { DraftingInputs, Pack, TextSource } from "@openthink/pablo-core";
import {
  AGENT_SECTION_HEADING,
  assemblePack,
  DEFAULT_MIN_SCENES,
  outputRulesFile,
  planBeatsFor,
  readDraftingInputs,
} from "@openthink/pablo-core";
import type { Marker } from "../marker";
import { NOVEL_ID } from "../outputs/novel/units";
import { layerOf, mergeVoice, packVoice, resolveVoiceLayers } from "../voice-layers";

/** `draft-chapter`'s length target, ported as pablo's default (AC2). */
export const DEFAULT_WORD_TARGET = 1800;

/** The real vault's family tree ends its cast facts here; open questions after it are not facts. */
export const CAST_ENDS_AT = "## Decisions for Matt";

/**
 * Distinct from `./project`'s `Refusal` (which always carries `tried`, a
 * list of paths a *resolution* looked at): this refusal is a pack-assembly
 * violation, which has no `tried` list to report.
 */
export interface PackRefusal {
  readonly ok: false;
  readonly code: 2;
  readonly message: string;
}

export interface ChapterPackResult {
  readonly ok: true;
  readonly pack: Pack;
  readonly inputs: DraftingInputs;
}

export type ChapterPackOutcome = ChapterPackResult | PackRefusal;

export interface BuildChapterPackOptions {
  readonly words?: number | undefined;
  readonly scenes?: number | undefined;
  /** The work's `pablo.json`, for `neverSend`. */
  readonly marker: Marker;
  /** A steer for this chapter beyond the beat row (AGT-1562): its own `direction` slice in the pack. */
  readonly direction?: string | undefined;
  /**
   * The output the unit belongs to (AGT-1671), default `novel`: the pack
   * carries that output's own continuity ledger plus `facts.md`, never another
   * output's ledger, and a slice sourced under another output's directory is
   * a refusal, like a `neverSend` one.
   */
  readonly output?: string | undefined;
  /** For the global voices directory (`$XDG_CONFIG_HOME`); defaults to `process.env`. */
  readonly env?: Record<string, string | undefined> | undefined;
}

/**
 * Assembles the drafting pack for `chapter` in `workDir` (a project directory
 * under `vaultRoot`). Throws only in the case `readDraftingInputs` throws
 * (no beat row for `chapter`) — callers run `chapterPreconditions` first so
 * that never happens; see `write.ts`.
 */
export function buildChapterPack(
  vaultRoot: string,
  workDir: string,
  chapter: number,
  options: BuildChapterPackOptions,
): ChapterPackOutcome {
  const wordTarget = options.words ?? DEFAULT_WORD_TARGET;
  const minScenes = options.scenes ?? DEFAULT_MIN_SCENES;

  // The output's plan maps the unit onto its beats (a row may name several);
  // no plan, or no row for the unit, is one unit per beat. Its RULES.md, when
  // it has one, is its own slice after the work's rules (AGT-1670).
  // `output` (AGT-1671) is the unit's own output: its plan, rules and ledger, never another's.
  const output = options.output ?? NOVEL_ID;
  const beats = planBeatsFor(workDir, output, chapter);
  const rulesPath = join(workDir, outputRulesFile(output));
  const inputs = readDraftingInputs({
    vaultRoot,
    workRoot: workDir,
    chapter,
    ...(beats !== undefined ? { beats } : {}),
    outputRulesPath: rulesPath,
    wordTarget,
    minScenes,
    castEndsAt: CAST_ENDS_AT,
    output,
  });

  return packFromInputs(vaultRoot, workDir, inputs, { ...options, output });
}

/**
 * The two pablo policies applied to read inputs, then the pack assembled and
 * checked against `neverSend`: shared by every output's pack builder (the
 * novel's chapter, the story's whole piece, the radio episode) so none
 * re-implements them.
 *
 * The voice is the layered one (AGT-2139, D-15), from `resolveVoiceLayers`:
 * the global and vault layers are the `style` slice, the work layer (the
 * voices its `pablo.json` lists, then its own rules file) the `workRules`
 * slice, the output's `RULES.md` the `outputRules` slice, and every voice's
 * `never.md` and exemplars their own slices. The rules file's text is the
 * reader's (`inputs.workRules`), which keeps the period facts in their own
 * slice. Which layers were used rides on the pack to the dry run and receipt.
 */
export function packFromInputs(
  vaultRoot: string,
  workDir: string,
  inputs: DraftingInputs,
  options: Pick<BuildChapterPackOptions, "marker" | "direction" | "output" | "env">,
): ChapterPackOutcome {
  const output = options.output ?? NOVEL_ID;
  const resolved = resolveVoiceLayers({ vaultRoot, workRoot: workDir, output, voice: options.marker.voice, env: options.env });
  const below = [...layerOf(resolved, "global"), ...layerOf(resolved, "vault")];
  const work = layerOf(resolved, "work");
  // The work layer's only piece no `pablo.json` entry named is its own rules file.
  const workVoices = work.filter((piece) => piece.via !== undefined);
  const hasRulesFile = work.some((piece) => piece.via === undefined);
  const outputPiece = layerOf(resolved, "output")[0];
  const all = mergeVoice(resolved.layers);
  const workRules = joinSources([
    ...filterVoice(mergeVoice(workVoices).rules),
    ...(hasRulesFile && inputs.workRules !== undefined ? [inputs.workRules] : []),
  ]);

  const filtered: DraftingInputs = {
    ...inputs,
    style: filterVoice(mergeVoice(below).rules),
    workRules,
    outputRules: outputPiece?.rules[0],
    never: all.never,
    exemplars: all.exemplars,
    voiceLayers: packVoice(resolved),
    ...(options.direction === undefined ? {} : { direction: options.direction }),
  };

  const pack = assemblePack("drafting", filtered);

  const violation = findNeverSendViolation(pack, vaultRoot, workDir, options.marker.neverSend);
  if (violation !== undefined) {
    return {
      ok: false,
      code: 2,
      message:
        `pablo: refusing to draft — slice "${violation.slice}" (${violation.source}) ` +
        `is under neverSend prefix "${violation.prefix}"`,
    };
  }

  const leak = findOtherOutputSlice(pack, vaultRoot, workDir, output);
  if (leak !== undefined) {
    return {
      ok: false,
      code: 2,
      message:
        `pablo: refusing to draft — slice "${leak.slice}" (${leak.source}) belongs to output ` +
        `"${leak.prefix}", not this unit's; another telling's continuity never enters a pack (promote it to facts.md)`,
    };
  }

  return { ok: true, pack, inputs: filtered };
}

/** Several rule sources as one, for a slice that takes one: texts in order, paths joined the way slice sources are. */
function joinSources(sources: readonly TextSource[]): TextSource | undefined {
  const kept = sources.filter((source) => source.text.trim() !== "");
  if (kept.length === 0) return undefined;
  if (kept.length === 1) return kept[0];
  return { path: kept.map((source) => source.path).join(", "), text: kept.map((source) => source.text.trim()).join("\n\n") };
}

/**
 * Drops any `## ` section of a voice source whose heading matches
 * `AGENT_SECTION_HEADING`. The text before the first `## ` heading (a
 * preamble, e.g. `style/prose.md`'s title line) is always kept.
 */
function filterVoice(style: readonly TextSource[]): readonly TextSource[] {
  return style.map((source) => ({ ...source, text: filterVoiceText(source.text) }));
}

function filterVoiceText(text: string): string {
  const parts = text.split("\n## ");
  const preamble = (parts[0] ?? "").trim();
  const sections = parts
    .slice(1)
    .map((section) => section.trim())
    .filter((section) => {
      const heading = section.split("\n", 1)[0] ?? "";
      return !AGENT_SECTION_HEADING.test(heading);
    })
    .map((section) => `## ${section}`);
  // Every kept segment is already trimmed, so joining on a single blank line
  // gives consistent spacing regardless of how the source file spaced them.
  return [preamble, ...sections].filter((part) => part !== "").join("\n\n");
}

interface NeverSendViolation {
  readonly slice: string;
  readonly source: string;
  readonly prefix: string;
}

/**
 * The first slice (in prompt order) whose source falls under one of
 * `neverSend`'s prefixes, or `undefined` when the pack is clean.
 *
 * `Slice.source` and `TextSource.path` are vault-relative (or, rarely, an
 * absolute path outside the vault — `readDraftingInputs`'s `label` falls
 * back to that); `neverSend` prefixes are work-relative (`"research/"`).
 * Both are normalised to work-relative before comparing. A joined
 * multi-source slice (`style`, `"a.md, b.md"`) is split on `", "` first so
 * each underlying path is checked on its own.
 */
function findNeverSendViolation(
  pack: Pack,
  vaultRoot: string,
  workDir: string,
  neverSend: readonly string[],
): NeverSendViolation | undefined {
  if (neverSend.length === 0) return undefined;

  for (const slice of pack.slices) {
    if (slice.source === undefined) continue;
    for (const sourcePath of slice.source.split(", ")) {
      const workRelative = toWorkRelative(vaultRoot, workDir, sourcePath);
      if (workRelative === undefined) continue;
      const prefix = neverSend.find((candidate) => workRelative.startsWith(candidate));
      if (prefix !== undefined) {
        return { slice: slice.name, source: sourcePath, prefix };
      }
    }
  }

  return undefined;
}

/**
 * The first slice sourced under `outputs/<type>/` for a type other than
 * `output` (AGT-1671): output-specific facts do not leak sideways. The
 * `prefix` it reports is the other type's id. The novel's unmigrated ledger
 * (`continuity.md` at the work root) is not under `outputs/`, so a non-novel
 * unit is kept from it by the reader (`continuityFile(work, output)`) rather
 * than here.
 */
function findOtherOutputSlice(pack: Pack, vaultRoot: string, workDir: string, output: string): NeverSendViolation | undefined {
  for (const slice of pack.slices) {
    if (slice.source === undefined) continue;
    for (const sourcePath of slice.source.split(", ")) {
      const rel = toWorkRelative(vaultRoot, workDir, sourcePath);
      const owner = rel === undefined ? undefined : /^outputs\/([^/]+)\//.exec(rel)?.[1];
      if (owner !== undefined && owner !== output) return { slice: slice.name, source: sourcePath, prefix: owner };
    }
  }
  return undefined;
}

/**
 * `source` (vault-relative, or absolute) as a path relative to `workDir`,
 * with `/` separators — or `undefined` when it falls outside `workDir`
 * entirely (the shared `style/` files, in particular, always do).
 */
function toWorkRelative(vaultRoot: string, workDir: string, source: string): string | undefined {
  const absolute = isAbsolute(source) ? source : join(vaultRoot, source);
  const rel = relative(workDir, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}
