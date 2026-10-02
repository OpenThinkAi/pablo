import { expect, test } from "bun:test";
import { DEFAULT_ACTIONS, DEFAULT_KEYMAP, effectiveKeys, KeysError, keysOf, normKey, prefixesOf, prefixRows, rowsOf, STATES, type KeyState } from "../src/keys";
import { loadKeymap, parseKeys } from "../src/key-config";

const book = (state: KeyState["state"], content = false): KeyState => ({ state, review: false, content });
const review = (state: KeyState["state"]): KeyState => ({ state, review: true, content: false });

test("every action has a primary key and an optional secondary, and ids are unique", () => {
  expect(new Set(DEFAULT_ACTIONS.map((a) => a.id)).size).toBe(DEFAULT_ACTIONS.length);
  for (const a of DEFAULT_ACTIONS) expect(a.key, a.id).not.toBe("");
  const down = DEFAULT_ACTIONS.find((a) => a.id === "rail.down")!;
  expect(keysOf(down)).toEqual(["down", "j"]);
  expect(keysOf(DEFAULT_ACTIONS.find((a) => a.id === "app.quit")!)).toEqual(["q"]);
});

test("a, f, v, g are the prefixes; each state has the prefixes that have second keys there", () => {
  expect(prefixesOf(book("rail"))).toEqual(["a", "v"]);
  expect(prefixesOf(book("main"))).toEqual(["a", "v", "g"]);
  expect(prefixesOf(review("main"))).toEqual(["a", "f", "v", "g"]);
  expect(prefixesOf(book("content", true))).toEqual(["v"]);
  expect(prefixRows(book("main"), "g").map((r) => r.id)).toEqual(["go.top", "go.end", "go.line"]);
});

test("the keys that act follow the state: rows by region, review and an open content area", () => {
  const ids = (ks: KeyState) => rowsOf(ks).map((r) => r.id);
  expect(ids(book("rail"))).not.toContain("rail.focus_content");
  expect(ids(book("rail", true))).toContain("rail.focus_content");
  expect(ids(book("rail"))).not.toContain("review.finish");
  expect(ids(review("rail"))).toContain("review.finish");
  expect(ids(book("content", true))).toEqual(["content.down", "content.up", "content.page_down", "content.page_up", "content.back"]);
  for (const s of STATES) expect(ids(book(s)).every((id) => !id.startsWith("review."))).toBe(true);
});

test("overrides rebind a primary and a secondary; the rest keep their defaults", () => {
  const km = effectiveKeys({ "rail.down": "m", "rail.up": { secondary: "" }, "main.page_down": { primary: "Page-Down" } });
  const row = (id: string) => km.actions.find((a) => a.id === id)!;
  expect(keysOf(row("rail.down"))).toEqual(["m", "j"]);
  expect(keysOf(row("rail.up"))).toEqual(["up"]);
  expect(row("main.page_down").key).toBe("pgdn");
  expect(keysOf(row("rail.collapse"))).toEqual(["left", "h"]);
  expect(effectiveKeys()).toEqual(DEFAULT_KEYMAP);
});

test("a conflicting binding in one state is refused with a message", () => {
  expect(() => effectiveKeys({ "rail.down": "k" })).toThrow(/rail\.down and rail\.up \(secondary\) are both "k" in the rail state/);
  expect(() => effectiveKeys({ "rail.down": { primary: "j", secondary: "j" } })).toThrow(/both primary and secondary/);
  // a key that is a prefix in that state
  expect(() => effectiveKeys({ "app.quit": "g" })).toThrow(/g is the go to prefix in the main state/);
  // a prefix's second keys among themselves
  expect(() => effectiveKeys({ "go.end": "g" })).toThrow(/go\.top and go\.end are both "g" after g/);
  // a review's key (n rejects) conflicts with the rail's in that state
  expect(() => effectiveKeys({ "rail.down": "n" })).toThrow(/rail\.down and review\.reject are both "n" in the rail state/);
  // the same key in different states is fine
  expect(() => effectiveKeys({ "content.down": "m", "rail.down": "m" })).not.toThrow();
  expect(() => effectiveKeys({ "app.quit": "g" })).toThrow(KeysError);
});

test("review keys conflict only inside a review", () => {
  expect(() => effectiveKeys({ "review.edit": "q" })).toThrow(/review\.edit and app\.quit are both "q" in the rail state/);
  expect(() => effectiveKeys({ "ai.write": "w", "review.edit": "w" })).not.toThrow();
});

test("Esc, Tab, fixed rows, unknown actions and bad keys are refused", () => {
  expect(() => effectiveKeys({ "rail.down": "esc" })).toThrow(/Esc always backs out/);
  expect(() => effectiveKeys({ "rail.down": "Tab" })).toThrow(/Tab moves focus/);
  expect(() => effectiveKeys({ "rail.focus_content": "t" })).toThrow(/fixed/);
  expect(() => effectiveKeys({ "go.line": "n" })).toThrow(/fixed/);
  expect(() => effectiveKeys({ "nope.nothing": "n" })).toThrow(/unknown action/);
  expect(() => effectiveKeys({ "rail.down": "not-a-key" })).toThrow(/a key is one printable character or a name/);
  expect(() => effectiveKeys({ "go.top": "5" })).toThrow(/digit starts a line number/);
});

test("key names normalise", () => {
  expect(normKey("Shift+Down")).toBe("shift-down");
  expect(normKey("↓")).toBe("down");
  expect(normKey("Ctrl+D")).toBe("ctrl-d");
  expect(normKey("\u0007")).toBeNull();
});

test("config.json: the keys object is read, the rest is left to core", () => {
  expect(parseKeys('{"default":"local","keys":{"rail.down":"n","main.up":{"primary":"p","secondary":""}}}')).toEqual({ "rail.down": { primary: "n" }, "main.up": { primary: "p", secondary: "" } });
  expect(parseKeys('{"default":"local"}')).toEqual({});
  expect(() => parseKeys("nope")).toThrow(/not valid JSON/);
  expect(() => parseKeys('{"keys":[]}')).toThrow(/must be an object/);
  expect(() => parseKeys('{"keys":{"rail.down":{"primry":"n"}}}')).toThrow(/unknown field "primry"/);
  expect(() => parseKeys('{"keys":{"rail.down":5}}')).toThrow(/must be a key or/);
});

test("loadKeymap reads the config path, falls back to the defaults, and refuses a conflict", () => {
  const env = { XDG_CONFIG_HOME: "/nonexistent-xdg" };
  expect(loadKeymap({ env, readFile: () => undefined })).toEqual(DEFAULT_KEYMAP);
  const read = (text: string) => (path: string) => { expect(path).toBe("/nonexistent-xdg/pablo/config.json"); return text; };
  expect(keysOf(loadKeymap({ env, readFile: read('{"keys":{"rail.down":"m"}}') }).actions.find((a) => a.id === "rail.down")!)).toEqual(["m", "j"]);
  expect(() => loadKeymap({ env, readFile: read('{"keys":{"rail.down":"k"}}') })).toThrow(/both "k"/);
});
