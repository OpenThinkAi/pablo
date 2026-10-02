import { expect, test } from "bun:test";
import { DEFAULT_ACTIONS, STATES, rowsOf, prefixesOf, prefixRows, showKey, effectiveKeys, type KeyState } from "../src/keys";
import { entriesOf, entriesFor, panelOf, panelTitle, plain } from "../src/panel";
import { initialState, reduce } from "../src/state";

const rail: KeyState = { state: "rail", review: false, content: false };

test("the panel lists the keys that act in the current state, grouped, with a line per prefix", () => {
  const e = entriesOf(rail).map((x) => `${x.keys} | ${x.label}`);
  expect(e).toContain("↓/↑ j/k | row");
  expect(e).toContain("⇧↓/⇧↑ J/K | group");
  expect(e).toContain("→ l | expand / enter");
  expect(e).toContain("q | quit");
  expect(e).toContain("a | AI…");
  expect(e.some((x) => x.includes("Tab"))).toBe(false); // no content area to focus
  expect(entriesOf({ ...rail, content: true }).map((x) => x.keys)).toContain("Tab");
});

test("every row that acts in a state has an entry on its panel", () => {
  for (const state of STATES) for (const review of [false, true]) for (const content of [false, true]) {
    const ks: KeyState = { state, review, content };
    const entries = entriesOf(ks);
    for (const r of rowsOf(ks)) expect(entries.some((e) => e.label === r.label && e.prim.includes(showKey(r.key))), `${r.id} in ${state}`).toBe(true);
    for (const p of prefixesOf(ks)) expect(entries.some((e) => e.prim === p), `prefix ${p} in ${state}`).toBe(true);
  }
});

test("a pending prefix shows its second keys; a number being typed shows how to finish", () => {
  const main: KeyState = { state: "main", review: false, content: false };
  expect(entriesOf(main, { prefix: "g" }).map((e) => `${e.keys} ${e.label}`)).toEqual(["g top", "e end", "f next hit", "F previous hit", "0-9 line"]);
  expect(entriesOf(main, { prefix: "v" }).map((e) => e.label)).toEqual(["zen", "editor", "save edits"]);
  expect(entriesOf(main, { prefix: "g", digits: "1" }).map((e) => e.keys)).toEqual(["0-9", "g Enter", "Esc"]);
  expect(panelTitle(main, { prefix: "g" })).toBe("g go to");
  expect(panelTitle(main)).toBe("keys");
  for (const p of prefixesOf(main)) expect(prefixRows(main, p).length).toBeGreaterThan(0);
});

test("the panel follows the screen's state", () => {
  let s = initialState();
  expect(entriesFor(s).map((e) => e.label)).not.toContain("accept");
  s = reduce(s, { type: "review.open", branch: "revise/x" });
  expect(entriesFor(s).map((e) => e.label)).toContain("accept");
  expect(panelTitle({ state: "rail", review: true })).toBe("changes");
  s = reduce(s, { type: "prefix.press", prefix: "f" });
  expect(entriesFor(s).map((e) => e.label)).toEqual(["all changes", "pending only"]);
});

test("a rebound key shows on the panel", () => {
  const km = effectiveKeys({ "rail.down": "m" });
  expect(entriesOf(rail, null, km).map((e) => e.keys)).toContain("m/↑ j/k");
});

test("the layout fits a grid, then drops secondaries, then flows", () => {
  const entries = entriesOf({ state: "main", review: false, content: false });
  const wide = panelOf("keys", entries, 80, 7);
  expect(wide.fit).toBe("grid");
  expect(wide.lines.length).toBeLessThanOrEqual(4);
  expect(wide.lines.map(plain).join("\n")).toContain("↓/↑ j/k");
  const narrow = panelOf("keys", entries, 40, 7);
  expect(narrow.fit).not.toBe("grid");
  for (const l of narrow.lines) expect([...plain(l)].length).toBeLessThanOrEqual(36);
  const tiny = panelOf("keys", entries, 20, 5);
  expect(tiny.lines.length).toBeLessThanOrEqual(2);
  expect(tiny.lines.map(plain).join("")).toContain("…");
  expect(panelOf("keys", [], 40, 7).lines).toEqual([]);
  expect(DEFAULT_ACTIONS.length).toBeGreaterThan(0);
});
