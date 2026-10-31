// `r ...` on the screen (AGT-2178): the planning and research verbs (`save`, `research plan|save|waive|link|distill`,
// `fact record`) run from the TUI. Each is the same in-project function the CLI verb and the MCP tool call, so the write
// lands on a `plan/` branch for the author to review, exactly as from the shell. The tui cannot import this package, so
// cli.ts passes `screenPlanner` in through runScreen's options. The id is the key row's (keys.ts `PLANNING_VERBS`).

import { isAbsolute, relative, resolve } from "node:path";
import { addChecklistItem, distillFactsInProject, linkChecklistItem, planChecklist, recordFactInProject, saveResearchInProject, waiveChecklistItem } from "./research-verbs";
import { saveCore } from "./save";
import type { VerbResult } from "./verbs";

export type ScreenPlanResult = { readonly ok: true; readonly lines: readonly string[] } | { readonly ok: false; readonly message: string };
export type ScreenPlanner = (id: string, line: string) => Promise<ScreenPlanResult>;

/** A verb's result as lines: its message, or the scalar fields it returned (`path`, `branch`, ...). */
function resultOf(r: VerbResult): ScreenPlanResult {
  const body = (r.body ?? {}) as Record<string, unknown>;
  if (r.exitCode !== 0 || body.ok === false) return { ok: false, message: typeof body.message === "string" ? body.message : `exit ${r.exitCode}` };
  const lines = Object.entries(body)
    .filter(([k, v]) => k !== "ok" && (typeof v === "string" || typeof v === "number" || (Array.isArray(v) && v.every((x) => typeof x !== "object"))))
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
  return { ok: true, lines: lines.length ? lines : ["done"] };
}

const bad = (message: string): ScreenPlanResult => ({ ok: false, message });
const parts = (line: string): string[] => line.split("|").map((p) => p.trim());

export function screenPlanner(vaultRoot: string, projectPath: string, env: NodeJS.ProcessEnv = process.env): ScreenPlanner {
  return async (id, line) => {
    try {
      switch (id) {
        case "plan.save": {
          const [stage, file] = line.split(/\s+/);
          if (!stage || !file) return bad("Type the stage and the file: <stage> <file>");
          const abs = isAbsolute(file) ? file : resolve(projectPath, file);
          const inside = relative(vaultRoot, abs);
          if (inside.startsWith("..") || isAbsolute(inside)) return bad(`pablo: save file must be inside the vault (${abs})`);
          return resultOf(saveCore({ stage, file: abs }, projectPath));
        }
        case "research.plan": return resultOf(await planChecklist(projectPath, env));
        case "research.distill": return resultOf(await distillFactsInProject(projectPath, env));
        case "research.save": {
          const [title, note, sources, items] = parts(line);
          if (!title || !note || !sources) return bad("Type <title> | <note> | <source> [<source>...] | <item numbers, optional>");
          return resultOf(saveResearchInProject(projectPath, { title, note, sources: sources.split(/\s+/) }, env, items ? items.split(/\s+/) : []));
        }
        case "research.add": {
          const [question, topic] = parts(line);
          if (!question) return bad("Type <question> | <topic, optional>");
          return resultOf(addChecklistItem(projectPath, question, topic || undefined, env));
        }
        case "research.waive": case "research.link": {
          const m = /^(\S+)\s+([\s\S]+)$/.exec(line);
          if (!m) return bad(id === "research.waive" ? "Type the item number and the reason: <#> <reason>" : "Type the item number and the note: <#> <note>");
          return resultOf(id === "research.waive" ? waiveChecklistItem(projectPath, m[1], m[2], env) : linkChecklistItem(projectPath, m[1], m[2], env));
        }
        case "fact.record": {
          const [head, fact, source] = parts(line);
          const [kind, where] = (head ?? "").split(/\s+/);
          if (!kind || !where || !fact) return bad("Type <researched|invented|author> <continuity|bible file> | <fact> | <source, for researched>");
          return resultOf(recordFactInProject(projectPath, { kind, where, fact, ...(source ? { source } : {}) }, env));
        }
        default: return bad(`Unknown planning verb "${id}".`);
      }
    } catch (error) {
      return bad(error instanceof Error ? error.message : String(error));
    }
  };
}
