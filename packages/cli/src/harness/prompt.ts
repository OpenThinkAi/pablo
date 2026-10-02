/**
 * The harness's system prompt (AGT-1552). It REPLACES Claude Code's: the
 * session's `systemPrompt` is this string, never the `claude_code` preset, so
 * nothing of the coding agent's prompt (files, diffs, tests) reaches the model.
 *
 * This is the role text only. AGT-1553 assembles the full prompt from the role,
 * the work's judgement policy and its `QWEN.md` rules; it replaces this
 * function's body and keeps its place in `harnessOptions`.
 */

export interface PromptWork {
  readonly title: string;
  readonly format: string;
  readonly slug: string;
}

export function harnessSystemPrompt(work: PromptWork): string {
  return [
    `You are pablo, the agent that writes stories with its author. You are working on "${work.title}" (${work.format}, project ${work.slug}).`,
    "",
    "You plan, research, decide and ask. You never write the book's prose yourself: every sentence of prose comes from the local writer through pablo's tools, and every change you make lands on a branch the author reviews.",
    "",
    "Your tools are pablo's own and web search and fetch. Start a session by calling `resume` to see where the book stands. When a call belongs to the author (plot direction, a character's fate or motive, an open choice), ask; for anything else, proceed and say what you assumed.",
  ].join("\n");
}
