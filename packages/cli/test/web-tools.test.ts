import { expect, test } from "bun:test";
import type { SearchBackend, WebFetchFn } from "@openthink/pablo-core";
import { harnessTools } from "../src/harness/tools";
import { harnessSystemPrompt } from "../src/harness/prompt";
import type { VerbContext } from "../src/verbs";
import { VERBS } from "../src/verbs";

// AGT-2126: nothing here touches the network; every call goes through the fake seams.
const publicDns = async () => ["93.184.216.34"];
const page = (body: string): WebFetchFn => async () => new Response(body, { headers: { "content-type": "text/html" } });

function ctx(web: VerbContext["web"]): VerbContext {
  return { cwd: process.cwd(), env: { XDG_CONFIG_HOME: "/nonexistent-pablo-test" }, stderr: { write() {} }, web };
}
const tool = (name: string) => {
  const found = harnessTools().find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
};

test("the agent's tools include web_search and web_fetch by plain name, and no SDK built-ins", () => {
  const names = harnessTools().map((t) => t.name);
  expect(names).toContain("web_search");
  expect(names).toContain("web_fetch");
  expect(names).not.toContain("WebSearch");
  expect(names).not.toContain("WebFetch");
  expect(VERBS.some((v) => v.name === "web")).toBe(true);
});

test("web_search returns the backend's ranked results", async () => {
  const backend: SearchBackend = {
    name: "fake",
    search: async (query, options) => [{ title: `about ${query}`, url: "https://example.test/a", snippet: `limit ${options?.limit}` }],
  };
  const r = await tool("web_search").run({ query: "ice prices 1929", limit: 3 }, ctx({ search: { backend } }));
  expect(r.exitCode).toBe(0);
  expect(r.body).toEqual({ ok: true, query: "ice prices 1929", results: [{ title: "about ice prices 1929", url: "https://example.test/a", snippet: "limit 3" }] });
});

test("web_search with no backend configured fails with the config hint", async () => {
  const r = await tool("web_search").run({ query: "x" }, ctx(undefined));
  expect(r.exitCode).toBe(1);
  expect((r.body as { message: string }).message).toContain("no search backend configured");
});

test("web_fetch returns markdown with the final URL and retrieval date", async () => {
  const r = await tool("web_fetch").run(
    { url: "https://example.test/ice" },
    ctx({ fetch: { fetch: page("<html><head><title>Ice</title></head><body><p>Cold.</p></body></html>"), resolveHost: publicDns, now: () => new Date("2029-01-02T00:00:00Z") } }),
  );
  expect(r.exitCode).toBe(0);
  const body = r.body as { ok: boolean; title: string; markdown: string; retrievedAt: string; url: string };
  expect(body).toMatchObject({ ok: true, title: "Ice", retrievedAt: "2029-01-02", url: "https://example.test/ice" });
  expect(body.markdown).toContain("Cold.");
});

test("web_fetch refuses a private address and a non-http scheme as exit 2", async () => {
  const web = { fetch: { fetch: page("x"), resolveHost: async () => ["10.0.0.1"] } };
  const blocked = await tool("web_fetch").run({ url: "https://intranet.test/" }, ctx(web));
  expect(blocked.exitCode).toBe(2);
  const scheme = await tool("web_fetch").run({ url: "file:///etc/passwd" }, ctx(web));
  expect(scheme.exitCode).toBe(2);
});

test("the system prompt names the web tools and still forbids invented sources", () => {
  const prompt = harnessSystemPrompt({ title: "T", format: "novel", slug: "t" });
  expect(prompt).not.toContain("no web access");
  expect(prompt).toContain("`web_search`");
  expect(prompt).toContain("`web_fetch`");
  expect(prompt).toContain("Never invent a source, a citation or a retrieval date");
});
