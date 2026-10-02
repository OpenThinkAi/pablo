/**
 * The harness's tool surface (AGT-1552): which tools a session can call.
 *
 * Two parts, and nothing else (`pm project show ai-terminal --doc harness`,
 * "Runtime"): Claude Code's WebSearch and WebFetch, the only built-ins left on
 * (`research` wraps them), and pablo's own MCP tools. There is no shell, no
 * Read/Edit/Write, no Task: every write the harness makes goes through a pablo
 * tool, so every change lands on a branch.
 *
 * pablo's tools are the same `McpToolSpec`s `pablo mcp` serves (`mcpTools()`),
 * attached in-process as an SDK MCP server named `pablo`, so the model sees
 * them as `mcp__pablo__<name>`. A tool ticket (read, search, timeline, ...)
 * adds its spec to `VERBS` in `verbs.ts` and it reaches both Claude Code over
 * `pablo mcp` and the harness here, with no change to this file.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildMcpServer, mcpTools } from "../mcp";
import type { McpToolSpec, VerbContext } from "../verbs";

/** The built-in Claude Code tools the harness keeps. Everything else built in is off. */
export const BUILTIN_TOOLS: readonly string[] = ["WebSearch", "WebFetch"];

/** The SDK MCP server name pablo's tools are attached under. */
export const PABLO_SERVER = "pablo";

/** The name the model calls a pablo tool by: `mcp__pablo__resume`. */
export function harnessToolName(tool: string): string {
  return `mcp__${PABLO_SERVER}__${tool}`;
}

/** pablo's tools as the harness attaches them. Defaults to every tool `pablo mcp` serves. */
export function harnessTools(): readonly McpToolSpec[] {
  return mcpTools();
}

/**
 * The allowed-tool list: the built-ins above, then one `mcp__pablo__*` name per
 * attached tool. With `permissionMode: "dontAsk"` this list is also the deny
 * boundary: anything not on it is refused, never prompted for.
 */
export function allowedTools(tools: readonly McpToolSpec[]): string[] {
  return [...BUILTIN_TOOLS, ...tools.map((tool) => harnessToolName(tool.name))];
}

/** A fresh in-process MCP server over `tools` (an `McpServer` connects to one transport, so one per session). */
export function pabloServer(ctx: VerbContext, tools: readonly McpToolSpec[]): McpServer {
  return buildMcpServer(ctx, tools);
}
