/**
 * `pablo agent --project <slug> --tag-facts` (AGT-1570): the one-time catch-up
 * for a bible that predates provenance tags. Every untagged fact in the bible
 * and `continuity.md` gets a proposed `researched` / `invented` / `author` tag
 * (`core/facts.ts`), written to one `plan/` branch through `record-fact.ts`'s
 * writer, one commit per file. Matt accepts the branch in review mode.
 *
 * It reads `bible/**` and `continuity.md` and writes only those. Chapters are
 * never read or written, and nothing goes under `research/`; the notes there
 * are read only to ground the classifier (Claude, the planner role, never the
 * local writer), the same narrowing the harness doc makes.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createPlanner, loadConfig } from "@openthink/pablo-core";
import type { Adapter, KeyLookup, LoadConfigOptions } from "@openthink/pablo-core";
import { readMarker } from "../marker";
import { startPlanSession } from "../plan";
import type { PlanSession } from "../plan";
import { findVault, resolveProject } from "../project";
import { FACT_KINDS, tagFactsInFile } from "../record-fact";
import type { TagClassifier, TagProposal, TagTarget } from "../record-fact";
import type { ProgressSink } from "../verbs";

export interface TagFactsContext {
  readonly cwd: string;
  readonly env: Record<string, string | undefined>;
  readonly stdout: ProgressSink;
  readonly stderr: ProgressSink;
}

/** Injected in tests: a fake classifier or adapter, no real Keychain or config. */
export interface TagFactsDeps {
  readonly classify?: TagClassifier;
  readonly adapter?: Adapter;
  readonly keys?: Partial<KeyLookup>;
  readonly readConfig?: LoadConfigOptions["readFile"];
  readonly session?: PlanSession;
}

/** The files whose facts get tagged: `continuity.md` and every `.md` under `bible/`, as `where` values. */
export function factFiles(workPath: string): string[] {
  const out: string[] = [];
  if (existsSync(join(workPath, "continuity.md"))) out.push("continuity");
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".md") && !name.startsWith("_")) out.push(relative(workPath, full).split("\\").join("/"));
    }
  };
  walk(join(workPath, "bible"));
  return out;
}

function researchNotes(workPath: string): string {
  const dir = join(workPath, "research");
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => `### research/${n}\n${readFileSync(join(dir, n), "utf8")}`)
    .join("\n\n");
}

const INSTRUCTIONS = `You classify the facts of a novel's story bible by provenance, one tag per fact:
- researched: a public, checkable fact about the real world (period technology, law, prices, a historical event). Give "source": the citation, from the research notes below. If no note supports it, it is not researched.
- invented: the invented people, places, rooms, history and details of the fiction.
- author: a decision or premise the author made (plot direction, a character's fate or motive, a rule of the work), or an open question left for the author.
Answer with ONLY a JSON array: [{"index": 0, "kind": "invented"}, {"index": 1, "kind": "researched", "source": "..."}], one object per fact.`;

function promptFor(file: string, targets: readonly TagTarget[], research: string): string {
  const facts = targets.map((t) => `${t.index}. ${t.heading ? `(${t.heading.replace(/^#+\s*/, "")}) ` : ""}${t.line.replace(/^\s*[-*]\s+/, "")}`);
  return [INSTRUCTIONS, research === "" ? "No research notes exist for this work." : `Research notes:\n${research}`, `Facts in ${file}:`, ...facts].join("\n\n");
}

/** Parses the model's answer; anything unusable yields no proposal, and the writer defaults it. */
export function parseProposals(text: string): TagProposal[] {
  const body = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end < start) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: TagProposal[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { index, kind, source } = item as Record<string, unknown>;
    if (typeof index !== "number" || typeof kind !== "string") continue;
    out.push({ index, kind, ...(typeof source === "string" ? { source } : {}) });
  }
  return out;
}

/** A classifier over a planner adapter; one `complete` call per file. */
export function adapterClassifier(adapter: Adapter, research: string): TagClassifier {
  return async (file, targets) => {
    let text = "";
    for await (const event of adapter.complete({ prompt: promptFor(file, targets, research) })) {
      if (event.type === "token") text += event.text;
    }
    return parseProposals(text);
  };
}

function refuse(ctx: TagFactsContext, code: number, message: string): number {
  ctx.stderr.write(`${message}\n`);
  return code;
}

export async function runTagFacts(project: string | undefined, ctx: TagFactsContext, deps: TagFactsDeps = {}): Promise<number> {
  if (project === undefined) return refuse(ctx, 2, "pablo: agent --tag-facts requires --project <slug>");
  const vault = findVault(ctx.cwd, ctx.env);
  if (!vault.ok) return refuse(ctx, vault.code, vault.message);
  const found = resolveProject(vault.path, project);
  if (!found.ok) return refuse(ctx, found.code, found.message);
  const marker = readMarker(found.path);
  if (!marker.ok) return refuse(ctx, marker.code, marker.message);

  let classify = deps.classify;
  if (classify === undefined) {
    let adapter = deps.adapter;
    try {
      adapter ??= createPlanner(loadConfig({ env: ctx.env, readFile: deps.readConfig }), { keys: deps.keys ?? { env: ctx.env }, claude: { env: ctx.env } }).adapter;
    } catch (error) {
      return refuse(ctx, 1, (error as Error).message);
    }
    classify = adapterClassifier(adapter, researchNotes(found.path));
  }

  const session = deps.session ?? startPlanSession(vault.path, project, { env: ctx.env });
  let tagged = 0;
  let defaulted = 0;
  for (const where of factFiles(found.path)) {
    let result;
    try {
      result = await tagFactsInFile(session, found.path, where, classify);
    } catch (error) {
      return refuse(ctx, 1, `pablo: tag-facts: ${(error as Error).message}`);
    }
    if (!result.ok) return refuse(ctx, 1, result.notice);
    if (result.tagged > 0) ctx.stdout.write(`tagged ${result.tagged} in ${result.path}${result.defaulted > 0 ? ` (${result.defaulted} defaulted to author)` : ""}\n`);
    tagged += result.tagged;
    defaulted += result.defaulted;
  }
  if (tagged === 0) {
    ctx.stdout.write("every fact is already tagged; nothing written\n");
    return 0;
  }
  ctx.stdout.write(`${tagged} facts tagged on ${session.branch} (kinds: ${FACT_KINDS.join(", ")}); ${defaulted} defaulted to author. Review the branch in review mode.\n`);
  return 0;
}
