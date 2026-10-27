// `r ...` (AGT-2178): the planning and research verbs run from the screen through the planner seam; a verb that takes a
// line asks for it in the content area, Enter runs it, Esc cancels; one that takes none runs at once.

import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import type { PlanResult } from "../src/screen";
import { entriesFor } from "../src/panel";
import { PLANNING_VERBS, DEFAULT_ACTIONS } from "../src/keys";
import { initialState, reduce } from "../src/state";

afterEach(() => cleanup());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const plain = (s: string | undefined) => (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

test("every planning verb is a key row under r, and every r row is a planning verb", () => {
  const rows = DEFAULT_ACTIONS.filter((a) => a.prefix === "r").map((a) => a.id).sort();
  expect(rows).toEqual(PLANNING_VERBS.map((v) => v.id).sort());
});

test("plan.open asks for a line, typing and Backspace edit it, Esc cancels; plan.start/done/failed put up the result", () => {
  let s = reduce(initialState(), { type: "plan.open", id: "research.waive", title: "Waive a research item", hint: "<#> <reason>" });
  expect(s.planning?.id).toBe("research.waive");
  s = reduce(reduce(reduce(s, { type: "plan.type", text: "3 no" }), { type: "plan.type", text: "x" }), { type: "plan.backspace" });
  expect(s.planning?.text).toBe("3 no");
  expect(s.content?.body).toContain("3 no");
  expect(entriesFor(s).map((e) => e.label)).toEqual(["run", "cancel"]);
  expect(reduce(s, { type: "escape" }).planning).toBeNull();
  const running = reduce(s, { type: "plan.start", id: "research.waive", title: "Waive" });
  expect(running.planning).toBeNull();
  expect(running.content?.body).toBe("running…");
  expect(reduce(running, { type: "plan.done", title: "Waive", lines: ["branch: plan/x"] }).content?.body).toBe("branch: plan/x");
  expect(reduce(running, { type: "plan.failed", title: "Waive", message: "no item 9" }).content?.body).toBe("no item 9");
});

function mount(planner?: (id: string, line: string) => Promise<PlanResult>) {
  return render(<App title="T" format="novel" rows={[{ id: "ch1", depth: 0 }]} labels={{ ch1: "ch 1" }} {...(planner ? { planner } : {})} size={{ cols: 100, rows: 28 }} />);
}

test("on the screen: r w asks for the item and reason, Enter hands the line to the planner and the result shows", async () => {
  const calls: unknown[] = [];
  const app = mount(async (id, line) => { calls.push([id, line]); return { ok: true, lines: ["branch: plan/waive"] }; });
  await sleep(20);
  app.stdin.write("r"); await sleep(30);
  app.stdin.write("w"); await sleep(40);
  expect(plain(app.lastFrame())).toContain("Waive a research item");
  app.stdin.write("\r"); await sleep(40); // an empty line runs nothing
  expect(calls).toEqual([]);
  app.stdin.write("3 No sources survive."); await sleep(40);
  app.stdin.write("\r"); await sleep(60);
  expect(calls).toEqual([["research.waive", "3 No sources survive."]]);
  expect(plain(app.lastFrame())).toContain("branch: plan/waive");
});

test("on the screen: r p takes no line and runs at once; a refusal is shown", async () => {
  const calls: unknown[] = [];
  const app = mount(async (id, line) => { calls.push([id, line]); return { ok: false, message: "no period brief yet" }; });
  await sleep(20);
  app.stdin.write("r"); await sleep(30);
  app.stdin.write("p"); await sleep(60);
  expect(calls).toEqual([["research.plan", ""]]);
  expect(plain(app.lastFrame())).toContain("no period brief yet");
});

test("on the screen: with no planner an r key says it is not available", async () => {
  const app = mount();
  await sleep(20);
  app.stdin.write("r"); await sleep(30);
  app.stdin.write("d"); await sleep(40);
  expect(plain(app.lastFrame())).toContain("not available here");
});
