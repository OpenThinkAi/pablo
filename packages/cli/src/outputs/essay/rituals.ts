/**
 * The essay output's after-merge rituals (AGT-2134): a section tells no beat
 * and has no continuity ledger, so of the novel's six steps it keeps three:
 * note (`notes/<today>-essay.md`, one line per merged section), git (the note
 * committed on its own; the section itself came in with the merge) and think.
 * Each is wrapped so none throws out of `afterMerge`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { attempt, attemptAsync, authorSection, runGit, runThink } from "../../novel/rituals";
import type { Ritual, RitualOptions } from "../../novel/rituals";
import type { OutputRituals } from "../types";
import { essayUnitOfPath } from "./units";

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

async function afterMerge(workDir: string, unit: number, _unitPath: string, opts: RitualOptions): Promise<Ritual[]> {
  const today = (opts.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const rel = join("notes", `${today}-essay.md`).split(sep).join("/");
  const note = appendNote(workDir, rel, `${today} — essay`, `section ${unit}: ${opts.receiptLine} — words: ${opts.words}, model: ${opts.model}`);
  const git = note.status === "ran" ? attempt("git", () => runGit(workDir, [rel], `${opts.slug}: essay section ${unit} merged`)) : { name: "git", status: "skipped" as const, detail: "no note written" };
  const think = await attemptAsync("think", () =>
    runThink(unit, opts.words, opts.slug, opts.env ?? process.env, opts.thinkTimeoutMs ?? 20_000, opts.env === undefined, "essay section"),
  );
  return [note, git, think];
}

type AfterRevisionOptions = Parameters<OutputRituals["afterRevision"]>[2];

/** After a revise/edit branch that changed the essay is merged: the revision and the author's comments go in the dated note. */
async function afterRevision(workDir: string, unit: number, opts: AfterRevisionOptions): Promise<Ritual[]> {
  const today = (opts.now ?? (() => new Date()))().toISOString().slice(0, 10);
  const rel = join("notes", `${today}-essay.md`).split(sep).join("/");
  const notes = (opts.authorNotes ?? []).filter((n) => essayUnitOfPath(n.path) !== undefined);
  const note = appendNote(workDir, rel, `${today} — essay`, `Revised on ${opts.branch}.${authorSection(notes)}`);
  const git = note.status === "ran" ? attempt("git", () => runGit(workDir, [rel], `${opts.slug}: notes on the essay (${opts.branch})`)) : { name: "git", status: "skipped" as const, detail: "no note written" };
  const think = await attemptAsync("think", () =>
    runThink(unit, 0, opts.slug, opts.env ?? process.env, opts.thinkTimeoutMs ?? 20_000, opts.env === undefined, "essay", "revised"),
  );
  return [note, git, think];
}

export const ESSAY_RITUALS: OutputRituals = { afterMerge, afterRevision };
