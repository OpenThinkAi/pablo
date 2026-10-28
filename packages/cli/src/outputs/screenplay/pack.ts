/**
 * The screenplay output's plan and write stage (AGT-2132): one scene per core
 * beat by default, what a scene needs before it is written, and the writer's
 * pack for it.
 *
 * The pack is the radio output's recipe in Fountain: the core's slices
 * (layered voice, period facts, cast, places, the timeline gated by the
 * beat's date, `facts.md`), the screenplay's own `RULES.md` and continuity
 * ledger, the beat rows the scene's plan row names, and a summary of the
 * previous scene in place of the novel's chapter tail (a Fountain tail joined
 * into paragraphs would run cues into their dialogue). Research is never in it.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { BEATS_FILE, beatsFile, gateTimeline, outputRulesFile, parseBeatRows, planBeatsFor, readDraftingInputs } from "@openthink/pablo-core";
import type { TextSource } from "@openthink/pablo-core";
import { readCoreState, undecidedPicks } from "../../core/machine";
import { CAST_ENDS_AT, packFromInputs } from "../../novel/pack";
import { frontmatterField } from "../novel/plan";
import type { PlanRow, UnitPackOptions, UnitPackOutcome, UnitPreconditions } from "../types";
import { fountainElements } from "./fountain";
import { SCREENPLAY_DIR, SCREENPLAY_ID, SCREENPLAY_UNIT_FILE } from "./units";

/** About three pages of screenplay, at roughly two hundred words a page. */
export const SCENE_WORDS = 600;

/** A unit is one scene. */
export const SCENE_SCENES = 1;

/** How the work is described to the writer in the brief. */
const SCREENPLAY_FORM = "a screenplay, one scene at a time, written in Fountain exactly as the screenplay rules say";

/** The previous scene's last elements carried into the summary. */
const SUMMARY_TAIL = 12;

function yearIn(text: string): number | undefined {
  const match = /(1[89]\d{2}|20\d{2})/.exec(text);
  return match === null ? undefined : Number(match[1]);
}

/** The work's scene files in the screenplay's directory, by number, absolute. */
export function screenplayUnitFiles(workDir: string): Map<number, string> {
  const dir = join(workDir, SCREENPLAY_DIR);
  const out = new Map<number, string>();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const m = SCREENPLAY_UNIT_FILE.exec(name);
    if (m && !out.has(Number(m[1]))) out.set(Number(m[1]), join(dir, name));
  }
  return out;
}

/** A scene file's frontmatter status (`draft` when it has none), or `beat` with no file. */
export function screenplayUnitStatus(file: string | undefined): string {
  if (file === undefined) return "beat";
  try {
    return frontmatterField(readFileSync(file, "utf8"), "status") ?? "draft";
  } catch {
    return "draft";
  }
}

/** `OUTPUTS.screenplay.plan`: one scene per beat row of the work's beats file. Reads only. */
export function screenplayDefaultPlan(workDir: string): PlanRow[] {
  const path = join(workDir, beatsFile(workDir));
  const files = screenplayUnitFiles(workDir);
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  return parseBeatRows(text, BEATS_FILE).map((b) => ({ unit: b.chapter, title: b.title, beats: [b.chapter], status: screenplayUnitStatus(files.get(b.chapter)) }));
}

/** The beats a scene tells: its plan row's, else beat N for scene N. */
export function screenplayBeats(workDir: string, scene: number): readonly number[] {
  return planBeatsFor(workDir, SCREENPLAY_ID, scene) ?? [scene];
}

/**
 * `OUTPUTS.screenplay.preconditions`: the beats the scene's plan row names,
 * the previous scene written, a timeline row for the beat's year, and no
 * undecided pick its beats name. Pure over the work.
 */
export function screenplayPreconditions(workDir: string, scene: number): UnitPreconditions {
  const state = readCoreState(workDir);
  const found = screenplayBeats(workDir, scene).map((n) => ({ n, row: state.beats.find((b) => b.chapter === n) }));
  const absent = found.filter((f) => f.row === undefined);
  if (absent.length > 0) return { ready: false, missing: absent.map((f) => `no beat ${f.n} for scene ${scene} in ${state.outlineFile}`) };
  const beats = found.map((f) => f.row as NonNullable<typeof f.row>);
  const missing: string[] = [];
  if (scene > 1 && !screenplayUnitFiles(workDir).has(scene - 1)) missing.push(`scene ${scene - 1} is not written`);
  const first = beats[0] as NonNullable<(typeof beats)[number]>;
  const year = yearIn(first.storyDate);
  if (year !== undefined && gateTimeline(state.bible.timelineText, first.storyDate, "bible/timeline.md").exists.length === 0) {
    missing.push(`bible/timeline.md has no row dated ${year} or earlier`);
  }
  for (const b of beats) missing.push(...undecidedPicks(state, b.beat));
  return { ready: missing.length === 0, missing };
}

/**
 * A summary of the previous scene for the next one to follow from, made
 * without a model: its title, where it was set (its scene headings), then how
 * it ended (its last elements, a speech as `NAME: words`). One item per
 * paragraph: the pack joins a paragraph's lines.
 */
export function previousSceneSummary(vaultRoot: string, workDir: string, scene: number): TextSource | undefined {
  if (scene <= 1) return undefined;
  const file = screenplayUnitFiles(workDir).get(scene - 1);
  if (file === undefined) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const elements = fountainElements(text);
  const headings = elements.filter((e) => e.kind === "heading").map((e) => e.text);
  const ending = elements
    .filter((e) => e.kind === "action" || e.kind === "dialogue")
    .slice(-SUMMARY_TAIL)
    .map((e) => (e.kind === "dialogue" ? `${e.speaker}: ${e.text}` : e.text));
  if (headings.length === 0 && ending.length === 0) return undefined;
  const title = frontmatterField(text, "title");
  const parts = [
    `Scene ${scene - 1}${title === undefined ? "" : `, "${title}"`}, in summary.`,
    ...(headings.length > 0 ? ["Where it was set:", ...headings] : []),
    ...(ending.length > 0 ? ["How it ended (its last lines):", ...ending] : []),
  ];
  return { path: relative(vaultRoot, file).split(sep).join("/"), text: parts.join("\n\n") };
}

/** `OUTPUTS.screenplay.pack`: the scene's writer pack (layered voice included), or a refusal (a `neverSend` violation). */
export function buildScreenplayPack(vaultRoot: string, workDir: string, scene: number, options: UnitPackOptions): UnitPackOutcome {
  const inputs = readDraftingInputs({
    vaultRoot,
    workRoot: workDir,
    chapter: scene,
    beats: screenplayBeats(workDir, scene),
    // The screenplay's own rules, never another output's.
    outputRulesPath: join(workDir, outputRulesFile(SCREENPLAY_ID)),
    wordTarget: options.words ?? SCENE_WORDS,
    minScenes: options.scenes ?? SCENE_SCENES,
    castEndsAt: CAST_ENDS_AT,
    work: { description: SCREENPLAY_FORM },
    // The screenplay's own ledger (outputs/screenplay/continuity.md) plus facts.md.
    output: SCREENPLAY_ID,
  });
  const summary = previousSceneSummary(vaultRoot, workDir, scene);
  const { previousTail: _novelTail, ...rest } = inputs;
  return packFromInputs(
    vaultRoot,
    workDir,
    {
      ...rest,
      unitLabel: `scene ${scene}`,
      scriptUnit: true,
      ...(summary !== undefined ? { previousTail: summary } : {}),
    },
    { ...options, output: SCREENPLAY_ID },
  );
}
