import { expect, test } from "bun:test";
import { parseSequence, resolve, tokenOf } from "../src/chord";
import { effectiveKeys, keyStateOf, type Do } from "../src/keys";
import { initialState, reduce, type State } from "../src/state";

/** Press keys one by one the way the app does: resolve in the current state, apply the model's actions. */
function press(s: State, tokens: string[], km = undefined as ReturnType<typeof effectiveKeys> | undefined): { state: State; done: Do[] } {
  const done: Do[] = [];
  for (const t of tokens) for (const a of resolve(keyStateOf(s), s.pending, t, km)) { done.push(a); if (a.type !== "command") s = reduce(s, a); }
  return { state: s, done };
}
const inMain = (lines = 50): State => {
  let s = initialState();
  s = reduce(s, { type: "rail.loaded", rows: [{ id: "ch1", depth: 0 }] });
  s = reduce(s, { type: "main.loaded", lines });
  s = reduce(s, { type: "measured", measure: { rail: 10, main: 10 } });
  return reduce(s, { type: "rail.expand" });
};

test("a prefix, then its second key", () => {
  const { state, done } = press(inMain(), ["g", "e"]);
  expect(done).toEqual([{ type: "prefix.press", prefix: "g" }, { type: "main.end" }, { type: "prefix.clear" }]);
  expect(state.pending).toBeNull();
  expect(state.book.main.cursor).toBe(49);
});

test("g, digits, g (or Enter) goes to that line; a bare g g is the top", () => {
  expect(press(inMain(), ["g", "1", "2", "g"]).state.book.main.cursor).toBe(11);
  expect(press(inMain(), ["g", "3", "0", "enter"]).state.book.main.cursor).toBe(29);
  const mid = press(inMain(), ["g", "e"]).state;
  expect(press(mid, ["g", "g"]).state.book.main.cursor).toBe(0);
  const typing = press(inMain(), ["g", "4", "2"]).state;
  expect(typing.pending).toEqual({ prefix: "g", digits: "42" });
  expect(press(typing, ["backspace"]).state.pending).toEqual({ prefix: "g", digits: "4" });
  expect(press(typing, ["x"]).state.pending).toBeNull();
});

test("a key that is not a second key cancels the prefix and does nothing else", () => {
  const { state, done } = press(inMain(), ["v", "j"]);
  expect(done).toEqual([{ type: "prefix.press", prefix: "v" }, { type: "prefix.clear" }]);
  expect(state.pending).toBeNull();
  expect(state.book.main.cursor).toBe(0);
});

test("Esc backs out of a prefix, then a content focus", () => {
  let s = press(inMain(), ["a"]).state;
  expect(s.pending).toEqual({ prefix: "a" });
  s = press(s, ["esc"]).state;
  expect(s.pending).toBeNull();
  s = reduce(s, { type: "content.show", content: { title: "t", body: "b" } });
  s = press(s, ["tab"]).state;
  expect(s.focus).toBe("content");
  s = press(s, ["esc"]).state;
  expect(s.focus).toBe("main");
  expect(s.content).not.toBeNull();
  expect(press(s, ["esc"]).state.content).toBeNull();
});

test("Tab moves focus into the content area and back, only with something there", () => {
  let s = inMain();
  expect(press(s, ["tab"]).state.focus).toBe("main");
  s = reduce(s, { type: "content.show", content: { title: "t", body: "b" } });
  s = press(s, ["tab"]).state;
  expect(s.focus).toBe("content");
  expect(press(s, ["tab"]).state.focus).toBe("main");
  // `v c` full-screen works from the content area too
  expect(press(s, ["v", "c"]).state.full).toBe(true);
});

test("commands come back for the layer above, and a prefix's keys are its own", () => {
  expect(press(inMain(), ["a", "r"]).done).toContainEqual({ type: "command", id: "ai.revise" });
  expect(press(initialState(), ["a", "r"]).done).not.toContainEqual({ type: "command", id: "ai.revise" }); // main only
  expect(press(initialState(), ["q"]).done).toEqual([{ type: "command", id: "quit" }]);
  expect(press(initialState(), ["z"]).done).toEqual([]);
});

test("an override acts, and the old key no longer does", () => {
  const km = effectiveKeys({ "main.down": "m" });
  const s = inMain();
  expect(press(s, ["m"], km).state.book.main.cursor).toBe(1);
  expect(press(s, ["down"], km).state.book.main.cursor).toBe(0);
  expect(press(s, ["j"], km).state.book.main.cursor).toBe(1);
});

test("Ink's keys read as tokens", () => {
  expect(tokenOf("", { downArrow: true })).toBe("down");
  expect(tokenOf("", { downArrow: true, shift: true })).toBe("shift-down");
  expect(tokenOf("", { escape: true })).toBe("esc");
  expect(tokenOf("d", { ctrl: true })).toBe("ctrl-d");
  expect(tokenOf("[1;2B", {})).toBe("shift-down");
  expect(tokenOf("j", {})).toBe("j");
  expect(tokenOf("", {})).toBeNull();
  expect(parseSequence("\x1b[Z")).toBe("shift-tab");
});
