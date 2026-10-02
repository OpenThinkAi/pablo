/**
 * `pablo publish` (AGT-1534) — the compiler: the publishable form of a work,
 * built from its line-oriented source. See the screen doc's "The manuscript
 * in git" section (`pm project show ai-terminal --doc screen`): manuscripts are
 * one sentence per line, and the compiler strips frontmatter, joins sentences
 * back into paragraphs, curls quotes, and assembles the chapters.
 *
 * Only `--target draft` exists today: one markdown file, every chapter in
 * order, written to `<work>/.pablo/out/<slug>-draft.md` (gitignored machine
 * state; never committed). `review` and `final` are refused until they have
 * something to publish to; pandoc formats (epub, docx, pdf) are deferred.
 *
 * Dashes are left as written: the style guide bans em-dashes in the source
 * and `check` flags them, so the compiler never invents one.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { joinSentences } from "@openthink/pablo-core";
import { parseFrontmatter } from "./novel/machine";

export const PUBLISH_TARGETS = ["draft", "review", "final"] as const;
export type PublishTarget = (typeof PUBLISH_TARGETS)[number];

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** A leading YAML frontmatter block removed; text with none is returned as is. */
export function stripFrontmatter(text: string): string {
  return text.replace(FRONTMATTER_RE, "");
}

/** Words that start with an apostrophe meaning an elision, never an opening quote ('tis, 'em, 'cause). */
const ELISIONS = new Set(["tis", "twas", "twere", "twill", "em", "cause", "til", "round", "bout", "n"]);

const OPENS = /[\s([{‘“]/;

/**
 * Curls straight quotes and apostrophes: `"` becomes a left or right double
 * quote, `'` a left single quote or the right single quote (which is also the
 * apostrophe). A quote opens after the start, whitespace, an opening bracket
 * or another opening quote, and closes everywhere else; after a dash it opens
 * only when a word follows it. Already-curly text is left alone.
 */
export function curlQuotes(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch !== '"' && ch !== "'") {
      out += ch;
      continue;
    }
    const prev = i === 0 ? "" : (text[i - 1] as string);
    const next = i + 1 < text.length ? (text[i + 1] as string) : "";
    let opening: boolean;
    if (prev === "" || OPENS.test(prev)) {
      opening = true;
    } else if (prev === "—" || prev === "–" || prev === "-") {
      opening = next !== "" && /[\p{L}\p{N}]/u.test(next);
    } else {
      opening = false;
    }
    if (ch === "'" && opening) {
      // An apostrophe opening a word ('tis, 'em, '29) is a right quote, not a left one.
      const word = /^[\p{L}\p{N}]*/u.exec(text.slice(i + 1))?.[0] ?? "";
      if (word === "" || ELISIONS.has(word.toLowerCase()) || /^\d{2}s?$/.test(word)) opening = false;
    }
    if (ch === '"') out += opening ? "“" : "”";
    else out += opening ? "‘" : "’";
  }
  return out;
}

/** Sentence lines to paragraphs: a blank line separates paragraphs, each paragraph's lines are joined into one. */
export function bodyParagraphs(body: string): string[] {
  const paragraphs: string[] = [];
  let lines: string[] = [];
  const flush = (): void => {
    if (lines.length === 0) return;
    const joined = joinSentences(lines);
    if (joined !== "") paragraphs.push(joined);
    lines = [];
  };
  for (const line of body.split(/\r?\n/)) {
    if (line.trim() === "") flush();
    else lines.push(line);
  }
  flush();
  return paragraphs;
}

export interface CompileChapter {
  readonly number: number;
  /** The raw chapter file, frontmatter and all. */
  readonly text: string;
}

/**
 * The draft target's one markdown document: `# <title>`, then each chapter
 * (in number order) as `## Chapter N: <title>` (just `## Chapter N` with no
 * frontmatter title) followed by its paragraphs. Pure.
 */
export function compileDraft(title: string, chapters: readonly CompileChapter[]): string {
  const sections: string[] = [`# ${curlQuotes(title)}`];
  for (const chapter of [...chapters].sort((a, b) => a.number - b.number)) {
    const chapterTitle = parseFrontmatter(chapter.text)["title"];
    const heading = chapterTitle ? `## Chapter ${chapter.number}: ${curlQuotes(chapterTitle)}` : `## Chapter ${chapter.number}`;
    sections.push(heading, ...bodyParagraphs(stripFrontmatter(chapter.text)).map(curlQuotes));
  }
  return `${sections.join("\n\n")}\n`;
}

export interface PublishSuccess {
  readonly ok: true;
  readonly code: 0;
  readonly target: PublishTarget;
  /** Absolute path of the file written. */
  readonly where: string;
  readonly chapters: number;
  readonly words: number;
}

export interface PublishRefusal {
  readonly ok: false;
  readonly code: 2;
  readonly message: string;
  readonly tried: readonly string[];
}

export type PublishOutcome = PublishSuccess | PublishRefusal;

function refuse(message: string, tried: readonly string[] = []): PublishRefusal {
  return { ok: false, code: 2, message, tried };
}

/** Compiles `<workDir>/chapters/NN-*.md` into `<workDir>/.pablo/out/<slug>-draft.md`. */
export function publishWork(workDir: string, slug: string, title: string, target: string | undefined): PublishOutcome {
  if (target === undefined) {
    return refuse(`pablo: publish requires --target (${PUBLISH_TARGETS.join("|")})`);
  }
  if (!(PUBLISH_TARGETS as readonly string[]).includes(target)) {
    return refuse(`pablo: publish: unknown --target "${target}" (expected ${PUBLISH_TARGETS.join("|")})`);
  }
  if (target !== "draft") {
    return refuse(`pablo: publish --target ${target} is not implemented yet (only draft is)`);
  }

  const dir = join(workDir, "chapters");
  const chapters: CompileChapter[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      const match = /^(\d{2,})-.*\.md$/.exec(name);
      if (match) chapters.push({ number: Number(match[1]), text: readFileSync(join(dir, name), "utf8") });
    }
  }
  if (chapters.length === 0) {
    return refuse("pablo: publish: no chapters to compile (chapters/NN-*.md)", [dir]);
  }

  const compiled = compileDraft(title, chapters);
  const outDir = join(workDir, ".pablo", "out");
  mkdirSync(outDir, { recursive: true });
  const where = join(outDir, `${slug}-draft.md`);
  writeFileSync(where, compiled, "utf8");
  const words = compiled.split(/\s+/).filter((word) => word !== "").length;
  return { ok: true, code: 0, target: "draft", where, chapters: chapters.length, words };
}
