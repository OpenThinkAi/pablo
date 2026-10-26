/**
 * A fake planner for `pablo story`'s track inference (AGT-2103): answers every
 * `complete` with `answer` and records the prompts it was asked. No model runs.
 */

import type { Adapter, CompletionEvent, CompletionRequest } from "@openthink/pablo-core";

export type FakePlanner = Adapter & { readonly asked: string[] };

export function fakeTrackPlanner(answer: string = '{"track": "fiction", "why": "the request names no historical period or event"}'): FakePlanner {
  const asked: string[] = [];
  const planner = {
    id: "fake-planner",
    model: "fake-planner-model",
    preferredOutput: "text" as const,
    asked,
    async *complete(request: CompletionRequest): AsyncIterable<CompletionEvent> {
      asked.push(request.prompt);
      yield { type: "token", text: answer };
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
