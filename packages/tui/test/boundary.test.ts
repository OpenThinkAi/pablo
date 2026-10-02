// The line between the model and the screen, held by a test: state.ts imports no terminal or React library, and the
// Ink layer keeps no state of its own. Where the author is and what is open lives in state.ts and changes only
// through `reduce`; a component that needs to remember something dispatches an action instead.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
/** Every `from "x"`, `import "x"`, `import("x")` and `require("x")` specifier in a source file. */
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g;

test("state.ts is pure: it imports nothing", () => {
  const source = readFileSync(join(SRC, "state.ts"), "utf8");
  expect([...source.matchAll(SPECIFIER)].map((m) => m[1])).toEqual([]);
});

test("the Ink layer holds no state of its own: one useReducer over the model, no useState, no useRef", () => {
  // resize.ts is the terminal's size as state, plumbing below the model, and the one file allowed its own useState.
  const files = readdirSync(SRC).filter((f) => /\.tsx?$/.test(f) && f !== "resize.ts");
  expect(files.length).toBeGreaterThan(0);
  const uses = (source: string, hook: string) => (source.match(new RegExp(`\\b${hook}\\s*(<|\\()`, "g")) ?? []).length;
  const reducers: string[] = [];
  for (const f of files) {
    const source = readFileSync(join(SRC, f), "utf8");
    expect(uses(source, "useState"), `${f} keeps state outside the model`).toBe(0);
    expect(uses(source, "useRef"), `${f} keeps state outside the model`).toBe(0);
    for (let i = 0; i < uses(source, "useReducer"); i++) reducers.push(f);
    expect(source.includes("useReducer(") && !source.includes("useReducer(reduce,"), `${f} reduces with something other than the model`).toBe(false);
  }
  expect(reducers).toEqual(["app.tsx"]);
});
