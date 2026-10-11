/**
 * The radio output's default plan (AGT-1686): one episode per core beat, as
 * the sandbox drama wrote twelve episodes from the Act I outline. `pablo
 * output add radio` renders it to `outputs/radio/plan.md`; an author who
 * wants an episode to tell two beats edits the row's beats cell, and `pablo
 * output plan radio` keeps it. Reads only, never writes.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BEATS_FILE, beatsFile, parseBeatRows } from "@openthink/pablo-core";
import { frontmatterField } from "../novel/plan";
import type { PlanRow } from "../types";
import { RADIO_DIR, RADIO_UNIT_FILE } from "./units";

/** The work's episode files in the radio output's directory, by number, absolute. */
export function radioUnitFiles(workDir: string): Map<number, string> {
  const dir = join(workDir, RADIO_DIR);
  const out = new Map<number, string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const m = RADIO_UNIT_FILE.exec(name);
    if (m && !out.has(Number(m[1]))) out.set(Number(m[1]), join(dir, name));
  }
  return out;
}

/** An episode file's frontmatter status (`draft` when it has none), or `beat` with no file. */
export function radioUnitStatus(file: string | undefined): string {
  if (file === undefined) return "beat";
  try {
    return frontmatterField(readFileSync(file, "utf8"), "status") ?? "draft";
  } catch {
    return "draft";
  }
}

/** `OUTPUTS.radio.plan`: one episode per beat row of the work's beats file. */
export function radioDefaultPlan(workDir: string): PlanRow[] {
  const path = join(workDir, beatsFile(workDir));
  const files = radioUnitFiles(workDir);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  return parseBeatRows(text, BEATS_FILE).map((b) => ({ unit: b.chapter, title: b.title, beats: [b.chapter], status: radioUnitStatus(files.get(b.chapter)) }));
}
