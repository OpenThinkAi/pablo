/**
 * The harness's `ask_author(question, options?, why)` tool (AGT-1560): when a
 * call is the author's (plot direction, a character's fate, an open `[pick]`,
 * which of two sources to follow), the loop stops here until an answer comes
 * back. Design: the `ai-terminal` pm doc `harness`, "The judgement policy".
 *
 * The tool is built around an `AskAuthor` function the front end supplies, so
 * it is not a `VERBS` entry (`pablo mcp` has nobody to ask): the compose view
 * (AGT-1566) passes one that shows a question card and resolves on the answer;
 * headless `pablo agent` passes `stdinAskAuthor`, which prints the card and
 * reads one line from stdin. A session with no `AskAuthor` simply has no
 * `ask_author` tool, so the model is never offered a question nobody can
 * answer. The SDK's tool call is the block: it returns only when the promise
 * does, so the session resumes with the answer as the tool's result.
 *
 * Recording the answer is the model's next step, not this tool's: the result
 * tells it to file the answer with `record_fact` (kind `author`) or note the
 * decision, so the write still goes through a pablo tool onto a branch.
 */

import { z } from "zod";
import type { McpToolSpec, ProgressSink } from "../verbs";

export interface AuthorQuestion {
  readonly question: string;
  /** Suggested answers; the author may answer outside them. */
  readonly options: readonly string[];
  /** Why this is the author's call, shown on the card. */
  readonly why: string;
}

/** Delivers a question to whatever front end runs the session; resolves with the author's answer. Rejects when none can come. */
export type AskAuthor = (question: AuthorQuestion) => Promise<string>;

const ARGS = z.object({
  question: z.string().describe("The question, in one or two sentences, self-contained."),
  options: z
    .array(z.string())
    .optional()
    .describe("Short candidate answers, when the call has a few natural ones. The author may answer in their own words."),
  why: z.string().describe("Why this is the author's call and not yours to make or assume."),
});

const NEXT =
  "Record the answer: a fact with record_fact (kind author), or a decision in the work's rules. Then continue.";

export const ASK_AUTHOR_TOOL = "ask_author";

export function askAuthorTool(ask: AskAuthor): McpToolSpec {
  return {
    name: ASK_AUTHOR_TOOL,
    description:
      "Stop and ask the author when the call is theirs: plot direction, a character's fate or motive, an open [pick], which of two conflicting sources to follow, anything that would contradict an author fact. Blocks until they answer and returns the answer. Batch questions; do not interrupt for small things, assume and say so instead.",
    args: ARGS,
    async run(raw) {
      const args = ARGS.parse(raw);
      const question = args.question.trim();
      if (question === "") return { body: { ok: false, code: 2, message: "pablo: ask_author: the question is empty" }, exitCode: 2 };
      let answer: string;
      try {
        answer = await ask({ question, options: args.options ?? [], why: args.why.trim() });
      } catch (error) {
        const message = `pablo: ask_author: no answer came (${error instanceof Error ? error.message : String(error)}). Proceed with a stated assumption, or stop and say what you need.`;
        return { body: { ok: false, code: 1, message }, exitCode: 1 };
      }
      return { body: { ok: true, answer: answer.trim(), next: NEXT }, exitCode: 0 };
    },
  };
}

/** The question card as plain lines: what `pablo agent` prints before it reads. */
export function formatQuestionCard(q: AuthorQuestion): string {
  const lines = [`? ${q.question}`, `  why: ${q.why}`];
  q.options.forEach((option, i) => lines.push(`  ${i + 1}. ${option}`));
  lines.push(q.options.length > 0 ? "  answer (a number picks an option, or type your own):" : "  answer:");
  return lines.join("\n");
}

/** One line at a time from a stream of text chunks; `undefined` once it ends. */
export function lineReader(stream: AsyncIterable<string | Uint8Array>): () => Promise<string | undefined> {
  const iterator = stream[Symbol.asyncIterator]();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  return async () => {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        return line.replace(/\r$/, "");
      }
      if (ended) {
        if (buffer === "") return undefined;
        const rest = buffer;
        buffer = "";
        return rest;
      }
      const next = await iterator.next();
      if (next.done) ended = true;
      else buffer += typeof next.value === "string" ? next.value : decoder.decode(next.value, { stream: true });
    }
  };
}

/**
 * Headless `AskAuthor`: prints the card to `out`, reads one non-empty line from
 * `readLine`, and returns it (a number within the options picks that option).
 * End of input rejects: nobody is there to answer.
 */
export function stdinAskAuthor(readLine: () => Promise<string | undefined>, out: ProgressSink): AskAuthor {
  return async (q) => {
    out.write(`${formatQuestionCard(q)}\n`);
    for (;;) {
      const line = await readLine();
      if (line === undefined) throw new Error("stdin closed before an answer");
      const answer = line.trim();
      if (answer === "") continue;
      const index = /^\d+$/.test(answer) ? Number(answer) : 0;
      return index >= 1 && index <= q.options.length ? q.options[index - 1]! : answer;
    }
  };
}
