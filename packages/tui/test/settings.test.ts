// The settings screen's rules without a terminal, and its saves against a temporary config (never ~/.config/pablo).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKeymap } from "../src/key-config";
import { DEFAULT_KEYMAP, effectiveKeys } from "../src/keys";
import { bindKey, changed, describeField, dirty, openSettings, overridesOf, saveSettings, settingsKey, settingsPaste, settingsStep } from "../src/settings";
import type { SettingsModel } from "../src/state";

let dir: string;
let path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pablo-settings-")); path = join(dir, "pablo", "config.json"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const open = (): SettingsModel => openSettings(DEFAULT_KEYMAP, "", path);
const press = (s: SettingsModel, ...tokens: string[]): SettingsModel => tokens.reduce((m, t) => { const r = settingsKey(m, t); return r.s; }, s);
const on = (s: SettingsModel, id: string): SettingsModel => ({ ...s, cursor: s.fields.findIndex((f) => f.kind === "key" && f.id === id) });

test("the list is every action's keys, then the editor command", () => {
  const s = open();
  expect(s.fields.length).toBe(DEFAULT_KEYMAP.actions.length + 1);
  expect(s.fields[s.fields.length - 1]).toEqual({ kind: "editor" });
  expect(describeField(s, s.fields[0]!)).toMatchObject({ label: "rail.down", primary: "↓", secondary: "j" });
  expect(dirty(s)).toBe(false);
});

test("pressing a key on a field captures it as the primary; → moves to the secondary", () => {
  let s = press(on(open(), "rail.down"), "enter");
  expect(s.sub).toEqual({ kind: "capture" });
  s = press(s, "x");
  expect(s.sub).toBeNull();
  expect(s.values.keys["rail.down"]).toEqual({ primary: "x", secondary: "j" });
  expect(s.message?.text).toBe("rail.down primary: x");
  s = press(s, "right", "enter", "m");
  expect(s.values.keys["rail.down"]).toEqual({ primary: "x", secondary: "m" });
  expect(changed(s.initial, s.values)).toEqual(["keys.rail.down.primary", "keys.rail.down.secondary"]);
});

test("a key already bound in one of the action's states is refused, and nothing changes", () => {
  const s = press(on(open(), "rail.down"), "enter", "k"); // k is rail.up's secondary in the rail
  expect(s.values).toBe(s.initial);
  expect(s.message?.error).toBe(true);
  expect(s.message?.text).toContain("refused");
  expect(s.message?.text).toContain("both \"k\"");
  // The same key where the states never meet is fine: `e` is a review key outside the rail's prefix layers? use a prefix's own second key.
  const prefixKey = press(on(open(), "view.zen"), "enter", "c"); // v c is view.fullscreen in the same layer
  expect(prefixKey.message?.error).toBe(true);
  // A prefix letter cannot become a top-level key where it is a prefix.
  const clash = press(on(open(), "rail.down"), "enter", "a");
  expect(clash.message?.error).toBe(true);
});

test("Esc cancels a capture without binding it; Tab is refused; a fixed row cannot be edited", () => {
  const esc = press(on(open(), "rail.down"), "enter", "esc");
  expect(esc.sub).toBeNull();
  expect(esc.values).toBe(esc.initial);
  const tab = press(on(open(), "rail.down"), "enter", "tab");
  expect(tab.message?.error).toBe(true);
  expect(tab.values).toBe(tab.initial);
  const fixed = press(on(open(), "go.line"), "enter");
  expect(fixed.sub).toBeNull();
  expect(fixed.message?.text).toContain("fixed");
});

test("Backspace clears a secondary only", () => {
  const prim = press(on(open(), "rail.down"), "backspace");
  expect(prim.message?.text).toContain("secondary");
  expect(prim.values).toBe(prim.initial);
  const sec = press(on(open(), "rail.down"), "right", "backspace");
  expect(sec.values.keys["rail.down"]).toEqual({ primary: "down", secondary: "" });
});

test("the editor command is typed on a line: Enter sets it, Esc abandons, a paste is added, control characters are dropped", () => {
  const last = (s: SettingsModel): SettingsModel => ({ ...s, cursor: s.fields.length - 1 });
  let s = press(last(open()), "enter", "h", "x", "space", "-", "n");
  expect(s.sub).toEqual({ kind: "typing", text: "hx -n" });
  s = settingsPaste(s, " --wait\x07");
  expect(s.sub).toEqual({ kind: "typing", text: "hx -n --wait" });
  s = press(s, "backspace", "enter");
  expect(s.values.editor).toBe("hx -n --wai");
  const abandoned = press(last(open()), "enter", "v", "esc");
  expect(abandoned.values.editor).toBe("");
  expect(settingsPaste(open(), "x")).toEqual(open()); // a paste means nothing when no line is being typed
});

test("Esc with changes asks; y saves, n discards, Esc keeps editing; with none it just leaves", () => {
  expect(settingsKey(open(), "esc").out).toBe("leave");
  const changedS = press(on(open(), "rail.down"), "enter", "x");
  const asked = settingsKey(changedS, "esc").s;
  expect(asked.sub).toEqual({ kind: "confirm" });
  expect(settingsKey(asked, "y").out).toBe("save");
  expect(settingsKey(asked, "n").out).toBe("leave");
  expect(settingsKey(asked, "esc").s.sub).toBeNull();
  expect(settingsKey(asked, "q").s.message?.text).toContain("y saves");
});

test("overridesOf lists only the rebound rows; an action put back to its default drops out", () => {
  const s = press(on(open(), "rail.down"), "enter", "x");
  expect(overridesOf(s.values)).toEqual({ "rail.down": { primary: "x", secondary: "j" } });
  const back = press(s, "enter", "down");
  expect(overridesOf(back.values)).toEqual({});
  expect(bindKey(open().values, "go.line", "primary", "x")).toHaveProperty("error"); // a fixed row
});

// ---------------------------------------------------------------- saving

test("saving writes keys and editor to the config, keeps every other entry, and reads back through the startup loader", () => {
  writeFileSync(join(dir, "seed.json"), "");
  const seed = { providers: { local: { endpoint: "http://127.0.0.1:8002/v1" } }, default: "local" };
  require("node:fs").mkdirSync(join(dir, "pablo"));
  writeFileSync(path, JSON.stringify(seed));
  let s = press(on(open(), "rail.down"), "enter", "x");
  s = press({ ...s, cursor: s.fields.length - 1 }, "enter", "h", "x", "enter");
  const saved = saveSettings(s);
  expect(saved).toEqual({ overrides: { "rail.down": { primary: "x", secondary: "j" } }, editor: "hx" });
  const file = JSON.parse(readFileSync(path, "utf8"));
  expect(file.providers).toEqual(seed.providers);
  expect(file.default).toBe("local");
  expect(file.keys).toEqual({ "rail.down": "x" });
  expect(file.editor).toBe("hx");
  expect(readdirSync(join(dir, "pablo"))).toEqual(["config.json"]); // no temp file left
  // What the screen opens with next time.
  const km = loadKeymap({ env: { XDG_CONFIG_HOME: dir } });
  expect(km.actions.find((a) => a.id === "rail.down")?.key).toBe("x");
});

test("saving creates the config when there is none; both bindings changed are written as an object; defaults and an emptied editor are removed", () => {
  let s = press(on(open(), "rail.down"), "enter", "x", "right", "enter", "m");
  s = press({ ...s, cursor: s.fields.length - 1 }, "enter", "h", "x", "enter");
  saveSettings(s);
  const file = JSON.parse(readFileSync(path, "utf8"));
  expect(file.keys).toEqual({ "rail.down": { primary: "x", secondary: "m" } });
  // Open again from what is saved, put everything back.
  const again = openSettings(effectiveKeys(overridesOf(s.values)), "hx", path);
  let back = press(on(again, "rail.down"), "enter", "down", "right", "enter", "j");
  back = press({ ...back, cursor: back.fields.length - 1 }, "enter", "ctrl-u", "enter");
  saveSettings(back);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({});
});

test("a save refuses a config that is not JSON or not an object, and writes nothing", () => {
  require("node:fs").mkdirSync(join(dir, "pablo"));
  writeFileSync(path, "{ nope");
  const s = press(on(open(), "rail.down"), "enter", "x");
  expect(() => saveSettings(s)).toThrow("not valid JSON");
  expect(readFileSync(path, "utf8")).toBe("{ nope");
  writeFileSync(path, "[1]");
  expect(() => saveSettings(s)).toThrow("JSON object");
  // Through the step: the screen stays, with the reason.
  const step = settingsStep({ ...s, sub: { kind: "confirm" } }, "y");
  expect("s" in step && step.s.message?.error).toBe(true);
  expect("s" in step && step.s.message?.text).toContain("JSON object");
});

test("a save replaces the file's `keys` with what the screen shows, so one changed underneath cannot leave a conflict", () => {
  require("node:fs").mkdirSync(join(dir, "pablo"));
  // The file now binds rail.up to "x"; the screen, opened earlier, binds rail.down to "x".
  writeFileSync(path, JSON.stringify({ keys: { "rail.up": "x" } }));
  const s = press(on(open(), "rail.down"), "enter", "x");
  expect(saveSettings(s)).toEqual({ overrides: { "rail.down": { primary: "x", secondary: "j" } }, editor: "" });
  expect(JSON.parse(readFileSync(path, "utf8")).keys).toEqual({ "rail.down": "x" });
  expect(() => effectiveKeys(JSON.parse(readFileSync(path, "utf8")).keys)).not.toThrow();
});

test("settingsStep: leaving with no changes closes without a save; y saves and closes carrying it", () => {
  expect(settingsStep(open(), "esc")).toEqual({ close: null });
  const s = press(on(open(), "rail.down"), "enter", "x");
  const asked = settingsKey(s, "esc").s;
  expect(settingsStep(asked, "n")).toEqual({ close: null });
  expect(settingsStep(asked, "y")).toEqual({ close: { overrides: { "rail.down": { primary: "x", secondary: "j" } }, editor: "" } });
  expect(JSON.parse(readFileSync(path, "utf8")).keys).toEqual({ "rail.down": "x" });
});
