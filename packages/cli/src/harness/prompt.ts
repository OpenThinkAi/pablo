/**
 * The harness's system prompt (AGT-1552, assembled by AGT-1553). It REPLACES
 * Claude Code's: the session's `systemPrompt` is this string, never the
 * `claude_code` preset, so nothing of the coding agent's prompt (files, diffs,
 * tests) reaches the model.
 *
 * Three parts, in order (`pm project show ai-terminal --doc harness`, "The
 * judgement policy" and "Runtime"):
 *
 *   1. pablo's role: what it is, that Claude directs and the local writer
 *      writes, and that every change lands on a branch.
 *   2. The judgement policy: when to research, invent, ask or proceed. Named
 *      by `pablo.json`'s `policy` and shipped as `packages/cli/policies/<name>.md`;
 *      a minimal default when the work names none.
 *   3. The work's rules: its `QWEN.md`, minus any `<!-- writer-only -->`
 *      section (text meant for the writer's pack alone).
 *
 * `harnessSystemPrompt` is pure: it takes the texts, not paths. `loadPromptWork`
 * is the only part that reads disk, and it refuses a policy name pablo does
 * not ship rather than silently falling back to the default.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Marker } from "../marker";
import type { Refusal } from "../project";

/** The judgement policy, by name, as loaded from `policies/`. */
export interface PromptPolicy {
  readonly name: string;
  readonly text: string;
}

export interface PromptWork {
  readonly title: string;
  readonly format: string;
  readonly slug: string;
  /** The work's judgement policy; absent means `DEFAULT_POLICY`. */
  readonly policy?: PromptPolicy;
  /** The work's `QWEN.md` as written (writer-only sections are stripped here); absent when it has none. */
  readonly rules?: string;
}

/** Where pablo's shipped judgement policies live (`packages/cli/policies/`). */
export const POLICIES_DIR = fileURLToPath(new URL("../../policies/", import.meta.url));

/** The policy for a work whose `pablo.json` names none: the judgement every format shares. */
export const DEFAULT_POLICY: PromptPolicy = {
  name: "default",
  text: [
    "- Ask the author when the call is theirs: plot direction, a character's fate or motive, an open `[pick]`, or anything that would contradict a decision in the work's rules.",
    "- Proceed with a stated assumption for everything else, and say what you assumed. Batch questions where you can; do not interrupt the author for small things.",
    "- When you record a fact, tag where it came from: `researched` (with its source), `invented`, or `author`.",
  ].join("\n"),
};

const WRITER_ONLY_OPEN = /<!--\s*writer-only\s*-->/;
const WRITER_ONLY_CLOSE = /<!--\s*\/writer-only\s*-->/;

/**
 * The work's rules without the parts meant for the writer alone. A section
 * fenced `<!-- writer-only -->` … `<!-- /writer-only -->` is dropped, fences
 * included; an unclosed fence drops to the end of the file, so a missing
 * close never leaks writer-only text into the harness.
 */
export function stripWriterOnly(rules: string): string {
  let rest = rules;
  let kept = "";
  for (;;) {
    const open = WRITER_ONLY_OPEN.exec(rest);
    if (open === null) return (kept + rest).replace(/\n{3,}/g, "\n\n").trim();
    kept += rest.slice(0, open.index);
    rest = rest.slice(open.index + open[0].length);
    const close = WRITER_ONLY_CLOSE.exec(rest);
    if (close === null) return kept.replace(/\n{3,}/g, "\n\n").trim();
    rest = rest.slice(close.index + close[0].length);
  }
}

function role(work: PromptWork): string {
  return [
    `You are pablo, the agent that writes stories with its author. You are working on "${work.title}" (${work.format}, project ${work.slug}).`,
    "",
    "You plan, research, decide and ask. You never write the book's prose yourself: every sentence of prose comes from the local writer through pablo's tools, and every change you make lands on a branch the author reviews.",
    "",
    "Your tools are pablo's own and web search and fetch. Start a session by calling `resume` to see where the book stands. The judgement policy below says when to research, invent, ask or proceed; the work's rules below are the author's, and they bind you as they bind the writer.",
  ].join("\n");
}

/** The whole system prompt: role, then the judgement policy, then the work's rules. Pure. */
export function harnessSystemPrompt(work: PromptWork): string {
  const policy = work.policy ?? DEFAULT_POLICY;
  const parts = [role(work), "", `<judgement_policy name="${policy.name}">`, policy.text.trim(), "</judgement_policy>"];
  const rules = work.rules === undefined ? "" : stripWriterOnly(work.rules);
  if (rules !== "") parts.push("", '<work_rules source="QWEN.md">', rules, "</work_rules>");
  return parts.join("\n");
}

/**
 * Reads what the prompt needs for one work: the policy its marker names (or
 * none, for the default) and its `QWEN.md` (or none). A policy name pablo does
 * not ship is a refusal naming the ones it does.
 */
export function loadPromptWork(
  projectPath: string,
  marker: Marker,
  slug: string,
  policiesDir: string = POLICIES_DIR,
): { ok: true; work: PromptWork } | Refusal {
  let policy: PromptPolicy | undefined;
  if (marker.policy !== undefined) {
    const path = join(policiesDir, `${marker.policy}.md`);
    if (!existsSync(path)) {
      return {
        ok: false,
        code: 2,
        message: `pablo: ${join(projectPath, "pablo.json")} names policy "${marker.policy}", which pablo does not ship (shipped: ${shippedPolicies(policiesDir).join(", ") || "none"})`,
        tried: [path],
      };
    }
    policy = { name: marker.policy, text: readFileSync(path, "utf8") };
  }
  const rulesPath = join(projectPath, "QWEN.md");
  const rules = existsSync(rulesPath) ? readFileSync(rulesPath, "utf8") : undefined;
  return {
    ok: true,
    work: {
      title: marker.title,
      format: marker.format,
      slug,
      ...(policy === undefined ? {} : { policy }),
      ...(rules === undefined ? {} : { rules }),
    },
  };
}

function shippedPolicies(policiesDir: string): string[] {
  try {
    return readdirSync(policiesDir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}
