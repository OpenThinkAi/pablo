// Dependency-free PDF text extraction for web_fetch (AGT-2192, D-11). Not a PDF
// renderer: it inflates the FlateDecode content streams (node:zlib, built in),
// and reads the text-showing operators (Tj, TJ, ', ") inside BT..ET blocks.
// Good for the text PDFs research needs (brochures, papers). Fonts that map
// glyphs through a custom ToUnicode CMap, scans, and encrypted files yield
// little or no text; the caller treats an empty result as unsupported.

import { inflateSync } from "node:zlib";

const latin1 = new TextDecoder("latin1");

/** The bytes of every content stream in the file, inflated when FlateDecode'd. */
function streams(pdf: Uint8Array): string[] {
  const text = latin1.decode(pdf);
  const out: string[] = [];
  const re = /stream\r?\n/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const start = m.index + m[0].length;
    const end = text.indexOf("endstream", start);
    if (end < 0) break;
    const dictStart = text.lastIndexOf("obj", m.index);
    const dict = dictStart >= 0 ? text.slice(dictStart, m.index) : "";
    re.lastIndex = end;
    if (/\/Subtype\s*\/(Image|Form)\b|\/Type\s*\/(XRef|ObjStm|Metadata)\b|\/FontFile/.test(dict)) continue;
    const raw = pdf.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) {
      try {
        out.push(latin1.decode(inflateSync(raw)));
      } catch {
        // a damaged or unsupported (e.g. predictor) stream: skip it
      }
    } else if (!/\/Filter/.test(dict)) {
      out.push(latin1.decode(raw));
    }
  }
  return out;
}

function unescapeLiteral(s: string): string {
  return s.replace(/\\(?:([0-7]{1,3})|(\r\n|\n|\r)|(.))/gs, (_m, oct: string | undefined, nl: string | undefined, ch: string | undefined) => {
    if (oct !== undefined) return String.fromCharCode(parseInt(oct, 8) & 0xff);
    if (nl !== undefined) return "";
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[ch!] ?? ch!;
  });
}

function hexString(h: string): string {
  const clean = h.replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2).padEnd(2, "0"), 16));
  return out;
}

/** Text of one content stream: each BT..ET block, with a line break at line moves and a space for wide TJ kerning. */
function contentText(content: string): string {
  const lines: string[] = [];
  let line = "";
  const flush = () => {
    if (line.trim()) lines.push(line.replace(/[ \t]+/g, " ").trim());
    line = "";
  };
  const token = /\(((?:\\.|[^\\()]|\((?:\\.|[^\\()])*\))*)\)|<([0-9a-fA-F\s]*)>|\[|\]|(-?\d*\.?\d+)|\/[^\s/<>\[\]()]+|([A-Za-z'"*]+)/gs;
  for (const block of content.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) {
    for (const t of block[1]!.matchAll(token)) {
      if (t[1] !== undefined) line += unescapeLiteral(t[1]);
      else if (t[2] !== undefined) line += hexString(t[2]);
      else if (t[3] !== undefined) {
        if (Number(t[3]) < -200) line += " "; // wide TJ kerning is a word gap
      } else if (t[4] !== undefined) {
        const op = t[4];
        if (op === "Td" || op === "TD" || op === "T*" || op === "Tm" || op === "'" || op === '"') flush();
      }
    }
    flush();
    lines.push("");
  }
  return lines.join("\n");
}

/** Extract plain text from a PDF's bytes; "" when it has none this reader can see. */
export function pdfToText(pdf: Uint8Array): string {
  if (latin1.decode(pdf.subarray(0, 8)).indexOf("%PDF") < 0) return "";
  if (/\/Encrypt\b/.test(latin1.decode(pdf.subarray(Math.max(0, pdf.length - 2048))))) return "";
  const pages = streams(pdf).map(contentText).filter((t) => t.trim() !== "");
  return pages
    .join("\n\n")
    // printable text only: drop the control bytes a custom-encoded font leaves behind
    .replace(/[^\S\n]*[\u0000-\u0008\u000b-\u001f\u007f]+[^\S\n]*/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
