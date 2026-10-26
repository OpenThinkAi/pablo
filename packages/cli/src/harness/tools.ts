/**
 * The harness's tool surface (AGT-1552): which tools a session can call.
 *
 * pablo's own tools and nothing else (`pm project show ai-terminal --doc
 * harness`, "Runtime"): there is no shell, no file read or write, no subagent;
 * every write the harness makes goes through a pablo tool, so every change
 * lands on a branch. The agent loop (`loop.ts`) offers exactly these, by their
 * plain names.
 *
 * They are the same `McpToolSpec`s `pablo mcp` serves (`mcpTools()`). A tool
 * ticket adds its spec to `VERBS` in `verbs.ts` and it reaches both an outside
 * agent over `pablo mcp` and the harness here, with no change to this file.
 */

import { askAuthorTool } from "./ask-author";
import type { AskAuthor } from "./ask-author";
import { mcpTools } from "../mcp";
import type { McpToolSpec } from "../verbs";

/**
 * pablo's tools as the harness offers them: every tool `pablo mcp` serves,
 * plus `ask_author` (AGT-1560) when the front end can ask the author.
 */
export function harnessTools(ask?: AskAuthor): readonly McpToolSpec[] {
  return ask === undefined ? mcpTools() : [...mcpTools(), askAuthorTool(ask)];
}
