/**
 * What the request and the premise say about the radio output's shape (AGT-2318):
 * how many episodes (a single episode, a count, or a total length) and which
 * old-time-radio conventions (announcer, narrator, music) are in play. Both are
 * read from the work's own words, the request (`README.md`'s "Asked for" quote)
 * first and the premise (`bible/overview.md`) second, and both default to the
 * template's conventions when the words say nothing. Pure over the work
 * directory; reads only.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** About how long one episode runs (the rules template's twelve-minute broadcast). */
export const RADIO_EPISODE_MINUTES = 12;

/** Spoken words per broadcast minute: the writer's word target and the rules' length line both come from it. */
export const RADIO_WORDS_PER_MINUTE = 150;

/** About how many spoken words one episode of `minutes` holds (default: the twelve-minute broadcast). */
export function radioEpisodeWords(minutes: number = RADIO_EPISODE_MINUTES): number {
  return Math.round(minutes * RADIO_WORDS_PER_MINUTE);
}

/** Where the work's words asked for something: the request (`README.md`), the premise (`bible/overview.md`), or both. */
export type RadioCueSource = "request" | "premise" | "premise and request";

/** The conventions an episode follows; the template's defaults are all on. */
export interface RadioStyle {
  readonly announcer: boolean;
  readonly narrator: boolean;
  readonly music: boolean;
  /** Where a switched-off convention was asked for; absent when none was. */
  readonly source?: RadioCueSource;
  /** One episode's length when the words give it ("a 30-minute episode"); absent: the template's twelve-minute broadcast. */
  readonly minutes?: number;
}

export const RADIO_DEFAULT_STYLE: RadioStyle = { announcer: true, narrator: true, music: true };

/** How many episodes the words ask for, or `undefined` when they say nothing, and the cue that said so. */
export interface EpisodeCue {
  readonly episodes: number;
  readonly reason: string;
  /** A single episode's length, when the words attach one to "episode". */
  readonly minutes?: number;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };

function numberOf(word: string): number | undefined {
  const w = word.toLowerCase();
  return NUMBER_WORDS[w] ?? (/^\d+$/.test(w) ? Number(w) : undefined);
}

/** A word that may describe an episode's format between "single"/"one" and "episode". */
const SINGLE_FORMAT_WORD = "(?:radio|audio|drama|audio-drama|radio-drama|short|long|full|complete|standalone|self-contained|half-hour|hour-long|~?\\d+(?:\\.\\d+)?[- ]?(?:minute|min|hour)(?:[- ]long)?|\\d+[- ]?(?:minutes?|mins?))";

/** The episode count one text asks for: a count, a single episode, or a total length; `source` names the text in the reason. */
export function episodeCue(text: string, source: "request" | "premise" = "request"): EpisodeCue | undefined {
  const the = `the ${source}`;
  const count = /\b(\d+|two|three|four|five|six|seven|eight|nine|ten|twelve)[- ]?(?:part\s+)?episodes?\b(?!\s+(?:per|of)\b)/i.exec(text);
  const counted = count?.[1] === undefined ? undefined : numberOf(count[1]);
  if (counted !== undefined && counted >= 1) return { episodes: counted, reason: `${the} asks for ${counted} episode${counted === 1 ? "" : "s"}` };

  // A length is read only beside a format noun, never in story prose ("an hour before the tide", "ten minutes to get out").
  const noun = "(episode|play|drama|broadcast|programme|program|show|serial)";
  const lenBefore = new RegExp(`\\b(\\d+(?:\\.\\d+)?|an?|one|two|three)[- ](hours?|minutes?|mins?)\\b(?:[- ]long)?[^.\\n]{0,15}?\\b${noun}\\b`, "i").exec(text);
  const lenAfter = new RegExp(`\\b${noun}\\b[^.\\n]{0,25}?\\b(\\d+(?:\\.\\d+)?|an?|one|two|three)[- ](hours?|minutes?|mins?)\\b`, "i").exec(text);
  const len = lenBefore !== null ? { n: lenBefore[1], unit: lenBefore[2], noun: lenBefore[3] } : lenAfter !== null ? { n: lenAfter[2], unit: lenAfter[3], noun: lenAfter[1] } : undefined;
  const minutes = len === undefined ? undefined : (numberOf(len.n as string) ?? (/^an?$/i.test(len.n as string) ? 1 : Number(len.n))) * (/^h/i.test(len.unit as string) ? 60 : 1);
  const singular = len !== undefined && /^episode$/i.test(len.noun as string);

  // Only format words may sit between the quantifier and "episode" ("a single radio episode", "one ~10-minute
  // episode", "a standalone audio-drama episode"); story prose ("one bad episode in his life") never counts, and
  // "episode of ..." is how prose talks about an event, not a format.
  const single = new RegExp(`\\b(?:single|one|1|standalone|self-contained)\\s+(?:${SINGLE_FORMAT_WORD}\\s+){0,3}episode\\b(?!s)(?!\\s+(?:per|of)\\b)`, "i").exec(text);
  if (single !== null || singular) {
    const len1 = minutes !== undefined && Number.isFinite(minutes) && minutes > 0 ? minutes : undefined;
    return { episodes: 1, reason: `${the} asks for ${singular && single === null ? "one episode" : "a single episode"}${len1 !== undefined ? ` of about ${len1} minutes` : ""}`, ...(len1 !== undefined ? { minutes: len1 } : {}) };
  }

  if (minutes !== undefined && Number.isFinite(minutes) && minutes > 0) {
    const episodes = Math.max(1, Math.round(minutes / RADIO_EPISODE_MINUTES));
    return { episodes, reason: `${the} asks for about ${minutes} minutes, ${episodes} episode${episodes === 1 ? "" : "s"} of about ${RADIO_EPISODE_MINUTES}` };
  }
  return undefined;
}

/** The request a work was asked for (the README's `> ` quote under "Asked for"), or "". */
export function askedFor(workDir: string): string {
  const file = join(workDir, "README.md");
  if (!existsSync(file)) return "";
  const quote = /Asked for on [^\n]*:\n\n((?:>[^\n]*\n?)+)/.exec(readFileSync(file, "utf8"))?.[1];
  return quote?.split("\n").map((l) => l.replace(/^>\s?/, "")).join("\n").trim() ?? "";
}

/** The premise file's text (`bible/overview.md`), or "". */
export function premiseText(workDir: string): string {
  const file = join(workDir, "bible", "overview.md");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

/** The first source that asks for an episode count: the request, then the premise. */
export function radioEpisodeCue(workDir: string): EpisodeCue | undefined {
  return episodeCue(askedFor(workDir), "request") ?? episodeCue(premiseText(workDir), "premise");
}

const NO_NARRATOR = /\b(?:no|without(?: a| any)?|zero)[ -](?:narrator|narration|voice-?over)\b|\bnarrator-?free\b|\bnever (?:a|any) narrator\b/i;
const NO_ANNOUNCER = /\b(?:no|without(?: a| any)?)[ -]announcer\b|\bannouncer-?free\b/i;
const NO_MUSIC = /\b(?:no|without(?: any)?)[ -](?:theme |bridge |incidental )?music\b/i;

/** The conventions a text switches off: the tone says "no narrator" and the rules follow. */
export function styleOf(text: string): RadioStyle {
  return { announcer: !NO_ANNOUNCER.test(text), narrator: !NO_NARRATOR.test(text), music: !NO_MUSIC.test(text) };
}

/** The work's radio style: the premise and the request can each switch a convention off; silence keeps the default. */
export function radioStyleOf(workDir: string): RadioStyle {
  const premise = styleOf(premiseText(workDir));
  const asked = styleOf(askedFor(workDir));
  const style = { announcer: premise.announcer && asked.announcer, narrator: premise.narrator && asked.narrator, music: premise.music && asked.music };
  const keys = ["announcer", "narrator", "music"] as const;
  const byPremise = keys.some((k) => !premise[k]);
  const byRequest = keys.some((k) => !asked[k]);
  const source: RadioCueSource | undefined = byPremise && byRequest ? "premise and request" : byPremise ? "premise" : byRequest ? "request" : undefined;
  const minutes = radioEpisodeCue(workDir)?.minutes;
  return { ...style, ...(source !== undefined ? { source } : {}), ...(minutes !== undefined ? { minutes } : {}) };
}

/** `groupBeats([1, 2, 3, 4, 5], 2)` is `[[1,2,3],[4,5]]`: the beat numbers dealt into `n` contiguous groups, as even as can be. */
export function groupBeats(beats: readonly number[], n: number): number[][] {
  const groups = Math.max(1, Math.min(n, beats.length));
  const out: number[][] = [];
  let at = 0;
  for (let i = 0; i < groups; i++) {
    const size = Math.floor(beats.length / groups) + (i < beats.length % groups ? 1 : 0);
    out.push(beats.slice(at, at + size));
    at += size;
  }
  return out;
}
