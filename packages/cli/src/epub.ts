/**
 * A minimal EPUB 3 writer (AGT-2136): one XHTML file per chapter, a nav
 * document and the package file, in a zip of stored (uncompressed) entries.
 * Dependency-free so `pablo publish --target final` needs no pandoc. Pure:
 * the same inputs give the same bytes (fixed timestamps, no random ids).
 */

export interface EpubChapter {
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

export interface EpubBook {
  readonly title: string;
  /** Stable identifier, e.g. the work's slug. */
  readonly id: string;
  readonly chapters: readonly EpubChapter[];
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Inline markdown emphasis in the compiled text (`*x*`, `_x_`) is plain prose here; only escaping is applied. */
function xhtml(title: string, body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">\n<head><meta charset="utf-8"/><title>${esc(title)}</title></head>\n<body>\n${body}\n</body>\n</html>\n`;
}

const encoder = new TextEncoder();

interface Entry {
  readonly name: string;
  readonly data: Uint8Array;
}

function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}

/** A zip of stored entries, in the order given (EPUB needs `mimetype` first). */
export function zipStored(entries: readonly Entry[]): Uint8Array {
  const DOS_TIME = 0;
  const DOS_DATE = (1 << 5) | 1 | ((2000 - 1980) << 9); // 2000-01-01, fixed for reproducible output
  const central: number[][] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = Bun.hash.crc32(entry.data) >>> 0;
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(DOS_TIME), ...u16(DOS_DATE),
      ...u32(crc), ...u32(entry.data.length), ...u32(entry.data.length), ...u16(name.length), ...u16(0),
    ];
    chunks.push(Uint8Array.from(local), name, entry.data);
    central.push([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(DOS_TIME), ...u16(DOS_DATE),
      ...u32(crc), ...u32(entry.data.length), ...u32(entry.data.length), ...u16(name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...Array.from(name),
    ]);
    offset += local.length + name.length + entry.data.length;
  }
  const centralBytes = Uint8Array.from(central.flat());
  const end = Uint8Array.from([
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(centralBytes.length), ...u32(offset), ...u16(0),
  ]);
  chunks.push(centralBytes, end);
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** The book as EPUB 3 bytes. */
export function buildEpub(book: EpubBook): Uint8Array {
  const files = book.chapters.map((_, i) => `chapter-${String(i + 1).padStart(2, "0")}.xhtml`);
  const entries: Entry[] = [
    { name: "mimetype", data: encoder.encode("application/epub+zip") },
    {
      name: "META-INF/container.xml",
      data: encoder.encode(
        `<?xml version="1.0" encoding="utf-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n`,
      ),
    },
  ];
  const manifest = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    ...files.map((f, i) => `<item id="c${i + 1}" href="${f}" media-type="application/xhtml+xml"/>`),
  ];
  const spine = files.map((_, i) => `<itemref idref="c${i + 1}"/>`);
  entries.push({
    name: "OEBPS/content.opf",
    data: encoder.encode(
      `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">\n<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">pablo:${esc(book.id)}</dc:identifier><dc:title>${esc(book.title)}</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">2000-01-01T00:00:00Z</meta></metadata>\n<manifest>\n${manifest.join("\n")}\n</manifest>\n<spine>\n${spine.join("\n")}\n</spine>\n</package>\n`,
    ),
  });
  entries.push({
    name: "OEBPS/nav.xhtml",
    data: encoder.encode(
      xhtml(book.title, `<nav epub:type="toc"><h1>${esc(book.title)}</h1><ol>\n${book.chapters.map((c, i) => `<li><a href="${files[i]}">${esc(c.heading)}</a></li>`).join("\n")}\n</ol></nav>`),
    ),
  });
  book.chapters.forEach((chapter, i) => {
    const body = `<h1>${esc(chapter.heading)}</h1>\n${chapter.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("\n")}`;
    entries.push({ name: `OEBPS/${files[i]}`, data: encoder.encode(xhtml(chapter.heading, body)) });
  });
  return zipStored(entries);
}
