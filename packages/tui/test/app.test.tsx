import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { resolve } from "../src/chord";
import { keyStateOf } from "../src/keys";
import { clean } from "../src/sanitize";
import { initialState } from "../src/state";

afterEach(() => cleanup());

/** A frame as plain text: Ink colours the dim labels. */
const plain = (frame: string | undefined) => (frame ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the screen shows the project's title and format with the quit key", () => {
  const app = render(<App title="Ice House" format="novel" size={{ cols: 80, rows: 24 }} />);
  const frame = app.lastFrame() ?? "";
  expect(frame).toContain("Ice House");
  expect(frame).toContain("novel");
  expect(frame).toMatch(/q\s+quit/);
});

test("below the minimum size a too-small notice replaces the layout", () => {
  const app = render(<App title="Ice House" format="novel" size={{ cols: 40, rows: 10 }} />);
  const frame = app.lastFrame() ?? "";
  expect(frame).toContain("too small");
  expect(frame).toContain("60x20");
  expect(frame).not.toContain("Ice House");
});

test("q exits the app and clears its frame", async () => {
  const app = render(<App title="Ice House" format="novel" size={{ cols: 80, rows: 24 }} />);
  await sleep(20);
  expect(app.lastFrame()).toContain("Ice House");
  app.stdin.write("q");
  await sleep(50);
  expect(app.lastFrame()).not.toContain("Ice House");
});

test("the keys reach the model: → enters the main pane, Tab is refused with no content, Esc backs out", async () => {
  const app = render(<App title="Ice House" format="novel" size={{ cols: 80, rows: 24 }} />);
  await sleep(20);
  expect(app.lastFrame()).toContain("book · rail");
  // Nothing is loaded in the rail yet, so → has no row to enter; Tab has no content area to move into.
  app.stdin.write("\x1b[C");
  await sleep(30);
  expect(app.lastFrame()).toContain("book · rail");
  app.stdin.write("\t");
  await sleep(30);
  expect(app.lastFrame()).toContain("book · rail");
  app.stdin.write("\x1b");
  await sleep(30);
  expect(app.lastFrame()).toContain("book · rail");
  expect(app.lastFrame()).toContain("Ice House");
});

test("the key panel lists the keys that act, and a prefix swaps it for its second keys", async () => {
  const app = render(<App title="Ice House" format="novel" size={{ cols: 80, rows: 24 }} />);
  await sleep(20);
  expect(app.lastFrame()).toMatch(/v\s+view…/);
  app.stdin.write("v");
  await sleep(30);
  expect(app.lastFrame()).toMatch(/z\s+zen/);
  expect(app.lastFrame()).toContain("v view");
  app.stdin.write("\x1b");
  await sleep(30);
  expect(app.lastFrame()).toMatch(/v\s+view…/);
});

test("a command key reaches onCommand; an unbound key does nothing", async () => {
  const seen: string[] = [];
  const app = render(<App title="Ice House" format="novel" size={{ cols: 80, rows: 24 }} onCommand={(c) => seen.push(c.id)} />);
  await sleep(20);
  app.stdin.write("a");
  await sleep(30);
  app.stdin.write("p");
  await sleep(30);
  app.stdin.write("!");
  await sleep(30);
  expect(seen).toEqual(["ai.plan"]);
});

test("the arrows act in the focused region, Tab moves focus, Esc backs out", () => {
  const rail = initialState();
  const at = (s: typeof rail, token: string) => resolve(keyStateOf(s), s.pending, token);
  expect(at(rail, "down")).toEqual([{ type: "rail.down" }]);
  expect(at(rail, "right")).toEqual([{ type: "rail.expand" }]);
  expect(at(rail, "left")).toEqual([{ type: "rail.collapse" }]);
  expect(at(rail, "esc")).toEqual([{ type: "escape" }]);
  expect(at(rail, "x")).toEqual([]);
  expect(at(rail, "tab")).toEqual([]); // nothing in the content area to move into
  const main = { ...rail, pane: "main" as const, focus: "main" as const };
  expect(at(main, "down")).toEqual([{ type: "main.down" }]);
  expect(at(main, "left")).toEqual([{ type: "main.to_rail" }]);
  expect(at(main, "right")).toEqual([]);
  const content = { ...rail, focus: "content" as const, content: { title: "t", body: "b" } };
  expect(at(content, "down")).toEqual([{ type: "content.down" }]);
  expect(at(content, "tab")).toEqual([{ type: "focus.back" }]);
  expect(at({ ...rail, content: content.content }, "tab")).toEqual([{ type: "focus.content" }]);
});

test("control characters in the title never reach the screen as escapes", () => {
  const app = render(<App title={"Ice\x1b]0;pwned\x07 House"} format="novel" size={{ cols: 80, rows: 24 }} />);
  expect(app.lastFrame()).not.toContain("\x1b]");
  expect(clean("a\x1b[2Jb")).toBe("ab");
});

const ROWS = [
  { id: "premise", depth: 0 }, { id: "beats", depth: 0 }, { id: "chapters", depth: 0, group: true }, { id: "ch1", depth: 1 }, { id: "ch2", depth: 1 },
];
const book = { title: "Ice House", format: "novel", drafted: 1, total: 2, branch: "draft/ch02", comments: { continuity: 3 }, rows: ROWS, labels: { ch1: "1 The well" }, mainTitle: "chapters/01-the-well.md", lines: ["The well had been dry since June.", "She did not look up."] };

test("the three parts: status area, rail and main pane, content area beside the key panel", async () => {
  const app = render(<App {...book} size={{ cols: 120, rows: 32 }} />);
  await sleep(30);
  const frame = plain(app.lastFrame());
  for (const want of ["Ice House", "novel", "ch 1 of 2 drafted", "branch draft/ch02", "▲ 3 continuity", "BOOK", "premise", "▾ chapters", "1 The well", "chapters/01-the-well.md", "The well had been dry", "CONTENT"]) {
    expect(frame).toContain(want);
  }
  expect(frame.split("\n").length).toBeLessThanOrEqual(32);
});

test("resizing relayouts without a restart", async () => {
  const app = render(<App {...book} size={{ cols: 120, rows: 32 }} />);
  await sleep(30);
  expect(app.lastFrame()).toContain("▾ chapters");
  app.rerender(<App {...book} size={{ cols: 80, rows: 24 }} />);
  await sleep(30);
  const small = plain(app.lastFrame());
  expect(small).toContain("The well had been dry");
  expect(small).toContain("q quit");
  expect(small.split("\n").length).toBeLessThanOrEqual(24);
  app.rerender(<App {...book} size={{ cols: 40, rows: 10 }} />);
  await sleep(30);
  expect(app.lastFrame()).toContain("too small");
  app.rerender(<App {...book} size={{ cols: 120, rows: 32 }} />);
  await sleep(30);
  expect(app.lastFrame()).toContain("▾ chapters");
});

test("at under 100 columns the rail is a narrow strip", async () => {
  const app = render(<App {...book} size={{ cols: 80, rows: 24 }} />);
  await sleep(30);
  const frame = plain(app.lastFrame());
  expect(frame).toContain("BK");
  expect(frame).not.toContain("BOOK");
});

test("the arrows move the rail's cursor through the loaded rows", async () => {
  const app = render(<App {...book} size={{ cols: 120, rows: 32 }} />);
  await sleep(30);
  app.stdin.write("\x1b[B\x1b[B");
  await sleep(30);
  // The cursor is on `chapters`; → steps into it, → again enters the main pane.
  app.stdin.write("\x1b[C\x1b[C\x1b[C");
  await sleep(30);
  expect(app.lastFrame()).toContain("book · main");
});
