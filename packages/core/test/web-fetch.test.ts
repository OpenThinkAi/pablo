import { describe, expect, test } from "bun:test";
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

const fixedNow = () => new Date("2026-10-26T12:00:00Z");

describe("webFetch", () => {
  test("extracts main text to markdown with url and retrieval date", async () => {
    const r = await webFetch("https://example.com/p", { fetch: fake(PAGE), now: fixedNow });
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
      await expect(webFetch(u, { fetch: f })).rejects.toBeInstanceOf(WebFetchError);
    }
    expect(called).toBe(false);
  });

  test("refuses a redirect to a non-http(s) URL", async () => {
    await expect(webFetch("https://a.com/", { fetch: fake("x", { url: "file:///etc/passwd" }) })).rejects.toMatchObject({ code: "bad-scheme" });
  });

  test("enforces the size cap by header and by streamed body", async () => {
    await expect(webFetch("https://a.com/", { fetch: fake("x", { headers: { "content-length": "999999" } }), maxBytes: 100 })).rejects.toMatchObject({ code: "too-large" });
    await expect(webFetch("https://a.com/", { fetch: fake("y".repeat(500)), maxBytes: 100 })).rejects.toMatchObject({ code: "too-large" });
  });

  test("times out a hung fetch", async () => {
    const hung: WebFetchFn = (_u, init) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    await expect(webFetch("https://a.com/", { fetch: hung, timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
  });

  test("truncates to the token budget", async () => {
    const r = await webFetch("https://a.com/t", { fetch: fake("word ".repeat(1000), { type: "text/plain" }), maxTokens: 50 });
    expect(r.truncated).toBe(true);
    expect(r.markdown).toContain("[truncated");
    expect(r.markdown.length).toBeLessThan(300);
  });

  test("passes plain text through, rejects binary types and HTTP errors", async () => {
    const t = await webFetch("https://a.com/t", { fetch: fake("hello\r\nworld", { type: "text/plain" }) });
    expect(t.markdown).toBe("hello\nworld");
    expect(t.title).toBeNull();
    await expect(webFetch("https://a.com/i", { fetch: fake("x", { type: "image/png" }) })).rejects.toMatchObject({ code: "unsupported-type" });
    await expect(webFetch("https://a.com/n", { fetch: fake("no", { status: 404 }) })).rejects.toMatchObject({ code: "http-status" });
  });

  test("wraps network failures", async () => {
    const f: WebFetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(webFetch("https://a.com/", { fetch: f })).rejects.toMatchObject({ code: "network" });
  });
});

describe("htmlToMarkdown", () => {
  test("decodes entities and falls back to the body", () => {
    expect(htmlToMarkdown("<body><p>a&nbsp;&lt;b&gt; &#65;</p></body>").markdown).toBe("a <b> A");
  });
});
