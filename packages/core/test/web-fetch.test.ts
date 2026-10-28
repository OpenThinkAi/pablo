import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { WebFetchError, htmlToMarkdown, webFetch, type WebFetchFn } from "../src/web/fetch";

const PAGE = `<!doctype html><html><head><title>A &amp; B</title><style>.x{}</style><script>evil()</script></head>
<body><nav>Home | About</nav><main><h1>Heading</h1><p>First <strong>bold</strong> and <a href="https://e.com/x">a link</a>.</p>
<ul><li>one</li><li>two</li></ul><pre>code  here</pre></main><footer>copyright</footer></body></html>`;

function fake(body: string, init: { status?: number; type?: string; headers?: Record<string, string>; url?: string } = {}): WebFetchFn {
  return async (u) => {
    const res = new Response(body, { status: init.status ?? 200, headers: { "content-type": init.type ?? "text/html; charset=utf-8", ...init.headers } });
    Object.defineProperty(res, "url", { value: init.url ?? u });
    return res;
  };
}

const publicDns = async () => ["93.184.216.34"];
function redirectTo(location: string): WebFetchFn {
  return async () => new Response(null, { status: 302, headers: { location } });
}

const fixedNow = () => new Date("2026-10-26T12:00:00Z");

describe("webFetch", () => {
  test("extracts main text to markdown with url and retrieval date", async () => {
    const r = await webFetch("https://example.com/p", { resolveHost: publicDns, fetch: fake(PAGE), now: fixedNow });
    expect(r.url).toBe("https://example.com/p");
    expect(r.retrievedAt).toBe("2026-10-26");
    expect(r.title).toBe("A & B");
    expect(r.markdown).toContain("# Heading");
    expect(r.markdown).toContain("**bold**");
    expect(r.markdown).toContain("[a link](https://e.com/x)");
    expect(r.markdown).toContain("- one\n- two");
    expect(r.markdown).toContain("```\ncode  here\n```");
    expect(r.markdown).not.toContain("evil");
    expect(r.markdown).not.toContain("Home |");
    expect(r.markdown).not.toContain("copyright");
    expect(r.truncated).toBe(false);
  });

  test("refuses non-http(s) and invalid URLs without fetching", async () => {
    let called = false;
    const f: WebFetchFn = async () => {
      called = true;
      return new Response("x");
    };
    for (const u of ["file:///etc/passwd", "ftp://x.com/a", "javascript:alert(1)", "not a url"]) {
      await expect(webFetch(u, { fetch: f, resolveHost: publicDns })).rejects.toBeInstanceOf(WebFetchError);
    }
    expect(called).toBe(false);
  });

  test("refuses a redirect to a non-http(s) URL", async () => {
    await expect(webFetch("https://a.com/", { resolveHost: publicDns, fetch: redirectTo("file:///etc/passwd") })).rejects.toMatchObject({ code: "bad-scheme" });
  });

  test("refuses local, private and link-local hosts, and names that resolve to them", async () => {
    let called = 0;
    const f: WebFetchFn = async () => {
      called++;
      return new Response("x");
    };
    const urls = ["http://127.0.0.1:8002/", "http://localhost/", "http://foo.localhost/", "http://169.254.169.254/", "http://[::1]/", "http://10.0.0.1/", "http://172.16.5.5/", "http://192.168.1.1/", "http://0.0.0.0/", "http://2130706433/", "http://0x7f.1/", "http://100.64.0.1/", "http://[fe80::1]/", "http://[fc00::1]/", "http://[::ffff:127.0.0.1]/"];
    for (const u of urls) await expect(webFetch(u, { fetch: f, resolveHost: publicDns })).rejects.toMatchObject({ code: "blocked-host" });
    await expect(webFetch("https://sneaky.example/", { fetch: f, resolveHost: async () => ["10.1.2.3"] })).rejects.toMatchObject({ code: "blocked-host" });
    expect(called).toBe(0);
  });

  test("checks every redirect hop and caps the chain", async () => {
    await expect(webFetch("https://a.com/", { resolveHost: publicDns, fetch: redirectTo("http://169.254.169.254/latest") })).rejects.toMatchObject({ code: "blocked-host" });
    const loop: WebFetchFn = async (u) => new Response(null, { status: 302, headers: { location: `${u}x` } });
    await expect(webFetch("https://a.com/", { resolveHost: publicDns, fetch: loop, maxRedirects: 3 })).rejects.toMatchObject({ code: "too-many-redirects" });
    let n = 0;
    const ok: WebFetchFn = async () => (n++ === 0 ? new Response(null, { status: 301, headers: { location: "/next" } }) : new Response("hi", { headers: { "content-type": "text/plain" } }));
    const r = await webFetch("https://a.com/start", { resolveHost: publicDns, fetch: ok });
    expect(r.finalUrl).toBe("https://a.com/next");
    expect(r.markdown).toBe("hi");
  });

  test("enforces the size cap by header and by streamed body", async () => {
    await expect(webFetch("https://a.com/", { resolveHost: publicDns, fetch: fake("x", { headers: { "content-length": "999999" } }), maxBytes: 100 })).rejects.toMatchObject({ code: "too-large" });
    await expect(webFetch("https://a.com/", { resolveHost: publicDns, fetch: fake("y".repeat(500)), maxBytes: 100 })).rejects.toMatchObject({ code: "too-large" });
  });

  test("times out a hung fetch", async () => {
    const hung: WebFetchFn = (_u, init) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    await expect(webFetch("https://a.com/", { resolveHost: publicDns, fetch: hung, timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
  });

  test("truncates to the token budget", async () => {
    const r = await webFetch("https://a.com/t", { resolveHost: publicDns, fetch: fake("word ".repeat(1000), { type: "text/plain" }), maxTokens: 50 });
    expect(r.truncated).toBe(true);
    expect(r.markdown).toContain("[truncated");
    expect(r.markdown.length).toBeLessThan(300);
  });

  test("passes plain text through, rejects binary types and HTTP errors", async () => {
    const t = await webFetch("https://a.com/t", { resolveHost: publicDns, fetch: fake("hello\r\nworld", { type: "text/plain" }) });
    expect(t.markdown).toBe("hello\nworld");
    expect(t.title).toBeNull();
    await expect(webFetch("https://a.com/i", { resolveHost: publicDns, fetch: fake("x", { type: "image/png" }) })).rejects.toMatchObject({ code: "unsupported-type" });
    await expect(webFetch("https://a.com/n", { resolveHost: publicDns, fetch: fake("no", { status: 404 }) })).rejects.toMatchObject({ code: "http-status" });
  });

  test("wraps network failures", async () => {
    const f: WebFetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(webFetch("https://a.com/", { fetch: f, resolveHost: publicDns })).rejects.toMatchObject({ code: "network" });
  });
});

describe("htmlToMarkdown", () => {
  test("decodes entities and falls back to the body", () => {
    expect(htmlToMarkdown("<body><p>a&nbsp;&lt;b&gt; &#65;</p></body>").markdown).toBe("a <b> A");
  });
});

// A tiny hand-built PDF (AGT-2192): one page whose content stream shows text with Tj and TJ, optionally Flate-compressed.
function pdfBytes(content: string, flate: boolean): Uint8Array {
  const body = flate ? deflateSync(Buffer.from(content, "latin1")) : Buffer.from(content, "latin1");
  const head = Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${body.length}${flate ? " /Filter /FlateDecode" : ""} >>\nstream\n`, "latin1");
  const tail = Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1");
  return new Uint8Array(Buffer.concat([head, body, tail]));
}
const PDF_CONTENT = "BT /F1 12 Tf 72 700 Td (Canyon Brochure \\(2026\\)) Tj 0 -14 Td [(Trails) -300 (open) 20 (daily)] TJ 0 -14 Td <48656C6C6F> Tj ET";
function fakeBytes(bytes: Uint8Array, type: string): WebFetchFn {
  return async () => new Response(Buffer.from(bytes), { status: 200, headers: { "content-type": type } });
}

describe("webFetch PDFs", () => {
  for (const flate of [false, true]) {
    test(`extracts text from a ${flate ? "Flate-compressed" : "plain"} PDF`, async () => {
      const r = await webFetch("https://nps.gov/b.pdf", { resolveHost: publicDns, fetch: fakeBytes(pdfBytes(PDF_CONTENT, flate), "application/pdf") });
      expect(r.markdown).toBe("Canyon Brochure (2026)\nTrails opendaily\nHello");
    });
  }

  test("a PDF over the byte cap is refused, and one with no text is unsupported", async () => {
    await expect(webFetch("https://a.com/b.pdf", { resolveHost: publicDns, maxBytes: 50, fetch: fakeBytes(pdfBytes(PDF_CONTENT, false), "application/pdf") })).rejects.toMatchObject({ code: "too-large" });
    await expect(webFetch("https://a.com/s.pdf", { resolveHost: publicDns, fetch: fakeBytes(pdfBytes("0 0 m 10 10 l S", false), "application/pdf") })).rejects.toMatchObject({ code: "unsupported-type" });
  });
});
