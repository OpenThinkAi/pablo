/**
 * The essay output's publish (AGT-2134): the compiler over `essay.md`, written
 * to `.pablo/out/<slug>-essay-<target>.md`:
 *
 *   draft    the essay under a "Draft" line naming its length and any
 *            citation that resolves to nothing, then its sources
 *   final    the clean copy and its sources; refused while a citation
 *            resolves to nothing
 *
 * Sections keep their `## ` headings (a one-section essay has none); sentences are joined back into
 * paragraphs and quotes curled. Every citation (`[#2]`, `[@note-id]`, the
 * claim-support check's syntax, AGT-2114) becomes a numbered reference
 * (`[1]`, `[1, 3]`) into the sources list: a `@note-id` is that research
 * note, a `#n` the notes claims row n cites. A source is listed by its note's
 * title, its sources (URLs) and its retrieval date, in order of first
 * citation. Pure apart from reading the work and writing the one file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { CLAIMS_FILE, parseClaims, researchNoteId } from "../../core/nonfiction";
import { readResearchNotes } from "../../distill";
import { bodyParagraphs, curlQuotes, straightenQuotes, workKeepsStraightQuotes } from "../../publish";
import type { PublishOutcome } from "../types";
import { CITATION, ESSAY_PATH, parseEssayFile } from "./sections";
import { ESSAY_PUBLISH_TARGETS } from "./units";

function refuse(message: string, tried: readonly string[] = []): PublishOutcome {
  return { ok: false, code: 2, message, tried };
}

/** One entry of the sources list. */
export interface EssaySource {
  readonly id: string;
  readonly title: string;
  readonly links: readonly string[];
  readonly retrieved?: string;
}

/** A research note read for the sources list: its `# ` title, `Retrieved:` date and `## Sources` bullets. Pure. */
export function noteSource(id: string, text: string): EssaySource {
  const title = /^#\s+(.+?)\s*$/m.exec(text)?.[1] ?? id;
  const retrieved = /^\s*Retrieved:\s*(\S+)/im.exec(text)?.[1];
  const at = /^##\s+Sources\b.*$/im.exec(text);
  const links =
    at === null
      ? []
      : text
          .slice(at.index + at[0].length)
          .split("\n")
          .map((line) => /^\s*[-*]\s+(.+?)\s*$/.exec(line)?.[1])
          .filter((link): link is string => link !== undefined);
  return { id, title, links, ...(retrieved === undefined ? {} : { retrieved }) };
}

export interface CompiledEssay {
  readonly text: string;
  readonly words: number;
  readonly sources: readonly EssaySource[];
  /** Citation tokens that resolve to no note (`@ghost`, `#9`, a claims row that cites nothing). */
  readonly unresolved: readonly string[];
}

/**
 * The compiled essay for `target`. `notes` are the work's research notes by id, `claims` its claims rows' cited
 * note ids by row number. Pure.
 */
export function compileEssay(
  title: string,
  content: string,
  notes: ReadonlyMap<string, string>,
  claims: ReadonlyMap<number, readonly string[]>,
  target: "draft" | "final",
): CompiledEssay {
  const order: string[] = [];
  const unresolved: string[] = [];
  const numberOf = (id: string): number => {
    if (!order.includes(id)) order.push(id);
    return order.indexOf(id) + 1;
  };
  const cite = (paragraph: string): string =>
    paragraph.replace(CITATION, (_whole, inner: string) => {
      const numbers: number[] = [];
      for (const token of inner.split(/[;,]/).map((t) => t.trim()).filter((t) => t !== "")) {
        const ids = token.startsWith("@") ? [researchNoteId(token.slice(1))] : (claims.get(Number(token.slice(1))) ?? []);
        const found = ids.filter((id) => notes.has(id));
        if (found.length === 0 || found.length < ids.length) unresolved.push(token);
        for (const id of found) numbers.push(numberOf(id));
      }
      const unique = [...new Set(numbers)].sort((a, b) => a - b);
      return unique.length === 0 ? "" : ` [${unique.join(", ")}]`;
    });

  const file = parseEssayFile(content);
  const body: string[] = [];
  for (const paragraph of bodyParagraphs(file.preamble.replace(/^#\s.*$/m, ""))) body.push(curlQuotes(cite(paragraph)));
  // A one-section essay (a fiction track's) is the essay itself: no heading over it.
  const headed = file.sections.length > 1;
  for (const section of file.sections) {
    if (headed) body.push(`## ${curlQuotes(section.title)}`);
    for (const paragraph of bodyParagraphs(section.body)) body.push(curlQuotes(cite(paragraph)));
  }
  const sources = order.map((id) => noteSource(id, notes.get(id) as string));
  const words = body
    .filter((p) => !p.startsWith("## "))
    .join(" ")
    .replace(/\[\d+(?:, \d+)*\]/g, "")
    .split(/\s+/)
    .filter((w) => w !== "").length;
  const list = sources.map((s, i) => `${i + 1}. ${s.title}${s.links.length === 0 ? "" : `. ${s.links.join("; ")}`}${s.retrieved === undefined ? "" : ` (retrieved ${s.retrieved})`}`);
  const distinct = [...new Set(unresolved)];
  const draftLine = `*Draft, ${words} words.${distinct.length === 0 ? "" : ` Unresolved citations: ${distinct.join(", ")}.`}*`;
  const parts = [`# ${curlQuotes(title)}`, ...(target === "draft" ? [draftLine] : []), ...body, ...(list.length === 0 ? [] : ["## Sources", list.join("\n")])];
  return { text: `${parts.join("\n\n")}\n`, words, sources, unresolved: distinct };
}

export function publishEssay(workDir: string, slug: string, title: string, target: string | undefined): PublishOutcome {
  if (target === undefined) return refuse(`pablo: publish requires --target (${ESSAY_PUBLISH_TARGETS.join("|")})`);
  if (!(ESSAY_PUBLISH_TARGETS as readonly string[]).includes(target)) {
    return refuse(`pablo: publish: unknown --target "${target}" (expected ${ESSAY_PUBLISH_TARGETS.join("|")})`);
  }
  const source = join(workDir, ESSAY_PATH);
  if (!existsSync(source)) return refuse(`pablo: publish: no essay to compile (${ESSAY_PATH})`, [source]);

  const notes = new Map(readResearchNotes(workDir).map((n) => [n.id, n.text] as const));
  const claimsPath = join(workDir, CLAIMS_FILE);
  const claims = new Map(parseClaims(existsSync(claimsPath) ? readFileSync(claimsPath, "utf8") : "").map((r) => [r.number, r.sources] as const));
  const compiled = compileEssay(title, readFileSync(source, "utf8"), notes, claims, target as "draft" | "final");
  if (target === "final" && compiled.unresolved.length > 0) {
    return refuse(
      `pablo: publish: the final essay cannot carry citations that resolve to nothing: ${compiled.unresolved.join(", ")} (fix them, or publish --target draft to see where)`,
      [source],
    );
  }
  const outDir = join(workDir, ".pablo", "out");
  const where = join(outDir, `${slug}-essay-${target}.md`);
  if (!where.startsWith(outDir + sep)) return refuse(`pablo: publish: marker slug "${slug}" would write outside ${outDir}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(where, workKeepsStraightQuotes(workDir) ? straightenQuotes(compiled.text) : compiled.text, "utf8");
  return { ok: true, code: 0, target, where, chapters: parseEssayFile(readFileSync(source, "utf8")).sections.length, words: compiled.words };
}
