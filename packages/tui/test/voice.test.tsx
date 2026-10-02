// `a v` (AGT-1547): the selected sentences are offered to the voice; f flags, e keeps; the content area says where.

import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import type { VoiceResult } from "../src/screen";
import { initialState, reduce, type Action, type State } from "../src/state";

afterEach(() => cleanup());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plain = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const FILE = "---\nstatus: draft\n---\n\nThe well had been dry since June.\nShe did not look up.\n\nEdwin stood in the doorway.";
const run = (...actions: Action[]): State => actions.reduce(reduce, initialState());

test("voice.offer shows the sentences and the two choices; Esc withdraws it; none selected is a hint", () => {
  const offered = run({ type: "voice.offer", sentences: ["She did not look up."] });
  expect(offered.voice).toEqual(["She did not look up."]);
  expect(offered.content?.kind).toBe("voice");
  expect(offered.content?.body).toContain("f  flag it");
  expect(offered.content?.body).toContain("e  keep it");
  expect(reduce(offered, { type: "escape" }).voice).toBeNull();
  const none = run({ type: "voice.offer", sentences: [] });
  expect(none.voice).toBeNull();
  expect(none.content?.body).toContain("Select the sentences first");
});

test("voice.start takes the offer, done and failed put up the result", () => {
  const offered = run({ type: "voice.offer", sentences: ["x"] });
  const started = reduce(offered, { type: "voice.start", kind: "flag" });
  expect(started.voice).toBeNull();
  expect(reduce(started, { type: "voice.start", kind: "flag" })).toBe(started); // nothing offered, nothing to start
  expect(reduce(started, { type: "voice.done", lines: ["Flagged in style/prose.md"] }).content?.body).toBe("Flagged in style/prose.md");
  expect(reduce(started, { type: "voice.failed", message: "no" }).content?.title).toBe("Not added to the voice");
});

function mount(voicer: (kind: "flag" | "exemplar", s: readonly string[]) => Promise<VoiceResult>) {
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

test("on the screen: with nothing selected a v says so and calls nothing; Esc cancels an offer", async () => {
  const calls: string[] = [];
  const app = mount(async (kind) => { calls.push(kind); return { ok: true, lines: [] }; });
  await sleep(30);
  app.stdin.write("\x1b[C"); await sleep(30);
  app.stdin.write("a"); await sleep(20); app.stdin.write("v"); await sleep(40);
  expect(plain(app.lastFrame())).toContain("Select the sentences first");
  app.stdin.write("f"); await sleep(40);
  expect(calls).toEqual([]);
  app.stdin.write("\x1b"); await sleep(30);
  app.stdin.write("\x1b[1;2B"); await sleep(30);
  app.stdin.write("a"); await sleep(20); app.stdin.write("v"); await sleep(40);
  app.stdin.write("\x1b"); await sleep(40); // withdraws the offer (the offer goes before the selection)
  app.stdin.write("e"); await sleep(40);
  expect(calls).toEqual([]);
});
