/**
 * The harness's `record_fact(fact, where, source)` tool (AGT-1558): a fact the
 * harness learned or decided is appended, tagged with its provenance, to a
 * bible file or `continuity.md` on the session's `plan/` branch. The tag
 * (`core/facts.ts`) is what makes the judgement policy checkable. Design: the
 * `ai-terminal` pm doc `harness`.
 *
 * Library only, over `planWrite`; the SDK registration is AGT-1552's. Every
 * refusal is a returned notice and writes nothing (no branch is created).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { formatFactLine, formatProvenance, type Provenance } from "@openthink/pablo-core";
import { insertUnderHeading } from "./markdown";
import { type PlanSession, planWrite } from "./plan";

export const FACT_KINDS = ["researched", "invented", "author"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export interface RecordFactArgs {
  fact: string;
  /** `continuity` (the work's `continuity.md`) or a bible file (`bible/places.md`, or just `places`). */
  where: string;
  kind: string;
  /** Required for `researched` (the citation); ignored otherwise. */
  source?: string;
  /** Optional `## ` heading of the section to file under; absent means the end of the file. */
  heading?: string;
  /** Optional chapter tag, e.g. `ch03`, kept before the provenance tag. */
  chapter?: string;
}

export type RecordFactResult =
  | { ok: true; path: string; line: string; branch: string; sha?: string }
  | { ok: false; notice: string };

const refuse = (why: string): RecordFactResult => ({ ok: false, notice: `pablo: record_fact: ${why}` });

/** The work-relative path `where` names, or a refusal message. Never under `research/`. */
function resolveWhere(where: string): { ok: true; rel: string } | { ok: false; message: string } {
  const w = where.trim().replace(/^\.?\//, "");
  if (w === "continuity" || w === "continuity.md") return { ok: true, rel: "continuity.md" };
  let rel = w.startsWith("bible/") ? w : `bible/${w}`;
  if (!rel.endsWith(".md")) rel += ".md";
  if (rel.split("/").includes("..") || !/^bible\/[A-Za-z0-9._\/-]+$/.test(rel)) {
    return { ok: false, message: `"${where}" is not a bible file or continuity` };
  }
  return { ok: true, rel };
}

function provenanceOf(args: RecordFactArgs): Provenance | string {
  if (args.kind === "invented" || args.kind === "author") return { kind: args.kind };
  if (args.kind !== "researched") return `unknown kind "${args.kind}" (valid kinds: ${FACT_KINDS.join(", ")})`;
  const source = (args.source ?? "").replace(/\s+/g, " ").trim();
  if (source === "") return "a researched fact needs a source (a citation); give one, or record it as invented or author";
  if (/[\[\]]/.test(source)) return "a source cannot contain square brackets";
  return { kind: "researched", source };
}

function currentText(session: PlanSession, workPath: string, rel: string, vaultRel: string): string | undefined {
  if (session.worktree) {
    const p = join(session.worktree, vaultRel);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  try {
    return execFileSync("git", ["-C", session.repo, "show", `main:${vaultRel}`], { encoding: "utf8", stdio: "pipe" });
  } catch {
    const p = join(workPath, rel);
    return existsSync(p) ? readFileSync(p, "utf8") : undefined;
  }
}

/**
 * Appends one tagged fact on the session's plan branch. A `researched` fact
 * without a source, an unknown kind, an empty fact, or a target outside the
 * bible and `continuity.md` (including `research/`) is refused with a message.
 */
export function recordFact(session: PlanSession, workPath: string, args: RecordFactArgs): RecordFactResult {
  const text = args.fact.replace(/\s+/g, " ").trim();
  if (text === "") return refuse("the fact is empty");
  const provenance = provenanceOf(args);
  if (typeof provenance === "string") return refuse(provenance);
  const target = resolveWhere(args.where);
  if (!target.ok) return refuse(target.message);
  const chapter = args.chapter?.trim();
  if (chapter !== undefined && chapter !== "" && !/^ch\d+$/.test(chapter)) return refuse(`chapter tag "${chapter}" is not chNN`);

  const line = formatFactLine({
    text,
    tags: chapter ? [chapter] : [],
    provenance,
    conflicting: false,
  });
  formatProvenance(provenance); // belt and braces: throws on a malformed tag before anything is written

  const vaultRel = `${relative(session.repo, workPath).split("\\").join("/")}/${target.rel}`.replace(/^\//, "");
  const existing = currentText(session, workPath, target.rel, vaultRel);
  if (existing === undefined) return refuse(`${target.rel} does not exist in this work`);

  let lines = existing.split("\n");
  const hadFinalNewline = lines[lines.length - 1] === "";
  if (hadFinalNewline) lines.pop();
  if (args.heading !== undefined && args.heading.trim() !== "") {
    lines = insertUnderHeading(lines, `## ${args.heading.trim().replace(/^#+\s*/, "")}`, line);
  } else {
    lines.push(line);
  }
  const content = lines.join("\n") + "\n";

  const written = planWrite(session, { path: vaultRel, content, message: `record fact: ${text.slice(0, 60)}` });
  if (!written.ok) return written;
  return { ok: true, path: vaultRel, line, branch: session.branch, ...(written.sha ? { sha: written.sha } : {}) };
}
