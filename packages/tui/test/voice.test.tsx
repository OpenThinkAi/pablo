// `a v` (AGT-1547): the selected sentences are offered to the voice; f flags, e keeps; the content area says where.

import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import type { VoiceResult } from "../src/screen";
import { entriesFor, panelTitle } from "../src/panel";
import { keyStateOf, voiceChoicesFor, VOICE_TARGETS } from "../src/keys";
import { initialState, reduce, type Action, type State } from "../src/state";

afterEach(() => cleanup());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plain = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const FILE = "---\nstatus: draft\n---\n\nThe well had been dry since June.\nShe did not look up.\n\nEdwin stood in the doorway.";
const run = (...actions: Action[]): State => actions.reduce(reduce, initialState());
/** What the app dispatches for `a v`: the choices are keys.ts data, handed in with the sentences. */
const offer = (sentences: readonly string[]): Action => ({ type: "voice.offer", sentences, choices: voiceChoicesFor(sentences.length) });

test("voice.offer shows the sentences and the three choices; Esc withdraws it; none selected offers only the rule", () => {
  const offered = run(offer(["She did not look up."]));
  expect(offered.voice).toEqual(["She did not look up."]);
  expect(offered.content?.kind).toBe("voice");
  expect(offered.content?.body).toContain("f  flag it");
  expect(offered.content?.body).toContain("e  keep it");
  expect(offered.content?.body).toContain("r  rule");
  expect(reduce(offered, { type: "escape" }).voice).toBeNull();
  const none = run(offer([]));
  expect(none.voice).toEqual([]);
  expect(none.content?.body).toContain("Nothing is selected");
  expect(none.content?.body).toContain("r  rule");
  expect(none.content?.body).not.toContain("f  flag");
  expect(reduce(none, { type: "escape" }).voice).toBeNull();
});

test("voice.start takes the offer, done and failed put up the result", () => {
  const offered = run(offer(["x"]));
  const started = reduce(offered, { type: "voice.start", kind: "flag" });
  expect(started.voice).toBeNull();
  expect(reduce(started, { type: "voice.start", kind: "flag" })).toBe(started); // nothing offered, nothing to start
  expect(reduce(started, { type: "voice.done", lines: ["Flagged in style/prose.md"] }).content?.body).toBe("Flagged in style/prose.md");
  expect(reduce(started, { type: "voice.failed", message: "no" }).content?.title).toBe("Not added to the voice");
});

function mount(voicer: (kind: "flag" | "exemplar" | "rule", s: readonly string[], rule?: { text: string; target: "voice" | "work" }) => Promise<VoiceResult>) {
  return render(<App title="T" format="novel" rows={[{ id: "ch1", depth: 0 }]} labels={{ ch1: "ch 1" }} load={() => ({ title: "chapters/01.md", text: FILE })} voicer={voicer} size={{ cols: 100, rows: 28 }} />);
}
async function select(app: ReturnType<typeof mount>) {
  await sleep(30);
  app.stdin.write("\x1b[C"); await sleep(30);
  app.stdin.write("\x1b[1;2B"); await sleep(30);
  app.stdin.write("\x1b[1;2B"); await sleep(30);
  app.stdin.write("a"); await sleep(20); app.stdin.write("v"); await sleep(40);
}

test("on the screen: a v offers, f flags the selection through the voicer and the content area confirms where", async () => {
  const calls: unknown[] = [];
  const app = mount(async (kind, sentences) => { calls.push([kind, sentences]); return { ok: true, lines: ["Flagged in style/prose.md (voice fiction)."] }; });
  await select(app);
  expect(plain(app.lastFrame())).toContain("Add the 2 sentences to the voice");
  app.stdin.write("f"); await sleep(60);
  expect(calls).toEqual([["flag", ["The well had been dry since June.", "She did not look up."]]]);
  expect(plain(app.lastFrame())).toContain("Flagged in style/prose.md (voice fiction).");
});

test("on the screen: e keeps it as an exemplar; a refusal is shown", async () => {
  const calls: string[] = [];
  const app = mount(async (kind) => { calls.push(kind); return { ok: false, message: "pablo: voice exemplar: nowhere to keep it" }; });
  await select(app);
  app.stdin.write("e"); await sleep(60);
  expect(calls).toEqual(["exemplar"]);
  expect(plain(app.lastFrame())).toContain("nowhere to keep it");
});

test("on the screen: with nothing selected a v offers only the rule, f and e call nothing; Esc cancels an offer", async () => {
  const calls: string[] = [];
  const app = mount(async (kind) => { calls.push(kind); return { ok: true, lines: [] }; });
  await sleep(30);
  app.stdin.write("\x1b[C"); await sleep(30);
  app.stdin.write("a"); await sleep(20); app.stdin.write("v"); await sleep(40);
  expect(plain(app.lastFrame())).toContain("Nothing is selected");
  app.stdin.write("f"); await sleep(40);
  expect(calls).toEqual([]);
  app.stdin.write("\x1b"); await sleep(30);
  app.stdin.write("\x1b[1;2B"); await sleep(30);
  app.stdin.write("a"); await sleep(20); app.stdin.write("v"); await sleep(40);
  app.stdin.write("\x1b"); await sleep(40); // withdraws the offer (the offer goes before the selection)
  app.stdin.write("e"); await sleep(40);
  expect(calls).toEqual([]);
});

// ---- a v r (AGT-1594): the rule input, at the state-model level

const typed = (text: string): Action[] => [...text].map((t) => ({ type: "voice.rule_type", text: t }) as Action);

test("r on the offer opens a one-line input with the first target; typing and Backspace edit it; Tab cycles the target; Esc cancels", () => {
  const input = run(offer(["She did not look up."]), { type: "voice.rule", targets: VOICE_TARGETS }, ...typed("Use contractions."), { type: "voice.rule_backspace" });
  expect(input.voice).toBeNull();
  expect(input.voiceRule).toMatchObject({ text: "Use contractions", at: 0, sentences: ["She did not look up."] });
  expect(input.content?.body).toContain("Into: the voice's rules");
  expect(input.content?.body).toContain("Example: “She did not look up.”");
  expect(input.content?.body).toContain("Use contractions\u258f");
  const other = reduce(input, { type: "voice.rule_target" });
  expect(other.content?.body).toContain("Into: this work's QWEN.md");
  expect(reduce(other, { type: "voice.rule_target" }).voiceRule?.at).toBe(0); // wraps
  const cancelled = reduce(input, { type: "escape" });
  expect(cancelled.voiceRule).toBeNull();
  expect(cancelled.content).toBeNull();
});

test("voice.rule needs the offer; with no selection the input has no example line", () => {
  expect(run({ type: "voice.rule", targets: VOICE_TARGETS }).voiceRule).toBeNull();
  const input = run(offer([]), { type: "voice.rule", targets: VOICE_TARGETS });
  expect(input.voiceRule?.sentences).toEqual([]);
  expect(input.content?.body).not.toContain("Example");
});

test("voice.start with kind rule takes the typed rule; an empty rule starts nothing; done and failed clear it", () => {
  const input = run(offer([]), { type: "voice.rule", targets: VOICE_TARGETS });
  expect(reduce(input, { type: "voice.start", kind: "rule" })).toBe(input);
  const started = reduce(reduce(input, { type: "voice.rule_type", text: "x" }), { type: "voice.start", kind: "rule" });
  expect(started.voiceRule).toBeNull();
  expect(started.content?.body).toBe("writing…");
  expect(reduce(started, { type: "voice.done", lines: ["Rule added"] }).content?.body).toBe("Rule added");
  const failing = reduce(reduce(input, { type: "voice.rule_type", text: "x" }), { type: "voice.failed", message: "no" });
  expect(failing.voiceRule).toBeNull();
});

test("the key panel lists the voice choices while the offer is up, the rule input's keys while typing (both are keys.ts data)", () => {
  const withSelection = run(offer(["A."]));
  expect(entriesFor(withSelection).map((e) => `${e.keys} ${e.label}`)).toEqual(["f flag", "e exemplar", "r rule", "Esc cancel"]);
  expect(panelTitle(keyStateOf(withSelection), null, true)).toBe("voice");
  expect(entriesFor(run(offer([]))).map((e) => e.label)).toEqual(["rule", "cancel"]);
  const input = run(offer(["A."]), { type: "voice.rule", targets: VOICE_TARGETS });
  expect(entriesFor(input).map((e) => `${e.keys} ${e.label}`)).toEqual(["Enter write rule", "Tab target", "Esc cancel"]);
});

test("on the screen: a v r types a rule; Tab picks the work's QWEN.md; Enter hands text, target and selection to the voicer", async () => {
  const calls: unknown[] = [];
  const app = mount(async (kind, sentences, rule) => { calls.push([kind, sentences, rule]); return { ok: true, lines: ["Rule added in QWEN.md."] }; });
  await select(app);
  app.stdin.write("r"); await sleep(40);
  expect(plain(app.lastFrame())).toContain("Add a rule");
  app.stdin.write("Keep it plain."); await sleep(40);
  app.stdin.write("\t"); await sleep(40);
  expect(plain(app.lastFrame())).toContain("Into: this work's QWEN.md");
  app.stdin.write("\r"); await sleep(60);
  expect(calls).toEqual([["rule", ["The well had been dry since June.", "She did not look up."], { text: "Keep it plain.", target: "work" }]]);
  expect(plain(app.lastFrame())).toContain("Rule added in QWEN.md.");
});

test("on the screen: with nothing selected a v r still works (no example); Enter on an empty line does nothing; Esc cancels", async () => {
  const calls: unknown[] = [];
  const app = mount(async (kind, sentences, rule) => { calls.push([kind, sentences, rule]); return { ok: true, lines: ["done"] }; });
  await sleep(30);
  app.stdin.write("\x1b[C"); await sleep(30);
  app.stdin.write("a"); await sleep(20); app.stdin.write("v"); await sleep(40);
  app.stdin.write("r"); await sleep(40);
  app.stdin.write("\r"); await sleep(40);
  expect(calls).toEqual([]);
  app.stdin.write("No adverbs."); await sleep(40);
  app.stdin.write("\r"); await sleep(60);
  expect(calls).toEqual([["rule", [], { text: "No adverbs.", target: "voice" }]]);
  app.stdin.write("a"); await sleep(20); app.stdin.write("v"); await sleep(40);
  app.stdin.write("r"); await sleep(40);
  app.stdin.write("\x1b"); await sleep(40);
  expect(plain(app.lastFrame())).not.toContain("Add a rule");
});
