/**
 * The working title for `pablo story` (AGT-2290, D-22): without `--title`, one planner call on the prompt names the
 * work (a title, never a prompt prefix), and the slug is cut from it. A planner that cannot be asked, or answers
 * with something unreadable, leaves the old prompt-derived working title (`titleFromPrompt`); the run is never failed
 * over a title.
 */

import type { Adapter } from "@openthink/pablo-core";

/** Marks the title call (the track call's prompt never starts with it); tests tell the two planner calls apart by it. */
export const TITLE_PROMPT_LEAD = "Title a piece of fiction.";

/** The single planner message: the request, and the JSON shape to answer in. */
export function titlePrompt(prompt: string): string {
  return [
    `${TITLE_PROMPT_LEAD} Give the story its own short title, two to six words, about the story itself and not the request ("The Last Ferry", not "Write me a story about a ferry"). Answer with JSON only, no prose and no code fence:`,
    '{"title": "<the title>"}',
    "",
    "The request:",
    "",
    `> ${prompt.replace(/\n/g, "\n> ")}`,
  ].join("\n");
}

/** The planner's answer as a title, or undefined when it is not the JSON asked for or reads as a sentence, not a title. */
export function parseTitleAnswer(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const raw = (parsed as { title?: unknown } | null)?.title;
  if (typeof raw !== "string") return undefined;
  const title = raw.replace(/\s+/g, " ").replace(/^["'“”*_#\s]+|["'“”*_.\s]+$/g, "").trim();
  const words = title.split(" ").length;
  return title === "" || words > 10 ? undefined : title;
}

/** Asks `planner` once for a title for `prompt`; undefined when it cannot be asked or answers unreadably. */
export async function planTitle(prompt: string, planner: Adapter): Promise<string | undefined> {
  let text = "";
  try {
    for await (const ev of planner.complete({ prompt: titlePrompt(prompt), maxTokens: 200 })) {
      if (ev.type === "token") text += ev.text;
    }
  } catch {
    return undefined;
  }
  return parseTitleAnswer(text);
}
