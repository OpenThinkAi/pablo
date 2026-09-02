/**
 * AGT-1202 — the structured-output bake-off.
 *
 * Runs both structured paths of one adapter over the fixtures in `bench/spans`:
 * a native `propose_edit` tool call whose argument is a replacement string, and
 * CriticMarkup in the completion body. Every answer goes through
 * `validateProposal` — for the tool path, wrapped into the substitution the app
 * would write, which is the form the answer actually has to survive as — and
 * each failure is labelled with the mangling classes in `classify.ts`. Then it
 * runs the `extract_facts` tool call over the same passages and checks each
 * anchor verbatim, the way the writing-lab extraction bench does.
 *
 * This is a bench, not a test. It talks to a real endpoint, takes tens of
 * minutes, and is run by hand:
 *
 * ```sh
 * bun run bench/bakeoff.ts --adapter local
 * bun run bench/bakeoff.ts --adapter openai --paths tool --json out.json
 * ```
 *
 * `--adapter` is any provider id in the config, so the Anthropic adapter
 * (AGT-1206) is measurable the day it registers, with no change here.
 */

import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import {
  createProviders,
  loadConfig,
  validateProposal,
  type Adapter,
  type ExtractedFact,
  type Intent,
  type OutputMode,
  type PabloConfig,
  type ProviderConfig,
} from "../packages/core/src/index";
import { classify, MANGLING_CLASSES, type ManglingClass } from "./classify";
import { countWords, loadSpans, type BenchSpan } from "./spans";

const DEFAULT_SPANS = fileURLToPath(new URL("./spans", import.meta.url));
/** The RateMeter starts cold, so nothing stretches the first request's budget: be generous. */
const DEFAULT_TIMEOUT_MS = 300_000;
const REVISE: Intent = { name: "bakeoff", kind: "revising" };
const EXTRACT_INSTRUCTION =
  "Every fact a later chapter could contradict: names, roles, relationships, objects, places," +
  " times, what characters know, and what was said aloud.";

interface Options {
  readonly adapter: string;
  readonly spansDir: string;
  readonly paths: readonly OutputMode[];
  readonly timeoutMs: number;
  readonly maxTokens: number;
  readonly temperature: number;
  readonly limit: number | undefined;
  readonly json: string | undefined;
  readonly extract: boolean;
  readonly proposals: boolean;
}

interface ProposalResult {
  readonly spanId: string;
  readonly path: OutputMode;
  readonly words: number;
  readonly ok: boolean;
  readonly failure: string | undefined;
  readonly mangling: readonly ManglingClass[];
  readonly wallMs: number;
  readonly outWords: number;
}

interface ExtractResult {
  readonly spanId: string;
  readonly ok: boolean;
  readonly failure: string | undefined;
  readonly facts: number;
  readonly anchorsOk: number;
  /** Anchors that match once whitespace is collapsed: a hard wrap rather than a paraphrase. */
  readonly anchorsOkUnwrapped: number;
  readonly wallMs: number;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = withTimeout(loadConfig(), options.adapter, options.timeoutMs);
  const provider = config.providers.get(options.adapter);
  if (!provider) {
    fail(`no provider called "${options.adapter}" — configured providers are ${[...config.providers.keys()].join(", ")}`);
  }

  // Every response is teed so the raw answer can be classified even when the
  // adapter rejected it; the adapter still reads the original stream.
  const raw = new Capture();
  const providers = createProviders(config, { fetch: raw.fetch });
  const adapter = providers.adapter(options.adapter);

  const all = loadSpans(options.spansDir);
  const spans = options.limit === undefined ? all : all.slice(0, options.limit);
  if (spans.length === 0) fail(`no fixtures in ${options.spansDir}`);

  console.log(`# bake-off: ${options.adapter} (${provider.model}) at ${provider.endpoint}`);
  console.log(`${spans.length} spans, ${spans.filter((span) => span.words > 400).length} of them over 400 words`);
  console.log(`paths: ${options.paths.join(", ")}; timeout ${options.timeoutMs / 1000}s; started ${new Date().toISOString()}\n`);

  const proposals: ProposalResult[] = [];
  for (const path of options.proposals ? options.paths : []) {
    for (const span of spans) {
      const result = await runProposal(adapter, raw, span, path, options);
      proposals.push(result);
      console.log(report(result));
    }
  }

  const extractions: ExtractResult[] = [];
  if (options.extract) {
    console.log("");
    for (const span of spans) {
      const result = await runExtraction(adapter, span, options);
      extractions.push(result);
      console.log(
        `  ${result.spanId.padEnd(14)} extract  ${result.ok ? "ok  " : "FAIL"}  ` +
          `${result.facts} facts, ${result.anchorsOk} anchors verbatim ` +
          `(${result.anchorsOkUnwrapped} unwrapped)  ${seconds(result.wallMs)}` +
          `${result.failure === undefined ? "" : `  ${result.failure}`}`,
      );
    }
  }

  console.log(`\n${summary(options, provider, proposals, extractions)}`);
  if (options.json !== undefined) {
    writeFileSync(options.json, `${JSON.stringify({ adapter: options.adapter, model: provider.model, proposals, extractions }, null, 2)}\n`);
    console.log(`\nwrote ${options.json}`);
  }
}

async function runProposal(
  adapter: Adapter,
  raw: Capture,
  span: BenchSpan,
  path: OutputMode,
  options: Options,
): Promise<ProposalResult> {
  raw.reset();
  const started = Date.now();
  let replacement: string | undefined;
  let failure: string | undefined;

  try {
    const proposal = await adapter.proposeEdit({
      intent: REVISE,
      instruction: span.instruction,
      document: span.document,
      span: span.span,
      output: path,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      timeoutMs: options.timeoutMs,
    });
    replacement = proposal.variants[0];
  } catch (error) {
    failure = short(error);
  }
  const wallMs = Date.now() - started;
  const answer = await raw.answer(path);

  // The tool path returns a bare replacement; what the app writes is the
  // substitution around it, and that is what has to pass the parser.
  if (failure === undefined && replacement !== undefined && path === "tool") {
    const check = validateProposal(`{~~${span.passage}~>${replacement}~~}`);
    if (!check.ok) {
      failure = `as CriticMarkup: ${check.violations[0]?.message ?? "does not conform"}`;
    }
  }

  return {
    spanId: span.id,
    path,
    words: span.words,
    ok: failure === undefined,
    failure,
    mangling: classify({ passage: span.passage, replacement: replacement ?? answer, raw: answer ?? "" }),
    wallMs,
    outWords: countWords(replacement ?? ""),
  };
}

async function runExtraction(adapter: Adapter, span: BenchSpan, options: Options): Promise<ExtractResult> {
  const started = Date.now();
  if (adapter.extractFactsWithAnchors === undefined) {
    return {
      spanId: span.id,
      ok: false,
      failure: "the adapter has no tool path",
      facts: 0,
      anchorsOk: 0,
      anchorsOkUnwrapped: 0,
      wallMs: 0,
    };
  }
  try {
    const facts = await adapter.extractFactsWithAnchors({
      text: span.passage,
      instruction: EXTRACT_INSTRUCTION,
      maxTokens: options.maxTokens,
      timeoutMs: options.timeoutMs,
    });
    return {
      spanId: span.id,
      ok: true,
      failure: undefined,
      facts: facts.length,
      anchorsOk: facts.filter((fact) => anchorOk(fact, span.passage)).length,
      anchorsOkUnwrapped: facts.filter((fact) => anchorOk(fact, span.passage, true)).length,
      wallMs: Date.now() - started,
    };
  } catch (error) {
    return {
      spanId: span.id,
      ok: false,
      failure: short(error),
      facts: 0,
      anchorsOk: 0,
      anchorsOkUnwrapped: 0,
      wallMs: Date.now() - started,
    };
  }
}

/**
 * The writing-lab bench's check, unchanged: the anchor is a verbatim substring
 * of the passage.
 *
 * `unwrapped` collapses whitespace on both sides first, which separates the two
 * ways an anchor can miss: a model that paraphrased (still a miss), and a model
 * that quoted correctly across one of the manuscript's hard line wraps (a
 * lookup problem, and the app's to solve). The strict number is the one the
 * writing-lab bench reports.
 */
function anchorOk(fact: ExtractedFact, passage: string, unwrapped = false): boolean {
  if (fact.anchor === undefined || fact.anchor === "") return false;
  if (passage.includes(fact.anchor)) return true;
  return unwrapped && collapse(passage).includes(collapse(fact.anchor));
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A `fetch` that keeps a copy of each response body.
 *
 * The adapter turns a non-conforming answer into an error and does not hand the
 * text back, but the whole point of the bench is to name what was wrong with
 * it. Cloning is what keeps the adapter's own stream intact.
 */
class Capture {
  #bodies: Promise<string>[] = [];

  // `Object.assign` because Bun's `fetch` type carries a `preconnect` member
  // that a bare arrow function does not have.
  readonly fetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
      const response = await globalThis.fetch(input, init);
      const copy = response.clone();
      this.#bodies.push(copy.text().catch(() => ""));
      return response;
    },
    { preconnect: globalThis.fetch.preconnect },
  );

  reset(): void {
    this.#bodies = [];
  }

  /** What the model said, decoded out of whichever wire shape the path used. */
  async answer(path: OutputMode): Promise<string | undefined> {
    const bodies = await Promise.all(this.#bodies);
    const body = bodies[bodies.length - 1];
    if (body === undefined) return undefined;
    return path === "tool" ? toolAnswer(body) : sseAnswer(body);
  }
}

function sseAnswer(body: string): string {
  let text = "";
  for (const event of body.split("\n\n")) {
    const line = event.split("\n").find((candidate) => candidate.startsWith("data:"));
    const payload = line?.slice("data:".length).trim();
    if (payload === undefined || payload === "[DONE]") continue;
    try {
      const content = (JSON.parse(payload) as { choices?: { delta?: { content?: unknown } }[] }).choices?.[0]?.delta
        ?.content;
      if (typeof content === "string") text += content;
    } catch {
      // A chunk that is not JSON is itself the finding; the adapter reports it.
    }
  }
  return text;
}

function toolAnswer(body: string): string {
  try {
    const args = (
      JSON.parse(body) as { choices?: { message?: { content?: unknown; tool_calls?: { function?: { arguments?: unknown } }[] } }[] }
    ).choices?.[0]?.message;
    const raw = args?.tool_calls?.[0]?.function?.arguments;
    if (typeof raw !== "string") return typeof args?.content === "string" ? args.content : body;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed["replacement"] === "string" ? parsed["replacement"] : raw;
  } catch {
    return body;
  }
}

function report(result: ProposalResult): string {
  const state = result.ok ? "ok  " : "FAIL";
  const classes = result.mangling.length === 0 ? "" : `  [${result.mangling.join(", ")}]`;
  const why = result.failure === undefined ? "" : `  ${result.failure}`;
  return (
    `  ${result.spanId.padEnd(14)} ${result.path.padEnd(5)} ${state}  ` +
    `${String(result.words).padStart(3)}w in / ${String(result.outWords).padStart(3)}w out  ` +
    `${seconds(result.wallMs)}${classes}${why}`
  );
}

function summary(
  options: Options,
  provider: ProviderConfig,
  proposals: readonly ProposalResult[],
  extractions: readonly ExtractResult[],
): string {
  const lines = [
    `## ${options.adapter} — ${provider.model}`,
    "",
    "| path | pass rate | over 400w | median wall | total wall | mangling classes seen |",
    "|---|---|---|---|---|---|",
  ];

  for (const path of options.paths) {
    const runs = proposals.filter((result) => result.path === path);
    if (runs.length === 0) continue;
    const long = runs.filter((result) => result.words > 400);
    const seen = MANGLING_CLASSES.filter((mangling) => runs.some((run) => run.mangling.includes(mangling)));
    lines.push(
      `| ${path} | ${passRate(runs)} | ${passRate(long)} | ${seconds(median(runs.map((run) => run.wallMs)))} | ` +
        `${seconds(runs.reduce((total, run) => total + run.wallMs, 0))} | ` +
        `${seen.length === 0 ? "none" : seen.map((mangling) => `${mangling} ×${runs.filter((run) => run.mangling.includes(mangling)).length}`).join(", ")} |`,
    );
  }

  if (extractions.length > 0) {
    const facts = extractions.reduce((total, run) => total + run.facts, 0);
    const anchors = extractions.reduce((total, run) => total + run.anchorsOk, 0);
    const unwrapped = extractions.reduce((total, run) => total + run.anchorsOkUnwrapped, 0);
    lines.push(
      "",
      `extract_facts: ${extractions.filter((run) => run.ok).length}/${extractions.length} spans returned a tool call, ` +
        `${facts} facts, ${anchors} anchors verbatim (${percent(anchors, facts)}), ` +
        `${unwrapped} once hard wraps are collapsed (${percent(unwrapped, facts)}), ` +
        `median ${seconds(median(extractions.map((run) => run.wallMs)))}`,
    );
  }
  return lines.join("\n");
}

function passRate(runs: readonly ProposalResult[]): string {
  if (runs.length === 0) return "n/a";
  return `${runs.filter((run) => run.ok).length}/${runs.length} (${percent(runs.filter((run) => run.ok).length, runs.length)})`;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "n/a" : `${Math.round((part / whole) * 100)}%`;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function short(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^pablo: the model at \S+ returned /, "").replace(/\s+/g, " ").slice(0, 160);
}

/** Raises the idle timeout on the provider being measured; every other entry is untouched. */
function withTimeout(config: PabloConfig, id: string, timeoutMs: number): PabloConfig {
  const provider = config.providers.get(id);
  if (provider === undefined) return config;
  const providers = new Map(config.providers);
  providers.set(id, { ...provider, timeoutMs });
  return { ...config, providers };
}

function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let at = 0; at < argv.length; at += 1) {
    const flag = argv[at] ?? "";
    if (!flag.startsWith("--")) fail(`unexpected argument ${flag}`);
    if (flag === "--no-extract" || flag === "--no-proposals") {
      flags.set(flag.slice(2), "true");
      continue;
    }
    const value = argv[at + 1];
    if (value === undefined || value.startsWith("--")) fail(`${flag} needs a value`);
    flags.set(flag.slice(2), value);
    at += 1;
  }

  const paths = (flags.get("paths") ?? "tool,text").split(",").map((path) => path.trim());
  for (const path of paths) {
    if (path !== "tool" && path !== "text") fail(`--paths takes "tool", "text", or "tool,text", not ${path}`);
  }

  return {
    adapter: flags.get("adapter") ?? "local",
    spansDir: flags.get("spans") ?? DEFAULT_SPANS,
    paths: paths as OutputMode[],
    timeoutMs: number(flags.get("timeout"), DEFAULT_TIMEOUT_MS),
    maxTokens: number(flags.get("max-tokens"), 2_000),
    temperature: number(flags.get("temperature"), 0.2),
    limit: flags.has("limit") ? number(flags.get("limit"), 0) : undefined,
    json: flags.get("json"),
    extract: !flags.has("no-extract"),
    proposals: !flags.has("no-proposals"),
  };
}

function number(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`expected a positive number, got ${value}`);
  return parsed;
}

function fail(message: string): never {
  console.error(`bakeoff: ${message}`);
  console.error("usage: bun run bench/bakeoff.ts [--adapter <id>] [--paths tool,text] [--spans <dir>]");
  console.error("                               [--timeout <ms>] [--max-tokens <n>] [--temperature <t>]");
  console.error("                               [--limit <n>] [--no-extract] [--no-proposals] [--json <file>]");
  process.exit(2);
}

await main();
