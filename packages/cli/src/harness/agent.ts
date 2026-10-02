/**
 * `pablo agent --project <slug> "<message>"` (AGT-1552): one harness session,
 * headless, its transcript printed as it arrives.
 *
 * CLI-only, never an MCP tool: the agent is what calls pablo's tools, not one
 * of them. With `--json` the transcript is one JSON object at the end
 * (`{ok, route, entries, result}`) instead of lines as they happen.
 *
 * `ask_author` (AGT-1560) is answered from stdin: the question card is printed
 * and one line is read back (a number picks an option).
 *
 * The conversation is saved per work under `.pablo/sessions/` and resumed on the
 * next run (`sessions.ts`); `--new` starts a fresh session and leaves the old one
 * on disk (AGT-1565).
 *
 * Exit codes follow the CLI's contract: 0 when the session ends in a success
 * result, 2 for a refusal (no project, no marker, no message, a policy pablo
 * does not ship), 1 for anything else (an error result, no result at all, or
 * the SDK failing to start).
 */

import { loadConfig } from "@openthink/pablo-core";
import type { KeyLookup, LoadConfigOptions } from "@openthink/pablo-core";
import { readMarker } from "../marker";
import { findVault, resolveProject } from "../project";
import type { ProgressSink, VerbContext } from "../verbs";
import { startPlanSession } from "../plan";
import { lineReader, stdinAskAuthor } from "./ask-author";
import { harnessAuth } from "./auth";
import { planTools } from "./plan-tools";
import type { HarnessAuth } from "./auth";
import { loadPromptWork } from "./prompt";
import { chooseSession } from "./sessions";
import { runHarness, sdkQuery } from "./session";
import { runTagFacts } from "./tag-facts";
import type { TagFactsDeps } from "./tag-facts";
import type { HarnessQuery } from "./session";
import { formatEntry, transcriptEntries } from "./transcript";
import type { TranscriptEntry } from "./transcript";

export interface AgentArgs {
  readonly project: string | undefined;
  readonly message: string | undefined;
  readonly json: boolean;
  /** AGT-1570: tag every untagged fact on a plan branch instead of running a session. */
  readonly tagFacts?: boolean;
  /** `--new` (AGT-1565): start a fresh session instead of resuming the work's current one. */
  readonly new?: boolean;
}

export interface AgentContext {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly stdout: ProgressSink;
  readonly stderr: ProgressSink;
  /** Where `ask_author` answers are read from (AGT-1560); absent, the session has no `ask_author` tool. */
  readonly stdin?: AsyncIterable<string | Uint8Array>;
}

/** Injected in tests: a fake session, and no real Keychain or config file. */
export interface AgentDeps {
  readonly query?: HarnessQuery;
  readonly keys?: Partial<KeyLookup>;
  readonly readConfig?: LoadConfigOptions["readFile"];
  /** `--tag-facts` (AGT-1570): a fake classifier, no real planner call. */
  readonly tagFacts?: TagFactsDeps;
}

function refuse(ctx: AgentContext, json: boolean, code: number, message: string, tried: readonly string[] = []): number {
  if (json) ctx.stdout.write(`${JSON.stringify({ ok: false, code, message, tried })}\n`);
  else ctx.stderr.write(`${message}\n`);
  return code;
}

export async function runAgent(args: AgentArgs, ctx: AgentContext, deps: AgentDeps = {}): Promise<number> {
  if (args.tagFacts === true) return runTagFacts(args.project, ctx, deps.tagFacts);
  if (args.project === undefined) return refuse(ctx, args.json, 2, "pablo: agent requires --project <slug>");
  if (args.message === undefined || args.message.trim() === "") {
    return refuse(ctx, args.json, 2, 'pablo: agent requires a message: pablo agent --project <slug> "<message>"');
  }

  const vault = findVault(ctx.cwd, ctx.env);
  if (!vault.ok) return refuse(ctx, args.json, vault.code, vault.message, vault.tried);
  const project = resolveProject(vault.path, args.project);
  if (!project.ok) return refuse(ctx, args.json, project.code, project.message, project.tried);
  const marker = readMarker(project.path);
  if (!marker.ok) return refuse(ctx, args.json, marker.code, marker.message, marker.tried);
  // The system prompt's inputs: the work's judgement policy and its QWEN.md (AGT-1553).
  const work = loadPromptWork(project.path, marker.marker, args.project);
  if (!work.ok) return refuse(ctx, args.json, work.code, work.message, work.tried);

  let auth: HarnessAuth;
  try {
    const config = loadConfig({ env: ctx.env, readFile: deps.readConfig });
    auth = harnessAuth(config, ctx.env, deps.keys ?? { env: ctx.env });
  } catch (error) {
    return refuse(ctx, args.json, 1, (error as Error).message);
  }

  // pablo's tools run in this process; their progress goes to stderr, never
  // into the transcript on stdout.
  const verbCtx: VerbContext = { cwd: ctx.cwd, env: ctx.env, stderr: ctx.stderr, caller: "mcp" };
  const session = chooseSession(project.path, { fresh: args.new === true });
  const spec = {
    session,
    work: work.work,
    projectPath: project.path,
    auth,
    ctx: verbCtx,
    // The card goes where the transcript goes; with --json stdout is one object, so it goes to stderr.
    ...(ctx.stdin === undefined ? {} : { ask: stdinAskAuthor(lineReader(ctx.stdin), args.json ? ctx.stderr : ctx.stdout) }),
    // One plan branch per session; it exists only once a planning tool writes.
    sessionTools: planTools(startPlanSession(vault.path, args.project, { env: ctx.env }), project.path),
  };

  const entries: TranscriptEntry[] = [];
  let result: Extract<TranscriptEntry, { kind: "result" }> | undefined;
  ctx.stderr.write(`pablo: ${session.resume ? "resuming" : "starting"} session ${session.id}\n`);
  if (!args.json) ctx.stdout.write(`› ${args.message}\n`);
  try {
    for await (const message of runHarness(args.message, spec, deps.query ?? sdkQuery)) {
      for (const entry of transcriptEntries(message)) {
        entries.push(entry);
        if (entry.kind === "result") result = entry;
        if (!args.json) ctx.stdout.write(`${formatEntry(entry)}\n`);
      }
    }
  } catch (error) {
    const hint =
      auth.route === "subscription"
        ? "Run `claude` once to log in, or put an Anthropic key in pablo's config."
        : "Check the Anthropic key in pablo's config.";
    return refuse(ctx, args.json, 1, `pablo: the harness session failed (${(error as Error).message}). ${hint}`);
  }

  const ok = result?.ok === true;
  if (args.json) ctx.stdout.write(`${JSON.stringify({ ok, route: auth.route, session: { id: session.id, resumed: session.resume }, entries, result: result ?? null })}\n`);
  else if (result === undefined) ctx.stderr.write("pablo: the session ended without a result\n");
  return ok ? 0 : 1;
}
