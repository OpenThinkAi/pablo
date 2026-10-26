/**
 * Track inference for `pablo story` (AGT-2103, pm project `pablo-platform`,
 * D-6): without `--track`, a run asks the planner once whether the prompt
 * names a historical period or event. Yes is `historical-fiction`, anything
 * else is `fiction`; `nonfiction` is never inferred (a story is fiction).
 * `--track` always wins and no call is made.
 *
 * The planner is a seam: `inferTrack` takes the `Adapter` it asks, so tests
 * hand it a fake and never reach a model. A planner that cannot be reached,
 * or answers with something unreadable, leaves the run on `fiction` and says
 * so in `why`, never failing the run over a guess.
 */

import type { Adapter } from "@openthink/pablo-core";
import type { TrackId } from "./registry";

/** The track a run is on, and how it got there. */
export interface TrackChoice {
  readonly track: TrackId;
  /** True when the planner chose it from the prompt; false when `--track` named it (or the planner could not answer). */
  readonly inferred: boolean;
  /** One sentence: why this track. */
  readonly why: string;
}

/** The single planner message: the prompt, the two choices, and the JSON shape to answer in. */
export function trackInferencePrompt(prompt: string): string {
  return [
    "Classify a request for a piece of fiction by its track. Answer with JSON only, no prose and no code fence:",
    '{"track": "historical-fiction" | "fiction", "why": "<one short sentence>"}',
    "",
    '"historical-fiction": the request names a historical period (a past year, decade, century or era, e.g. "1900", "the 1920s", "Victorian London") or a real historical event (a war, a disaster, a migration, a named event).',
    '"fiction": anything else, including invented worlds, the present day, the future, and a past that is not named.',
    "",
    "The request:",
    "",
    `> ${prompt.replace(/\n/g, "\n> ")}`,
  ].join("\n");
}

/** The planner's answer as a track and a reason, or undefined when it is not the JSON asked for. */
export function parseTrackAnswer(text: string): { track: TrackId; why: string } | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { track, why } = parsed as { track?: unknown; why?: unknown };
  if (track !== "historical-fiction" && track !== "fiction") return undefined;
  const reason = typeof why === "string" ? why.trim() : "";
  return { track, why: reason === "" ? (track === "fiction" ? "the request names no historical period or event" : "the request names a historical period or event") : reason };
}

/** The track `--track` named: no planner call. */
export function explicitTrack(track: TrackId): TrackChoice {
  return { track, inferred: false, why: "--track" };
}

/** Asks `planner` once which track `prompt` is on; falls back to `fiction`, saying why, when it cannot tell. */
export async function inferTrack(prompt: string, planner: Adapter): Promise<TrackChoice> {
  let text = "";
  try {
    for await (const ev of planner.complete({ prompt: trackInferencePrompt(prompt), maxTokens: 400 })) {
      if (ev.type === "token") text += ev.text;
    }
  } catch (error) {
    return { track: "fiction", inferred: false, why: `the planner could not be asked (${(error as Error).message}); fiction by default` };
  }
  const answer = parseTrackAnswer(text);
  if (answer === undefined) return { track: "fiction", inferred: false, why: "the planner's answer could not be read; fiction by default" };
  return { track: answer.track, inferred: true, why: answer.why };
}
