/**
 * The screenplay output's publish (AGT-2132, AGT-2133): every written scene in
 * order as one Fountain file, `.pablo/out/<slug>-screenplay.fountain`, under a
 * Fountain title page; for `draft` and `final` also `<slug>-screenplay.pdf`,
 * typeset in standard screenplay format by the dependency-free writer in
 * `../../screenplay-pdf.ts`. pablo's frontmatter is stripped from each scene; the Fountain
 * itself is copied line for line (quotes stay straight: Fountain tools
 * typeset it).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { stripFrontmatter } from "../../publish";
import { buildScreenplayPdf } from "../../screenplay-pdf";
import type { PublishOutcome } from "../types";
import { screenplayUnitFiles } from "./pack";
import { SCREENPLAY_DIR, SCREENPLAY_PUBLISH_TARGETS } from "./units";

function refuse(message: string, tried: readonly string[] = []): PublishOutcome {
  return { ok: false, code: 2, message, tried };
}

/** The compiled screenplay: a title page, then each scene's Fountain, a blank line between. Pure. */
export function compileScreenplay(title: string, scenes: readonly string[]): string {
  const bodies = scenes.map((text) => stripFrontmatter(text).replace(/^\s*\n/, "").trimEnd()).filter((body) => body !== "");
  return `${[`Title: ${title}`, ...bodies].join("\n\n")}\n`;
}

export function publishScreenplay(workDir: string, slug: string, title: string, target: string | undefined): PublishOutcome {
  if (target === undefined) return refuse(`pablo: publish requires --target (${SCREENPLAY_PUBLISH_TARGETS.join("|")})`);
  if (!(SCREENPLAY_PUBLISH_TARGETS as readonly string[]).includes(target)) {
    return refuse(`pablo: publish: unknown --target "${target}" (expected ${SCREENPLAY_PUBLISH_TARGETS.join("|")})`);
  }
  const files = [...screenplayUnitFiles(workDir).entries()].sort(([a], [b]) => a - b).map(([, file]) => file);
  if (files.length === 0) return refuse(`pablo: publish: no scenes to compile (${SCREENPLAY_DIR})`, [join(workDir, SCREENPLAY_DIR)]);

  const compiled = compileScreenplay(title, files.map((file) => readFileSync(file, "utf8")));
  const outDir = join(workDir, ".pablo", "out");
  const where = join(outDir, `${slug}-screenplay.fountain`);
  if (!where.startsWith(outDir + sep)) return refuse(`pablo: publish: marker slug "${slug}" would write outside ${outDir}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(where, compiled, "utf8");
  const written = [`${slug}-screenplay.fountain`];
  if (target !== "fountain") {
    writeFileSync(join(outDir, `${slug}-screenplay.pdf`), buildScreenplayPdf(compiled, title));
    written.push(`${slug}-screenplay.pdf`);
  }
  return { ok: true, code: 0, target, where, chapters: files.length, words: compiled.split(/\s+/).filter((w) => w !== "").length, files: written };
}
