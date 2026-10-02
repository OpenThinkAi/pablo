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
import { formatFactLine, formatProvenance, parseFactLine, type Provenance, withProvenance } from "@openthink/pablo-core";
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

// ---------------------------------------------------------------------------
// Catch-up tagging (AGT-1570): the same writer, applied to facts already there.
// ---------------------------------------------------------------------------

/** One untagged (or conflictingly tagged) fact, as the tagger sees it: a bullet and its wrapped continuation lines, joined. */
export interface TagTarget {
  /** 0-based index among this file's targets; a proposal names it. */
  readonly index: number;
  /** The `## ` heading above it, if any. */
  readonly heading: string | undefined;
  /** The fact line as a single line. */
  readonly line: string;
}

/** What to tag one target as. A researched one carries its citation. */
export interface TagProposal {
  readonly index: number;
  readonly kind: string;
  readonly source?: string;
}

/** Decides tags for a file's targets; may be a model call. A target it leaves out is defaulted. */
export type TagClassifier = (file: string, targets: readonly TagTarget[]) => Promise<readonly TagProposal[]>;

export type TagFactsResult =
  | { ok: true; path: string; tagged: number; defaulted: number; branch: string; sha?: string }
  | { ok: false; notice: string };

interface Bullet {
  readonly start: number;
  readonly end: number;
  readonly heading: string | undefined;
  readonly line: string;
}

/** Facts needing a tag, with wrapped bullets (indented continuation lines) joined to one line. */
function untaggedBullets(lines: readonly string[]): Bullet[] {
  const found: Bullet[] = [];
  let heading: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i] as string;
    if (/^#{1,6}\s/.test(first)) {
      heading = first.trim();
      continue;
    }
    if (parseFactLine(first) === undefined) continue;
    let end = i;
    while (end + 1 < lines.length) {
      const next = lines[end + 1] as string;
      if (next.trim() === "" || !/^\s/.test(next) || parseFactLine(next) !== undefined) break;
      end++;
    }
    const line = lines
      .slice(i, end + 1)
      .map((l, k) => (k === 0 ? l.trimEnd() : l.trim()))
      .join(" ");
    const fact = parseFactLine(line);
    if (fact !== undefined && fact.provenance === undefined) found.push({ start: i, end, heading, line });
    i = end;
  }
  return found;
}

/**
 * Tags every untagged fact of one bible file or `continuity.md` in a single
 * commit on the plan branch, through the same target rules and provenance
 * validation as `recordFact`. `classify` proposes; a proposal that is missing,
 * of an unknown kind, or `researched` without a source cannot be written as
 * asked and is tagged `author` instead (the author's text, claiming neither
 * research nor invention), counted in `defaulted`. Nothing else in the file
 * changes, except that a wrapped bullet becomes one line. A file with nothing
 * untagged writes nothing.
 */
export async function tagFactsInFile(
  session: PlanSession,
  workPath: string,
  where: string,
  classify: TagClassifier,
): Promise<TagFactsResult> {
  const target = resolveWhere(where);
  if (!target.ok) return { ok: false, notice: `pablo: record_fact: ${target.message}` };
  const vaultRel = `${relative(session.repo, workPath).split("\\").join("/")}/${target.rel}`.replace(/^\//, "");
  const existing = currentText(session, workPath, target.rel, vaultRel);
  if (existing === undefined) return { ok: false, notice: `pablo: record_fact: ${target.rel} does not exist in this work` };

  const lines = existing.split("\n");
  const bullets = untaggedBullets(lines);
  if (bullets.length === 0) return { ok: true, path: vaultRel, tagged: 0, defaulted: 0, branch: session.branch };

  const targets = bullets.map((b, index): TagTarget => ({ index, heading: b.heading, line: b.line }));
  const proposals = new Map((await classify(target.rel, targets)).map((p) => [p.index, p]));

  let defaulted = 0;
  const replacement = new Map<number, string>();
  for (const [index, bullet] of bullets.entries()) {
    const proposal = proposals.get(index);
    let provenance = proposal === undefined ? undefined : provenanceOf({ fact: "", where, kind: proposal.kind, ...(proposal.source === undefined ? {} : { source: proposal.source }) });
    if (typeof provenance === "string" || provenance === undefined) {
      provenance = { kind: "author" };
      defaulted++;
    }
    replacement.set(bullet.start, withProvenance(bullet.line, provenance));
  }

  const out: string[] = [];
  const ends = new Map(bullets.map((b) => [b.start, b.end]));
  for (let i = 0; i < lines.length; i++) {
    const replaced = replacement.get(i);
    if (replaced === undefined) {
      out.push(lines[i] as string);
      continue;
    }
    out.push(replaced);
    i = ends.get(i) as number;
  }

  const written = planWrite(session, { path: vaultRel, content: out.join("\n"), message: `tag facts: ${target.rel}` });
  if (!written.ok) return written;
  return { ok: true, path: vaultRel, tagged: bullets.length, defaulted, branch: session.branch, ...(written.sha ? { sha: written.sha } : {}) };
}
