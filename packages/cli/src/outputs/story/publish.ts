/**
 * The story output's publish (AGT-1689): the compiler over `story.md`. Only
 * `draft` is built: the story's text with frontmatter stripped, sentences
 * joined back into paragraphs and quotes curled, under the work's title, in
 * `.pablo/out/<slug>-story-draft.md`. `review` (the review round) and `final`
 * are refused until they exist, as the novel's are.
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

export function publishStory(workDir: string, slug: string, title: string, target: string | undefined): PublishOutcome {
  if (target === undefined) return refuse(`pablo: publish requires --target (${STORY_PUBLISH_TARGETS.join("|")})`);
  if (!(STORY_PUBLISH_TARGETS as readonly string[]).includes(target)) {
    return refuse(`pablo: publish: unknown --target "${target}" (expected ${STORY_PUBLISH_TARGETS.join("|")})`);
  }
  if (target !== "draft") return refuse(`pablo: publish --target ${target} is not implemented yet (only draft is)`);

  const source = join(workDir, STORY_DIR, STORY_FILE);
  if (!existsSync(source)) return refuse(`pablo: publish: no story to compile (${STORY_DIR}/${STORY_FILE})`, [source]);

  const compiled = compileStory(title, readFileSync(source, "utf8"));
  const outDir = join(workDir, ".pablo", "out");
  const where = join(outDir, `${slug}-story-draft.md`);
  if (!where.startsWith(outDir + sep)) return refuse(`pablo: publish: marker slug "${slug}" would write outside ${outDir}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(where, compiled, "utf8");
  return { ok: true, code: 0, target: "draft", where, chapters: 1, words: compiled.split(/\s+/).filter((w) => w !== "").length };
}
