/**
 * The novel output's default plan (AGT-1668): one chapter per core beat.
 * `pablo migrate outputs` renders it to `outputs/novel/plan.md`; the registry
 * returns its rows as `OUTPUTS.novel.plan`. Reads only, never writes.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BEATS_FILE, beatsFile, parseBeatRows } from "@openthink/pablo-core";
import type { PlanRow } from "../types";
import { NOVEL_UNIT_FILE, novelUnitDir } from "./units";

/** A frontmatter field's value (surrounding quotes dropped), or undefined when the file has no such field. */
export function frontmatterField(text: string, key: string): string | undefined {
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (fm === undefined) return undefined;
  const m = new RegExp(`^${key}:[ \\t]*["']?([^"'\\r\\n]*)["']?[ \\t]*$`, "m").exec(fm);
  return m?.[1]?.trim() || undefined;
}

/** The work's chapter files by number, absolute paths. */
export function novelUnitFiles(workDir: string): Map<number, string> {
  const dir = novelUnitDir(workDir);
  const out = new Map<number, string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const m = NOVEL_UNIT_FILE.exec(name);
    if (m) out.set(Number(m[1]), join(dir, name));
  }
  return out;
}

/** One unit per beat row of `beatsText`; a unit whose chapter exists carries its status (`draft` when it has none), else `beat`. */
export function novelPlanRows(workDir: string, beatsText: string): PlanRow[] {
  const chapters = novelUnitFiles(workDir);
  return parseBeatRows(beatsText, BEATS_FILE).map((b) => {
    const file = chapters.get(b.chapter);
    const status = file === undefined ? "beat" : (frontmatterField(readFileSync(file, "utf8"), "status") ?? "draft");
    return { unit: b.chapter, title: b.title, beats: [b.chapter], status };
  });
}

/** `OUTPUTS.novel.plan`: the default plan over the work's beats file (either name). */
export function novelDefaultPlan(workDir: string): PlanRow[] {
  const path = join(workDir, beatsFile(workDir));
  return novelPlanRows(workDir, existsSync(path) ? readFileSync(path, "utf8") : "");
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

/** `outputs/novel/plan.md`'s text for `rows`. */
export function renderNovelPlan(rows: readonly PlanRow[]): string {
  return [
    "# Plan: novel",
    "",
    `The novel's units (chapters) mapped onto the core beats in \`${BEATS_FILE}\`:`,
    "one chapter per beat. A unit whose chapter exists carries the chapter's status.",
    "",
    "| unit | title | beats | status |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.unit} | ${cell(r.title)} | ${r.beats.join(", ")} | ${cell(r.status)} |`),
    "",
  ].join("\n");
}
