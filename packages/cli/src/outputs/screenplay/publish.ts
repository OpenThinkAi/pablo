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

/** What pablo.json adds to the title page (AGT-2194): the author, and an optional draft date and contact. */
export interface TitleMeta {
  readonly author?: string;
  readonly draftDate?: string;
  readonly contact?: string;
}

/** The Fountain title block: `Title:`, then `Credit:` and `Author:` when there is an author, then the optional keys. Pure. */
export function titleBlock(title: string, meta: TitleMeta): string {
  const author = meta.author?.trim() ?? "";
  const lines = [`Title: ${title}`];
  if (author !== "") lines.push("Credit: Written by", `Author: ${author}`);
  const date = meta.draftDate?.trim() ?? "";
  if (date !== "") lines.push(`Draft date: ${date}`);
  const contact = meta.contact?.trim() ?? "";
  if (contact !== "") lines.push(`Contact: ${contact.replace(/\s*\n\s*/g, " ")}`);
  return lines.join("\n");
}

/** The title-page extras from the work's pablo.json: `author` (already required by the marker) and the optional `draftDate` and `contact`. */
export function titleMetaOf(workDir: string): TitleMeta {
  try {
    const data = JSON.parse(readFileSync(join(workDir, "pablo.json"), "utf8")) as Record<string, unknown>;
    const str = (key: string): string | undefined => (typeof data[key] === "string" ? (data[key] as string) : undefined);
    return { author: str("author"), draftDate: str("draftDate"), contact: str("contact") };
  } catch {
    return {};
  }
}

/** The compiled screenplay: a title page, then each scene's Fountain, a blank line between. Pure. */
export function compileScreenplay(title: string, scenes: readonly string[], meta: TitleMeta = {}): string {
  const bodies = scenes.map((text) => stripFrontmatter(text).replace(/^\s*\n/, "").trimEnd()).filter((body) => body !== "");
  return `${[titleBlock(title, meta), ...bodies].join("\n\n")}\n`;
}

export function publishScreenplay(workDir: string, slug: string, title: string, target: string | undefined): PublishOutcome {
  if (target === undefined) return refuse(`pablo: publish requires --target (${SCREENPLAY_PUBLISH_TARGETS.join("|")})`);
  if (!(SCREENPLAY_PUBLISH_TARGETS as readonly string[]).includes(target)) {
    return refuse(`pablo: publish: unknown --target "${target}" (expected ${SCREENPLAY_PUBLISH_TARGETS.join("|")})`);
  }
  const files = [...screenplayUnitFiles(workDir).entries()].sort(([a], [b]) => a - b).map(([, file]) => file);
  if (files.length === 0) return refuse(`pablo: publish: no scenes to compile (${SCREENPLAY_DIR})`, [join(workDir, SCREENPLAY_DIR)]);

  const compiled = compileScreenplay(title, files.map((file) => readFileSync(file, "utf8")), titleMetaOf(workDir));
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
