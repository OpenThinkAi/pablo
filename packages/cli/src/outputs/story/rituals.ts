/**
 * The story output's after-merge rituals (AGT-1689): the novel's six, over a
 * story that tells many beats. outline ticks every beat the story tells to
 * `draft`; note drops `notes/<today>-story.md`; readme adds a bullet under
 * "Where things stand"; continuity extracts facts from the story; git commits
 * exactly those paths; think syncs. Each is independent and wrapped so none
 * throws out of `afterMerge` (a failure is a `failed` ritual).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { beatsFile, continuityFile } from "@openthink/pablo-core";
import { runContinuity } from "../../novel/continuity";
import { attempt, attemptAsync, runGit, runThink, tickOutline } from "../../novel/rituals";
import type { Ritual, RitualOptions } from "../../novel/rituals";
import type { OutputRituals } from "../types";
import { storyBeats } from "./pack";
import { STORY_UNIT } from "./units";

function stripFrontmatter(text: string): string {
  const match = text.match(/^---\n[\s\S]*?\n---\n\n?/);
  return match ? text.slice(match[0].length) : text;
}

function tickBeats(workDir: string): Ritual {
  const results = storyBeats(workDir).map((beat) => tickOutline(workDir, beat));
  const ran = results.filter((r) => r.status === "ran");
  const failed = results.find((r) => r.status === "failed");
  if (failed !== undefined) return failed;
  if (ran.length === 0) return results[0] ?? { name: "outline", status: "skipped", detail: "the story tells no beats" };
  return { name: "outline", status: "ran", detail: `${ran.length} of ${results.length} beats -> draft` };
}

function writeNote(workDir: string, today: string, opts: RitualOptions): { ritual: Ritual; rel: string } {
  const rel = join("notes", `${today}-story.md`).split(sep).join("/");
  const ritual = attempt("note", () => {
    const abs = join(workDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    const line = `${opts.receiptLine} — words: ${opts.words}, model: ${opts.model}`;
    if (existsSync(abs)) {
      const existing = readFileSync(abs, "utf8");
      writeFileSync(abs, `${existing}${existing.endsWith("\n") ? "" : "\n"}${line}\n`, "utf8");
      return { name: "note", status: "ran", detail: `appended to ${rel}` };
    }
    writeFileSync(abs, `# ${today} — story drafted\n\n${line}\n`, "utf8");
    return { name: "note", status: "ran", detail: `created ${rel}` };
  });
  return { ritual, rel };
}

function tickReadme(workDir: string, today: string, opts: RitualOptions): Ritual {
  const path = join(workDir, "README.md");
  const bullet = `- ${today}: story drafted (${opts.words} words, ${opts.model}).`;
  if (!existsSync(path)) {
    writeFileSync(path, `## Where things stand\n\n${bullet}\n`, "utf8");
    return { name: "readme", status: "ran", detail: "created README.md with 'Where things stand'" };
  }
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n");
  const heading = lines.findIndex((l) => l.trim() === "## Where things stand");
  if (heading === -1) {
    writeFileSync(path, `${content}${content.endsWith("\n") ? "" : "\n"}\n## Where things stand\n\n${bullet}\n`, "utf8");
    return { name: "readme", status: "ran", detail: "added 'Where things stand' section" };
  }
  let end = lines.length;
  for (let i = heading + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const same = `- ${today}: story drafted `;
  for (let i = heading + 1; i < end; i++) {
    if ((lines[i] ?? "").startsWith(same)) {
      lines[i] = bullet;
      writeFileSync(path, lines.join("\n"), "utf8");
      return { name: "readme", status: "ran", detail: "story bullet replaced" };
    }
  }
  let at = heading + 1;
  for (let i = end - 1; i > heading; i--) {
    if ((lines[i] ?? "").trim() !== "") {
      at = i + 1;
      break;
    }
  }
  lines.splice(at, 0, bullet);
  writeFileSync(path, lines.join("\n"), "utf8");
  return { name: "readme", status: "ran", detail: "story bullet added" };
}

async function afterMerge(workDir: string, _unit: number, storyPath: string, opts: RitualOptions): Promise<Ritual[]> {
  const now = opts.now ?? (() => new Date());
  const allowNvmFallback = opts.env === undefined;
  const env = opts.env ?? process.env;
  const today = now().toISOString().slice(0, 10);

  const outline = attempt("outline", () => tickBeats(workDir));
  const { ritual: note, rel: noteRel } = writeNote(workDir, today, opts);
  const readme = attempt("readme", () => tickReadme(workDir, today, opts));
  const continuity = await attemptAsync("continuity", () =>
    runContinuity(workDir, STORY_UNIT, stripFrontmatter(readFileSync(storyPath, "utf8")), {
      adapter: opts.extractor,
      timeoutMs: opts.continuityTimeoutMs,
    }),
  );
  const storyRel = relative(workDir, storyPath).split(sep).join("/");
  const paths = [storyRel, beatsFile(workDir), noteRel, "README.md"];
  if (continuity.status === "ran") paths.push(continuityFile(workDir));
  const git = attempt("git", () => runGit(workDir, paths, `${opts.slug}: draft story`));
  const think = await attemptAsync("think", () => runThink(STORY_UNIT, opts.words, opts.slug, env, opts.thinkTimeoutMs ?? 20_000, allowNvmFallback, "story"));
  return [outline, note, readme, continuity, git, think];
}

export const STORY_RITUALS: OutputRituals = {
  afterMerge,
  // A revision of the story changes the text only; there is nothing to tick or note.
  afterRevision: () => [],
};
