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
import { groupBeats, radioEpisodeCue } from "./style";
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

/**
 * How the default plan is dealt (AGT-2318): one episode per beat, unless the
 * request or the premise asks for a single episode, a count or a total length,
 * in which case the beats are dealt into that many contiguous episodes. `reason`
 * says which was chosen and why; `plan.md` and the story run both print it.
 */
export function radioPlanChoice(workDir: string): { episodes: number; reason: string } {
  const beats = radioBeatRows(workDir);
  const cue = radioEpisodeCue(workDir);
  if (beats.length === 0) return { episodes: 0, reason: "no beats planned yet" };
  if (cue === undefined) return { episodes: beats.length, reason: "one episode per beat (the request and the premise name no episode count or length)" };
  const episodes = Math.min(cue.episodes, beats.length);
  return { episodes, reason: `${episodes} episode${episodes === 1 ? "" : "s"} over ${beats.length} beat${beats.length === 1 ? "" : "s"}: ${cue.reason}` };
}

function radioBeatRows(workDir: string) {
  const path = join(workDir, beatsFile(workDir));
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  return parseBeatRows(text, BEATS_FILE);
}

/** `OUTPUTS.radio.plan`: one episode per beat row of the work's beats file, or as many as the request or premise implies. */
export function radioDefaultPlan(workDir: string): PlanRow[] {
  const files = radioUnitFiles(workDir);
  const rows = radioBeatRows(workDir);
  const { episodes } = radioPlanChoice(workDir);
  if (episodes === rows.length) return rows.map((b) => ({ unit: b.chapter, title: b.title, beats: [b.chapter], status: radioUnitStatus(files.get(b.chapter)) }));
  const byNumber = new Map(rows.map((b) => [b.chapter, b]));
  return groupBeats(rows.map((b) => b.chapter), episodes).map((beats, i) => {
    const first = byNumber.get(beats[0] as number);
    return { unit: i + 1, title: first?.title ?? `Episode ${i + 1}`, beats, status: radioUnitStatus(files.get(i + 1)) };
  });
}
