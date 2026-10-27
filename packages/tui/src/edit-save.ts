// The editor's storage round-trip (AGT-2168, D-18), pure: no fs, no Ink. `loadForEdit` turns a unit's file as stored
// into the text the edit pane's buffer holds, and `saveEdited` turns the edited text back into the file, touching only
// what the author changed.
//
// - `sentences` (novel chapters, stories, essays): the pane shows one paragraph per line, paragraphs separated by a
//   blank line (joinManuscript's form, as the reading pane draws it). On save each edited paragraph is matched against
//   the stored paragraphs (a longest-common-subsequence over their joined text): a paragraph that is still there keeps
//   its stored bytes exactly, hard wraps and all, along with the blank lines between two kept neighbours; only a new or
//   changed paragraph is split one sentence per line (splitManuscript). An unedited save is a zero diff.
// - `lines` (radio, narrated) and `screenplay` (Fountain): the pane shows the stored lines as they are, and the edit is
//   stored exactly as typed. Never joined, never sentence-split: that would change the script.
//
// Either way the frontmatter (and the blank lines under it) is kept byte for byte: it is never in the pane's text.
// A file stored with CRLF line ends is shown with LF and written back with CRLF.

import { joinSentences, isProseBlock, splitManuscript } from "@openthink/pablo-core";
import type { Storage } from "./book";

/** What the edit pane opens: `text` is what the buffer holds (one paragraph per line for `sentences`, the stored lines otherwise). */
export interface EditDoc {
  readonly text: string;
  readonly storage: Storage;
}

/** A stored paragraph: its exact bytes (no trailing line end) and the joined text the pane shows for it. */
interface Block { readonly stored: string; readonly key: string }

/** A stored file taken apart: the head kept as is, the body's paragraphs, the blank-line runs between them, and the tail. */
interface Parsed {
  /** BOM, frontmatter and the blank lines before the body's first line, byte for byte. */
  readonly head: string;
  readonly blocks: readonly Block[];
  /** `seps[i]` sits between `blocks[i]` and `blocks[i + 1]`: the line end closing block i and any blank lines after it. */
  readonly seps: readonly string[];
  /** After the last paragraph: its line end and any trailing blank lines. */
  readonly tail: string;
  /** The body between head and tail, as stored. */
  readonly body: string;
  readonly eol: "\n" | "\r\n";
}

const blank = (line: string) => line.trim() === "";

/** The pane's text for a paragraph: a prose paragraph's lines joined into one; any other block (heading, list, table) as is. */
function keyOf(lines: readonly string[]): string {
  return isProseBlock(lines.join("\n")) ? joinSentences(lines) : lines.join("\n").trim();
}

/** Splits `raw` into lines that keep their own line ends, so slices of them put the file back together byte for byte. */
const linesOf = (s: string): string[] => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const strip = (line: string) => line.replace(/\r?\n$/, "");

function parse(raw: string): Parsed {
  const lines = linesOf(raw);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  let i = 0;
  // Frontmatter, read the way stripFrontmatter and displayDoc read it: an opening `---` line closed by another.
  if (strip(lines[0] ?? "").replace(/^﻿/, "").trim() === "---") {
    const close = lines.findIndex((l, k) => k > 0 && strip(l).trim() === "---");
    if (close > 0) i = close + 1;
  }
  while (i < lines.length && blank(strip(lines[i]!))) i++;
  const head = lines.slice(0, i).join("");

  const blocks: Block[] = [];
  const seps: string[] = [];
  let tail = "";
  let run: string[] = [];
  let gap = "";
  const flush = () => {
    if (run.length === 0) return;
    const last = run[run.length - 1]!;
    const end = last.length - strip(last).length;
    if (blocks.length > 0) seps.push(gap);
    blocks.push({ stored: run.join("").slice(0, run.join("").length - end), key: keyOf(run.map(strip)) });
    gap = last.slice(last.length - end);
    run = [];
  };
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (blank(strip(line))) { flush(); gap += line; } else run.push(line);
  }
  flush();
  tail = gap;
  const body = raw.slice(head.length, raw.length - tail.length);
  return { head, blocks, seps, tail, body, eol };
}

/** The edited text's paragraphs, split on blank lines the way splitManuscript reads them: each with its pane text and its lines. */
function editedParagraphs(text: string): { key: string; text: string }[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => ({ key: keyOf(p.split("\n")), text: p }));
}

/** For each `b` index, the `a` index it is matched to by a longest common subsequence of equal strings, or -1. */
function align(a: readonly string[], b: readonly string[]): number[] {
  const n = a.length, m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const match = new Array<number>(m).fill(-1);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { match[j] = i; i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
    else j++;
  }
  return match;
}

/** The pane's text for a unit's file as stored, under its storage mode. */
export function loadForEdit(raw: string, storage: Storage = "sentences"): EditDoc {
  const parsed = parse(raw);
  if (storage === "lines" || storage === "screenplay") return { text: parsed.body.replace(/\r\n/g, "\n"), storage };
  return { text: parsed.blocks.map((b) => b.key).join("\n\n"), storage };
}

/**
 * The file to store for `edited` (the pane's text, as `loadForEdit` gave it and the author changed it) over `original`
 * (the file as it was opened). Frontmatter is kept byte for byte; under `sentences` only new or changed paragraphs are
 * re-split, everything else keeps its stored bytes; `lines` and `screenplay` store the edit exactly as typed.
 */
export function saveEdited(original: string, edited: string, storage: Storage = "sentences"): string {
  const p = parse(original);
  const nl = (s: string) => (p.eol === "\r\n" ? s.replace(/\r?\n/g, "\r\n") : s);
  // A file with no body yet gets a blank line under its frontmatter; otherwise the head already ends at a line end.
  const head = (() => {
    if (p.blocks.length > 0 || p.head === "") return p.head;
    const h = p.head.endsWith("\n") ? p.head : p.head + p.eol;
    return /\n[ \t\r]*\n$/.test(h) ? h : h + p.eol;
  })();
  // The stored tail (its line end, trailing blank lines, or none at all) stays; a file that had no body ends with one line end.
  const tail = p.blocks.length > 0 ? p.tail : p.eol;

  if (storage === "lines" || storage === "screenplay") {
    const body = edited.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    return body.trim() === "" ? p.head : head + nl(body) + tail;
  }

  const paragraphs = editedParagraphs(edited);
  if (paragraphs.length === 0) return p.head;
  const match = align(p.blocks.map((b) => b.key), paragraphs.map((q) => q.key));
  let out = head;
  let prev = -2;
  paragraphs.forEach((q, j) => {
    const k = match[j]!;
    if (j > 0) out += k >= 0 && prev >= 0 && k === prev + 1 ? p.seps[prev]! : p.eol + p.eol;
    out += k >= 0 ? p.blocks[k]!.stored : nl(splitManuscript(q.text));
    prev = k;
  });
  // The tail belongs after the stored last paragraph; a new last paragraph ends with one line end.
  const lastKept = match[paragraphs.length - 1]! === p.blocks.length - 1;
  return out + (lastKept ? tail : p.eol);
}
