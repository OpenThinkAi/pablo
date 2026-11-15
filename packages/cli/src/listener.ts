/**
 * The `listener` check (AGT-2323, pm project `pablo-platform`): can a radio script be followed by ear? Found
 * dogfooding AGT-2162: anachronism and fact accuracy passed a script whose events were carried only by sound
 * effects, and nobody who did not already know the story could tell what happened.
 *
 * A fresh model on the `check` intent (the planner role, any provider, D-12/D-13) is given only what a listener
 * hears, numbered (`heardLines`): each speaker line with its delivery notes in parentheses removed, and each
 * `[SFX]`/`[BED]` cue reduced to "(a sound)" and `[MUSIC]` to "(music)", their description text never shown. The
 * `CAST:` line, headings and anything else in the file are not heard. It is asked, as a first-time listener, to
 *
 *  1. retell the story,
 *  2. list every point it could not follow, each with the line it points at,
 *  3. list anything repeated, contradictory or that sounds like a restart (a second intro, a recap, a doubled
 *     ending: the manual version caught a doubled ending from stitched drafts this way),
 *  4. give a verdict, `yes`, `mostly` or `no`.
 *
 * Then a second call, which does see the episode's beats (its plan row's, else beat N), compares the retelling to
 * them: each beat the listener missed or got wrong is named with the line that was meant to carry it. The
 * listener never sees the beats, so its retelling is blind.
 *
 * Each confusion, repeat and missed beat is a hit (`rule: "listener"`) on the file line it points at, quoting that
 * line as heard. An episode passes only on a `yes` verdict with no beat missed. A reply that is not the JSON asked
 * for is asked once more with a stricter instruction (as fact accuracy does, AGT-2284); a second unreadable reply,
 * or a model error, stops the run with a notice.
 *
 * `pablo check --output radio` runs it on each scanned episode; `pablo story --output radio` runs it on each
 * episode's draft before casting, and a failed one is redrafted once with the confusions as direction, then left
 * for review (`story.ts`). The model is a seam: `ask` is passed in (tests a fake; real runs `listenerAsk`).
 */

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { CHECK_INTENT, createPlanner, loadConfig } from "@openthink/pablo-core";
import type { Hit } from "./check";
import { readCoreState } from "./core/machine";
import { DATA_RULE, adapterAsk, fence, jsonIn } from "./critique";
import type { Ask } from "./critique";
import { radioBeats } from "./outputs/radio/pack";
// `script.py`'s grammar, through its TS mirror (held to it by the role-names parity fixture), never redeclared.
import { CUE, LINE, frontmatterLines } from "./outputs/radio/script";

export const LISTENER_RULE = "listener";

/** What a listener hit is: a point it could not follow, a repeat or restart, or a beat its retelling misses. */
export type ListenerKind = "confusion" | "repeat" | "missed-beat";

/** The listener's verdict on whether the episode can be followed by ear. */
export type ListenerVerdict = "yes" | "mostly" | "no";

/** One listener hit: `check`'s `Hit`, so it lands in `hits[]` unchanged. */
export interface ListenerHit extends Hit {
  readonly rule: typeof LISTENER_RULE;
  readonly kind: ListenerKind;
  /** The line as the listener heard it (speaker and words, a cue as "(a sound)"). */
  readonly excerpt: string;
  /** The beat the retelling misses (`missed-beat` only). */
  readonly beat?: number;
  /** `confusion: <what>`, `repeat: <what>` or `missed beat N "<title>": <why>`. */
  readonly detail: string;
}

/** What the listener made of one episode. */
export interface ListenerUnit {
  /** The episode file, work-relative. */
  readonly path: string;
  readonly unit?: number;
  readonly verdict: ListenerVerdict;
  /** `yes` and no beat missed. */
  readonly passed: boolean;
  /** The listener's retelling, as a first-time listener. */
  readonly retelling: string;
  readonly hits: readonly ListenerHit[];
}

/** A run over the scanned episodes: each one's result, and why the run stopped short. */
export interface ListenerRun {
  readonly units: readonly ListenerUnit[];
  readonly hits: readonly ListenerHit[];
  /** Episodes left unchecked because the run stopped (no model, a failed call, a reply still unreadable). */
  readonly notRun?: number;
  readonly notice?: string;
}

/** The test-only injection point: set `ask` and every listener check uses it instead of building the planner. No test calls a real model. */
export const listenerModel: { ask?: Ask } = {};

/** One heard line: what the listener hears, and the 1-based file line it is on. */
export interface HeardLine {
  readonly line: number;
  readonly text: string;
}

const PAREN = /\([^)]*\)/g;

/**
 * What a listener hears of a radio script, line by line: speaker lines with their parenthesised delivery notes
 * removed, `[SFX]`/`[BED]` cues as "(a sound)" and `[MUSIC]` as "(music)". The frontmatter, the `CAST:` line,
 * headings and any other line are not heard; a line of only delivery notes is dropped.
 */
export function heardLines(text: string): HeardLine[] {
  const lines = text.split("\n");
  const start = frontmatterLines(lines);
  const out: HeardLine[] = [];
  for (let i = start; i < lines.length; i++) {
    const raw = (lines[i] ?? "").trim().replace(/\*/g, "");
    if (raw === "" || raw.startsWith("#") || raw.toUpperCase().startsWith("CAST:")) continue;
    const cue = CUE.exec(raw);
    if (cue !== null) {
      out.push({ line: i + 1, text: (cue[1] ?? "").toUpperCase() === "MUSIC" ? "(music)" : "(a sound)" });
      continue;
    }
    const spoken = LINE.exec(raw);
    if (spoken === null) continue;
    const words = (spoken[2] ?? "").replace(PAREN, " ").replace(/\s+/g, " ").trim();
    if (words === "") continue;
    out.push({ line: i + 1, text: `${(spoken[1] ?? "").trim()}: ${words}` });
  }
  return out;
}

/** The listener's prompt: the heard lines, numbered, and the four questions. It never carries a beat. */
export function listenerPrompt(label: string, heard: readonly HeardLine[]): string {
  const lines = heard.map((h, i) => `L${i + 1}. ${h.text}`).join("\n");
  return [
    "You are hearing one episode of a radio drama for the first time. You know nothing about the story beyond what you hear. The episode is given below as the lines you hear, in order, numbered L1, L2, ...",
    "Each spoken line is labelled with who speaks only so you can tell the voices apart: you hear a voice, not the label, so you know a character's name only once someone says it aloud. (a sound) is a sound effect or background sound: you hear it but nothing tells you what it is. (music) is music. Nothing else reaches you: no stage directions, no descriptions, no notes on how a line is delivered.",
    "Judge only what a listener can follow by ear. Do not guess what the writer meant.",
    "1. Retell the story of the episode as you understood it, as a first-time listener: who the people are, where they are and what happens.",
    "2. List every point you could not follow: who is speaking or being spoken about, where we are, what just happened, why someone acts as they do. Each one points at the line (its L number) where you got lost.",
    "3. List anything that is repeated, contradicts itself, or sounds like a restart: a second introduction, a recap of what you just heard, an ending that comes twice. Each one points at the line (its L number) where it happens.",
    '4. Give a verdict on whether a listener can follow the episode: "yes", "mostly" or "no".',
    DATA_RULE,
    fence(`radio episode ${label} as heard`, lines),
    'Reply with JSON only: {"retelling": "<your retelling>", "confusions": [{"line": <L number>, "what": "<one short line>"}], "repeats": [{"line": <L number>, "what": "<one short line>"}], "verdict": "yes" | "mostly" | "no"}. Empty lists when there is nothing to report.',
  ].join("\n\n");
}

/** One of the episode's beats, as the comparison is shown it. */
export interface EpisodeBeat {
  readonly n: number;
  readonly title: string;
  readonly beat: string;
}

/** The comparison's prompt: the beats, the listener's retelling and the heard lines. */
export function beatsPrompt(label: string, beats: readonly EpisodeBeat[], retelling: string, heard: readonly HeardLine[]): string {
  const beatList = beats.map((b) => `B${b.n}. ${b.title === "" ? "" : `${b.title}: `}${b.beat}`).join("\n");
  const lines = heard.map((h, i) => `L${i + 1}. ${h.text}`).join("\n");
  return [
    "A radio drama episode was written to tell the beats below. A first-time listener heard only the lines below (spoken lines; (a sound) is a sound effect whose meaning is not explained) and retold what they understood.",
    "Compare the retelling to the beats. Report each beat the retelling misses, or gets wrong in a way that matters to the story, with the line (its L number) that was meant to carry it: the line where the listener should have learned it. A beat the retelling shows the listener understood, even in other words, is not reported.",
    DATA_RULE,
    fence("beats", beatList),
    fence(`radio episode ${label} as heard`, lines),
    fence("the listener's retelling", retelling),
    'Reply with JSON only: {"missed": [{"beat": <B number>, "line": <L number>, "why": "<one short line>"}]}. An empty list when the retelling has every beat.',
  ].join("\n\n");
}

/** Appended to a prompt on the one retry: the reply was not the JSON asked for. */
export const LISTENER_STRICT_RETRY =
  "Your last reply was not valid JSON. Reply with ONLY the JSON object asked for and nothing else: no prose, no explanation, no markdown fences, no thinking.";

/** A reply that is not the JSON asked for: the one failure a stricter retry can fix. */
class UnreadableReply extends Error {
  constructor(what: string) {
    super(`the model's reply was not the ${what} JSON`);
  }
}

/** Model text that reaches a terminal: control characters (escape sequences) stripped, whitespace collapsed. */
const clean = (value: unknown): string => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim() : "");

/** An L number from a reply, `L12` or `12`; `undefined` when it names no shown line. */
function lineNumber(value: unknown, count: number): number | undefined {
  const n = Number(String(value ?? "").replace(/^L/i, ""));
  return Number.isInteger(n) && n >= 1 && n <= count ? n : undefined;
}

interface ListenerReply {
  readonly retelling: string;
  readonly confusions: ReadonlyArray<{ readonly line?: number; readonly what: string }>;
  readonly repeats: ReadonlyArray<{ readonly line?: number; readonly what: string }>;
  readonly verdict: ListenerVerdict;
}

function objectIn(reply: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = jsonIn(reply);
  } catch {
    return undefined;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The listener's reply: a retelling, points with a line (kept without one when it names no shown line) and a verdict. */
export function parseListenerReply(reply: string, count: number): ListenerReply {
  const value = objectIn(reply);
  const verdict = clean(value?.["verdict"]).toLowerCase();
  if (value === undefined || !["yes", "mostly", "no"].includes(verdict)) throw new UnreadableReply("listener");
  const points = (key: string): Array<{ line?: number; what: string }> => {
    const list = value[key];
    if (!Array.isArray(list)) return [];
    const out: Array<{ line?: number; what: string }> = [];
    for (const item of list as unknown[]) {
      const raw = typeof item === "string" ? { what: item } : item !== null && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
      if (raw === undefined) continue;
      const what = clean(raw["what"] ?? raw["why"] ?? raw["point"]);
      if (what === "") continue;
      const line = lineNumber(raw["line"], count);
      out.push({ ...(line !== undefined ? { line } : {}), what });
    }
    return out;
  };
  return { retelling: clean(value["retelling"]), confusions: points("confusions"), repeats: points("repeats"), verdict: verdict as ListenerVerdict };
}

/** The comparison's reply: each missed beat that names a shown beat, with its line when it names a shown one. */
export function parseMissedBeats(reply: string, beats: readonly EpisodeBeat[], count: number): Array<{ beat: number; line?: number; why: string }> {
  const value = objectIn(reply);
  const list = value?.["missed"];
  if (!Array.isArray(list)) throw new UnreadableReply("missed beats");
  const shown = new Set(beats.map((b) => b.n));
  const out: Array<{ beat: number; line?: number; why: string }> = [];
  const seen = new Set<number>();
  for (const item of list as unknown[]) {
    if (item === null || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    const beat = Number(String(raw["beat"] ?? "").replace(/^B/i, ""));
    if (!shown.has(beat) || seen.has(beat)) continue;
    seen.add(beat);
    const line = lineNumber(raw["line"], count);
    out.push({ beat, ...(line !== undefined ? { line } : {}), why: clean(raw["why"]) });
  }
  return out;
}

/** Asks once, and once more with the strict instruction when the reply is unreadable. */
async function askParsed<T>(ask: Ask, prompt: string, parse: (reply: string) => T): Promise<T> {
  try {
    return parse(await ask(prompt));
  } catch (error) {
    if (!(error instanceof UnreadableReply)) throw error;
    return parse(await ask(`${prompt}\n\n${LISTENER_STRICT_RETRY}`));
  }
}

/** The beats an episode tells, from the work's core: its plan row's, else beat N. Rows the outline lacks are left out. */
export function episodeBeats(coreDir: string, unit: number): EpisodeBeat[] {
  const state = readCoreState(coreDir);
  return radioBeats(coreDir, unit).flatMap((n) => {
    const row = state.beats.find((b) => b.chapter === n);
    return row === undefined ? [] : [{ n, title: row.title, beat: row.beat }];
  });
}

/**
 * Listens to one episode (`text` its script, `path` its report label) and compares the retelling to `beats`. No
 * heard lines: a `no` verdict with nothing asked. No beats: only the listener call. Throws when the model fails or a
 * reply is still unreadable after the retry.
 */
export async function listenToEpisode(
  text: string,
  path: string,
  beats: readonly EpisodeBeat[],
  ask: Ask,
  unit?: number,
  progress?: (line: string) => void,
): Promise<ListenerUnit> {
  const heard = heardLines(text);
  const base = { path, ...(unit !== undefined ? { unit } : {}) };
  if (heard.length === 0) {
    const hit: ListenerHit = { path, line: 1, rule: LISTENER_RULE, kind: "confusion", excerpt: "", detail: "confusion: the episode has no line a listener hears" };
    return { ...base, verdict: "no", passed: false, retelling: "", hits: [hit] };
  }
  const listened = await askParsed(ask, listenerPrompt(path, heard), (reply) => parseListenerReply(reply, heard.length));
  if (beats.length > 0) progress?.(`listener: ${path}: comparing the retelling to ${beats.length} beat${beats.length === 1 ? "" : "s"}…`);
  const missed = beats.length === 0 ? [] : await askParsed(ask, beatsPrompt(path, beats, listened.retelling, heard), (reply) => parseMissedBeats(reply, beats, heard.length));

  // A point with no shown line is kept, on the first heard line, so a confusion is never dropped.
  const at = (line: number | undefined): { line: number; excerpt: string; unplaced: boolean } => {
    const h = heard[(line ?? 1) - 1] as HeardLine;
    return { line: h.line, excerpt: h.text, unplaced: line === undefined };
  };
  const hits: ListenerHit[] = [];
  for (const [kind, list] of [["confusion", listened.confusions], ["repeat", listened.repeats]] as const) {
    for (const point of list) {
      const where = at(point.line);
      hits.push({ path, line: where.line, rule: LISTENER_RULE, kind, excerpt: where.excerpt, detail: `${kind}: ${point.what}${where.unplaced ? " (no line given)" : ""}` });
    }
  }
  for (const miss of missed) {
    const where = at(miss.line);
    const beat = beats.find((b) => b.n === miss.beat) as EpisodeBeat;
    const name = beat.title === "" ? "" : ` "${beat.title}"`;
    hits.push({
      path,
      line: where.line,
      rule: LISTENER_RULE,
      kind: "missed-beat",
      excerpt: where.excerpt,
      beat: miss.beat,
      detail: `missed beat ${miss.beat}${name}${miss.why === "" ? "" : `: ${miss.why}`}${where.unplaced ? " (no line given)" : ""}`,
    });
  }
  hits.sort((a, b) => a.line - b.line);
  return { ...base, verdict: listened.verdict, passed: listened.verdict === "yes" && missed.length === 0, retelling: listened.retelling, hits };
}

/** The check model: the planner role under the `check` intent (or the test injection). A message when it cannot be built. */
export function listenerAsk(env: NodeJS.ProcessEnv | Record<string, string | undefined>, projectDir: string): Ask | string {
  if (listenerModel.ask !== undefined) return listenerModel.ask;
  try {
    return adapterAsk(createPlanner(loadConfig({ env, projectDir }), { keys: { env }, intent: CHECK_INTENT }).adapter);
  } catch (error) {
    return (error as Error).message.replace(/^pablo: /, "");
  }
}

/**
 * Direction for the one redraft after a failed listener check: what the listener could not follow, so the next
 * draft carries it in what is said aloud. One line (it goes in the draft's frontmatter), capped.
 */
export function listenerDirection(result: ListenerUnit, max = 1500): string {
  const points = result.hits.map((h) => `${h.detail} (at "${h.excerpt}")`);
  const head = `A first-time listener rated this episode "${result.verdict}" by ear. Carry the story in what is said aloud: a sound effect alone tells a listener nothing, and a name is known only once spoken. Fix each point:`;
  const body = points.length === 0 ? " make who is speaking, where we are and what happens clear from the dialogue and narration." : ` ${points.join("; ")}.`;
  const text = `${head}${body}`.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface ListenerOptions {
  readonly workDir: string;
  /** Where the beats are read when not `workDir`: main's, for a draft branch's worktree. */
  readonly coreDir?: string;
  /** The episode files `check` scanned, absolute. */
  readonly files: readonly string[];
  /** The episode a file is (`OutputDefinition.unitOfPath`). */
  readonly unitOf: (label: string) => number | undefined;
  /** The model seam, built only when an episode needs it: an `Ask`, or a message saying why there is none. */
  readonly ask: () => Ask | string;
  /** Told before each episode, so a long run on a local endpoint is never a silent wait. */
  readonly progress?: (line: string) => void;
}

/** The listener check over the scanned episodes: two model calls each; the first failure stops the run with a notice (results so far kept). */
export async function runListener(opts: ListenerOptions): Promise<ListenerRun> {
  const episodes = opts.files.filter((file) => file.endsWith(".md"));
  const units: ListenerUnit[] = [];
  let notice: string | undefined;
  let ask: Ask | string | undefined;
  for (const [i, file] of episodes.entries()) {
    const label = relative(opts.workDir, file).split("\\").join("/");
    ask ??= opts.ask();
    if (typeof ask === "string") {
      notice = `listener not run: ${ask} (${episodes.length} episode${episodes.length === 1 ? "" : "s"} not run)`;
      break;
    }
    const unit = opts.unitOf(label);
    const beats = unit === undefined ? [] : episodeBeats(opts.coreDir ?? opts.workDir, unit);
    opts.progress?.(`listener: ${label} (${i + 1}/${episodes.length}), asking the check model to follow it by ear…`);
    try {
      units.push(await listenToEpisode(readFileSync(file, "utf8"), label, beats, ask, unit, opts.progress));
    } catch (error) {
      notice = `listener stopped at ${label}: ${(error as Error).message}${error instanceof UnreadableReply ? " (after one retry)" : ""} (${episodes.length - i} episode${episodes.length - i === 1 ? "" : "s"} not run)`;
      break;
    }
  }
  const notRun = notice === undefined ? 0 : episodes.length - units.length;
  return { units, hits: units.flatMap((u) => u.hits), ...(notRun > 0 ? { notRun } : {}), ...(notice !== undefined ? { notice } : {}) };
}

/** The JSON summary `check` reports: each episode's verdict, whether it passed and the retelling, without the hits (they are in `hits[]`). */
export function listenerBody(run: ListenerRun): { units: Array<Omit<ListenerUnit, "hits">>; notRun?: number; notice?: string } {
  return {
    units: run.units.map(({ hits: _hits, ...rest }) => rest),
    ...(run.notRun !== undefined ? { notRun: run.notRun } : {}),
    ...(run.notice !== undefined ? { notice: run.notice } : {}),
  };
}
