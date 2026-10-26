import { afterAll, expect, test } from "bun:test";
import {
  NO_BACKEND_MESSAGE,
  ProviderConfigError,
  WebSearchError,
  parseConfig,
  webSearch,
} from "../src/index";

// A fixture SearXNG on a random local port; the real network is never touched.
const requests: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    requests.push(url.pathname + url.search);
    if (url.pathname !== "/search") return new Response("nope", { status: 404 });
    const q = url.searchParams.get("q");
    if (q === "forbidden") return new Response("no", { status: 403 });
    if (q === "garbage") return Response.json({ nothing: true });
    return Response.json({
      results: [
        { title: "Ice houses", url: "https://example.org/ice", content: "Cut in winter." },
        { url: "https://example.org/no-title" },
        { title: "no url" },
        { title: "Third", url: "https://example.org/3", content: "x" },
      ],
    });
  },
});
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;
const configured = (extra = "") =>
  parseConfig(JSON.stringify({ web: { search: { backend: "searxng", url: `${base}/` , ...(extra ? { timeoutMs: 5 } : {}) } } }));

test("with no backend configured, web_search says so", async () => {
  const error = await webSearch("ice houses", { config: parseConfig("{}").web }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(WebSearchError);
  expect((error as Error).message).toBe(NO_BACKEND_MESSAGE);
  expect(parseConfig("{}").web).toEqual({});
});

test("the searxng backend calls <base>/search?format=json and maps results", async () => {
  requests.length = 0;
  const results = await webSearch("ice houses", { config: configured().web });
  expect(requests).toEqual(["/search?q=ice+houses&format=json"]);
  expect(results).toEqual([
    { title: "Ice houses", url: "https://example.org/ice", snippet: "Cut in winter." },
    { title: "https://example.org/no-title", url: "https://example.org/no-title", snippet: "" },
    { title: "Third", url: "https://example.org/3", snippet: "x" },
  ]);
});

test("limit trims the results", async () => {
  expect(await webSearch("ice", { config: configured().web, limit: 1 })).toHaveLength(1);
});

test("an injected fetch seam is used instead of the network", async () => {
  const seen: string[] = [];
  const results = await webSearch("q", {
    config: configured().web,
    fetch: async (url) => {
      seen.push(url);
      return { ok: true, status: 200, json: async () => ({ results: [{ title: "T", url: "https://t", content: "c" }] }) };
    },
  });
  expect(seen).toEqual([`${base}/search?q=q&format=json`]);
  expect(results).toEqual([{ title: "T", url: "https://t", snippet: "c" }]);
});

test("a custom backend can be plugged in", async () => {
  const results = await webSearch("q", { backend: { name: "fake", search: async () => [{ title: "a", url: "u", snippet: "s" }] } });
  expect(results).toHaveLength(1);
});

test("backend failures are named", async () => {
  const web = configured().web;
  await expect(webSearch("forbidden", { config: web })).rejects.toThrow(/answered 403.*search\.formats/);
  await expect(webSearch("garbage", { config: web })).rejects.toThrow(/no "results" list/);
  const down = parseConfig(JSON.stringify({ web: { search: { backend: "searxng", url: "http://127.0.0.1:1" } } })).web;
  await expect(webSearch("x", { config: down })).rejects.toThrow(/could not reach searxng/);
  await expect(webSearch("  ", { config: web })).rejects.toThrow(/query is empty/);
});

test("a bad web.search block is reported by name", () => {
  const bad = (web: unknown): void => {
    expect(() => parseConfig(JSON.stringify({ web }))).toThrow(ProviderConfigError);
  };
  bad("x");
  bad({ search: "x" });
  bad({ search: { backend: "brave", url: "http://x" } });
  bad({ search: { backend: "searxng" } });
  bad({ search: { backend: "searxng", url: "ftp://x" } });
  bad({ search: { backend: "searxng", url: "not a url" } });
  bad({ search: { backend: "searxng", url: "http://x", timeoutMs: -1 } });
});
