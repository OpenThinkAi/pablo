// The settings screen (`\`): every action's keys and the editor command, edited on one screen and saved to
// ~/.config/pablo/config.json. Copied from prview's settings.ts and adapted: pablo's config is JSON, and has no models,
// roles or display options here yet, so the list is the keys and the editor.
//
// The screen's model is data in state.ts; this file is the rules that change it, pure apart from `saveSettings`, so
// every edit, refusal and save is tested without a terminal. Nothing here has rules of its own: a key is checked by
// `effectiveKeys` (the same check that refuses a bad `keys` when the screen opens), and the file is re-read, edited and
// parsed again before it is written, so the screen can never save a config pablo would refuse to start with.
//
// What a save rewrites: the `keys` and `editor` entries of the file as it is on disk now; every other entry (providers,
// intents, anything not pablo-tui's) is kept as it was. A key put back to its default has its `keys` entry removed,
// and an emptied editor has its `editor` removed.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseConfig } from "@openthink/pablo-core";
import { parseEditor, parseKeys } from "./key-config";
import { DEFAULT_ACTIONS, effectiveKeys, KeysError, showKey, type KeyAction, type Keymap } from "./keys";
import { clean } from "./sanitize";
import type { SavedSettings, SettingsField, SettingsModel, SettingsValues } from "./state";

type Slot = SettingsModel["slot"];

/** The keys of the screen's list: every action in table order (the fixed ones are listed, and say so when edited), then the editor. */
export const fieldsOf = (): SettingsField[] => [...DEFAULT_ACTIONS.map((a): SettingsField => ({ kind: "key", id: a.id })), { kind: "editor" }];

/** The section a field is listed under. */
export const sectionOf = (f: SettingsField): string => (f.kind === "key" ? "Keys" : "Editor command");

const rowOf = (id: string): KeyAction => DEFAULT_ACTIONS.find((a) => a.id === id)!;

/** The values the screen opens with: the keymap in force (defaults with overrides) and the editor command. */
export function valuesOf(keymap: Keymap, editor: string): SettingsValues {
  return { keys: Object.fromEntries(keymap.actions.map((a) => [a.id, { primary: a.key, secondary: a.secondary ?? "" }])), editor };
}

export function openSettings(keymap: Keymap, editor: string, path: string): SettingsModel {
  const v = valuesOf(keymap, editor);
  return { fields: fieldsOf(), initial: v, values: v, cursor: 0, slot: "primary", sub: null, path };
}

/** Every value as `path -> text`, so two sets of values compare and a save names what it touches. */
export function flat(v: SettingsValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, b] of Object.entries(v.keys)) { out[`keys.${id}.primary`] = b.primary; out[`keys.${id}.secondary`] = b.secondary; }
  out["editor"] = v.editor;
  return out;
}

/** The settings that differ from `a` in `b`. */
export function changed(a: SettingsValues, b: SettingsValues): string[] {
  const fa = flat(a), fb = flat(b);
  return Object.keys(fb).filter((k) => fa[k] !== fb[k]);
}
export const dirty = (s: SettingsModel): boolean => changed(s.initial, s.values).length > 0;

// ---------------------------------------------------------------- keys

/** The `keys` object these values amount to: every rebindable action whose keys differ from its default. */
export function overridesOf(v: SettingsValues): Record<string, { primary: string; secondary: string }> {
  const out: Record<string, { primary: string; secondary: string }> = {};
  for (const a of DEFAULT_ACTIONS) {
    const b = v.keys[a.id];
    if (a.fixed || !b) continue;
    if (b.primary !== a.key || b.secondary !== (a.secondary ?? "")) out[a.id] = { primary: b.primary, secondary: b.secondary };
  }
  return out;
}

/** `token` as `id`'s binding in `slot` ("" clears it), or why not, in the words the config check uses. */
export function bindKey(v: SettingsValues, id: string, slot: Slot, token: string): { values: SettingsValues } | { error: string } {
  const a = rowOf(id);
  if (a.fixed) return { error: `${id} is fixed (${showKey(a.key)}) and cannot be rebound` };
  const next: SettingsValues = { ...v, keys: { ...v.keys, [id]: { ...v.keys[id]!, [slot]: token } } };
  try { effectiveKeys(overridesOf(next)); } catch (e) {
    if (e instanceof KeysError) return { error: e.message.replace(/^keys: /, "") };
    throw e;
  }
  return { values: next };
}

const shown = (a: KeyAction, token: string) => (token ? (a.prefix ? `${a.prefix} ${showKey(token)}` : showKey(token)) : "-");

// ---------------------------------------------------------------- the keys of the screen

export type Out = { s: SettingsModel; out?: "leave" | "save" };

const say = (s: SettingsModel, text: string, error = false): SettingsModel => ({ ...s, message: { text, error } });
const field = (s: SettingsModel): SettingsField => s.fields[s.cursor]!;

/** The settings screen's own keys, while no binding is being captured, no line typed and no question asked. */
export function settingsAct(s0: SettingsModel, token: string): Out {
  const s: SettingsModel = { ...s0, message: undefined };
  const f = field(s);
  switch (token) {
    case "down": case "j": return { s: { ...s, cursor: Math.min(s.fields.length - 1, s.cursor + 1) } };
    case "up": case "k": return { s: { ...s, cursor: Math.max(0, s.cursor - 1) } };
    case "right": case "l": return { s: f.kind === "key" ? { ...s, slot: "secondary" } : s };
    case "left": case "h": return { s: f.kind === "key" ? { ...s, slot: "primary" } : s };
    case "esc": return dirty(s) ? { s: { ...s, sub: { kind: "confirm" } } } : { s, out: "leave" };
    case "backspace": {
      if (f.kind !== "key") return { s: say(s, "Backspace clears a key's secondary binding") };
      const a = rowOf(f.id);
      if (a.fixed) return { s: say(s, `${f.id} is fixed and cannot be rebound`, true) };
      if (s.slot !== "secondary") return { s: say(s, "Backspace clears a secondary; Enter binds a new primary (→ for the secondary)") };
      if (!s.values.keys[f.id]!.secondary) return { s: say(s, `${f.id} has no secondary`) };
      const r = bindKey(s.values, f.id, "secondary", "");
      return "error" in r ? { s: say(s, r.error, true) } : { s: say({ ...s, values: r.values }, `${f.id}: secondary cleared`) };
    }
    case "enter": {
      if (f.kind === "editor") return { s: { ...s, sub: { kind: "typing", text: s.values.editor } } };
      const a = rowOf(f.id);
      if (a.fixed) return { s: say(s, `${f.id} is fixed (${shown(a, a.key)}) and cannot be rebound`, true) };
      return { s: { ...s, sub: { kind: "capture" } } };
    }
  }
  return { s };
}

/** Typed text (a paste, or one key) onto the editor line. Control characters are dropped. */
const typed = (text: string, add: string) => text + clean(add).replace(/[\r\n]/g, "");

/**
 * A key on the screen. While a binding is captured, the editor line typed or the way out asked, the key itself is what
 * counts, not the action it is bound to. Capturing: Esc cancels (it cannot be bound), Tab is refused, Backspace clears
 * a secondary, any other key is checked like a `keys` entry and refused when it clashes.
 */
export function settingsKey(s0: SettingsModel, token: string): Out {
  const s: SettingsModel = { ...s0, message: undefined };
  const sub = s.sub;
  if (!sub) return settingsAct(s0, token);
  const done = (x: SettingsModel): SettingsModel => ({ ...x, sub: null });
  if (sub.kind === "confirm") {
    if (token === "y") return { s: done(s), out: "save" };
    if (token === "n") return { s: done(s), out: "leave" };
    if (token === "esc") return { s: done(s) };
    return { s: say(s, "y saves, n discards, Esc keeps editing") };
  }
  if (sub.kind === "typing") {
    if (token === "enter") return { s: done({ ...s, values: { ...s.values, editor: sub.text.trim() } }) };
    if (token === "esc") return { s: done(s) };
    const text = token === "backspace" ? sub.text.slice(0, -1) : token === "ctrl-u" ? "" : token === "ctrl-w" ? sub.text.replace(/\S+\s*$/, "") : token === "space" ? sub.text + " " : [...token].length === 1 ? typed(sub.text, token) : sub.text;
    return { s: { ...s, sub: { kind: "typing", text } } };
  }
  const f = field(s);
  if (f.kind !== "key") return { s: done(s) };
  const a = rowOf(f.id);
  if (token === "esc") return { s: say(done(s), "Esc always backs out and cannot be bound; nothing changed") };
  if (token === "tab" || token === "shift-tab") return { s: say(done(s), "Tab moves focus to the content area and cannot be bound", true) };
  if (token === "backspace") {
    if (s.slot === "secondary") return settingsAct(done(s), "backspace");
    return { s: say(done(s), "Backspace clears a secondary; a primary needs a key", true) };
  }
  const r = bindKey(s.values, f.id, s.slot, token);
  if ("error" in r) return { s: say(done(s), `refused: ${r.error}`, true) };
  return { s: say(done({ ...s, values: r.values }), `${f.id} ${s.slot}: ${shown(a, token)}`) };
}

/**
 * One key on the screen, with the save it may cause done: either the screen as it is now, or the way out (`close`),
 * with what a save left in force (null when the changes were discarded or there were none). A save that fails (a
 * config changed underneath, say) stays on the screen with the reason.
 */
export function settingsStep(s: SettingsModel, token: string): { s: SettingsModel } | { close: SavedSettings | null } {
  const r = settingsKey(s, token);
  if (r.out === "leave") return { close: null };
  if (r.out === "save") {
    try { return { close: saveSettings(r.s) }; } catch (e) {
      if (e instanceof SettingsError) return { s: say(r.s, e.message, true) };
      throw e;
    }
  }
  return { s: r.s };
}

/** A paste while the editor line is being typed; anywhere else it means nothing. */
export function settingsPaste(s: SettingsModel, text: string): SettingsModel {
  return s.sub?.kind === "typing" ? { ...s, message: undefined, sub: { kind: "typing", text: typed(s.sub.text, text) } } : s;
}

// ---------------------------------------------------------------- what a field reads as

export interface FieldView { readonly label: string; readonly value: string; readonly changed: boolean; readonly fixed?: boolean; readonly states?: string; readonly primary?: string; readonly secondary?: string; readonly description: string }

/** The label and value a field shows; for a key, its states and the two bindings. */
export function describeField(s: SettingsModel, f: SettingsField): FieldView {
  const fi = flat(s.initial), fv = flat(s.values);
  const ch = (...paths: string[]) => paths.some((p) => fi[p] !== fv[p]);
  if (f.kind === "editor") {
    return { label: "editor", value: s.values.editor || "(from $EDITOR, else hx)", changed: ch("editor"), description: "The command v e runs, with the file and line added. Empty: $EDITOR, else hx. Enter edits it." };
  }
  const a = rowOf(f.id), b = s.values.keys[f.id]!;
  return {
    label: f.id, value: "", changed: ch(`keys.${f.id}.primary`, `keys.${f.id}.secondary`), ...(a.fixed ? { fixed: true } : {}),
    states: `${a.states.join(", ")}${a.prefix ? ` · ${a.prefix}` : ""}`, primary: b.primary ? shown(a, b.primary) : "(unbound)", secondary: shown(a, b.secondary),
    description: a.description,
  };
}

// ---------------------------------------------------------------- saving

/** The values as the session keeps them in force once saved. */
export const savedOf = (v: SettingsValues): SavedSettings => ({ overrides: overridesOf(v), editor: v.editor });

export class SettingsError extends Error {}

/**
 * Write the changed settings into the config file as it is on disk now, and return what is now in force. The new text
 * is checked with the startup check (`keys`, then core's own parser) first and must read back as what the screen shows;
 * if it does not (the file was changed underneath, say) nothing is written and a SettingsError says why.
 */
export function saveSettings(s: SettingsModel): SavedSettings {
  const path = s.path;
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  let obj: Record<string, unknown> = {};
  if (before.trim()) {
    let raw: unknown;
    try { raw = JSON.parse(before); } catch (e) { throw new SettingsError(`${path} is not valid JSON (${(e as Error).message}); nothing was written`); }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new SettingsError(`${path} must contain a JSON object; nothing was written`);
    obj = raw as Record<string, unknown>;
  }
  const overrides = overridesOf(s.values);
  const { keys: _keys, editor: _editor, ...rest } = obj;
  const next: Record<string, unknown> = { ...rest };
  if (Object.keys(overrides).length) next["keys"] = Object.fromEntries(Object.entries(overrides).map(([id, b]) => [id, bindingOf(rowOf(id), b)]));
  if (s.values.editor) next["editor"] = s.values.editor;
  const text = `${JSON.stringify(next, null, 2)}\n`;
  try {
    parseConfig(text, path);
    const keymap = effectiveKeys(parseKeys(text, path));
    const got = flat(valuesOf(keymap, parseEditor(text) ?? "")), want = flat(s.values);
    const off = changed(s.initial, s.values).filter((p) => got[p] !== want[p]);
    if (off.length) throw new SettingsError(`${path} would not read back as set (${off.join(", ")}); nothing was written`);
  } catch (e) {
    if (e instanceof SettingsError) throw e;
    throw new SettingsError(`${(e as Error).message}; nothing was written`);
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return savedOf(s.values);
}

/** A binding as the file spells it: just the primary when the secondary is the default's, else both. */
function bindingOf(a: KeyAction, b: { primary: string; secondary: string }): string | { primary: string; secondary: string } {
  return b.secondary === (a.secondary ?? "") ? b.primary : b;
}
