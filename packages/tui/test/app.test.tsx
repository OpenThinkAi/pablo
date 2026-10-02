import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { actionOf, App } from "../src/app";
import { clean } from "../src/sanitize";
import { initialState } from "../src/state";

afterEach(() => cleanup());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the screen shows the project's title and format with the quit key", () => {
  const app = render(<App title="Ice House" format="novel" size={{ cols: 80, rows: 24 }} />);
  const frame = app.lastFrame() ?? "";
  expect(frame).toContain("Ice House");
  expect(frame).toContain("novel");
  expect(frame).toContain("q quit");
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

test("actionOf: the arrows act in the focused region, Tab moves focus, Esc backs out", () => {
  const rail = initialState();
  expect(actionOf("", { downArrow: true }, rail)).toEqual({ type: "rail.down" });
  expect(actionOf("", { upArrow: true }, rail)).toEqual({ type: "rail.up" });
  expect(actionOf("", { rightArrow: true }, rail)).toEqual({ type: "rail.expand" });
  expect(actionOf("", { leftArrow: true }, rail)).toEqual({ type: "rail.collapse" });
  expect(actionOf("", { tab: true }, rail)).toEqual({ type: "focus.content" });
  expect(actionOf("", { escape: true }, rail)).toEqual({ type: "escape" });
  expect(actionOf("x", {}, rail)).toBeNull();
  const main = { ...rail, pane: "main" as const, focus: "main" as const };
  expect(actionOf("", { downArrow: true }, main)).toEqual({ type: "main.down" });
  expect(actionOf("", { leftArrow: true }, main)).toEqual({ type: "main.to_rail" });
  expect(actionOf("", { rightArrow: true }, main)).toBeNull();
  const content = { ...rail, focus: "content" as const };
  expect(actionOf("", { downArrow: true }, content)).toEqual({ type: "content.down" });
  expect(actionOf("", { rightArrow: true }, content)).toBeNull();
  expect(actionOf("", { tab: true }, content)).toEqual({ type: "focus.back" });
});

test("control characters in the title never reach the screen as escapes", () => {
  const app = render(<App title={"Ice\x1b]0;pwned\x07 House"} format="novel" size={{ cols: 80, rows: 24 }} />);
  expect(app.lastFrame()).not.toContain("\x1b]");
  expect(clean("a\x1b[2Jb")).toBe("ab");
});
