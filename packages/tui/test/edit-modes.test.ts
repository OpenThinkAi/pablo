// Focus and typewriter (AGT-2176): the paragraph and scroll rules, the rows they shape, the persisted toggles and their keys.

import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadModes, modeOfKey, NO_MODES, paragraphSpan, parseModes, saveModes, scrollTop, toggled } from "../src/edit-modes";
import { openText, paneView } from "../src/edit-pane";
import { DEFAULT_KEYMAP, effectiveKeys, keyStateOf, rowsOf } from "../src/keys";
import { initialState, reduce } from "../src/state";

const NOVEL = "---\nchapter: 1\n---\n\nOne a.\n\nTwo a.\nTwo b.\n\nThree a.\n";

test("paragraphSpan: the run of non-blank rows around the row; a blank row is only itself", () => {
  const lines = ["a", "b", "", "c", "", "", "d", "e", "f"];
  expect(paragraphSpan(lines, 1)).toEqual({ first: 0, last: 1 });
  expect(paragraphSpan(lines, 3)).toEqual({ first: 3, last: 3 });
  expect(paragraphSpan(lines, 2)).toEqual({ first: 2, last: 2 });
  expect(paragraphSpan(lines, 6)).toEqual({ first: 6, last: 8 });
});

test("scrollTop: kept while the cursor is in the window, moved just far enough otherwise, clamped; typewriter centres", () => {
  expect(scrollTop(3, 5, 10, 40, false)).toBe(3);
  expect(scrollTop(3, 2, 10, 40, false)).toBe(2);
  expect(scrollTop(3, 20, 10, 40, false)).toBe(11);
  expect(scrollTop(30, 5, 10, 6, false)).toBe(5);
  expect(scrollTop(0, 20, 11, 40, true)).toBe(15);
  expect(scrollTop(99, 0, 11, 40, true)).toBe(-5); // the first line sits mid-screen, blank above
});

test("paneView focus: rows outside the cursor's paragraph are dim, the paragraph's own are not", () => {
  const t = openText(NOVEL, "sentences", 7); // "Two a. Two b."
  expect(t.buffer.cursor.row).toBe(2);
  const off = paneView(t, 40, 10, new Map());
  expect(off.rows.every((r) => r.dim === undefined)).toBe(true);
  const on = paneView(t, 40, 10, new Map(), { focus: true });
  expect(on.rows.map((r) => [r.kind === "text" ? r.text : "", r.dim === true])).toEqual([["One a.", true], ["", true], ["Two a. Two b.", false], ["", true], ["Three a.", true]]);
});

test("paneView focus: a hit's box dims with the paragraph it sits under", () => {
  const t = openText(NOVEL, "sentences", 7);
  const hit = (line: number) => ({ line, rule: "r", excerpt: "x" });
  const rows = paneView(t, 40, 20, new Map([[0, [hit(5)]], [2, [hit(7)]]]), { focus: true }).rows;
  const boxes = rows.filter((r) => r.kind === "box");
  expect(boxes.length).toBeGreaterThan(2);
  const dimBoxes = boxes.filter((r) => r.dim === true).length;
  expect(dimBoxes).toBe(boxes.length / 2);
});

test("paneView typewriter: the cursor's row is the middle row, padded with blanks near the ends; it never writes the buffer's top", () => {
  const body = Array.from({ length: 30 }, (_, i) => `Line ${i}.`).join("\n\n");
  const t = openText(`---\nx: 1\n---\n\n${body}\n`, "sentences", 1);
  const mid = (look: { top?: number }, row: number) => {
    t.buffer.cursor = { row, col: 0 };
    const v = paneView(t, 40, 9, new Map(), { typewriter: true, ...look });
    expect(v.rows.length).toBe(9);
    expect(v.rows[4]).toMatchObject({ text: t.buffer.lines[row]!, cursor: expect.anything() });
    return v;
  };
  expect(mid({}, 0).rows[0]).toMatchObject({ kind: "text", text: "" });
  mid({}, 20);
  expect(mid({}, 58).rows[8]).toMatchObject({ text: "" }); // past the last row: blank below
  expect(t.buffer.top).toBe(0);
});

test("paneView without typewriter scrolls from the given top and reports it", () => {
  const body = Array.from({ length: 30 }, (_, i) => `Line ${i}.`).join("\n\n");
  const t = openText(`---\nx: 1\n---\n\n${body}\n`, "sentences", 1);
  t.buffer.cursor = { row: 20, col: 0 };
  const v = paneView(t, 40, 6, new Map(), { top: 0 });
  expect(v.top).toBe(15);
  expect(v.rows.at(-1)).toMatchObject({ cursor: expect.anything() });
  expect(paneView(t, 40, 6, new Map(), { top: v.top }).top).toBe(15);
});

test("modes persist in the config's editModes, keeping every other entry; both off removes the entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "pablo-modes-"));
  const path = join(dir, "pablo", "config.json");
  saveModes(path, { focus: true, typewriter: false });
  expect(parseModes(readFileSync(path, "utf8"))).toEqual({ focus: true, typewriter: false });
  writeFileSync(path, JSON.stringify({ editor: "hx", keys: { "rail.down": "n" }, editModes: { focus: true } }));
  saveModes(path, { focus: true, typewriter: true });
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ editor: "hx", keys: { "rail.down": "n" }, editModes: { focus: true, typewriter: true } });
  saveModes(path, NO_MODES);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ editor: "hx", keys: { "rail.down": "n" } });
  writeFileSync(path, "[1]");
  expect(() => saveModes(path, { focus: true, typewriter: false })).toThrow(/must contain a JSON object/);
  expect(readFileSync(path, "utf8")).toBe("[1]");
});

test("parseModes and loadModes: absent, malformed or non-boolean entries read as off", () => {
  expect(parseModes("{}")).toEqual(NO_MODES);
  expect(parseModes("not json")).toEqual(NO_MODES);
  expect(parseModes('{"editModes":{"focus":"yes","typewriter":true}}')).toEqual({ focus: false, typewriter: true });
  expect(loadModes({ env: { XDG_CONFIG_HOME: "/nope" }, readFile: () => undefined })).toEqual(NO_MODES);
  expect(loadModes({ env: { XDG_CONFIG_HOME: "/nope" }, readFile: () => '{"editModes":{"focus":true}}' })).toEqual({ focus: true, typewriter: false });
  expect(toggled(NO_MODES, "focus")).toEqual({ focus: true, typewriter: false });
});

test("the toggles are key-config rows: Ctrl+F and Ctrl+T by default, rebindable", () => {
  expect(modeOfKey("ctrl-f", DEFAULT_KEYMAP)).toBe("focus");
  expect(modeOfKey("ctrl-t", DEFAULT_KEYMAP)).toBe("typewriter");
  expect(modeOfKey("x", DEFAULT_KEYMAP)).toBeNull();
  expect(modeOfKey(null, DEFAULT_KEYMAP)).toBeNull();
  const km = effectiveKeys({ "edit.focus": "ctrl-g" });
  expect(modeOfKey("ctrl-g", km)).toBe("focus");
  expect(modeOfKey("ctrl-f", km)).toBeNull();
});

test("the toggles are listed only while the pane is open, and the model holds the modes and the scroll", () => {
  let s = initialState({ focus: true, typewriter: false });
  expect(s.modes).toEqual({ focus: true, typewriter: false });
  expect(rowsOf({ state: "main", review: false, content: false }).map((r) => r.id)).not.toContain("edit.focus");
  expect(rowsOf({ state: "insert", review: false, content: false, pane: true }).map((r) => r.id)).toEqual(expect.arrayContaining(["edit.focus", "edit.typewriter"]));
  s = reduce(s, { type: "modes.set", modes: { focus: true, typewriter: true } });
  expect(s.modes.typewriter).toBe(true);
  expect(keyStateOf(s).pane).toBe(false);
  expect(reduce(s, { type: "pane.scroll", top: 4 })).toBe(s); // no pane open: nothing to scroll
});
