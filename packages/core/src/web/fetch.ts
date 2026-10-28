// web_fetch (AGT-2123, D-11): pablo's own page fetcher for research, so it no
// longer leans on Claude Code's WebFetch. http(s) only, a size cap, a timeout,
// main-text extraction to markdown and a token budget. The result keeps the URL
// and the retrieval date so `save_research` can record a source. Core stays
// dependency-free, so the HTML reduction is a small hand-rolled pass, and the
// network is an injected `fetch` seam (tests never touch a real one).

import { pdfToText } from "./pdf";

export type WebFetchFn = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: "follow" | "manual" | "error" }) => Promise<Response>;

export interface WebFetchOptions {
  /** The fetch implementation; defaults to the global `fetch`. */
  fetch?: WebFetchFn;
  /** Hard cap on bytes read from the body. Default 2 MiB. */
  maxBytes?: number;
  /** Abort after this many milliseconds (headers and body together). Default 15000. */
  timeoutMs?: number;
  /** Truncate the extracted markdown to roughly this many tokens. Default 4000. */
  maxTokens?: number;
  /** Resolve a hostname to its addresses for the private-address check; defaults to `node:dns`. */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Redirect hops followed (each re-checked) before giving up. Default 5. */
  maxRedirects?: number;
  /** Clock for the retrieval date. */
  now?: () => Date;
}

export interface WebFetchResult {
  /** The URL as requested. */
  url: string;
  /** The URL after redirects. */
  finalUrl: string;
  /** ISO date (YYYY-MM-DD) of retrieval, for `save_research` sources. */
  retrievedAt: string;
  title: string | null;
  markdown: string;
  /** True when the markdown was cut to the token budget. */
  truncated: boolean;
  /** Estimated tokens in `markdown`. */
  tokens: number;
}

export type WebFetchErrorCode = "bad-url" | "bad-scheme" | "blocked-host" | "too-many-redirects" | "http-status" | "too-large" | "timeout" | "unsupported-type" | "network";

export class WebFetchError extends Error {
  constructor(readonly code: WebFetchErrorCode, message: string) {
    super(message);
    this.name = "WebFetchError";
  }
}

export const WEB_FETCH_DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const WEB_FETCH_DEFAULT_TIMEOUT_MS = 15_000;
export const WEB_FETCH_DEFAULT_MAX_TOKENS = 4000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function webFetch(url: string, options: WebFetchOptions = {}): Promise<WebFetchResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WebFetchError("bad-url", `not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new WebFetchError("bad-scheme", `only http and https URLs can be fetched, not ${parsed.protocol}`);
  }
  const doFetch = options.fetch ?? ((u, init) => fetch(u, init));
  const maxBytes = options.maxBytes ?? WEB_FETCH_DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? WEB_FETCH_DEFAULT_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? WEB_FETCH_DEFAULT_MAX_TOKENS;
  const now = options.now ?? (() => new Date());

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    let res: Response;
    let current = parsed;
    const maxRedirects = options.maxRedirects ?? 5;
    for (let hop = 0; ; hop++) {
      try {
        await assertPublicHost(current, options.resolveHost);
        res = await doFetch(current.href, {
          signal: controller.signal,
          headers: { accept: "text/html,text/plain,text/markdown,application/pdf;q=0.9,*/*;q=0.1", "user-agent": "pablo-web-fetch" },
          redirect: "manual",
        });
      } catch (err) {
        throw wrapNetwork(err, timedOut, timeoutMs, current.href);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        if (hop >= maxRedirects) throw new WebFetchError("too-many-redirects", `${parsed.href} redirected more than ${maxRedirects} times`);
        let next: URL;
        try {
          next = new URL(res.headers.get("location")!, current);
        } catch {
          throw new WebFetchError("bad-url", `${current.href} redirected to an invalid URL`);
        }
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          throw new WebFetchError("bad-scheme", `redirected to a non-http(s) URL: ${next.href}`);
        }
        await res.body?.cancel().catch(() => {});
        current = next;
        continue;
      }
      break;
    }
    const finalUrl = current.href;
    if (!res.ok) throw new WebFetchError("http-status", `${parsed.href} returned HTTP ${res.status}`);

    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const isHtml = type === "text/html" || type === "application/xhtml+xml";
    const isPdf = type === "application/pdf";
    if (type !== "" && !isHtml && !isPdf && !type.startsWith("text/")) {
      throw new WebFetchError("unsupported-type", `unsupported content type ${type} for ${parsed.href}`);
    }
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new WebFetchError("too-large", `${parsed.href} is ${declared} bytes, over the ${maxBytes}-byte cap`);
    }

    let bytes: Uint8Array;
    try {
      bytes = await readCapped(res, maxBytes, parsed.href);
    } catch (err) {
      throw wrapNetwork(err, timedOut, timeoutMs, parsed.href);
    }

    let title: string | null = null;
    let markdown: string;
    const body = isPdf ? "" : new TextDecoder("utf-8").decode(bytes);
    if (isPdf) {
      markdown = pdfToText(bytes);
      if (markdown === "") throw new WebFetchError("unsupported-type", `${parsed.href} is a PDF with no extractable text (scanned, encrypted or custom-encoded)`);
    } else if (isHtml || (type === "" && /<\s*(html|body|p|div)\b/i.test(body))) {
      const extracted = htmlToMarkdown(body);
      title = extracted.title;
      markdown = extracted.markdown;
    } else {
      markdown = body.replace(/\r\n?/g, "\n").trim();
    }

    const budget = Math.max(1, maxTokens) * 4;
    const truncated = markdown.length > budget;
    if (truncated) markdown = `${markdown.slice(0, budget).trimEnd()}\n\n[truncated to the ${maxTokens}-token budget]`;
    return {
      url,
      finalUrl,
      retrievedAt: now().toISOString().slice(0, 10),
      title,
      markdown,
      truncated,
      tokens: estimateTokens(markdown),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Hosts the fetcher refuses: loopback, private, link-local and other non-public ranges. */
export function isBlockedAddress(raw: string): boolean {
  const host = raw.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (host.includes(":")) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return isBlockedAddress(mapped[1]!);
    if (/^::ffff:[0-9a-f]+:[0-9a-f]+$/.test(host)) return true;
    if (host === "::" || host === "::1") return true;
    const first = parseInt(host.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}

async function assertPublicHost(url: URL, resolveHost?: (host: string) => Promise<string[]>): Promise<void> {
  const host = url.hostname;
  if (isBlockedAddress(host)) throw new WebFetchError("blocked-host", `refusing to fetch a local or private address: ${host}`);
  if (/^[\d.]+$/.test(host) || host.includes(":")) return; // an IP literal, already checked
  const resolve =
    resolveHost ??
    (async (name: string) => {
      const dns = await import("node:dns/promises");
      return (await dns.lookup(name, { all: true })).map((r) => r.address);
    });
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (err) {
    throw new WebFetchError("network", `could not resolve ${host}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const bad = addresses.find(isBlockedAddress);
  if (bad) throw new WebFetchError("blocked-host", `${host} resolves to a local or private address (${bad})`);
}

function wrapNetwork(err: unknown, timedOut: boolean, timeoutMs: number, url: string): Error {
  if (err instanceof WebFetchError) return err;
  if (timedOut) return new WebFetchError("timeout", `${url} did not finish within ${timeoutMs} ms`);
  return new WebFetchError("network", `could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`);
}

async function readCapped(res: Response, maxBytes: number, url: string): Promise<Uint8Array> {
  const tooLarge = () => new WebFetchError("too-large", `${url} is over the ${maxBytes}-byte cap`);
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    if (all.length > maxBytes) throw tooLarge();
    return all;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return all;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      } catch {
        return m;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Reduce an HTML page to its main text as markdown. Exported for tests. */
export function htmlToMarkdown(html: string): { title: string | null; markdown: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? collapse(decodeEntities(stripTags(titleMatch[1]!))) || null : null;

  let h = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of ["script", "style", "noscript", "svg", "template", "head", "nav", "footer", "aside", "form", "iframe"]) {
    h = h.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, "gi"), " ");
  }
  const main = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(h) ?? /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(h) ?? /<body\b[^>]*>([\s\S]*?)(?:<\/body\s*>|$)/i.exec(h);
  h = main ? main[1]! : h;

  const blocks: string[] = [];
  h = h.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, inner: string) => {
    blocks.push(`\`\`\`\n${decodeEntities(stripTags(inner)).replace(/^\n+|\n+$/g, "")}\n\`\`\``);
    return `\n\n\u0000PRE${blocks.length - 1}\u0000\n\n`;
  });
  h = h.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, n: string, inner: string) => `\n\n${"#".repeat(Number(n))} ${collapse(stripTags(inner))}\n\n`);
  h = h.replace(/<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, d: string | undefined, s: string | undefined, inner: string) => {
    const href = d ?? s ?? "";
    const text = collapse(stripTags(inner));
    return text && /^https?:/i.test(href) ? `[${text}](${href})` : text;
  });
  h = h.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) => (collapse(stripTags(inner)) ? `**${collapse(stripTags(inner))}**` : ""));
  h = h.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) => (collapse(stripTags(inner)) ? `*${collapse(stripTags(inner))}*` : ""));
  h = h.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_m, inner: string) => `\`${stripTags(inner)}\``);
  h = h.replace(/<li\b[^>]*>/gi, "\n- ");
  h = h.replace(/<blockquote\b[^>]*>/gi, "\n\n> ");
  h = h.replace(/<br\s*\/?>/gi, "\n");
  h = h.replace(/<\/(p|div|section|ul|ol|table|tr|blockquote|figure|figcaption|dd|dt)\s*>/gi, "\n\n");
  h = h.replace(/<(p|div|section|ul|ol|table|tr)\b[^>]*>/gi, "\n\n");

  const text = decodeEntities(stripTags(h))
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0000PRE(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)]!)
    .trim();
  return { title, markdown: text };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

function collapse(s: string): string {
  return decodeEntities(s).replace(/\s+/g, " ").trim();
}
