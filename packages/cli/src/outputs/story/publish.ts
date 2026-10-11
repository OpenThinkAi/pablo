/**
 * The story output's publish (AGT-1689, AGT-1705): the compiler over
 * `story.md`. The story's text with frontmatter stripped, sentences joined
 * back into paragraphs and quotes curled, under the work's title, written to
 * `.pablo/out/<slug>-story-<target>.md`:
 *
 *   draft    the compiled story
 *   review   the compiled story under a "Review copy" line naming its length,
 *            for a reader to mark up
 *   final    the compiled story, nothing added: the clean copy to keep or send
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { bodyParagraphs, curlQuotes, stripFrontmatter } from "../../publish";
import type { PublishOutcome } from "../types";
import { STORY_DIR, STORY_FILE, STORY_PUBLISH_TARGETS } from "./units";

function refuse(message: string, tried: readonly string[] = []): PublishOutcome {
  return { ok: false, code: 2, message, tried };
}

/** The compiled story: `# <title>`, then its paragraphs. Pure. */
export function compileStory(title: string, text: string): string {
  return `${[`# ${curlQuotes(title)}`, ...bodyParagraphs(stripFrontmatter(text)).map(curlQuotes)].join("\n\n")}\n`;
}

/** The review target's copy: the compiled story with a "Review copy" line under the title. Pure. */
export function compileStoryReview(title: string, text: string): string {
  const paragraphs = bodyParagraphs(stripFrontmatter(text)).map(curlQuotes);
  const words = paragraphs.join(" ").split(/\s+/).filter((w) => w !== "").length;
  return `${[`# ${curlQuotes(title)}`, `*Review copy, ${words} words.*`, ...paragraphs].join("\n\n")}\n`;
}

export function publishStory(workDir: string, slug: string, title: string, target: string | undefined): PublishOutcome {
  if (target === undefined) return refuse(`pablo: publish requires --target (${STORY_PUBLISH_TARGETS.join("|")})`);
  if (!(STORY_PUBLISH_TARGETS as readonly string[]).includes(target)) {
    return refuse(`pablo: publish: unknown --target "${target}" (expected ${STORY_PUBLISH_TARGETS.join("|")})`);
  }

  const source = join(workDir, STORY_DIR, STORY_FILE);
  if (!existsSync(source)) return refuse(`pablo: publish: no story to compile (${STORY_DIR}/${STORY_FILE})`, [source]);

  const text = readFileSync(source, "utf8");
  const compiled = target === "review" ? compileStoryReview(title, text) : compileStory(title, text);
  const outDir = join(workDir, ".pablo", "out");
  const where = join(outDir, `${slug}-story-${target}.md`);
  if (!where.startsWith(outDir + sep)) return refuse(`pablo: publish: marker slug "${slug}" would write outside ${outDir}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(where, compiled, "utf8");
  return { ok: true, code: 0, target, where, chapters: 1, words: compiled.split(/\s+/).filter((w) => w !== "").length };
}
