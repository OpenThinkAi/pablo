/**
 * A dependency-free screenplay PDF writer (AGT-2133): compiled Fountain in,
 * standard screenplay pages out. US Letter, Courier 12 (a PDF base-14 font,
 * so nothing is embedded), 6 lines to the inch, margins 1.5in left and 1in
 * right/top/bottom, page numbers top right from the second script page.
 * Pure: the same text gives the same bytes (no dates, no random ids).
 *
 * Fountain read here: a title page (`Title:` keys), scene headings, action,
 * character cues with parentheticals and dialogue, transitions, centered
 * text, forced elements (`.` `!` `@` `>`), page breaks (`===`). Never
 * printed: notes `[[ ]]`, the boneyard, sections `#`, synopses `=`.
 */

import { cueName, isSceneHeading, isTransition } from "./outputs/screenplay/fountain";

const PAGE_W = 612;
const PAGE_H = 792;
const LEADING = 12;
const CHAR_W = 7.2;
const LINES_PER_PAGE = 54;
const TOP = PAGE_H - 72;

/** Left edge of each element, in points, and its width in characters. */
const LEFT = { margin: 108, dialogue: 180, parenthetical: 223.2, cue: 266.4 } as const;
const COLS = { action: 60, dialogue: 35, parenthetical: 25 } as const;
const RIGHT_EDGE = 540;

interface PdfLine {
  readonly x: number;
  readonly text: string;
  readonly bold?: boolean;
}

/** One block of lines kept together where it fits; a blank line separates blocks. */
interface Block {
  readonly lines: readonly PdfLine[];
  readonly kind: "heading" | "dialogue" | "other";
  readonly pageBreak?: boolean;
}

const PRINTED_KEYS = /^(title|credit|author|authors|source|draft date|date|contact|copyright|notes)\s*:/i;

/** Fountain's inline markup, flattened: emphasis markers and escapes drop out. */
function plain(text: string): string {
  return text
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/(?<![A-Za-z0-9])_([^_]+)_(?![A-Za-z0-9])/g, "$1")
    .replace(/\\([*_\\])/g, "$1")
    .replace(/\t/g, "    ");
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line !== "") out.push(line);
  return out;
}

/** The text with notes and the boneyard removed, as blocks of non-blank trimmed lines. */
function blocksOf(text: string): string[][] {
  const clean = text
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, "")
    .replace(/\[\[[\s\S]*?\]\]/g, "");
  const blocks: string[][] = [];
  let run: string[] = [];
  const flush = (): void => {
    if (run.length > 0) blocks.push(run);
    run = [];
  };
  for (const raw of clean.split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "") flush();
    else if (/^(#|=(?!==))/.test(line.trim())) continue;
    else run.push(line.trim());
  }
  flush();
  return blocks;
}

function titlePage(keys: ReadonlyMap<string, string>): PdfLine[][] {
  const page: PdfLine[] = [];
  const centered = (text: string): PdfLine => ({ x: Math.max(LEFT.margin, (PAGE_W - text.length * CHAR_W) / 2), text });
  const gap = (n: number): void => {
    for (let i = 0; i < n; i += 1) page.push({ x: 0, text: "" });
  };
  gap(14);
  page.push(centered((keys.get("title") ?? "").toUpperCase()));
  const credit = keys.get("credit");
  const author = keys.get("author") ?? keys.get("authors");
  if (credit !== undefined || author !== undefined) gap(2);
  if (credit !== undefined) page.push(centered(credit));
  if (author !== undefined) {
    gap(1);
    page.push(centered(author));
  }
  const source = keys.get("source");
  if (source !== undefined) {
    gap(2);
    page.push(centered(source));
  }
  const foot = ["contact", "draft date", "date", "copyright"].map((k) => keys.get(k)).filter((v): v is string => v !== undefined);
  if (foot.length > 0) {
    while (page.length < LINES_PER_PAGE - foot.length - 1) gap(1);
    for (const f of foot) page.push({ x: LEFT.margin, text: f });
  }
  return [page];
}

function toBlock(block: readonly string[]): Block | undefined {
  const head = block[0] as string;
  if (/^===+$/.test(head)) return { lines: [], kind: "other", pageBreak: true };
  if (block.length === 1 && isSceneHeading(head)) {
    const text = plain(head.replace(/^\./, "")).toUpperCase();
    return { kind: "heading", lines: wrap(text, COLS.action).map((t) => ({ x: LEFT.margin, text: t, bold: true })) };
  }
  if (block.length === 1 && /^>.*<$/.test(head)) {
    const text = plain(head.replace(/^>\s*/, "").replace(/\s*<$/, ""));
    return { kind: "other", lines: [{ x: Math.max(LEFT.margin, (PAGE_W - text.length * CHAR_W) / 2), text }] };
  }
  if (block.length === 1 && isTransition(head)) {
    const text = plain(head.replace(/^>\s*/, "")).toUpperCase();
    return { kind: "other", lines: [{ x: Math.max(LEFT.margin, RIGHT_EDGE - text.length * CHAR_W), text }] };
  }
  const cue = block.length > 1 && !head.startsWith("!") ? cueName(head) : undefined;
  if (cue !== undefined) {
    const ext = /(\([^)]*\))\s*\^?$/.exec(head.replace(/^@/, ""));
    const lines: PdfLine[] = [{ x: LEFT.cue, text: plain(`${cue}${ext && !cue.includes(ext[1] as string) ? ` ${ext[1]}` : ""}`).toUpperCase() }];
    for (const l of block.slice(1)) {
      if (/^\(.*\)$/.test(l)) for (const t of wrap(plain(l), COLS.parenthetical)) lines.push({ x: LEFT.parenthetical, text: t });
      else for (const t of wrap(plain(l), COLS.dialogue)) lines.push({ x: LEFT.dialogue, text: t });
    }
    return { kind: "dialogue", lines };
  }
  const lines: PdfLine[] = [];
  for (const l of block) for (const t of wrap(plain(l.replace(/^!/, "")), COLS.action)) lines.push({ x: LEFT.margin, text: t });
  return lines.length === 0 ? undefined : { kind: "other", lines };
}

/** Compiled Fountain to pages of positioned lines (title page first, when the text has one). Pure. */
export function layoutScreenplay(fountain: string): { pages: PdfLine[][]; titled: boolean } {
  const blocks = blocksOf(fountain);
  const pages: PdfLine[][] = [];
  const first = blocks[0];
  if (first !== undefined && first.every((l) => PRINTED_KEYS.test(l))) {
    const keys = new Map<string, string>();
    for (const l of first) {
      const m = /^([^:]+):\s*(.*)$/.exec(l);
      if (m) keys.set((m[1] as string).trim().toLowerCase(), plain((m[2] as string).trim()));
    }
    pages.push(...titlePage(keys));
    blocks.shift();
  }

  let page: PdfLine[] = [];
  const newPage = (): void => {
    pages.push(page);
    page = [];
  };
  const titled = pages.length;
  for (const raw of blocks) {
    const block = toBlock(raw);
    if (block === undefined) continue;
    if (block.pageBreak) {
      if (page.length > 0) newPage();
      continue;
    }
    // A heading needs room for itself and two more lines.
    if (block.kind === "heading" && page.length > 0 && LINES_PER_PAGE - page.length - 1 < block.lines.length + 3) newPage();
    let rest = block.lines;
    while (rest.length > 0) {
      const lead = page.length === 0 ? 0 : 1;
      const room = LINES_PER_PAGE - page.length - lead;
      if (rest.length <= room) {
        if (lead === 1) page.push({ x: 0, text: "" });
        page.push(...rest);
        break;
      }
      // A heading or a speech moves whole when it fits a page. Action splits, but never leaves fewer than
      // two lines on either side of the break (AGT-2194); a block taller than a page is cut wherever it must.
      const splittable = block.kind === "other" || rest.length > LINES_PER_PAGE;
      const take = splittable ? Math.min(room, rest.length - 2) : 0;
      if (take >= 2) {
        if (lead === 1) page.push({ x: 0, text: "" });
        page.push(...rest.slice(0, take));
        rest = rest.slice(take);
      }
      newPage();
    }
  }
  if (page.length > 0 || pages.length === titled) newPage();
  return { pages, titled: titled > 0 };
}

/** cp1252 for the characters prose uses; anything else becomes `?`. */
const WIN_ANSI: Readonly<Record<string, number>> = {
  "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "–": 0x96, "—": 0x97, "…": 0x85, "•": 0x95, " ": 0x20,
};

function pdfString(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    const byte = WIN_ANSI[ch] ?? (code < 256 ? code : 0x3f);
    out += byte === 0x28 || byte === 0x29 || byte === 0x5c ? `\\${String.fromCharCode(byte)}` : String.fromCharCode(byte);
  }
  return out;
}

/** The PDF bytes for compiled Fountain. `title` goes in the document info. Pure. */
export function buildScreenplayPdf(fountain: string, title: string): Uint8Array {
  const { pages, titled: hasTitlePage } = layoutScreenplay(fountain);
  const objects: string[] = [];
  const add = (body: string): number => objects.push(body);
  // 1 catalog, 2 pages, 3 Courier, 4 Courier-Bold, 5 info; then a content + page object per page.
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add(""); // pages, filled below
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>");
  add(`<< /Title (${pdfString(title)}) /Producer (pablo) >>`);
  const kids: number[] = [];
  pages.forEach((lines, index) => {
    const ops: string[] = [];
    const scriptPage = hasTitlePage ? index : index + 1;
    if (scriptPage >= 2) {
      const label = `${scriptPage}.`;
      ops.push(`BT /F1 12 Tf ${(RIGHT_EDGE - label.length * CHAR_W).toFixed(1)} ${PAGE_H - 36 - 9} Td (${pdfString(label)}) Tj ET`);
    }
    lines.forEach((line, n) => {
      if (line.text === "") return;
      ops.push(`BT /${line.bold ? "F2" : "F1"} 12 Tf ${line.x.toFixed(1)} ${(TOP - LEADING * n - 9).toFixed(1)} Td (${pdfString(line.text)}) Tj ET`);
    });
    const stream = ops.join("\n");
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${content} 0 R >>`));
  });
  objects[1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] >>`;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character is a single byte (see pdfString), so string offsets are byte offsets.
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}
