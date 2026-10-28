/**
 * The radio output's after-merge rituals (AGT-1686): what happens once an
 * episode's script is on `main`. A dated note, a README bullet, continuity
 * extracted into the radio output's own ledger (`outputs/radio/continuity.md`,
 * never the novel's, never `facts.md` by itself), a `cast` step that says
 * which of the script's roles still need a voice (the cast stage becoming
 * ready), a commit of exactly those paths, and a think sync.
 *
 * The outline's beat status is the core's and the novel's: an episode never
 * ticks it. Each step is wrapped so none throws out of `afterMerge` (a
 * failure is a `failed` ritual).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { continuityFile } from "@openthink/pablo-core";
import { runContinuity } from "../../novel/continuity";
import { attempt, attemptAsync, authorSection, runGit, runThink } from "../../novel/rituals";
import type { Ritual, RitualOptions } from "../../novel/rituals";
import { stripFrontmatter } from "../../publish";
import type { OutputRituals } from "../types";
import { unboundRoles } from "./state";
import { episodeTag, RADIO_ID, radioUnitOfPath } from "./units";

function noteRel(today: string, episode: number): string {
  return join("notes", `${today}-radio-${episodeTag(episode)}.md`).split(sep).join("/");
}

function writeNote(workDir: string, episode: number, today: string, opts: RitualOptions): Ritual {
  const rel = noteRel(today, episode);
  return attempt("note", () => {
    const abs = join(workDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    const line = `${opts.receiptLine} — words: ${opts.words}, model: ${opts.model}`;
    if (existsSync(abs)) {
      const existing = readFileSync(abs, "utf8");
      writeFileSync(abs, `${existing}${existing.endsWith("\n") ? "" : "\n"}${line}\n`, "utf8");
      return { name: "note", status: "ran", detail: `appended to ${rel}` };
    }
    writeFileSync(abs, `# ${today} — radio episode ${episode} drafted\n\n${line}\n`, "utf8");
    return { name: "note", status: "ran", detail: `created ${rel}` };
  });
}

function tickReadme(workDir: string, episode: number, today: string, opts: RitualOptions): Ritual {
  const path = join(workDir, "README.md");
  const lead = `- ${today}: radio episode ${episode} drafted `;
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
  for (let i = heading + 1; i < end; i += 1) {
    if ((lines[i] ?? "").startsWith(lead)) {
      lines[i] = bullet;
      writeFileSync(path, lines.join("\n"), "utf8");
      return { name: "readme", status: "ran", detail: `episode ${episode} bullet replaced` };
    }
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
  return { name: "readme", status: "ran", detail: `episode ${episode} bullet added` };
}

/** The cast stage becoming ready: which of the script's roles still need a voice. Reads only. */
function castReadiness(workDir: string, episode: number, slug: string): Ritual {
  return attempt("cast", () => {
    const unbound = unboundRoles(workDir, episode);
    if (unbound === undefined) return { name: "cast", status: "skipped", detail: `episode ${episode} has no CAST: line yet` };
    if (unbound.length === 0) return { name: "cast", status: "ran", detail: `every role is cast; next: pablo perform --project ${slug} --output radio --unit ${episode}` };
    return { name: "cast", status: "ran", detail: `${unbound.length} role(s) to cast (${unbound.join(", ")}); next: pablo cast --auto --project ${slug} --episode ${episode}` };
  });
}

async function afterMerge(workDir: string, episode: number, scriptPath: string, opts: RitualOptions): Promise<Ritual[]> {
  const now = opts.now ?? (() => new Date());
  const allowNvmFallback = opts.env === undefined;
  const env = opts.env ?? process.env;
  const today = now().toISOString().slice(0, 10);

  const note = writeNote(workDir, episode, today, opts);
  const readme = attempt("readme", () => tickReadme(workDir, episode, today, opts));
  const continuity = await attemptAsync("continuity", () =>
    runContinuity(workDir, episode, stripFrontmatter(readFileSync(scriptPath, "utf8")), {
      adapter: opts.extractor,
      timeoutMs: opts.continuityTimeoutMs,
      // The radio output files its facts in its own ledger, outputs/radio/continuity.md.
      output: RADIO_ID,
      unitNoun: "episode",
    }),
  );
  const cast = castReadiness(workDir, episode, opts.slug);
  const scriptRel = relative(workDir, scriptPath).split(sep).join("/");
  const paths = [scriptRel, noteRel(today, episode), "README.md"];
  if (continuity.status === "ran") paths.push(continuityFile(workDir, RADIO_ID));
  const git = attempt("git", () => runGit(workDir, paths, `${opts.slug}: draft radio episode ${episode}`));
  const think = await attemptAsync("think", () => runThink(episode, opts.words, opts.slug, env, opts.thinkTimeoutMs ?? 20_000, allowNvmFallback, "radio episode", undefined, workDir));
  return [note, readme, continuity, cast, git, think];
}

type AfterRevisionOptions = Parameters<OutputRituals["afterRevision"]>[2];

/** After a non-draft branch that changed or commented on the episode is merged: the note (with the author's comments), its commit, a think sync. */
async function afterRevision(workDir: string, episode: number, opts: AfterRevisionOptions): Promise<Ritual[]> {
  const today = (opts.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const rel = noteRel(today, episode);
  const notes = (opts.authorNotes ?? []).filter((n) => radioUnitOfPath(n.path) === episode);
  const note = attempt("note", () => {
    const abs = join(workDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    const body = `Revised on ${opts.branch}.${authorSection(notes)}`;
    if (existsSync(abs)) {
      const existing = readFileSync(abs, "utf8");
      writeFileSync(abs, `${existing}${existing.endsWith("\n") ? "" : "\n"}\n${body}\n`, "utf8");
      return { name: "note", status: "ran", detail: `appended to ${rel}` };
    }
    writeFileSync(abs, `# ${today} — radio episode ${episode} revised\n\n${body}\n`, "utf8");
    return { name: "note", status: "ran", detail: `created ${rel}` };
  });
  const git =
    note.status === "ran"
      ? attempt("git", () => runGit(workDir, [rel], `${opts.slug}: notes on radio episode ${episode} (${opts.branch})`))
      : { name: "git", status: "skipped" as const, detail: "no note written" };
  const allowNvmFallback = opts.env === undefined;
  const think = await attemptAsync("think", () =>
    runThink(episode, 0, opts.slug, opts.env ?? process.env, opts.thinkTimeoutMs ?? 20_000, allowNvmFallback, "radio episode", "revised", workDir),
  );
  return [note, git, think];
}

export const RADIO_RITUALS: OutputRituals = { afterMerge, afterRevision };
