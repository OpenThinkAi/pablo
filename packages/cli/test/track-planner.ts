/**
 * A fake planner for `pablo story`'s track inference (AGT-2103): answers every
 * `complete` with `answer` and records the prompts it was asked. No model runs.
 */

import { TITLE_PROMPT_LEAD } from "../src/story-title";
import type { Adapter, CompletionEvent, CompletionRequest } from "@openthink/pablo-core";

/** `asked` records the track calls; `titled` the title calls (AGT-2290), answered with `titleAnswer` (default: unreadable, so the prompt-derived title stands). */
export type FakePlanner = Adapter & { readonly asked: string[]; readonly titled: string[] };

export function fakeTrackPlanner(answer: string = '{"track": "fiction", "why": "the request names no historical period or event"}', titleAnswer = ""): FakePlanner {
  const asked: string[] = [];
  const titled: string[] = [];
  const planner = {
    id: "fake-planner",
    model: "fake-planner-model",
    preferredOutput: "text" as const,
    asked,
    titled,
    async *complete(request: CompletionRequest): AsyncIterable<CompletionEvent> {
      const isTitle = request.prompt.startsWith(TITLE_PROMPT_LEAD);
      (isTitle ? titled : asked).push(request.prompt);
      yield { type: "token", text: isTitle ? titleAnswer : answer };
      yield { type: "done", stats: { timeToFirstTokenMs: 1, elapsedMs: 1, tokensRead: 10, tokensWritten: 10, tokensPerSecond: 10 } };
    },
    async proposeEdit(): Promise<never> {
      throw new Error("not used");
    },
    async extractFacts(): Promise<never> {
      throw new Error("not used");
    },
  };
  return planner as unknown as FakePlanner;
}
