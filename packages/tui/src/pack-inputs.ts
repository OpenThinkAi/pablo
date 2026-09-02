/**
 * Turning "this span, this instruction" into the inputs `assemblePack` wants
 * (AC1, AC7).
 *
 * The core's pack assembly is pure by contract — it reads no files — so the
 * disk half lives here and in `pack/vault.ts` next to it. This module answers
 * the two questions the core cannot: **which vault is this file in**, and
 * **which work inside it**.
 *
 * It does not answer them itself. `brief.ts` already defines both — the vault
 * root is the nearest ancestor holding `style/`, and a work is
 * `<vault>/<kind>/<slug>` — and one definition of "the work" for the brief and
 * a second for the pack would drift the first time either moved. The work root
 * here is that same directory; the only thing this module adds is reading the
 * `QWEN.md` inside it (AC7).
 *
 * Neither is required. A file opened outside a vault gets a pack with no style
 * slices and a notice saying so, because silently sending an unruled prompt is
 * worse than sending a smaller one and saying it.
 */

import { join } from "node:path";
import {
  readStyle,
  readWorkRules,
  type Document,
  type OutputMode,
  type Span,
  type SpanEditInputs,
  type TextSource,
} from "@openthink/pablo-core";
import { detectWork, findVaultRoot, type DirectoryProbe } from "./brief";

export interface SpanEditInputsOptions {
  readonly doc: Document;
  readonly span: Span;
  /** What to do to the span, in the author's terms. */
  readonly instruction: string;
  /**
   * **Seam for AGT-1207 (brief on open).** Extra context spliced in after the
   * vault's style files: the brief arrives as one more `TextSource` on the
   * style slice, so it sits between the prose rules and the work's own rules in
   * the assembled prompt and needs no change in `packages/core`. It is inside a
   * reducible slice kept head-first, so a pack that blows its budget truncates
   * the brief before it truncates the prose rules — which is the right order.
   */
  readonly extraContext?: string | undefined;
  /** Overrides the discovered vault root; the tests and a future `--vault` use it. */
  readonly vaultRoot?: string | undefined;
  /**
   * Which structured path the answer will take, so the pack prices the closing
   * line that actually goes over the wire (AGT-1202). pablo's `prompt` verb
   * streams `pack.prompt` through `complete()` and parses the answer itself, so
   * it asks for `"text"`; the default is the tool call.
   */
  readonly output?: OutputMode | undefined;
  /** The directory probe vault detection uses; injected in tests. */
  readonly isDirectory?: DirectoryProbe | undefined;
}

export interface BuiltSpanEditInputs {
  readonly inputs: SpanEditInputs;
  readonly vaultRoot: string | undefined;
  readonly workRoot: string | undefined;
  /** What the author should know about what is *not* in the pack. */
  readonly notices: readonly string[];
}

/**
 * The span-edit pack inputs for a selection, with the style rules and the
 * work's rules read off disk (AC7).
 */
export function buildSpanEditInputs(options: SpanEditInputsOptions): BuiltSpanEditInputs {
  const notices: string[] = [];
  const vaultRoot = options.vaultRoot ?? findVaultRoot(options.doc.path, options.isDirectory);

  let style: TextSource[] = [];
  if (vaultRoot === undefined) {
    notices.push("no vault above this file (no style/ directory), so the pack carries no style rules");
  } else {
    style = [...readStyle(vaultRoot)];
    if (style.length === 0) notices.push(`no style rules in ${join(vaultRoot, "style")}`);
  }

  const extra = options.extraContext?.trim() ?? "";
  if (extra !== "") style.push({ path: "the session brief", text: extra });

  const work = vaultRoot === undefined ? undefined : detectWork(options.doc.path, options.isDirectory);
  const workRoot = work === undefined ? undefined : join(work.vaultRoot, work.kind, work.slug);
  const workRules =
    workRoot === undefined || vaultRoot === undefined ? undefined : readWorkRules(vaultRoot, workRoot);

  return {
    inputs: {
      document: options.doc,
      span: options.span,
      instruction: options.instruction,
      style,
      workRules,
      ...(options.output === undefined ? {} : { output: options.output }),
    },
    vaultRoot,
    workRoot,
    notices,
  };
}
