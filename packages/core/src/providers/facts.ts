/**
 * The `extract_facts` tool call, normalized into `ExtractedFact`.
 *
 * Both adapters define the same tool with the same argument shape — the
 * writing-lab extraction schema — so the check that turns it into the internal
 * type belongs to neither of them. Model output is untrusted input throughout:
 * a malformed entry is dropped rather than trusted, and an anchor is whatever
 * the model said, never something this verified.
 */

import { ProviderResponseError } from "./errors";
import type { ExtractedFact } from "./types";

export function readFacts(endpoint: string, args: Record<string, unknown>): readonly ExtractedFact[] {
  const facts = args["facts"];
  if (!Array.isArray(facts)) {
    throw new ProviderResponseError(endpoint, "an extract_facts call whose facts are not an array");
  }
  return facts.flatMap((entry): ExtractedFact[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const item = entry as Record<string, unknown>;
    const fact = item["fact"];
    if (typeof fact !== "string" || fact.trim() === "") return [];
    const entities = item["entities"];
    return [
      {
        fact: fact.trim(),
        entities: Array.isArray(entities) ? entities.filter((name): name is string => typeof name === "string") : [],
        storyTime: stringOrUndefined(item["story_time"]),
        certainty: stringOrUndefined(item["certainty"]),
        anchor: stringOrUndefined(item["anchor"]),
      },
    ];
  });
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
