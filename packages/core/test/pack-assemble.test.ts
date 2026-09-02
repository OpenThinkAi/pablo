import { afterEach, expect, test } from "bun:test";
import {
  assemblePack,
  createProviders,
  estimateTokens,
  hashPrompt,
  PACK_BUDGETS,
  parseConfig,
} from "../src/index";
import type { Document, Intent, SpanEditInputs, TextSource } from "../src/index";
import { startFakeEndpoint } from "./fake-endpoint";
import type { FakeEndpoint } from "./fake-endpoint";

const running: FakeEndpoint[] = [];
afterEach(() => {
  while (running.length > 0) running.pop()?.stop();
});

const STYLE: TextSource[] = [
  { path: "style/prose.md", text: "Straight quotes, never curly. No em-dashes; use a comma." },
  { path: "style/anti-tells.md", text: "No closing paragraph that explains the scene." },
];

const TEXT = [
  "The pond rang under the horse before it rang under the saws.",
  "Marcel had marked the grid at first light.",
  "The hoist chain took up and a cake came out of the channel streaming.",
  "She wrote the number in the green book.",
  "The wagon door stood open on the road side.",
].join("\n\n");

const doc: Document = { path: "novels/ice-house/chapters/01-the-last-full-cut.md", text: TEXT };

/** The third paragraph. */
const span = { start: TEXT.indexOf("The hoist"), end: TEXT.indexOf("The hoist") + TEXT.slice(TEXT.indexOf("The hoist")).indexOf("\n\n") };

function inputs(overrides: Partial<SpanEditInputs> = {}): SpanEditInputs {
  return {
    document: doc,
    span,
    instruction: "cut this by a third",
    style: STYLE,
    workRules: { path: "novels/ice-house/QWEN.md", text: "The harbor is the whole economy." },
    ...overrides,
  };
}

test("a span-edit pack carries the style, the work's rules, the neighbourhood, the span and the intent", () => {
  const pack = assemblePack("spanEdit", inputs());

  expect(pack.slices.map((slice) => slice.name)).toEqual([
    "style",
    "workRules",
    "before",
    "after",
    "passage",
    "instruction",
    "closing",
  ]);
  expect(pack.kind).toBe("spanEdit");
  expect(pack.budgetTokens).toBe(PACK_BUDGETS.spanEdit);
  expect(pack.withinBudget).toBe(true);
  expect(pack.adjustments).toEqual([]);

  const style = pack.slices.find((slice) => slice.name === "style");
  expect(style?.source).toBe("style/prose.md, style/anti-tells.md");
  expect(style?.text).toContain("No em-dashes");

  const passage = pack.slices.find((slice) => slice.name === "passage");
  expect(passage?.text).toBe(TEXT.slice(span.start, span.end));
  expect(pack.prompt).toContain("cut this by a third");
});

test("the neighbourhood is the requested number of paragraphs on each side, nearest first", () => {
  const one = assemblePack("spanEdit", inputs({ neighborhoodParagraphs: 1 }));
  const two = assemblePack("spanEdit", inputs({ neighborhoodParagraphs: 2 }));

  expect(one.slices.find((slice) => slice.name === "before")?.text).toBe(
    "Marcel had marked the grid at first light.",
  );
  expect(one.slices.find((slice) => slice.name === "after")?.text).toBe(
    "She wrote the number in the green book.",
  );
  expect(two.slices.find((slice) => slice.name === "before")?.text).toContain("The pond rang");
  expect(two.slices.find((slice) => slice.name === "after")?.text).toContain("The wagon door");
});

test("a span with no manuscript around it simply has no neighbourhood slices", () => {
  const only: Document = { path: "fragments/one.md", text: "One paragraph and no more." };
  const pack = assemblePack("spanEdit", {
    document: only,
    span: { start: 0, end: only.text.length },
    instruction: "rougher",
    style: STYLE,
  });

  expect(pack.slices.map((slice) => slice.name)).toEqual(["style", "passage", "instruction", "closing"]);
});

test("assembly is deterministic: same inputs, same bytes, same hash", () => {
  const first = assemblePack("spanEdit", inputs());
  const second = assemblePack("spanEdit", inputs());

  expect(second.prompt).toBe(first.prompt);
  expect(second.hash).toBe(first.hash);
  expect(first.hash).toBe(hashPrompt(first.prompt));
  expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
});

test("a different instruction is a different hash", () => {
  const before = assemblePack("spanEdit", inputs());
  const after = assemblePack("spanEdit", inputs({ instruction: "rougher, and shorter" }));

  expect(after.hash).not.toBe(before.hash);
});

test("assembly touches no model and no clock", async () => {
  const calls: string[] = [];
  const noNetwork = ((input: unknown) => {
    calls.push(String(input));
    throw new Error("assembly must not reach the network");
  }) as unknown as typeof fetch;

  const saved = globalThis.fetch;
  globalThis.fetch = noNetwork;
  try {
    assemblePack("spanEdit", inputs());
  } finally {
    globalThis.fetch = saved;
  }
  expect(calls).toEqual([]);
});

test("the token estimator is one swappable function", () => {
  const words = (text: string): number => text.split(/\s+/).filter((word) => word !== "").length;
  const chars = assemblePack("spanEdit", inputs());
  const wordy = assemblePack("spanEdit", inputs(), { estimate: words });

  // Swapping the estimator changes the prices, never the prompt.
  expect(wordy.prompt).toBe(chars.prompt);
  expect(wordy.hash).toBe(chars.hash);
  expect(wordy.totalTokens).toBeLessThan(chars.totalTokens);

  // A pack's total is the sum of its rendered slices, under either estimator.
  const rendered = (slice: { heading: string; text: string }): string =>
    slice.heading === "" ? slice.text : `${slice.heading}\n\n${slice.text}`;
  expect(chars.totalTokens).toBe(chars.slices.reduce((sum, slice) => sum + estimateTokens(rendered(slice)), 0));
  expect(wordy.totalTokens).toBe(wordy.slices.reduce((sum, slice) => sum + words(rendered(slice)), 0));
});

test("pack.context is what the adapter is given, and pack.prompt is what goes over the wire", async () => {
  const fake = startFakeEndpoint({ tokens: ["a tighter paragraph"] });
  running.push(fake);

  const pack = assemblePack("spanEdit", inputs());
  const config = parseConfig(
    JSON.stringify({ providers: { local: { endpoint: fake.url, model: "fake-writer" } } }),
  );
  const adapter = createProviders(config, { keys: { env: {} } }).adapter("local");
  const intent: Intent = { name: "tighten", kind: "revising" };

  const edit = { intent, instruction: "cut this by a third", context: pack.context, document: doc, span };
  await adapter.proposeEdit({ ...edit, output: "text" });
  await adapter.proposeEdit(edit);

  const sentAs = (index: number) =>
    String(
      ((fake.requests[index]?.body["messages"] as { content?: unknown }[] | undefined)?.[0]?.content) ?? "",
    );
  const sentText = sentAs(0);
  const sentDefault = sentAs(1);

  // The pack owns the prompt. On the CriticMarkup-as-text path what the adapter
  // composed begins with the pack's context verbatim, and the tail it adds for
  // itself (the passage, the instruction, the closing line) is the tail the
  // pack already priced — so the pack's total is what the endpoint was asked to
  // read, not an approximation of it. Asserted by shape rather than by byte
  // equality so that a change to the adapter's own wording is not a failure.
  expect(sentText.startsWith(pack.context)).toBe(true);
  expect(pack.prompt.startsWith(pack.context)).toBe(true);
  for (const name of ["passage", "instruction", "closing"]) {
    const text = pack.slices.find((candidate) => candidate.name === name)?.text ?? "";
    expect(text).not.toBe("");
    expect(sentText).toContain(text);
    expect(pack.prompt).toContain(text);
  }
  expect(pack.context).not.toContain("cut this by a third");

  // The adapter's preferred path (the tool call, from the AGT-1202 bake-off)
  // reads the same context, passage and instruction; only its closing line
  // differs, because it asks for a call rather than for markup. The priced
  // slices are the ones that dominate the size either way.
  expect(sentDefault.startsWith(pack.context)).toBe(true);
  for (const name of ["passage", "instruction"]) {
    const text = pack.slices.find((candidate) => candidate.name === name)?.text ?? "";
    expect(sentDefault).toContain(text);
  }
});
