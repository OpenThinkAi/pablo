/**
 * The fact provenance tag (AGT-1556): every fact line in the bible or
 * `continuity.md` says whether it was researched, invented, or decided by the
 * author, so the harness's judgement policy (pm project `ai-terminal`,
 * `--doc harness`) is checkable by reading the file.
 *
 *   - Valley fact [researched: Smith, Wine Trade 1919, p. 40]
 *   - Her late husband kept bees [ch03] [invented]
 *   - The ship sails in March [ch01, anchor not found] [author]
 *
 * The provenance tag is the LAST bracket group on the line. It coexists with
 * the chapter tag `runContinuity` writes (`[chNN]`, `[chNN, anchor not
 * found]`), which stays where it is: bracket groups before the provenance tag
 * are kept verbatim and in order. Any other bracketed text (a `[pick]`, say)
 * is just part of the fact. Round trip: `formatFactLine(parseFactLine(l))` is
 * `l` for any line in the canonical shape above.
 *
 * Pure and dependency-free: text in, text out.
 */

export type Provenance =
  | { readonly kind: "researched"; readonly source: string }
  | { readonly kind: "invented" }
  | { readonly kind: "author" };

export interface FactLine {
  /** The fact itself, without bullet, chapter tags or provenance tag. */
  readonly text: string;
  /** Chapter-style bracket groups (`ch03`, `ch03, anchor not found`), inner text only, in line order. */
  readonly tags: readonly string[];
  /** Undefined when the line is untagged, or carries conflicting provenance tags (see `conflicting`). */
  readonly provenance: Provenance | undefined;
  /** More than one provenance tag on the line: reported rather than guessed at. */
  readonly conflicting: boolean;
}

export interface FactEntry {
  /** 0-based line index in the scanned text. */
  readonly line: number;
  /** The nearest `#` heading above the line, or undefined before the first. */
  readonly heading: string | undefined;
  readonly fact: FactLine;
}

export interface FactScan {
  readonly facts: readonly FactEntry[];
  /** Facts with no usable provenance tag (none, or conflicting). */
  readonly untagged: readonly FactEntry[];
}

const BULLET = /^\s*[-*]\s+(.*)$/;
const TRAILING_GROUP = /\s*\[([^\[\]]*)\]\s*$/;
const CHAPTER_TAG = /^ch\d+(?:,\s*[^\[\]]+)?$/;
const RESEARCHED = /^researched:\s*(\S[^\[\]]*)$/;

function provenanceOf(inner: string): Provenance | undefined {
  const text = inner.trim();
  if (text === "invented") return { kind: "invented" };
  if (text === "author") return { kind: "author" };
  const match = RESEARCHED.exec(text);
  if (match?.[1] !== undefined) return { kind: "researched", source: match[1].trim() };
  return undefined;
}

/** The tag as written: `[researched: <source>]`, `[invented]` or `[author]`. */
export function formatProvenance(provenance: Provenance): string {
  if (provenance.kind !== "researched") return `[${provenance.kind}]`;
  const source = provenance.source.replace(/\s+/g, " ").trim();
  if (source === "") throw new RangeError("a researched fact needs a source");
  if (/[\[\]]/.test(source)) throw new RangeError("a source cannot contain square brackets");
  return `[researched: ${source}]`;
}

/**
 * A bullet line as a fact, or undefined when the line is not a bullet.
 * Trailing bracket groups are peeled from the end: provenance tags and chapter
 * tags are recognised, and the first group that is neither ends the peel.
 */
export function parseFactLine(line: string): FactLine | undefined {
  const bullet = BULLET.exec(line);
  if (bullet?.[1] === undefined) return undefined;
  let rest = bullet[1];
  const tags: string[] = [];
  const found: Provenance[] = [];
  for (;;) {
    const group = TRAILING_GROUP.exec(rest);
    if (group?.[1] === undefined) break;
    const provenance = provenanceOf(group[1]);
    if (provenance !== undefined) found.unshift(provenance);
    else if (CHAPTER_TAG.test(group[1].trim())) tags.unshift(group[1].trim());
    else break;
    rest = rest.slice(0, group.index);
  }
  return {
    text: rest.trim(),
    tags,
    provenance: found.length === 1 ? found[0] : undefined,
    conflicting: found.length > 1,
  };
}

/** The canonical line: `- <text> [<tag>]... [<provenance>]`. */
export function formatFactLine(fact: FactLine): string {
  const text = fact.text.replace(/[\r\n]+/g, " ").trim();
  const parts = [`- ${text}`, ...fact.tags.map((tag) => `[${tag}]`)];
  if (fact.provenance !== undefined) parts.push(formatProvenance(fact.provenance));
  return parts.join(" ");
}

/**
 * `line` with its provenance set to `provenance` (replacing any tag or
 * conflict), everything else kept. A line that is not a fact is returned
 * unchanged.
 */
export function withProvenance(line: string, provenance: Provenance): string {
  const fact = parseFactLine(line);
  if (fact === undefined) return line;
  return formatFactLine({ ...fact, provenance, conflicting: false });
}

/** Every bullet line of `text` as a fact, and which of them carry no provenance tag. */
export function scanFacts(text: string): FactScan {
  const facts: FactEntry[] = [];
  let heading: string | undefined;
  text.split("\n").forEach((line, index) => {
    if (/^#{1,6}\s/.test(line)) {
      heading = line.trim();
      return;
    }
    const fact = parseFactLine(line);
    if (fact !== undefined) facts.push({ line: index, heading, fact });
  });
  return { facts, untagged: facts.filter((entry) => entry.fact.provenance === undefined) };
}
