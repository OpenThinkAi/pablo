import { expect, test } from "bun:test";
import { BINDINGS, chordsFor, matchBinding } from "../src/keymap";
import { ACTIONS } from "../src/view-state";

/** The chord vocabulary: a printable character, or one of these named keys. */
const NAMED = ["space", "up", "down", "left", "right", "pageup", "pagedown", "home", "end", "escape"];

test("no action needs a function key or a number key (AC5)", () => {
  for (const binding of BINDINGS) {
    for (const chord of binding.chords) {
      const key = chord.replace(/^(ctrl\+|meta\+)+/, "");
      expect(`${binding.action}: ${chord}`).not.toMatch(/^f\d{1,2}$/);
      expect(`${binding.action}: ${chord}`).not.toMatch(/\d/);
      expect(NAMED.includes(key) || (key.length === 1 && key >= "!" && key <= "~")).toBe(true);
    }
  }
});

test("every action in the map exists, and no chord is bound twice", () => {
  // `reload` is the one action the view owns, because it touches the disk.
  const missing = BINDINGS.filter((binding) => binding.action !== "reload" && !(binding.action in ACTIONS));
  expect(missing.map((binding) => binding.action)).toEqual([]);

  const seen = new Set<string>();
  const duplicates = BINDINGS.flatMap((binding) => binding.chords).filter((chord) => {
    const repeated = seen.has(chord);
    seen.add(chord);
    return repeated;
  });
  expect(duplicates).toEqual([]);
});

test("every action has a label, so the help screen documents the whole map", () => {
  for (const binding of BINDINGS) {
    expect(binding.label.length).toBeGreaterThan(3);
  }
});

test("a shifted symbol binds as itself, not as its unshifted key", () => {
  // `?` and `G` come off the Corne's shift layer; binding them by the character
  // the terminal reports is what makes the map layout-independent.
  expect(matchBinding({ name: "?", sequence: "?" })?.action).toBe("toggleHelp");
  expect(matchBinding({ name: "g", sequence: "G" })?.action).toBe("bottom");
  expect(matchBinding({ name: "g", sequence: "g" })?.action).toBe("top");
  expect(matchBinding({ name: "]", sequence: "}" })?.action).toBe("endForward");
});

test("letters, arrows and control chords all resolve", () => {
  expect(matchBinding({ name: "q", sequence: "q" })?.action).toBe("quit");
  expect(matchBinding({ name: "c", sequence: "", ctrl: true })?.action).toBe("quit");
  expect(matchBinding({ name: "down", sequence: "" })?.action).toBe("scrollDown");
  expect(matchBinding({ name: "space", sequence: " " })?.action).toBe("pageDown");
  expect(matchBinding({ name: "z", sequence: "z" })).toBeUndefined();
});

test("a control byte never counts as a literal chord", () => {
  expect(chordsFor({ name: "c", sequence: "", ctrl: true })).toEqual(["ctrl+c"]);
});
