/**
 * AGT-2185: `pablo story`'s research stage searches the web when a search backend is configured, and saves notes
 * that cite the page it fetched. Without one, the stages are not offered the web tools and the stage says so. Every
 * run is on a temp git copy of the synthetic fixture vault, pablo's real agent loop on a scripted model, a fake
 * search backend and a fake fetch: no model, no network, never `~/writing`.
 */

import { afterAll, afterEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScriptedChatAdapter } from "@openthink/pablo-core";
import type { ChatEvent, ChatRequest, SearchBackend, WebFetchFn } from "@openthink/pablo-core";
import { adapterProvider } from "../src/harness/provider";
import { runStory, stageMessage, webConfigured } from "../src/story";
import type { VerbContext } from "../src/verbs";
import { fakeTrackPlanner } from "./track-planner";
import { useLocalConfigHome } from "./local-config";

useLocalConfigHome();

const FIXTURE_VAULT = fileURLToPath(new URL("./fixtures/vault", import.meta.url));
const NO_THINK_PATH = [dirname(Bun.which("bun") ?? "/usr/local/bin/bun"), "/usr/bin", "/bin"].join(":");
const SPEC = "write me a story about a fishing family in a Ligurian village who are offered one passage to New York";
const PAGE_URL = "https://example.org/liguria-fishing-1900";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  return result.stdout.toString("utf8").trim();
}

function tempVault(web?: VerbContext["web"]): { vault: string; ctx: VerbContext } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pablo-story-web-")));
  roots.push(root);
  const vault = join(root, "vault");
  cpSync(FIXTURE_VAULT, vault, { recursive: true });
  git(vault, "init", "-q", "-b", "main");
  git(vault, "config", "user.email", "pablo-test@example.com");
  git(vault, "config", "user.name", "Pablo Test");
  git(vault, "config", "commit.gpgsign", "false");
  git(vault, "add", ".");
  git(vault, "commit", "-q", "-m", "base");
  const env = { PABLO_VAULT: vault, PABLO_HOME: join(root, "pablo-home"), PATH: NO_THINK_PATH, HOME: root, XDG_CONFIG_HOME: join(root, "config") };
  return { vault, ctx: { cwd: vault, env, stderr: { write: () => {} }, ...(web === undefined ? {} : { web }) } };
}

/** The latest assistant turn's single tool call name, and its result body. */
function lastResult(request: ChatRequest): { name: string; body: Record<string, any> } {
  const messages = request.messages;
  const result = messages.at(-1)!;
  const assistant = [...messages].reverse().find((m) => m.role === "assistant");
  const call = assistant?.role === "assistant" ? assistant.toolCalls?.at(-1) : undefined;
  return { name: call?.name ?? "", body: JSON.parse(result.role === "tool" ? result.content : "{}") as Record<string, any> };
}

/**
 * A model that researches as the stage asks: web_search, then web_fetch on the first result, then save_research
 * citing the url and retrievedAt the fetch returned. It records each stage's message and offered tools.
 */
function researchingModel() {
  const offered: string[][] = [];
  const messages: string[] = [];
  const calls: string[] = [];
  let n = 0;
  const call = (name: string, args: Record<string, unknown>): ChatEvent[] => {
    calls.push(name);
    return [{ type: "tool_call", call: { id: `call-${++n}`, name, arguments: args } }];
  };
  const turn = (request: ChatRequest): readonly ChatEvent[] => {
    const last = request.messages.at(-1)!;
    if (last.role === "user") {
      messages.push(last.content);
      offered.push(request.tools.map((t) => t.name));
      if (!/Stage 1 of 5, research\./.test(last.content) || !request.tools.some((t) => t.name === "web_search")) return [{ type: "text", text: "done" }];
      return call("web_search", { query: "Ligurian fishing villages 1900 anchovy" });
    }
    const { name, body } = lastResult(request);
    if (body.ok === false) throw new Error(`${name} refused: ${body.message}`);
    if (name === "web_search") return call("web_fetch", { url: body.results[0].url });
    if (name === "web_fetch") {
      return call("save_research", {
        title: "Ligurian fishing villages, 1900",
        note: "Camogli's fleet fished anchovy and sardine; emigrants sailed from Genoa.",
        sources: [`${body.url} (retrieved ${body.retrievedAt})`],
      });
    }
    return [{ type: "text", text: "done" }];
  };
  const adapter = createScriptedChatAdapter({ turns: Array.from({ length: 50 }, () => turn), id: "scripted-agent", model: "scripted-agent-model" });
  return { provider: adapterProvider(adapter, { local: true }), offered, messages, calls };
}

const today = new Date();
const TODAY = today.toISOString().slice(0, 10);

function webSeams(queries: string[]): NonNullable<VerbContext["web"]> {
  const backend: SearchBackend = {
    name: "fake",
    search: async (query) => {
      queries.push(query);
      return [{ title: "Fishing in Liguria, 1900", url: PAGE_URL, snippet: "anchovy and sardine" }];
    },
  };
  const fetch: WebFetchFn = async () =>
    new Response("<html><head><title>Fishing in Liguria</title></head><body><p>Camogli's fleet fished anchovy.</p></body></html>", {
      headers: { "content-type": "text/html" },
    });
  return { search: { backend }, fetch: { fetch, resolveHost: async () => ["93.184.216.34"], now: () => today } };
}

test("AC1+AC3: with a search backend the research stage is offered the web tools, searches, fetches, and saves a note citing the fetched URL and retrieval date", async () => {
  const queries: string[] = [];
  const { vault, ctx } = tempVault(webSeams(queries));
  const model = researchingModel();
  const result = await runStory({ prompt: SPEC, review: true, track: "fiction" }, ctx, { agent: model.provider, planner: fakeTrackPlanner() });
  const body = result.body as Record<string, any>;
  expect(result.exitCode).toBe(0);
  expect(body.waiting.step).toBe("core:research");

  expect(model.offered[0]).toEqual(expect.arrayContaining(["web_search", "web_fetch", "save_research"]));
  expect(model.messages[0]).toContain("Search the web with web_search");
  expect(model.messages[0]).toContain("Every note cites at least one page you fetched");
  expect(model.messages[0]).not.toContain("no web access");
  expect(model.calls).toEqual(["web_search", "web_fetch", "save_research"]);
  expect(queries).toEqual(["Ligurian fishing villages 1900 anchovy"]);

  const branch = body.waiting.branch as string;
  const note = git(vault, "show", `${branch}:stories/${body.project}/research/ligurian-fishing-villages-1900.md`);
  expect(note).toContain(`Retrieved: ${TODAY}`);
  expect(note).toContain(`## Sources\n\n- ${PAGE_URL} (retrieved ${TODAY})`);
});

test("AC1: without a search backend the stages are not offered the web tools and the research stage says so", async () => {
  const { ctx } = tempVault();
  const model = researchingModel();
  // The scripted model saves nothing here, so the run stops later on an unmet stage; only the research turn matters.
  await runStory({ prompt: SPEC, review: true, track: "fiction" }, ctx, { agent: model.provider, planner: fakeTrackPlanner() });
  for (const tools of model.offered) expect(tools).not.toContain("web_search");
  expect(model.offered[0]).not.toContain("web_search");
  expect(model.offered[0]).not.toContain("web_fetch");
  expect(model.offered[0]).toContain("save_research");
  expect(model.messages[0]).toContain("You have no web access");
  expect(model.calls).toEqual([]);
});

test("webConfigured reads web.search from the config file, and the research text follows it", () => {
  const env = { XDG_CONFIG_HOME: "/nonexistent-pablo-test" };
  const withSearch = JSON.stringify({ web: { search: { backend: "searxng", url: "http://127.0.0.1:8080" } } });
  expect(webConfigured({ env }, () => withSearch)).toBe(true);
  expect(webConfigured({ env }, () => JSON.stringify({}))).toBe(false);
  expect(webConfigured({ env }, () => undefined)).toBe(false);
  const state = { prompt: SPEC, outputs: ["story"], review: false };
  expect(stageMessage("research", state, "T", "t", true)).toContain("web_fetch");
  expect(stageMessage("research", state, "T", "t", false)).toContain("You have no web access");
  expect(stageMessage("premise", state, "T", "t", true)).not.toContain("web_search");
});

test("AC2: the research stage's save_research refuses a note citing general knowledge, and the stage fails naming it", async () => {
  const { ctx } = tempVault();
  const model = createScriptedChatAdapter({
    id: "scripted-agent",
    turns: Array.from({ length: 10 }, () => (request: ChatRequest): readonly ChatEvent[] => {
      const last = request.messages.at(-1)!;
      if (last.role === "user") {
        return [{ type: "tool_call", call: { id: "c1", name: "save_research", arguments: { title: "Fishing", note: "Anchovy.", sources: ["General knowledge of Ligurian fishing practice"] } } }];
      }
      const { body } = lastResult(request);
      return [{ type: "text", text: body.ok === false ? `refused: ${body.message}` : "saved" }];
    }),
  });
  const result = await runStory({ prompt: SPEC, review: true, track: "fiction" }, ctx, { agent: adapterProvider(model, { local: true }), planner: fakeTrackPlanner() });
  // The stage itself ends (the model answered); the note was never written, so nothing waits on a branch.
  const refusal = model.requests.flatMap((r) => r.messages).find((m) => m.role === "tool");
  expect(refusal?.role === "tool" ? refusal.content : "").toContain("not a source");
  expect(JSON.stringify(result.body)).not.toContain("ligurian-fishing");
});
