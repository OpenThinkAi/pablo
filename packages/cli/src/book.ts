/**
 * Book mode's table of contents (AGT-1526): the novel stage machine's state as the screen's stages. Pure over the
 * `NovelState` that `readNovelState` returns (the same data `pablo status` reports), with each chapter's reasons
 * from `chapterPreconditions` — nothing here decides readiness itself.
 */

import type { BookStage } from "@openthink/pablo-tui";
import { chapterPreconditions } from "./novel/machine";
import type { NovelState } from "./novel/machine";

export function bookStages(state: NovelState): BookStage[] {
  const stages: BookStage[] = [];
  const stage = (id: string, name: string, ok: boolean, missing: string[], extra: Partial<BookStage> = {}) =>
    stages.push({ id, name, depth: 0, status: ok ? "ready" : "missing", missing: ok ? [] : missing, ...extra });

  stage("premise", "premise", state.premise, ["bible/overview.md has no text under ## Logline"]);

  const absent = state.bible.files.filter((f) => !f.exists).map((f) => `${f.file} does not exist`);
  const cast = state.bible.files.filter((f) => f.exists && f.file.includes("characters/")).length;
  if (cast === 0) absent.push("bible/characters/ has no character files");
  stage("bible", "bible", absent.length === 0, absent);

  stage("acts", "acts", state.acts.length > 0, ["outline/chapters.md has no | Act | table"]);
  stage("beats", state.beats.length > 0 ? `beats (${state.beats.length})` : "beats", state.beats.length > 0, ["outline/chapters.md has no beat rows"]);

  const numbers = [...new Set([...state.beats.map((b) => b.chapter), ...state.chapters.map((c) => c.number)])].sort((a, b) => a - b);
  const drafted = state.chapters.length;
  stage("chapters", `chapters (${drafted}/${numbers.length})`, numbers.length > 0, ["no beat rows or chapter files yet"], { group: true });
  for (const n of numbers) {
    const file = state.chapters.find((c) => c.number === n);
    const name = `${n}${file?.title ? ` ${file.title}` : ""}`;
    if (file) {
      stages.push({ id: `chapter:${n}`, name, depth: 1, status: "drafted", missing: [] });
      continue;
    }
    const pre = chapterPreconditions(state, n);
    stages.push({ id: `chapter:${n}`, name, depth: 1, status: pre.ready ? "ready" : "missing", missing: pre.missing });
  }
  return stages;
}
