/**
 * The harness's `propose(stage, content)` tool (AGT-1561): planning output
 * (premise, acts, beats, cast, places) is written on the session's `plan/`
 * branch for Matt to accept in review mode. Design: the `ai-terminal` pm doc
 * `harness`.
 *
 * A proposal is shaped exactly as `pablo save` shapes it (same stage targets,
 * same table validation, same replace-the-table splice in
 * `outline/chapters.md`), so accepting the branch leaves the files the novel
 * stage machine reads. The difference is where it lands: a pathspec commit
 * on the plan branch as pablo, never the vault's working tree. Library only;
 * the SDK registration is AGT-1552's.
 */

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { type PlanSession, planWrite } from "./plan";
import { buildContent, resolveStageTarget } from "./save";

/** The stages `propose` accepts, in the order the novel machine needs them. */
export const PROPOSE_STAGES = ["premise", "acts", "beats", "cast", "places"] as const;
export type ProposeStage = (typeof PROPOSE_STAGES)[number];

export interface ProposeArgs {
  stage: string;
  content: string;
  /** `cast` only: the character's file name stem (`cora` -> `bible/characters/cora.md`). */
  name?: string;
}

export type ProposeResult =
  | { ok: true; stage: ProposeStage; path: string; branch: string; sha?: string }
  | { ok: false; notice: string };

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The vault-relative path (forward slashes) of `workPath`, which sits inside the session's repo. */
function workRel(session: PlanSession, workPath: string): string {
  return relative(session.repo, workPath).split("\\").join("/");
}

/** The file's current text: the plan worktree's copy if this session already wrote it, else `main`'s. */
function existingText(session: PlanSession, workPath: string, rel: string, inWork: string): string {
  if (session.worktree) {
    const p = join(session.worktree, rel);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  try {
    return execFileSync("git", ["-C", session.repo, "show", `main:${rel}`], { encoding: "utf8", stdio: "pipe" });
  } catch {
    // Not on main yet (a fresh template); fall back to the working tree, then empty.
    const p = join(workPath, inWork);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  }
}

/**
 * Writes a planning stage on the session's plan branch. An unknown stage is
 * refused with the valid list; table stages are validated before anything is
 * written; nothing is created on a refusal.
 */
export function propose(session: PlanSession, workPath: string, args: ProposeArgs): ProposeResult {
  const stage = args.stage as ProposeStage;
  if (!PROPOSE_STAGES.includes(stage)) {
    return { ok: false, notice: `pablo: propose: unknown stage "${args.stage}" (valid stages: ${PROPOSE_STAGES.join(", ")})` };
  }

  let saveStage: string;
  if (stage === "cast") {
    if (!args.name || !NAME_PATTERN.test(args.name)) {
      return { ok: false, notice: `pablo: propose: cast needs a name in lowercase-hyphen form (got "${args.name ?? ""}")` };
    }
    saveStage = `bible/characters/${args.name}.md`;
  } else if (stage === "places") {
    saveStage = "bible/places.md";
  } else {
    saveStage = stage;
  }

  const resolved = resolveStageTarget(workPath, saveStage);
  if (!resolved.ok) return { ok: false, notice: resolved.message.replace("pablo: save:", "pablo: propose:") };
  const target = resolved.target;

  const rel = `${workRel(session, workPath)}/${target.relPath}`.replace(/^\//, "");
  const built = buildContent(target, args.content, existingText(session, workPath, rel, target.relPath));
  if (!built.ok) return { ok: false, notice: built.message.replace("pablo: save:", "pablo: propose:") };

  const written = planWrite(session, { path: rel, content: built.content, message: `propose ${stage}${args.name ? `: ${args.name}` : ""}` });
  if (!written.ok) return written;
  return { ok: true, stage, path: rel, branch: session.branch, ...(written.sha ? { sha: written.sha } : {}) };
}
