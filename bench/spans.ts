/**
 * The bake-off's fixture format.
 *
 * A fixture is a small markdown document with the replacement target marked
 * out, so the bench exercises the same thing the app does: a span inside a
 * document, with prose on both sides of it that the model can see and must not
 * rewrite. The prose is written for this bench and is deliberately not from the
 * writing vault — the GitHub mirror of this repo is public.
 *
 * ```
 * ---
 * id: 01-lighthouse
 * instruction: What to do to the span.
 * ---
 * context before
 *
 * <<<span
 * the passage to replace
 * span>>>
 *
 * context after
 * ```
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Document, Span } from "../packages/core/src/index";

export interface BenchSpan {
  readonly id: string;
  readonly instruction: string;
  /** The fixture with the markers removed: what the app would have on disk. */
  readonly document: Document;
  readonly span: Span;
  /** The text of the span, for the word counts and the anchor check. */
  readonly passage: string;
  readonly words: number;
}

const OPEN = "<<<span\n";
const CLOSE = "\nspan>>>";

export function loadSpans(dir: string): readonly BenchSpan[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => parseSpan(join(dir, name)));
}

export function parseSpan(path: string): BenchSpan {
  const source = readFileSync(path, "utf8");
  const { fields, body } = frontmatter(path, source);

  const open = body.indexOf(OPEN);
  const close = body.indexOf(CLOSE);
  if (open === -1 || close === -1 || close < open) {
    throw new Error(`${path}: expected the passage between a "<<<span" line and a "span>>>" line`);
  }

  const before = body.slice(0, open);
  const passage = body.slice(open + OPEN.length, close);
  const after = body.slice(close + CLOSE.length);
  const text = before + passage + after;

  return {
    id: fields["id"] ?? path,
    instruction: required(path, fields, "instruction"),
    document: { path, text },
    span: { start: before.length, end: before.length + passage.length },
    passage,
    words: countWords(passage),
  };
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

function frontmatter(path: string, source: string): { fields: Record<string, string>; body: string } {
  if (!source.startsWith("---\n")) throw new Error(`${path}: expected YAML frontmatter`);
  const end = source.indexOf("\n---\n", 3);
  if (end === -1) throw new Error(`${path}: unterminated frontmatter`);

  const fields: Record<string, string> = {};
  let key: string | undefined;
  for (const line of source.slice(4, end).split("\n")) {
    // A wrapped continuation line — the instructions are long enough to need them.
    if (/^\s/.test(line) && key !== undefined) {
      fields[key] = `${fields[key] ?? ""} ${line.trim()}`;
      continue;
    }
    const at = line.indexOf(":");
    if (at === -1) continue;
    key = line.slice(0, at).trim();
    fields[key] = line.slice(at + 1).trim();
  }
  return { fields, body: source.slice(end + 5) };
}

function required(path: string, fields: Record<string, string>, key: string): string {
  const value = fields[key];
  if (value === undefined || value === "") throw new Error(`${path}: frontmatter needs a "${key}"`);
  return value;
}
