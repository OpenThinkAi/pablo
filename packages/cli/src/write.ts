/**
 * `pablo write --project <slug> --chapter N` (AGT-1230, part 1: the pack and
 * `--dry-run`). See the design doc's `The write pipeline` section — this
 * ticket is steps 1 and 2 (check, pack) plus the dry-run view; steps 3 to 7
 * (send, normalize, write, rituals, receipt) are AGT-1237.
 *
 * Kept synchronous on purpose: nothing here calls a model, so there is
 * nothing to await. `main` in `cli.ts` may still become async for a sibling
 * ticket — a `number` return is compatible either way.
 */

import {
  createProviders,
  DEFAULT_MIN_SCENES,
  loadConfig,
  renderPack,
} from "@openthink/pablo-core";
import type { Intent } from "@openthink/pablo-core";
import { readMarker } from "./marker";
import { buildChapterPack, DEFAULT_WORD_TARGET } from "./novel/pack";
import { chapterPreconditions, readNovelState } from "./novel/machine";

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
}

/** The intent a drafting pack routes under — see `providers/registry.ts`'s `route`. */
const DRAFT_INTENT: Intent = { name: "draft", kind: "drafting" };

/** `--chapter`'s value as a positive integer, or `undefined` for anything else (including absent). */
function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value > 0 ? value : undefined;
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

/**
 * `runWrite`: parse `--chapter`; check the novel machine's preconditions for
 * it (refuse, exit 2, naming `missing[]`, if unmet — AC1); assemble the
 * drafting pack (`buildChapterPack`, which also refuses on a `neverSend`
 * violation, AC3); with `--dry-run`, render it and exit 0 (AC4); without,
 * this ticket stops here — AGT-1237 wires the send.
 */
export function runWrite(args: WriteArgs, vaultRoot: string, projectPath: string): number {
  const chapter = parsePositiveInt(args.chapter);
  if (chapter === undefined) {
    emitError("pablo: write requires --chapter <N> (a positive integer)", undefined, 2, args.json);
    return 2;
  }

  const words = parsePositiveInt(args.words) ?? DEFAULT_WORD_TARGET;
  const scenes = parsePositiveInt(args.scenes) ?? DEFAULT_MIN_SCENES;

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

  const message = "pablo: write is not wired to the model yet (AGT-1237); use --dry-run";
  if (args.json) {
    console.log(JSON.stringify({ ok: false, code: 1, message }));
  } else {
    console.error(message);
  }
  return 1;
}
