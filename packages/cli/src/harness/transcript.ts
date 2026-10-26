/**
 * A harness session's transcript (AGT-1552): what pablo said, which tools it
 * called with what, what came back, and how it ended, printed one entry at a
 * time. The agent loop (`loop.ts`, AGT-2120/2121) emits these entries
 * directly; `formatEntry` renders one as text.
 *
 * The `session` entry opens a session: the model, the tools on offer (plain
 * names, as the model calls them) and `apiKeySource`, the provider's key as
 * the config names it (`none` on a local provider), never the key itself.
 */

export type TranscriptEntry =
  | {
      readonly kind: "session";
      readonly model: string;
      readonly apiKeySource: string;
      readonly tools: readonly string[];
    }
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "tool_call"; readonly id: string; readonly tool: string; readonly input: unknown }
  | { readonly kind: "tool_result"; readonly id: string; readonly text: string; readonly isError: boolean }
  | {
      readonly kind: "result";
      readonly ok: boolean;
      readonly text: string;
      readonly turns: number;
      readonly durationMs: number;
      readonly costUsd: number;
      /** A model the price table does not know, whose reported usage `costUsd` therefore leaves out. */
      readonly unpricedModel?: string;
      readonly errors: readonly string[];
    };

const RESULT_PREVIEW = 400;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > RESULT_PREVIEW ? `${flat.slice(0, RESULT_PREVIEW)}…` : flat;
}

/** One entry as transcript text, without a trailing newline. */
export function formatEntry(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case "session": {
      return [`session: ${entry.model}, credential ${entry.apiKeySource}`, `  tools: ${entry.tools.join(", ")}`].join("\n");
    }
    case "assistant":
      return `pablo: ${entry.text.trim()}`;
    case "tool_call":
      return `  → ${entry.tool} ${JSON.stringify(entry.input)}`;
    case "tool_result":
      return `  ${entry.isError ? "✗" : "←"} ${preview(entry.text)}`;
    case "result": {
      const seconds = (entry.durationMs / 1000).toFixed(1);
      const status = entry.ok ? "done" : "failed";
      const errors = entry.errors.length === 0 ? "" : `\n  ${entry.errors.join("\n  ")}`;
      const cost = `$${entry.costUsd.toFixed(4)}${entry.unpricedModel === undefined ? "" : ` (no price for ${entry.unpricedModel}; its turns are not counted)`}`;
      return `— ${status}: ${entry.turns} turn(s), ${seconds}s, ${cost}${errors}`;
    }
  }
}
