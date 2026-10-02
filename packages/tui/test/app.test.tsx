import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";
import { clean } from "../src/sanitize";

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

test("control characters in the title never reach the screen as escapes", () => {
  const app = render(<App title={"Ice\x1b]0;pwned\x07 House"} format="novel" size={{ cols: 80, rows: 24 }} />);
  expect(app.lastFrame()).not.toContain("\x1b]");
  expect(clean("a\x1b[2Jb")).toBe("ab");
});
