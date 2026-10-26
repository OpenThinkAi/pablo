/**
 * `pablo mcp` (AGT-1235) — a stdio MCP server exposing `VERBS`' MCP surface
 * (`mcpTools()`) as MCP tools, with input schemas generated straight from the
 * same zod shapes `cli.ts` derives its `parseArgs` option table from — see
 * `verbs.ts`'s header for the single-source-of-truth design this implements
 * (AC1). The tool list is whatever `VERBS` offers; this file hardcodes none.
 *
 * Each `VERBS` entry contributes `verb.mcpTools ?? [verb]`: most verbs
 * register themselves, one tool each; a verb that sets `mcpTools` (e.g.
 * `voice`, AGT-1245, with its narrow `voice_*` tools) contributes those
 * instead, and a CLI-only verb (`mcpTools: []`) contributes none. This file never branches on
 * verb *names* to do that — it just reads whichever tool list each entry
 * offers.
 *
 * Every tool result is the exact `--json` body its own `run` returns (AC3): a
 * framework refusal (`ok:false, code, message, missing[]/tried[]`) comes back
 * as a normal, successful tool result carrying that body — never
 * `isError: true`. Only a genuine crash (something `run` itself throws, not a
 * refusal it returns) becomes `isError: true`.
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
import { VERSION } from "./version";
import type { McpToolSpec, VerbContext } from "./verbs";

const SERVER_NAME = "pablo";
const SERVER_VERSION = VERSION;

/**
 * Sent to every MCP client at initialize (AGT-1873): how an outside agent is
 * meant to drive pablo, so it works the way pablo's own harness does without
 * having read the docs. The same rules, for people, are docs/agents.md's "How
 * to drive it"; the harness's own role text is `harness/prompt.ts`.
 */
export const MCP_INSTRUCTIONS = [
  "pablo manages a writing project (a novel, story, screenplay, radio drama or essay) in the author's vault. You plan with the author; pablo writes the prose.",
  "",
  "- Call `guide` first. With no arguments it lists the tracks and outputs; with `track` and `output` it returns the step-by-step path from creating the work to publishing it, as pablo commands (the tool is the verb's name, or its narrow form: `research save` is `save_research`, `research plan` is `plan_research`).",
  "- Then start every session on a work with `resume` (pass `project`, the work's slug). It returns where the work stands and `next`.",
  "- Never write the book's prose yourself. Every sentence of prose comes from `write` (or `revise` with `branch`), which send one prompt to the author's configured writer model. Do not put prose into `save`.",
  "- Save planning through pablo: when you and the author agree on a premise, acts, beats or a bible file, call `save` so it lands where the framework reads it and is committed.",
  "- A result of `{ok: false, missing: [...]}` is a direction, not an error: it names what the plan still needs. Steer the author there; do not work around it.",
  "- Every manuscript change lands on a branch (`draft/`, `revise/`, `plan/`). Tell the author what is waiting; they accept it themselves (`pablo merge`, or the screen). There is deliberately no merge tool.",
  "- Ask the author about their calls (plot direction, a character's fate or motive, any open `[pick]`); proceed with a stated assumption on everything else, and batch questions.",
  "- When you record a fact, say whether it was researched (with the source), invented, or decided by the author.",
].join("\n");

/**
 * Every tool `pablo mcp` serves, flattened from `verb.mcpTools ?? [verb]`. The
 * harness (AGT-1552, `harness/tools.ts`) reads the same list, so a tool added
 * to `VERBS` reaches Claude Code and pablo's own agent at once.
 */
export function mcpTools(): readonly McpToolSpec[] {
  return VERBS.flatMap((verb): readonly McpToolSpec[] => verb.mcpTools ?? [verb]);
}

/**
 * Builds the `McpServer`, registering `verb.mcpTools ?? [verb]` for every
 * `VERBS` entry (AGT-1245 — see the file header). `ctx` defaults to the real
 * process (`process.cwd()`, `process.env`, `process.stderr`) but is
 * overridable so tests can point a spawned server's project resolution at a
 * fixture vault via `PABLO_VAULT` without touching the real environment.
 *
 * `tools` defaults to `mcpTools()`; the harness (AGT-1552) passes its own
 * list, built from the same specs.
 */
export function buildMcpServer(ctx: VerbContext, tools: readonly McpToolSpec[] = mcpTools()): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: MCP_INSTRUCTIONS });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.name,
        description: tool.description,
        inputSchema: tool.args.shape,
      },
      async (args) => {
        try {
          const outcome = await tool.run(args, ctx);
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
  // `caller: "mcp"` (AGT-1261) is read only by `review`'s `run` today, to pick
  // `decide`'s `by` field — every other verb ignores `VerbContext.caller`.
  const ctx: VerbContext = { cwd, env: process.env, stderr: process.stderr, caller: "mcp" };
  const server = buildMcpServer(ctx);
  const transport = new StdioServerTransport();

  await server.connect(transport);

  return new Promise<number>((resolve) => {
    transport.onclose = () => resolve(0);
  });
}
