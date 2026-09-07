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
import { assemblePack, DEFAULT_MIN_SCENES, readDraftingInputs } from "@openthink/pablo-core";
import type { Marker } from "../marker";

/** `draft-chapter`'s length target, ported as pablo's default (AC2). */
export const DEFAULT_WORD_TARGET = 1800;

/** The real vault's family tree ends its cast facts here; open questions after it are not facts. */
const CAST_ENDS_AT = "## Decisions for Matt";

/** A `## ` section heading that addresses the agent, not the reader — dropped by the voice filter. */
const AGENT_SECTION_HEADING = /repl(y|ies)|agent/i;

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

  const inputs = readDraftingInputs({
    vaultRoot,
    workRoot: workDir,
    chapter,
    wordTarget,
    minScenes,
    castEndsAt: CAST_ENDS_AT,
  });

  const filtered: DraftingInputs = { ...inputs, style: filterVoice(inputs.style) };

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

  return { ok: true, pack, inputs: filtered };
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
