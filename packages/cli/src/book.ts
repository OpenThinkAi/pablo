/**
 * Book mode's table of contents (AGT-1526): the novel stage machine's state as the screen's stages. Pure over the
 * `NovelState` that `readNovelState` returns (the same data `pablo status` reports), with each chapter's reasons
 * from `chapterPreconditions` — nothing here decides readiness itself.
 */

import type { BookStage } from "@openthink/pablo-tui";
import type { CoreState } from "./core/machine";
import { readMarker } from "./marker";
import { chapterPreconditions, readNovelState } from "./novel/machine";
import type { NovelState } from "./novel/machine";
import { outputDefinition } from "./outputs/registry";
import type { OutputDefinition } from "./outputs/types";

/**
 * The newest draft branch waiting for review for chapter `n`: `draft/chNN`, or the highest `draft/chNN-vK` (a re-draft;
 * the bare name counts as v1). Undefined when none of `waiting` is one.
 */
export function waitingDraft(waiting: readonly string[], n: number): string | undefined {
  let best: { branch: string; v: number } | undefined;
  for (const branch of waiting) {
    const m = /^draft\/ch0*(\d+)(?:-v(\d+))?$/.exec(branch);
    if (!m || Number(m[1]) !== n) continue;
    const v = m[2] === undefined ? 1 : Number(m[2]);
    if (!best || v > best.v) best = { branch, v };
  }
  return best?.branch;
}

/**
 * The core's stages as the rail's first rows (AGT-1672): premise, research, bible, acts, beats. Every output's group
 * comes after these; the core is the same whatever outputs the work derives from it.
 */
export function coreRailStages(state: CoreState): BookStage[] {
  const stages: BookStage[] = [];
  const stage = (id: string, name: string, ok: boolean, missing: string[]) =>
    stages.push({ id, name, depth: 0, status: ok ? "ready" : "missing", missing: ok ? [] : missing });

  stage("premise", "premise", state.premise, ["bible/overview.md has no text under ## Logline"]);
  stage("research", "research", state.research.length > 0, ["research/ has no files"]);

  const absent = state.bible.files.filter((f) => !f.exists).map((f) => `${f.file} does not exist`);
  const cast = state.bible.files.filter((f) => f.exists && f.file.includes("characters/")).length;
  if (cast === 0) absent.push("bible/characters/ has no character files");
  stage("bible", "bible", absent.length === 0, absent);

  stage("acts", "acts", state.acts.length > 0, [`${state.outlineFile} has no | Act | table`]);
  stage("beats", state.beats.length > 0 ? `beats (${state.beats.length})` : "beats", state.beats.length > 0, [`${state.outlineFile} has no beat rows`]);
  return stages;
}

/** `waiting` is the change branches waiting for review (`waitingBranches`); a chapter with no file whose draft is among them shows as `waiting`. */
export function bookStages(state: NovelState, waiting: readonly string[] = []): BookStage[] {
  return [...coreRailStages(state), ...novelRailStages(state, waiting)];
}

/**
 * Every output the work declares as its own group after the core's stages: the novel's chapters group, and a
 * `<type>` group (`radio`, then `radio › 3`) for any other registered type. A work that declares no outputs, or whose
 * marker cannot be read, shows the novel's group (every work was a novel before outputs existed).
 */
export function workBookStages(workDir: string, waiting: readonly string[] = []): BookStage[] {
  const state = readNovelState(workDir);
  const marker = readMarker(workDir);
  const types = marker.ok ? Object.keys(marker.marker.outputs) : [];
  if (types.length === 0) return bookStages(state, waiting);
  const stages: BookStage[] = coreRailStages(state);
  for (const type of types) {
    if (type === "novel") {
      stages.push(...novelRailStages(state, waiting));
      continue;
    }
    const def = outputDefinition(type);
    if (def !== undefined) stages.push(...outputRailStages(workDir, def, state, waiting));
  }
  return stages;
}

/** One non-novel output's group: its units from the type's own report, each ready or missing by the type's preconditions. */
export function outputRailStages(workDir: string, def: OutputDefinition, core: CoreState, waiting: readonly string[] = []): BookStage[] {
  const report = def.report(workDir, core);
  const stages: BookStage[] = [
    { id: `output:${def.id}`, name: `${def.id} (${report.drafted}/${report.total})`, depth: 0, group: true, status: report.total > 0 ? "ready" : "missing", missing: report.total > 0 ? [] : [`${def.id} has no units yet`], output: def.id },
  ];
  for (const u of report.units) {
    const name = `${u.unit}${u.title ? ` ${u.title}` : ""}`;
    const base = { id: `unit:${def.id}:${u.unit}`, name, depth: 1, output: def.id, unit: u.unit };
    if (u.file !== undefined) {
      stages.push({ ...base, status: "drafted", missing: [], file: u.file, storage: def.manuscript ?? "sentences" });
      continue;
    }
    const draft = waiting.filter((b) => def.unitOfBranch(b) === u.unit).sort().at(-1);
    if (draft !== undefined) {
      stages.push({ ...base, status: "waiting", missing: [], branch: draft });
      continue;
    }
    const pre = def.preconditions(workDir, u.unit);
    stages.push({ ...base, status: pre.ready ? "ready" : "missing", missing: pre.missing });
  }
  return stages;
}

/** The novel output's group: the chapters, each drafted, waiting, ready or missing. */
function novelRailStages(state: NovelState, waiting: readonly string[]): BookStage[] {
  const stages: BookStage[] = [];
  const numbers = [...new Set([...state.beats.map((b) => b.chapter), ...state.chapters.map((c) => c.number)])].sort((a, b) => a - b);
  const drafted = state.chapters.length;
  const ok = numbers.length > 0;
  stages.push({ id: "chapters", name: `chapters (${drafted}/${numbers.length})`, depth: 0, group: true, status: ok ? "ready" : "missing", missing: ok ? [] : ["no beat rows or chapter files yet"], output: "novel" });
  for (const n of numbers) {
    const file = state.chapters.find((c) => c.number === n);
    const name = `${n}${file?.title ? ` ${file.title}` : ""}`;
    const base = { id: `chapter:${n}`, name, depth: 1, output: "novel", unit: n };
    if (file) {
      stages.push({ ...base, status: "drafted", missing: [] });
      continue;
    }
    const draft = waitingDraft(waiting, n);
    if (draft !== undefined) {
      stages.push({ ...base, status: "waiting", missing: [], branch: draft });
      continue;
    }
    const pre = chapterPreconditions(state, n);
    stages.push({ ...base, status: pre.ready ? "ready" : "missing", missing: pre.missing });
  }
  return stages;
}
