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
 *
 * Except a tool marked `harness: false` (AGT-2143): `init`, `story` and
 * `merge` are the author's acts. An outside agent connected over MCP may take
 * them on the author's word; pablo's own agent is never offered them, so it
 * can neither run the drafting pipeline nor land its own draft.
 */

import { askAuthorTool } from "./ask-author";
import type { AskAuthor } from "./ask-author";
import { mcpTools } from "../mcp";
import type { McpToolSpec } from "../verbs";

/**
 * pablo's tools as the harness offers them: every tool `pablo mcp` serves but
 * the MCP-only ones (`harness: false`), plus `ask_author` (AGT-1560) when the
 * front end can ask the author.
 */
export function harnessTools(ask?: AskAuthor): readonly McpToolSpec[] {
  const tools = mcpTools().filter((tool) => tool.harness !== false);
  return ask === undefined ? tools : [...tools, askAuthorTool(ask)];
}
