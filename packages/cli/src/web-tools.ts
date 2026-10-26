/**
 * `web_search` and `web_fetch` as agent tools (AGT-2126, D-11): pablo's own web research, replacing the Claude Agent
 * SDK's built-in WebSearch/WebFetch. They are plain `McpToolSpec`s, served by `pablo mcp` and offered to the harness's
 * agent loop through the `web` entry in `VERBS` (`mcpTools`). The core does the work (`webSearch`, `webFetch`: SSRF
 * guard, byte cap, timeout, the configured backend); this module only turns a result or an error into a tool body.
 * Tests inject the network seams through `VerbContext.web`, so nothing here reaches a real server.
 */

import { z } from "zod";
import { loadConfig, ProviderConfigError, webFetch, WebFetchError, webSearch, WebSearchError } from "@openthink/pablo-core";
import type { WebFetchOptions, WebSearchOptions } from "@openthink/pablo-core";
import type { McpToolSpec, VerbContext, VerbResult } from "./verbs";

/** Network seams a test injects; absent in production. */
export interface WebSeams {
  readonly search?: WebSearchOptions;
  readonly fetch?: WebFetchOptions;
}

const REFUSED = 2;
const FAILED = 1;

/** Fetch errors the caller can fix by changing the request (a bad URL, a blocked address) are refusals; the rest are failures. */
const REFUSAL_CODES: ReadonlySet<string> = new Set(["bad-url", "bad-scheme", "blocked-host", "unsupported-type"]);

const SEARCH_ARGS = z.object({
  query: z.string().describe("What to look for on the web."),
  limit: z.number().int().positive().max(25).optional().describe("Most results to return (default 10)."),
});

export const WEB_SEARCH_TOOL: McpToolSpec = {
  name: "web_search",
  description:
    "Search the web through pablo's configured search backend. Returns ranked {title, url, snippet} results; read a promising one with `web_fetch`. A snippet is a pointer, not a source you have read: fetch the page before you cite it. Fails with a clear message when no backend is configured.",
  args: SEARCH_ARGS,
  run: async (raw, ctx) => {
    const args = SEARCH_ARGS.parse(raw);
    const seams = ctx.web?.search;
    try {
      const options: WebSearchOptions = {
        ...(seams ?? {}),
        ...(seams?.backend === undefined && seams?.config === undefined ? { config: loadConfig({ env: ctx.env }).web } : {}),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      };
      const results = await webSearch(args.query, options);
      return { body: { ok: true, query: args.query, results }, exitCode: 0 };
    } catch (error) {
      if (error instanceof WebSearchError || error instanceof ProviderConfigError) return failure(error.message, FAILED);
      throw error;
    }
  },
};

const FETCH_ARGS = z.object({
  url: z.string().describe("An http(s) URL to read."),
});

export const WEB_FETCH_TOOL: McpToolSpec = {
  name: "web_fetch",
  description:
    "Fetch one web page (http or https only; private and local addresses are refused) and return it as markdown with its title, final URL and retrieval date. Use the returned url and retrievedAt as the source when you save what you learned with `save_research`. When `truncated` is true the markdown ends with a truncation marker line: leave it out of anything you save.",
  args: FETCH_ARGS,
  run: async (raw, ctx) => {
    const args = FETCH_ARGS.parse(raw);
    try {
      const result = await webFetch(args.url, ctx.web?.fetch ?? {});
      return { body: { ok: true, ...result }, exitCode: 0 };
    } catch (error) {
      if (error instanceof WebFetchError) return failure(error.message, REFUSAL_CODES.has(error.code) ? REFUSED : FAILED);
      throw error;
    }
  },
};

function failure(message: string, code: number): VerbResult {
  return { body: { ok: false, code, message }, exitCode: code };
}

/** The `web` entry's own `run`: the tools are agent-facing only, so the CLI verb says where to find them. */
export async function runWebVerb(_args: unknown, _ctx: VerbContext): Promise<VerbResult> {
  return failure("pablo: web_search and web_fetch are agent tools (pablo agent, pablo mcp); there is no `pablo web` command", REFUSED);
}
