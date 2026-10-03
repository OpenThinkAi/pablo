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
// Waits for the screen to reach a state instead of trusting a fixed pause: a slow CI runner renders well after
// 30ms, and checking too early both fails the test and leaves keys typed into the wrong row.
const until = async (app: ReturnType<typeof render>, ok: (frame: string) => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok(app.lastFrame() ?? "") && Date.now() < end) await sleep(20);
  return app.lastFrame() ?? "";
};

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
  await type(app, "\\");
  await until(app, (f) => f.includes("Settings"));
  await type(app, "\r", "x"); // rail.down primary -> x
  expect(await until(app, (f) => f.includes("1 unsaved change"))).toContain("rail.down primary: x");
  await type(app, "\x1b[B", "\r", "j"); // rail.up: j is rail.down's secondary in the rail
  expect(await until(app, (f) => f.includes("refused"))).toContain("refused");
  // To the editor line (the last). One key per render: back-to-back escape sequences in one chunk are not
  // read as separate arrows, so each press waits for the screen to move before the next.
  for (let i = 0; i < 60; i++) { const before = app.lastFrame(); app.stdin.write("\x1b[B"); await until(app, (f) => f !== before, 300); }
  await type(app, "\r", "h", "x", "\r");
  expect(await until(app, (f) => f.includes("hx"))).toContain("hx");
  await type(app, "\x1b");
  expect(await until(app, (f) => f.includes("Save changes?"))).toContain("Save changes?");
  expect(existsSync(configFile)).toBe(false);
  await type(app, "y");
  await until(app, (f) => f.includes("book · rail"));
  expect(JSON.parse(readFileSync(configFile, "utf8"))).toEqual({ keys: { "rail.down": "x" }, editor: "hx" });
  // Back on the book, and the new binding is in force at once: x moves the rail, and the key panel lists it.
  expect(app.lastFrame()).toContain("book · rail");
  expect(app.lastFrame()).toContain("x/↑");
}, 60_000);

test("Esc with no changes leaves without a question; n discards the changes and writes nothing", async () => {
  const app = mount();
  await sleep(20);
  await type(app, "\\", "\x1b");
  expect(app.lastFrame()).toContain("book · rail");
  await type(app, "\\", "\r", "x", "\x1b", "n");
  expect(app.lastFrame()).toContain("book · rail");
  expect(existsSync(configFile)).toBe(false);
});
