// The editor's live word count and word targets (AGT-2175, D-18): the status line's `words` field while `v e` is open.
// The count is core's `countWords` over the buffer, the same counter `pablo status` uses for a unit file (`fileWords`),
// so the editor's number for a saved file is `status`'s. A target is for one unit (keyed by its file) or for the work
// (every unit of the output the edited unit belongs to, the edited one counted live); it persists through a `TargetStore`
// the CLI passes in (`<work>/.pablo/targets.json`). The pure parts come first; the one hook at the end is the pane's only
// touch point (app.tsx calls it, and the pane's keys are held while a target is being typed).

import { useEffect, useMemo, type Dispatch } from "react";
import { useInput } from "ink";
import { countWords } from "@openthink/pablo-core";
import { resolve, tokenOf } from "./chord";
import { DEFAULT_KEYMAP, type Keymap } from "./keys";
import type { BookRail } from "./book";
import type { EditText } from "./edit-pane";
import type { Action, EditPane, WordsState, WordTargets } from "./state";

/** The word targets: one per output of the work (all its units together), and one per unit file (work-relative). Held by the model (`state.words`). */
export type Targets = WordTargets;
/** Where targets persist (the CLI's `<work>/.pablo/targets.json`); `save` may throw, `load` returns the file's JSON (undefined for none), read by `readTargets`. */
export interface TargetStore {
  load(): unknown;
  save(targets: Targets): void;
}
export const NO_TARGETS: Targets = { outputs: {}, units: {} };

export type TargetScope = "unit" | "work";
export type TargetCommand = { readonly ok: true; readonly scope: TargetScope; readonly words: number | null } | { readonly ok: false; readonly message: string };

export const TARGET_HELP = "N: this unit · w N: this output · 0: clear";

/** What was typed at the target prompt: `600` (this unit), `w 5000` or `work 5000` (the unit's output), `0` or `clear` (remove it). */
export function parseTarget(input: string): TargetCommand {
  const m = /^\s*(?:(w|work|u|unit)\s*)?(\d[\d,_]*|clear)\s*$/i.exec(input);
  if (!m) return { ok: false, message: `target: ${TARGET_HELP}` };
  const scope: TargetScope = /^w/i.test(m[1] ?? "") ? "work" : "unit";
  if (/^clear$/i.test(m[2]!)) return { ok: true, scope, words: null };
  const n = Number(m[2]!.replace(/[,_]/g, ""));
  return Number.isSafeInteger(n) ? { ok: true, scope, words: n === 0 ? null : n } : { ok: false, message: "target: too large" };
}

/** `targets` with the unit's (by `file`) or its output's (by `output`) target set to `words`, or removed when null. */
export function withTarget(targets: Targets, scope: TargetScope, file: string, words: number | null, output = "work"): Targets {
  const key = scope === "work" ? output : file;
  const slot = scope === "work" ? "outputs" : "units";
  const next = { ...targets[slot] };
  if (words === null) delete next[key];
  else next[key] = words;
  return { ...targets, [slot]: next };
}

/** Normalises whatever a store file held into `Targets` (positive integers only). */
export function readTargets(raw: unknown): Targets {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const good = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  const units: Record<string, number> = {};
  if (o["units"] && typeof o["units"] === "object") for (const [k, v] of Object.entries(o["units"] as object)) if (good(v)) units[k] = v;
  const outputs: Record<string, number> = {};
  if (o["outputs"] && typeof o["outputs"] === "object") for (const [k, v] of Object.entries(o["outputs"] as object)) if (good(v)) outputs[k] = v;
  return { outputs, units };
}

/** `412/500 · 82%`. */
export const progressText = (count: number, target: number) => `${count}/${target} · ${Math.round((count / target) * 100)}%`;

/** The output a rail row belongs to (`novel`, `radio`), or `work` when it names none. */
export const outputOf = (book: BookRail | undefined, rowId: string | undefined): string => (book && rowId !== undefined ? book.outputOf[rowId] : undefined) ?? "work";

/** The words of every other drafted unit in the edited unit's output, from the rail (`status`'s counts as of the last read). */
export function otherWords(book: BookRail | undefined, rowId: string | undefined): number {
  if (!book || rowId === undefined) return 0;
  const output = book.outputOf[rowId];
  let sum = 0;
  for (const [id, n] of Object.entries(book.words)) if (id !== rowId && book.outputOf[id] === output) sum += n;
  return sum;
}

/** The status field's value: the count, then each target's progress (`412 words · unit 412/500 · 82% · novel 9000/80000 · 11%`). */
export function wordsValue(count: number, targets: Targets, file: string, others: number, output = "work"): string {
  const parts = [`${count} word${count === 1 ? "" : "s"}`];
  const unit = targets.units[file];
  if (unit !== undefined) parts.push(`unit ${progressText(count, unit)}`);
  const total = targets.outputs[output];
  if (total !== undefined) parts.push(`${output} ${progressText(others + count, total)}`);
  return parts.join(" · ");
}

/** The live count of the pane's buffer: what the file saves with, frontmatter aside. */
export const paneWords = (t: EditText): number => countWords(t.buffer.text());

export interface WordsField { readonly value: string; readonly color?: string; /** A target is being typed: the pane's own keys are held. */ readonly typing: boolean }

/**
 * The hook app.tsx calls: the words field for the status line while the pane is open (undefined otherwise), and whether
 * the target prompt holds the keys. Its state is the model's (`state.words`); this loads the targets once from `store`,
 * reads the `edit.target` key (opens the prompt), Enter (sets) and Esc (cancels) while it is open, and persists what is set.
 */
export function useWordTargets(words: WordsState, dispatch: Dispatch<Action>, pane: EditPane | null, store: TargetStore | undefined, book: BookRail | undefined, rowId: string | undefined, keymap: Keymap = DEFAULT_KEYMAP): WordsField | undefined {
  const { targets, typed, notice } = words;
  useEffect(() => {
    try { dispatch({ type: "words.loaded", targets: readTargets(store?.load()) }); } catch { /* no targets */ }
  }, []);
  const text = pane?.text as EditText | null | undefined;
  const count = useMemo(() => (text ? paneWords(text) : 0), [text]);
  const open = pane !== null && pane.phase !== "opening" && text != null;

  useInput((input, key) => {
    if (!pane) return;
    const token = tokenOf(input, key);
    if (typed === null) {
      if (token !== null && !text?.prompt && resolve({ state: text?.mode ?? "normal", pane: true }, null, token, keymap).some((d) => d.type === "words.prompt")) dispatch({ type: "words.prompt" });
      return;
    }
    if (token === "esc") return void dispatch({ type: "words.cancel" });
    if (token === "enter") {
      const cmd = parseTarget(typed);
      if (!cmd.ok) return void dispatch({ type: "words.notice", message: cmd.message });
      const next = withTarget(targets, cmd.scope, pane.file, cmd.words, outputOf(book, rowId));
      dispatch({ type: "words.set", targets: next });
      try { store?.save(next); } catch (e) { dispatch({ type: "words.notice", message: `target not saved: ${e instanceof Error ? e.message : String(e)}` }); }
      return;
    }
    if (token === "backspace") return void dispatch({ type: "words.back" });
    if (!key.ctrl && !key.meta && input !== "" && !/[\x00-\x1f\x7f]/.test(input)) dispatch({ type: "words.type", text: input });
  }, { isActive: open });

  if (!open || !pane || !text) return undefined;
  if (typed !== null) return { value: `target (${TARGET_HELP}) › ${typed}▏${notice ? ` · ${notice}` : ""}`, typing: true, ...(notice ? { color: "red" } : {}) };
  return { value: `${wordsValue(count, targets, pane.file, otherWords(book, rowId), outputOf(book, rowId))}${notice ? ` · ${notice}` : ""}`, typing: false, ...(notice ? { color: "red" } : {}) };
}
