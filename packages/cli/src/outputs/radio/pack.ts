/**
 * The radio output's script stage (AGT-1686): what an episode needs before it
 * is written, and the writer's pack for it.
 *
 * The recipe (pm project `pablo-story-core`, "The registry"): the core's
 * slices (voice, period facts, cast, places, the timeline gated by the
 * beat's date, `facts.md`), the radio output's own `RULES.md`
 * (`outputs/radio/RULES.md`, never another output's) and continuity ledger,
 * the beat rows the episode's plan row names, and a summary of the previous
 * episode in place of the novel's chapter tail. Research is never in it.
 */

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gateTimeline, outputRulesFile, planBeatsFor, readDraftingInputs } from "@openthink/pablo-core";
import type { TextSource } from "@openthink/pablo-core";
import { readCoreState, undecidedPicks } from "../../core/machine";
import { CAST_ENDS_AT, packFromInputs } from "../../novel/pack";
import { frontmatterField } from "../novel/plan";
import type { UnitPackOptions, UnitPackOutcome, UnitParts, UnitPreconditions } from "../types";
import { radioUnitFiles } from "./plan";
import { castEntries, isCastLine, speakerOf } from "./script";
import { radioEpisodeWords, radioStyleOf } from "./style";
import { RADIO_ID } from "./units";

/** What the radio rules ask for: a twelve-minute broadcast, about 1,800 spoken words. */
export const EPISODE_WORDS = radioEpisodeWords();

/** Three to five scenes, as the radio rules lay an episode out. */
export const EPISODE_SCENES = 3;

/** How the work is described to the writer in the brief. */
const RADIO_FORM = "a radio drama in episodes: a script for voices, laid out exactly as the radio rules say";

/** The last spoken lines of the previous episode carried into the summary. */
const SUMMARY_TAIL_LINES = 12;

function yearIn(text: string): number | undefined {
  const match = /(1[89]\d{2}|20\d{2})/.exec(text);
  return match === null ? undefined : Number(match[1]);
}

/** The beats an episode tells: its plan row's, else beat N for episode N. */
export function radioBeats(workDir: string, episode: number): readonly number[] {
  return planBeatsFor(workDir, RADIO_ID, episode) ?? [episode];
}

/**
 * `OUTPUTS.radio.preconditions`, the script stage: the beats the episode's
 * plan row names, the previous episode's script, a timeline row for the
 * beat's year, and no undecided pick its beats name. Pure over the work.
 */
export function radioPreconditions(workDir: string, episode: number): UnitPreconditions {
  const state = readCoreState(workDir);
  const found = radioBeats(workDir, episode).map((n) => ({ n, row: state.beats.find((b) => b.chapter === n) }));
  const absent = found.filter((f) => f.row === undefined);
  if (absent.length > 0) return { ready: false, missing: absent.map((f) => `no beat ${f.n} for episode ${episode} in ${state.outlineFile}`) };
  const beats = found.map((f) => f.row as NonNullable<typeof f.row>);
  const missing: string[] = [];
  if (episode > 1 && !radioUnitFiles(workDir).has(episode - 1)) missing.push(`episode ${episode - 1} is not written`);
  const first = beats[0] as NonNullable<(typeof beats)[number]>;
  const year = yearIn(first.storyDate);
  if (year !== undefined && gateTimeline(state.bible.timelineText, first.storyDate, "bible/timeline.md").exists.length === 0) {
    missing.push(`bible/timeline.md has no row dated ${year} or earlier`);
  }
  for (const b of beats) missing.push(...undecidedPicks(state, b.beat));
  return { ready: missing.length === 0, missing };
}

/**
 * A summary of the previous episode for the next one to follow from, made
 * without a model: its title, every narrator line (they place the listener
 * and bridge the scenes), then how it ended (its last spoken lines). The
 * casting line, cues and directions stay out; they are the rules' business.
 */
export function previousEpisodeSummary(vaultRoot: string, workDir: string, episode: number): TextSource | undefined {
  if (episode <= 1) return undefined;
  const file = radioUnitFiles(workDir).get(episode - 1);
  if (file === undefined) return undefined;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const body = text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "");
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\*/g, ""))
    .filter((l) => l !== "" && !/^CAST:/i.test(l) && !/^\[(SFX|BED|MUSIC):/i.test(l) && !l.startsWith("#"));
  const spoken = lines.filter((l) => /^[A-Z][A-Z .'\-]{0,30}:\s*\S/.test(l)).map((l) => l.replace(/^([A-Z][A-Z .'\-]{0,30}):\s*\([^)]*\)\s*/, "$1: "));
  const narration = spoken.filter((l) => /^NARRATOR:/.test(l));
  const ending = spoken.filter((l) => !/^(NARRATOR|ANNOUNCER):/.test(l)).slice(-SUMMARY_TAIL_LINES);
  if (narration.length === 0 && ending.length === 0) return undefined;
  const title = frontmatterField(text, "title");
  const parts = [
    `Episode ${episode - 1}${title === undefined ? "" : `, "${title}"`}, in summary.`,
    ...(narration.length > 0 ? ["Where it went (the narrator's lines):", ...narration] : []),
    ...(ending.length > 0 ? ["How it ended (its last lines):", ...ending] : []),
  ];
  // One item per paragraph: the pack joins a paragraph's lines (`joinManuscript`), and these are separate lines.
  return { path: relative(vaultRoot, file).split(sep).join("/"), text: parts.join("\n\n") };
}

/** `OUTPUTS.radio.pack`: the episode's writer pack, or a refusal (a `neverSend` violation, another output's slice). */
export function buildRadioPack(vaultRoot: string, workDir: string, episode: number, options: UnitPackOptions): UnitPackOutcome {
  const beats = radioBeats(workDir, episode);
  const inputs = readDraftingInputs({
    vaultRoot,
    workRoot: workDir,
    chapter: episode,
    beats,
    // The radio output's own rules, never the novel's (AGT-1694's carry-over).
    outputRulesPath: join(workDir, outputRulesFile(RADIO_ID)),
    // The same length the rules' length line gives ("a 30-minute episode": about 4,500 words), else the default.
    wordTarget: options.words ?? radioEpisodeWords(radioStyleOf(workDir).minutes),
    minScenes: options.scenes ?? EPISODE_SCENES,
    castEndsAt: CAST_ENDS_AT,
    work: { description: RADIO_FORM },
    // AGT-1671: the radio output's own ledger (outputs/radio/continuity.md) plus facts.md.
    output: RADIO_ID,
  });
  const summary = previousEpisodeSummary(vaultRoot, workDir, episode);
  const { previousTail: _novelTail, ...rest } = inputs;
  return packFromInputs(
    vaultRoot,
    workDir,
    {
      ...rest,
      unitLabel: `episode ${episode}`,
      // The previous episode's summary, never the novel's chapter tail the core reader finds.
      ...(summary !== undefined ? { previousTail: summary } : {}),
    },
    { ...options, output: RADIO_ID },
  );
}

/** Lines of the script so far each later part is given to continue from. */
const PART_TAIL_LINES = 24;

/** Characters of the next beat named to a part as the place to stop before. */
const NEXT_BEAT_CHARS = 400;

const isCast = isCastLine;
const speaker = speakerOf;
const isMusic = (line: string): boolean => /^\[MUSIC:/i.test(line.trim());

/**
 * Trims what a part wrote past its boundary (AGT-2322). Only the first part opens the episode and only the last
 * closes it, but a writer told so still sometimes does the other: so in a part that is not the last, an announcer line
 * after the opening is a sign-off (the part ran on to the end), and everything from it, with the theme cue just
 * before it, is dropped; in a part that is not the first, the announcer's opening lines (and the theme before them)
 * are dropped. The opening is the lines before the first role that is neither the announcer nor the narrator.
 * A scene the cut left open is closed.
 */
export function trimRadioPart(piece: string, index: number, count: number): string {
  let lines = piece.split(/\r?\n/);
  // The opening: the leading cast line, theme cues and announcer lines, ended by the first line that is anything else.
  const opening = (all: readonly string[]): number => {
    const at = all.findIndex((l) => l.trim() !== "" && !isCast(l) && !isMusic(l) && speaker(l) !== "ANNOUNCER");
    return at === -1 ? all.length : at;
  };
  if (index > 1) {
    const zone = lines.slice(0, opening(lines));
    const lastAnnouncer = zone.reduce((at, l, i) => (speaker(l) === "ANNOUNCER" ? i : at), -1);
    if (lastAnnouncer !== -1) {
      const from = zone.findIndex((l) => speaker(l) === "ANNOUNCER" || isMusic(l));
      lines = lines.filter((_, i) => i < from || i > lastAnnouncer);
    }
  }
  if (index < count) {
    // The first part's opening announcer stays; any announcer line after it is the sign-off.
    const start = index === 1 ? opening(lines) : 0;
    const cut = lines.findIndex((l, i) => i >= start && speaker(l) === "ANNOUNCER");
    if (cut !== -1) {
      let end = cut;
      while (end > 0 && (isMusic(lines[end - 1] as string) || (lines[end - 1] as string).trim() === "")) end -= 1;
      lines = lines.slice(0, end);
      const dramas = lines.filter((l) => /^\[DRAMA\]/i.test(l.trim())).length;
      const closed = lines.filter((l) => /^\[DRAMA:\s*off\]/i.test(l.trim())).length;
      if (dramas > closed) lines.push("[DRAMA: off]");
    }
  }
  return lines.join("\n").trim();
}

/** The parts' scripts as the one episode: a single `CAST:` line, the union of every part's roles, then the scripts in order. */
export function stitchRadioParts(pieces: readonly string[]): string {
  const cast = castEntries(pieces.join("\n"));
  const body = pieces
    .map((p) => p.split(/\r?\n/).filter((l) => !isCast(l)).join("\n").trim())
    .filter((p) => p !== "");
  return [...(cast.length > 0 ? [`CAST: ${cast.join(", ")}`] : []), ...body].join("\n").trim();
}

/** The radio episode as one request per beat (AGT-2322), or `undefined` when it tells one beat. */
export function radioParts(vaultRoot: string, workDir: string, episode: number, options: UnitPackOptions): UnitParts | undefined {
  const numbers = radioBeats(workDir, episode);
  if (numbers.length <= 1) return undefined;
  const rows = readCoreState(workDir).beats;
  const total = options.words ?? radioEpisodeWords(radioStyleOf(workDir).minutes); // the episode length the rules give
  const share = Math.max(1, Math.round(total / numbers.length));
  const count = numbers.length;
  return {
    count,
    plan: numbers.map((n, i) => {
      const row = rows.find((b) => b.chapter === n);
      const title = row === undefined ? `beat ${n}` : `beat ${n}, "${row.title}"`;
      const opens = i === 0 ? "opens the episode (announcer, title)" : "no opening, no recap";
      const closes = i === count - 1 ? "closes it" : "stops before the next beat";
      return `request ${i + 1} of ${count}: ${title}, about ${share} words; ${opens}; ${closes}`;
    }),
    finish: (piece, index) => trimRadioPart(piece, index, count),
    stitch: stitchRadioParts,
    pack: (index, soFar) => {
      const inputs = readDraftingInputs({
        vaultRoot,
        workRoot: workDir,
        chapter: episode,
        beats: [numbers[index - 1] as number],
        outputRulesPath: join(workDir, outputRulesFile(RADIO_ID)),
        wordTarget: share,
        minScenes: 1,
        castEndsAt: CAST_ENDS_AT,
        work: { description: RADIO_FORM },
        output: RADIO_ID,
      });
      const next = index < count ? rows.find((b) => b.chapter === numbers[index]) : undefined;
      // The script so far, one item per line, never its CAST line: the pack joins a paragraph's lines.
      const tail = soFar.split(/\r?\n/).filter((l) => l.trim() !== "" && !isCast(l)).slice(-PART_TAIL_LINES).join("\n\n");
      const summary = index === 1 ? previousEpisodeSummary(vaultRoot, workDir, episode) : undefined;
      const { previousTail: _novelTail, ...rest } = inputs;
      return packFromInputs(
        vaultRoot,
        workDir,
        {
          ...rest,
          unitLabel: `part ${index} of ${count} of episode ${episode}`,
          part: {
            number: index,
            of: count,
            script: true,
            ...(next === undefined ? {} : { next: { title: next.title, beat: next.beat.slice(0, NEXT_BEAT_CHARS).replace(/[.\s]+$/, "") } }),
          },
          ...(tail !== "" ? { previousTail: { path: "the script so far", text: tail } } : summary !== undefined ? { previousTail: summary } : {}),
        },
        { ...options, output: RADIO_ID },
      );
    },
  };
}
