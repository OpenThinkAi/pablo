// The settings screen through the Ink app, against a temporary config file (never ~/.config/pablo).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "ink-testing-library";
import { App } from "../src/app";

let dir: string;
let configFile: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pablo-settings-app-")); configFile = join(dir, "pablo", "config.json"); });
afterEach(() => { cleanup(); rmSync(dir, { recursive: true, force: true }); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mount = (extra: { onCommand?: (c: { id: string }) => void } = {}) => render(<App title="Ice House" format="novel" size={{ cols: 100, rows: 30 }} configFile={configFile} {...extra} />);
const type = async (app: ReturnType<typeof render>, ...keys: string[]) => { for (const k of keys) { app.stdin.write(k); await sleep(30); } };

test("\\ opens settings listing each action's keys; it does not reach onCommand", async () => {
  const seen: string[] = [];
  const app = mount({ onCommand: (c) => seen.push(c.id) });
  await sleep(20);
  await type(app, "\\");
  const frame = app.lastFrame() ?? "";
  expect(frame).toContain("Settings");
  expect(frame).toContain("saved to");
  expect(frame).toContain("rail.down");
  expect(frame).toContain("Keys");
  expect(seen).toEqual([]);
});

test("pressing a key rebinds, a clash is refused, the editor is typed, and Esc then y writes the config", async () => {
  const app = mount();
  await sleep(20);
  await type(app, "\\", "\r", "x"); // rail.down primary -> x
  expect(app.lastFrame()).toContain("rail.down primary: x");
  expect(app.lastFrame()).toContain("1 unsaved change");
  await type(app, "\x1b[B", "\r", "j"); // rail.up: j is rail.down's secondary in the rail
  expect(app.lastFrame()).toContain("refused");
  for (let i = 0; i < 60; i++) { app.stdin.write("\x1b[B"); await sleep(4); } // to the editor line (the last)
  await type(app, "\r", "h", "x", "\r");
  expect(app.lastFrame()).toContain("hx");
  await type(app, "\x1b");
  expect(app.lastFrame()).toContain("Save changes?");
  expect(existsSync(configFile)).toBe(false);
  await type(app, "y");
  expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({ keys: { "rail.down": "x" }, editor: "hx" });
  // Back on the book, and the new binding is in force at once: x moves the rail, and the key panel lists it.
  expect(app.lastFrame()).toContain("book · rail");
  expect(app.lastFrame()).toContain("x/↑");
});

test("Esc with no changes leaves without a question; n discards the changes and writes nothing", async () => {
  const app = mount();
  await sleep(20);
  await type(app, "\\", "\x1b");
  expect(app.lastFrame()).toContain("book · rail");
  await type(app, "\\", "\r", "x", "\x1b", "n");
  expect(app.lastFrame()).toContain("book · rail");
  expect(existsSync(configFile)).toBe(false);
});
