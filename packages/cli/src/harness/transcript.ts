/**
 * A harness session's transcript (AGT-1552): the SDK's message stream reduced
 * to what a reader needs (what pablo said, which tools it called with what,
 * what came back, how it ended) and printed one entry at a time.
 *
 * Pure: `transcriptEntries` maps one SDK message to zero or more entries and
 * `formatEntry` renders one as text. Message kinds the transcript has no use
 * for (stream deltas, hooks, status) map to nothing.
 *
 * The `session` entry is the init message: the model, the tools the session
 * actually loaded and `apiKeySource` (`none` on the subscription,
 * `ANTHROPIC_API_KEY` on the key route), which is how a manual smoke run shows
 * the allowed tools and the auth route took effect.
 */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { PABLO_SERVER } from "./tools";

export type TranscriptEntry =
  | {
      readonly kind: "session";
      readonly model: string;
      readonly apiKeySource: string;
      readonly tools: readonly string[];
      readonly mcpServers: readonly { readonly name: string; readonly status: string }[];
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
      readonly errors: readonly string[];
    };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** A tool_result's content: a string, or text blocks joined. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isRecord(block) && block["type"] === "text" && typeof block["text"] === "string" ? block["text"] : ""))
    .filter((text) => text !== "")
    .join("\n");
}

export function transcriptEntries(message: SDKMessage): TranscriptEntry[] {
  switch (message.type) {
    case "system":
      if (message.subtype !== "init") return [];
      return [
        {
          kind: "session",
          model: message.model,
          apiKeySource: message.apiKeySource,
          tools: message.tools,
          mcpServers: message.mcp_servers.map(({ name, status }) => ({ name, status })),
        },
      ];
    case "assistant": {
      // Subagent frames do not occur (no Task tool); skip them if they ever do.
      if (message.parent_tool_use_id !== null) return [];
      const entries: TranscriptEntry[] = [];
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim() !== "") entries.push({ kind: "assistant", text: block.text });
        if (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") {
          entries.push({ kind: "tool_call", id: block.id, tool: block.name, input: block.input });
        }
      }
      return entries;
    }
    case "user": {
      const content = message.message.content;
      if (message.parent_tool_use_id !== null || !Array.isArray(content)) return [];
      const entries: TranscriptEntry[] = [];
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        entries.push({ kind: "tool_result", id: block.tool_use_id, text: resultText(block.content), isError: block.is_error === true });
      }
      return entries;
    }
    case "result":
      return [
        {
          kind: "result",
          ok: message.subtype === "success" && !message.is_error,
          text: message.subtype === "success" ? message.result : "",
          turns: message.num_turns,
          durationMs: message.duration_ms,
          costUsd: message.total_cost_usd,
          errors: message.subtype === "success" ? [] : message.errors,
        },
      ];
    default:
      return [];
  }
}

/** `mcp__pablo__resume` reads as `resume`; built-ins keep their names. */
export function displayToolName(tool: string): string {
  const prefix = `mcp__${PABLO_SERVER}__`;
  return tool.startsWith(prefix) ? tool.slice(prefix.length) : tool;
}

const RESULT_PREVIEW = 400;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > RESULT_PREVIEW ? `${flat.slice(0, RESULT_PREVIEW)}…` : flat;
}

/** One entry as transcript text, without a trailing newline. */
export function formatEntry(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case "session": {
      const servers = entry.mcpServers.map((server) => `${server.name} (${server.status})`).join(", ");
      return [
        `session: ${entry.model}, credential ${entry.apiKeySource}`,
        `  tools: ${entry.tools.join(", ")}`,
        `  mcp: ${servers === "" ? "none" : servers}`,
      ].join("\n");
    }
    case "assistant":
      return `pablo: ${entry.text.trim()}`;
    case "tool_call":
      return `  → ${displayToolName(entry.tool)} ${JSON.stringify(entry.input)}`;
    case "tool_result":
      return `  ${entry.isError ? "✗" : "←"} ${preview(entry.text)}`;
    case "result": {
      const seconds = (entry.durationMs / 1000).toFixed(1);
      const status = entry.ok ? "done" : "failed";
      const errors = entry.errors.length === 0 ? "" : `\n  ${entry.errors.join("\n  ")}`;
      return `— ${status}: ${entry.turns} turn(s), ${seconds}s, $${entry.costUsd.toFixed(4)}${errors}`;
    }
  }
}
