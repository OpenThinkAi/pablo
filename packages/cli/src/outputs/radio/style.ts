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

/** The conventions an episode follows; the template's defaults are all on. */
export interface RadioStyle {
  readonly announcer: boolean;
  readonly narrator: boolean;
  readonly music: boolean;
}

export const RADIO_DEFAULT_STYLE: RadioStyle = { announcer: true, narrator: true, music: true };

/** How many episodes the words ask for, or `undefined` when they say nothing, and the cue that said so. */
export interface EpisodeCue {
  readonly episodes: number;
  readonly reason: string;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };

function numberOf(word: string): number | undefined {
  const w = word.toLowerCase();
  return NUMBER_WORDS[w] ?? (/^\d+$/.test(w) ? Number(w) : undefined);
}

/** The episode count one text asks for: a count, a single episode, or a total length. */
export function episodeCue(text: string): EpisodeCue | undefined {
  const count = /\b(\d+|two|three|four|five|six|seven|eight|nine|ten|twelve)[- ]?(?:part\s+)?episodes?\b(?!\s+per\b)/i.exec(text);
  const counted = count?.[1] === undefined ? undefined : numberOf(count[1]);
  if (counted !== undefined && counted >= 1) return { episodes: counted, reason: `the request asks for ${counted} episode${counted === 1 ? "" : "s"}` };

  const single = /\b(?:single|one|1|standalone)\b[^.\n]{0,40}?\bepisode\b(?!s)(?!\s+per\b)/i.exec(text);
  if (single !== null) return { episodes: 1, reason: "the request asks for a single episode" };

  const hours = /\b(\d+(?:\.\d+)?|an?|one|two|three)[- ]hours?\b/i.exec(text);
  const mins = /\b(\d+)[- ]?(?:minutes?|mins?)\b/i.exec(text);
  const minutes = mins?.[1] !== undefined ? Number(mins[1]) : hours?.[1] !== undefined ? (numberOf(hours[1]) ?? (/^an?$/i.test(hours[1]) ? 1 : Number(hours[1]))) * 60 : undefined;
  if (minutes !== undefined && Number.isFinite(minutes) && minutes > 0) {
    const episodes = Math.max(1, Math.round(minutes / RADIO_EPISODE_MINUTES));
    return { episodes, reason: `the request asks for about ${minutes} minutes, ${episodes} episode${episodes === 1 ? "" : "s"} of about ${RADIO_EPISODE_MINUTES}` };
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
  const asked = episodeCue(askedFor(workDir));
  if (asked !== undefined) return asked;
  const premise = episodeCue(premiseText(workDir));
  return premise === undefined ? undefined : { ...premise, reason: premise.reason.replace("the request", "the premise") };
}

const NO_NARRATOR = /\b(?:no|without(?: a| any)?|zero)[ -](?:narrator|narration|voice-?over)\b|\bnarrator-?free\b|\bnever (?:a|any) narrator\b/i;
const NO_ANNOUNCER = /\b(?:no|without(?: a| any)?)[ -](?:announcer|host)\b|\bannouncer-?free\b/i;
const NO_MUSIC = /\b(?:no|without(?: any)?)[ -](?:theme |bridge |incidental )?music\b/i;

/** The conventions a text switches off: the tone says "no narrator" and the rules follow. */
export function styleOf(text: string): RadioStyle {
  return { announcer: !NO_ANNOUNCER.test(text), narrator: !NO_NARRATOR.test(text), music: !NO_MUSIC.test(text) };
}

/** The work's radio style: the premise and the request can each switch a convention off; silence keeps the default. */
export function radioStyleOf(workDir: string): RadioStyle {
  const a = styleOf(premiseText(workDir));
  const b = styleOf(askedFor(workDir));
  return { announcer: a.announcer && b.announcer, narrator: a.narrator && b.narrator, music: a.music && b.music };
}

/** `chunks(5, 2)` is `[[1,2,3],[4,5]]`: the beat numbers dealt into `n` contiguous groups, as even as can be. */
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
