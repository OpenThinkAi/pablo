/**
 * `pablo mcp` (AGT-1235) — a stdio MCP server exposing `resume`, `status`,
 * `write`, `save` and `check` as MCP tools, one per `verbs.ts`'s `VERBS`
 * entry, with input schemas generated straight from the same zod shapes
 * `cli.ts` derives its `parseArgs` option table from — see `verbs.ts`'s
 * header for the single-source-of-truth design this implements (AC1).
 *
 * Every tool result is the verb's exact `--json` body (AC3): a framework
 * refusal (`ok:false, code, message, missing[]/tried[]`) comes back as a
 * normal, successful tool result carrying that body — never `isError: true`.
 * Only a genuine crash (something `run` itself throws, not a refusal it
 * returns) becomes `isError: true`.
 *
 * This process must write nothing to stdout but the MCP protocol itself —
 * every log goes to stderr. `verbs.ts`'s `write` verb takes care of the one
 * place a verb still (via `runWrite`, which this file never touches) prints
 * JSON to `console.log`, by capturing that call rather than letting it reach
 * real stdout.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERBS } from "./verbs";
import type { VerbContext } from "./verbs";

const SERVER_NAME = "pablo";
/** Mirrors `packages/cli/package.json`'s `version` — bump both together once pablo is published. */
const SERVER_VERSION = "0.0.0";

/**
 * Builds the `McpServer`, registering one tool per `VERBS` entry. `ctx`
 * defaults to the real process (`process.cwd()`, `process.env`,
 * `process.stderr`) but is overridable so tests can point a spawned server's
 * project resolution at a fixture vault via `PABLO_VAULT` without touching
 * the real environment.
 */
export function buildMcpServer(ctx: VerbContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const verb of VERBS) {
    server.registerTool(
      verb.name,
      {
        title: verb.name,
        description: verb.description,
        inputSchema: verb.args.shape,
      },
      async (args) => {
        try {
          const outcome = await verb.run(args, ctx);
          return { content: [{ type: "text" as const, text: JSON.stringify(outcome.body) }] };
        } catch (error) {
          // A genuine crash (not a refusal `run` returned as data) is the one
          // case that becomes a tool error — AC3 only exempts refusals.
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text" as const, text: message }], isError: true };
        }
      },
    );
  }

  return server;
}

/** `pablo mcp`'s entry point: serve over stdio until the client disconnects. Returns the process exit code (always 0 — a clean disconnect, not an error). */
export async function runMcp(cwd: string = process.cwd()): Promise<number> {
  const ctx: VerbContext = { cwd, env: process.env, stderr: process.stderr };
  const server = buildMcpServer(ctx);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  return new Promise<number>((resolve) => {
    transport.onclose = () => resolve(0);
  });
}
