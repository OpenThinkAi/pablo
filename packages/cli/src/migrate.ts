/**
 * `pablo migrate lines` (AGT-1533): the one-time split of a project's existing
 * chapters into one sentence per line, committed on its own so every later
 * diff is clean. Design: the `ai-terminal` pm doc `screen`, "The manuscript in
 * git" ("Migration"). Splitting is core's `splitSentences`; this file only
 * decides which text is prose, rewrites chapter files, and commits them.
 *
 * Only `chapters/*.md` is touched, and only the body: frontmatter is copied
 * byte for byte. Idempotent — a chapter already one-sentence-per-line splits
 * to itself, so a second run changes nothing and commits nothing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { splitSentences } from "@openthink/pablo-core";
import { gitCommit } from "./init";

export const MIGRATE_COMMIT_MESSAGE = "migrate: one sentence per line";

export type MigrateResult =
  | {
      readonly ok: true;
      readonly dryRun: boolean;
      /** Project-relative paths of the chapters that changed (or, dry-run, would change). */
      readonly changed: readonly string[];
      readonly committed: boolean;
      readonly notice?: string;
    }
  | { readonly ok: false; readonly code: 2; readonly message: string };

const FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * A block that is markup rather than a paragraph of prose: a heading, quote,
 * list item, scene break, table, fence, HTML, or an indented code block.
 */
function isProseBlock(block: string): boolean {
  if (/^( {4}|\t)/.test(block)) return false;
  return !/^(#{1,6}(\s|$)|>|[-*+](\s|$)|\d+[.)]\s|\||```|~~~|<|[-*_]{3,}\s*$)/.test(block);
}

/** Splits every prose paragraph of `body` into sentence lines, keeping blank lines and non-prose blocks as they were. */
export function splitBody(body: string): string {
  const leading = /^\s*/.exec(body)?.[0] ?? "";
  const trailing = /\s*$/.exec(body.slice(leading.length))?.[0] ?? "";
  const core = body.slice(leading.length, body.length - trailing.length);
  // Odd indexes are the blank-line separators, kept so spacing round-trips.
  const parts = core.split(/(\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*)/);
  const out = parts.map((part, i) => {
    if (i % 2 === 1 || part === "" || !isProseBlock(part)) return part;
    return splitSentences(part).join("\n");
  });
  return leading + out.join("") + trailing;
}

/** Splits a chapter's body and leaves its frontmatter block untouched. */
export function splitChapter(content: string): string {
  const fm = FRONTMATTER.exec(content)?.[0] ?? "";
  return fm + splitBody(content.slice(fm.length));
}

/** Of `relPaths` (vault-relative), those with uncommitted changes — a commit of exactly the migrated files must not sweep up an author's edits. */
function dirtyPaths(vault: string, relPaths: readonly string[]): string[] {
  try {
    const out = execFileSync("git", ["-C", vault, "status", "--porcelain", "--", ...relPaths], { stdio: "pipe", encoding: "utf8" });
    return out.split("\n").filter(Boolean).map((l) => l.slice(3));
  } catch {
    return []; // not a repository: nothing to protect, the commit step reports it
  }
}

export function migrateLines(vaultRoot: string, projectPath: string, opts: { dryRun: boolean }): MigrateResult {
  const chaptersDir = join(projectPath, "chapters");
  const files = existsSync(chaptersDir)
    ? readdirSync(chaptersDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
    : [];

  const changes: { abs: string; next: string }[] = [];
  for (const file of files) {
    const abs = join(chaptersDir, file);
    const current = readFileSync(abs, "utf8");
    const next = splitChapter(current);
    if (next !== current) changes.push({ abs, next });
  }

  const changed = changes.map((c) => relative(projectPath, c.abs));
  if (opts.dryRun || changes.length === 0) {
    return { ok: true, dryRun: opts.dryRun, changed, committed: false };
  }

  const dirty = dirtyPaths(
    vaultRoot,
    changes.map((c) => relative(vaultRoot, c.abs)),
  );
  if (dirty.length > 0) {
    return {
      ok: false,
      code: 2,
      message: `pablo: migrate lines: uncommitted changes in ${dirty.join(", ")} — commit or discard them first so the migration commit holds only the split`,
    };
  }

  for (const c of changes) writeFileSync(c.abs, c.next);
  const { committed, notice } = gitCommit(
    vaultRoot,
    MIGRATE_COMMIT_MESSAGE,
    changes.map((c) => c.abs),
  );
  return { ok: true, dryRun: false, changed, committed, ...(notice ? { notice } : {}) };
}
