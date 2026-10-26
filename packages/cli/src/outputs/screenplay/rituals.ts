/**
 * The screenplay output's after-merge rituals (AGT-2132): what happens once a
 * scene is on `main`, the radio output's steps without casting. A dated note,
 * a README bullet, continuity extracted into the screenplay's own ledger
 * (`outputs/screenplay/continuity.md`), a commit of exactly those paths, and
 * a think sync. The outline's beat status is the core's and the novel's: a
 * scene never ticks it. Each step is wrapped so none throws out of
 * `afterMerge` (a failure is a `failed` ritual).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { continuityFile } from "@openthink/pablo-core";
import { runContinuity } from "../../novel/continuity";
import { attempt, attemptAsync, authorSection, runGit, runThink } from "../../novel/rituals";
import type { Ritual, RitualOptions } from "../../novel/rituals";
import { stripFrontmatter } from "../../publish";
import type { OutputRituals } from "../types";
import { sceneTag, SCREENPLAY_ID, screenplayUnitOfPath } from "./units";

function noteRel(today: string, scene: number): string {
  return join("notes", `${today}-screenplay-${sceneTag(scene)}.md`).split(sep).join("/");
}

/** Appends `line` to the dated note, or creates it under `heading`. */
function appendNote(workDir: string, rel: string, heading: string, line: string): Ritual {
  return attempt("note", () => {
    const abs = join(workDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    if (existsSync(abs)) {
      const existing = readFileSync(abs, "utf8");
      writeFileSync(abs, `${existing}${existing.endsWith("\n") ? "" : "\n"}${line}\n`, "utf8");
      return { name: "note", status: "ran", detail: `appended to ${rel}` };
    }
    writeFileSync(abs, `# ${heading}\n\n${line}\n`, "utf8");
    return { name: "note", status: "ran", detail: `created ${rel}` };
  });
}

/** The scene's bullet under "## Where things stand" in the work's README, replaced when today's is already there. */
function tickReadme(workDir: string, scene: number, today: string, opts: RitualOptions): Ritual {
  const path = join(workDir, "README.md");
  const lead = `- ${today}: screenplay scene ${scene} drafted `;
  const bullet = `${lead}(${opts.words} words, ${opts.model}).`;
  if (!existsSync(path)) {
    writeFileSync(path, `## Where things stand\n\n${bullet}\n`, "utf8");
    return { name: "readme", status: "ran", detail: "created README.md with 'Where things stand'" };
  }
  const lines = readFileSync(path, "utf8").split("\n");
  const heading = lines.findIndex((l) => l.trim() === "## Where things stand");
  if (heading === -1) {
    const content = lines.join("\n");
    writeFileSync(path, `${content}${content.endsWith("\n") ? "" : "\n"}\n## Where things stand\n\n${bullet}\n`, "utf8");
    return { name: "readme", status: "ran", detail: "added 'Where things stand' section" };
  }
  let end = lines.length;
  for (let i = heading + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const same = lines.findIndex((l, i) => i > heading && i < end && l.startsWith(lead));
  if (same >= 0) {
    lines[same] = bullet;
    writeFileSync(path, lines.join("\n"), "utf8");
    return { name: "readme", status: "ran", detail: `scene ${scene} bullet replaced` };
  }
  let at = heading + 1;
  for (let i = end - 1; i > heading; i -= 1) {
    if ((lines[i] ?? "").trim() !== "") {
      at = i + 1;
      break;
    }
  }
  lines.splice(at, 0, bullet);
  writeFileSync(path, lines.join("\n"), "utf8");
  return { name: "readme", status: "ran", detail: `scene ${scene} bullet added` };
}

async function afterMerge(workDir: string, scene: number, scenePath: string, opts: RitualOptions): Promise<Ritual[]> {
  const now = opts.now ?? (() => new Date());
  const allowNvmFallback = opts.env === undefined;
  const env = opts.env ?? process.env;
  const today = now().toISOString().slice(0, 10);

  const rel = noteRel(today, scene);
  const note = appendNote(workDir, rel, `${today} — screenplay scene ${scene} drafted`, `${opts.receiptLine} — words: ${opts.words}, model: ${opts.model}`);
  const readme = attempt("readme", () => tickReadme(workDir, scene, today, opts));
  const continuity = await attemptAsync("continuity", () =>
    runContinuity(workDir, scene, stripFrontmatter(readFileSync(scenePath, "utf8")), {
      adapter: opts.extractor,
      timeoutMs: opts.continuityTimeoutMs,
      output: SCREENPLAY_ID,
      unitNoun: "scene",
    }),
  );
  const sceneRel = relative(workDir, scenePath).split(sep).join("/");
  const paths = [sceneRel, rel, "README.md"];
  if (continuity.status === "ran") paths.push(continuityFile(workDir, SCREENPLAY_ID));
  const git = attempt("git", () => runGit(workDir, paths, `${opts.slug}: draft screenplay scene ${scene}`));
  const think = await attemptAsync("think", () => runThink(scene, opts.words, opts.slug, env, opts.thinkTimeoutMs ?? 20_000, allowNvmFallback, "screenplay scene"));
  return [note, readme, continuity, git, think];
}

type AfterRevisionOptions = Parameters<OutputRituals["afterRevision"]>[2];

/** After a non-draft branch that changed or commented on the scene is merged: the note (with the author's comments), its commit, a think sync. */
async function afterRevision(workDir: string, scene: number, opts: AfterRevisionOptions): Promise<Ritual[]> {
  const today = (opts.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const rel = noteRel(today, scene);
  const notes = (opts.authorNotes ?? []).filter((n) => screenplayUnitOfPath(n.path) === scene);
  const note = appendNote(workDir, rel, `${today} — screenplay scene ${scene} revised`, `Revised on ${opts.branch}.${authorSection(notes)}`);
  const git =
    note.status === "ran"
      ? attempt("git", () => runGit(workDir, [rel], `${opts.slug}: notes on screenplay scene ${scene} (${opts.branch})`))
      : { name: "git", status: "skipped" as const, detail: "no note written" };
  const allowNvmFallback = opts.env === undefined;
  const think = await attemptAsync("think", () =>
    runThink(scene, 0, opts.slug, opts.env ?? process.env, opts.thinkTimeoutMs ?? 20_000, allowNvmFallback, "screenplay scene", "revised"),
  );
  return [note, git, think];
}

export const SCREENPLAY_RITUALS: OutputRituals = { afterMerge, afterRevision };
