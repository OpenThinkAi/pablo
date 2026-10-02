/**
 * `mergeDraft` (AGT-1536): the merge path for a `draft/chNN` branch. `write`
 * only commits the chapter on its branch; merging it is what brings the
 * chapter onto `main`, and the after-write steps (outline tick, dated note,
 * README, continuity, the touched-paths commit, `think sync`) run here,
 * against the merged tree, via `runAfterMerge`.
 *
 * A failed merge (conflict, wrong checkout) runs nothing: `main` is as it
 * was and the draft branch is untouched. A merged draft's worktree and
 * branch are removed afterwards; a failure there is a notice, never a
 * failed merge.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deleteBranch, mergeBranch, repoRoot } from "../branch";
import { runAfterMerge } from "./rituals";
import type { Ritual, RitualOptions } from "./rituals";

/** `draft/ch05` or `draft/ch05-v2` -> 5; undefined for any other branch. */
export function draftChapter(branch: string): number | undefined {
  const m = branch.match(/^draft\/ch(\d+)(?:-v\d+)?$/);
  return m ? Number(m[1]) : undefined;
}

export type MergeDraftResult =
  | { readonly ok: true; readonly sha: string; readonly chapter: number; readonly rituals: Ritual[]; readonly notices: string[] }
  | { readonly ok: false; readonly notice: string };

/** The options `runAfterMerge` takes, minus what the merged chapter's own frontmatter supplies. */
export type MergeDraftOptions = Omit<RitualOptions, "words" | "model" | "receiptLine">;

/** The `chapters/NN-*.md` file on the merged tree, or undefined. */
function findChapterFile(projectPath: string, chapter: number): string | undefined {
  const dir = join(projectPath, "chapters");
  if (!existsSync(dir)) return undefined;
  const prefix = `${String(chapter).padStart(2, "0")}-`;
  const name = readdirSync(dir).find((f) => f.startsWith(prefix) && f.endsWith(".md"));
  return name === undefined ? undefined : join(dir, name);
}

function frontmatterField(text: string, key: string): string | undefined {
  const block = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  const line = block.split("\n").find((l) => l.startsWith(`${key}:`));
  return line?.slice(key.length + 1).trim().replace(/^"(.*)"$/, "$1");
}

/**
 * Merges `branch` (a `draft/chNN[-vN]` branch of the repo holding
 * `projectPath`) into `main`, then runs the after-write steps for its chapter.
 */
export async function mergeDraft(
  projectPath: string,
  branch: string,
  opts: MergeDraftOptions,
): Promise<MergeDraftResult> {
  const chapter = draftChapter(branch);
  if (chapter === undefined) return { ok: false, notice: `pablo: merge: "${branch}" is not a draft branch (draft/chNN)` };
  const repo = repoRoot(projectPath);
  if (repo === undefined) return { ok: false, notice: `pablo: merge: ${projectPath} is not in a git repository` };

  const env = opts.env ?? process.env;
  const merged = mergeBranch(repo, branch, env);
  if (!merged.ok) return merged;
  const sha = merged.sha as string;

  const notices: string[] = [];
  const removed = deleteBranch(repo, opts.slug, branch, { env });
  if (!removed.ok) notices.push(removed.notice);

  const chapterPath = findChapterFile(projectPath, chapter);
  if (chapterPath === undefined) {
    notices.push(`pablo: merge: no chapters/${String(chapter).padStart(2, "0")}-*.md on main after merging ${branch}`);
    return { ok: true, sha, chapter, rituals: [], notices };
  }
  const text = readFileSync(chapterPath, "utf8");
  const rituals = await runAfterMerge(projectPath, chapter, chapterPath, {
    ...opts,
    words: Number(frontmatterField(text, "words")) || 0,
    model: frontmatterField(text, "model") ?? "unknown",
    receiptLine: `merged ${branch}`,
  });
  return { ok: true, sha, chapter, rituals, notices };
}
