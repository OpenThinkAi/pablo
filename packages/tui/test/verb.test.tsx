// The `o` keys (AGT-2179, D-3): each CLI verb's key runs it through the verb runner; verbs that need arguments open a one-line input.

import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import type { VerbResult } from "../src/screen";

afterEach(() => cleanup());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plain = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");

const mount = (calls: (readonly string[])[], result: VerbResult = { ok: true, lines: ["ok"] }) =>
  render(<App title="Ice House" format="novel" size={{ cols: 100, rows: 30 }} verbRunner={async (argv) => { calls.push(argv); return result; }} />);
const chord = async (app: ReturnType<typeof mount>, second: string) => { app.stdin.write("o"); await sleep(30); app.stdin.write(second); await sleep(60); };
const type = async (app: ReturnType<typeof mount>, text: string) => { app.stdin.write(text); await sleep(40); app.stdin.write("\r"); await sleep(80); };

test("o s runs config show at once; o k / o c / o p ask for an optional output (Enter alone runs as is), and show their output", async () => {
  const calls: (readonly string[])[] = [];
  const app = mount(calls, { ok: true, lines: ["3 hits"] });
  await sleep(30);
  await chord(app, "s");
  for (const k of ["k", "c", "p"]) { await chord(app, k); await type(app, ""); }
  expect(calls).toEqual([["config", "show"], ["check"], ["critique"], ["publish"]]);
  expect(plain(app.lastFrame())).toContain("3 hits");
});

test("o a asks for the output type, then runs output add with it; Esc cancels", async () => {
  const calls: (readonly string[])[] = [];
  const app = mount(calls);
  await sleep(30);
  await chord(app, "a");
  expect(plain(app.lastFrame())).toContain("Add an output");
  await type(app, "essay");
  expect(calls).toEqual([["output", "add", "essay"]]);
  await chord(app, "a");
  app.stdin.write("\x1b"); await sleep(60);
  expect(plain(app.lastFrame())).not.toContain("Add an output");
  expect(calls.length).toBe(1);
});

test("o e / o x / o u run voice edit, remove and use with the typed arguments", async () => {
  const calls: (readonly string[])[] = [];
  const app = mount(calls);
  await sleep(30);
  await chord(app, "e"); await type(app, "r3 No adverbs at all.");
  await chord(app, "x"); await type(app, "r4");
  await chord(app, "u"); await type(app, "noir");
  expect(calls).toEqual([["voice", "edit", "r3", "No adverbs at all."], ["voice", "remove", "r4"], ["voice", "use", "noir"]]);
});

test("o S sets a config path; a key must be a reference, and a value is neither drawn nor repeated", async () => {
  const calls: (readonly string[])[] = [];
  const app = mount(calls);
  await sleep(30);
  await chord(app, "S");
  app.stdin.write("providers.a.key sk-live-123"); await sleep(60);
  expect(plain(app.lastFrame())).not.toContain("sk-live-123");
  app.stdin.write("\r"); await sleep(80);
  expect(calls).toEqual([]);
  expect(plain(app.lastFrame())).toContain("never as the key itself");
  expect(plain(app.lastFrame())).not.toContain("sk-live-123");
  await chord(app, "S"); await type(app, "providers.a.key env:A_KEY");
  expect(calls).toEqual([["config", "set", "providers.a.key", "env:A_KEY"]]);
});

test("a verb's refusal is shown, as the verb said it", async () => {
  const app = mount([], { ok: false, message: "two outputs: novel, radio" });
  await sleep(30);
  await chord(app, "p"); await type(app, "");
  expect(plain(app.lastFrame())).toContain("two outputs: novel, radio");
});

test("o p with a typed output passes --output", async () => {
  const calls: (readonly string[])[] = [];
  const app = mount(calls);
  await sleep(30);
  await chord(app, "p"); await type(app, "radio");
  expect(calls).toEqual([["publish", "--output", "radio"]]);
});
